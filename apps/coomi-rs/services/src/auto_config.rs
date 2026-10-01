use crate::ProviderDocument;
use crate::ProviderSettings;
use anyhow::Context;
use anyhow::Result;
use coomi_telemetry::Telemetry;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::SystemTime;
use tokio::process::Command;

#[derive(Clone, Debug)]
pub enum AutoConfigIntent {
    Provider(Value),
    Mcp(Value),
    McpCommand(String),
    Skill(String),
}

#[derive(Clone, Debug)]
pub struct AutoConfigResult {
    pub kind: String,
    pub name: String,
    pub message: String,
}

pub fn detect_auto_config(input: &str) -> Option<AutoConfigIntent> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(value) = extract_json(trimmed) {
        if looks_like_provider(&value) {
            return Some(AutoConfigIntent::Provider(value));
        }
        if looks_like_mcp(&value) {
            return Some(AutoConfigIntent::Mcp(value));
        }
    }
    let command = trimmed.trim_start_matches('/');
    if command.to_ascii_lowercase().starts_with("mcp add ") {
        return Some(AutoConfigIntent::McpCommand(command.to_owned()));
    }
    let candidate = labeled_value(trimmed);
    if is_skill_source(candidate)
        && (trimmed.to_ascii_lowercase().contains("skill") || Path::new(candidate).exists())
    {
        return Some(AutoConfigIntent::Skill(candidate.to_owned()));
    }
    None
}

pub async fn apply_auto_config(home: &Path, intent: AutoConfigIntent) -> Result<AutoConfigResult> {
    match intent {
        AutoConfigIntent::Provider(value) => apply_provider(home, value),
        AutoConfigIntent::Mcp(value) => apply_mcp(home, value),
        AutoConfigIntent::McpCommand(command) => apply_mcp_command(home, &command),
        AutoConfigIntent::Skill(source) => install_skill_as(home, &source, None).await,
    }
}

fn apply_provider(home: &Path, value: Value) -> Result<AutoConfigResult> {
    let path = home.join("config").join("providers.json");
    let mut document = ProviderDocument::load(&path)?;
    if value.get("providers").and_then(Value::as_object).is_some() {
        let incoming: ProviderDocument = serde_json::from_value(value)?;
        let active = incoming.active.clone();
        document.providers.extend(incoming.providers);
        if !active.is_empty() {
            document.active = active;
        }
        document.save(&path)?;
        return Ok(AutoConfigResult {
            kind: "provider".into(),
            name: document.active.clone(),
            message: format!("Provider configuration merged; active: {}", document.active),
        });
    }

    let object = value
        .as_object()
        .context("Provider config must be an object")?;
    let id = string_alias(object, &["id", "provider", "provider_id", "name"])
        .filter(|value| !value.is_empty())
        .map(|value| sanitize_name(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "custom-provider".into());
    let provider = ProviderSettings {
        provider_type: string_alias(object, &["type", "provider_type"])
            .unwrap_or_else(|| "openai_compatible".into()),
        tool_protocol: string_alias(object, &["tool_protocol", "protocol"]),
        display: string_alias(object, &["display", "display_name"]).unwrap_or_else(|| id.clone()),
        api_key: string_alias(object, &["api_key", "apikey", "key", "token"]).unwrap_or_default(),
        base_url: string_alias(object, &["base_url", "baseurl", "url", "endpoint"])
            .unwrap_or_default(),
        model: string_alias(object, &["model", "model_name"]).unwrap_or_default(),
        fast_model: string_alias(object, &["fast_model"]),
        context_window: u64_alias(object, &["context_window"]),
        max_output_tokens: u64_alias(object, &["max_output_tokens"]),
        ..ProviderSettings::default()
    };
    document.providers.insert(id.clone(), provider);
    document.active = id.clone();
    document.save(&path)?;
    Ok(AutoConfigResult {
        kind: "provider".into(),
        name: id.clone(),
        message: format!("Provider `{id}` added and activated"),
    })
}

fn apply_mcp(home: &Path, value: Value) -> Result<AutoConfigResult> {
    let mut servers = extract_mcp_servers(&value)?;
    anyhow::ensure!(!servers.is_empty(), "MCP configuration contains no servers");
    let path = home.join("config").join("mcp_servers.json");
    let mut document = read_json_or_default(&path, json!({"servers": {}}))?;
    let target = document
        .get_mut("servers")
        .and_then(Value::as_object_mut)
        .context("mcp_servers.json has no servers object")?;
    let names = servers.keys().cloned().collect::<Vec<_>>();
    for (name, server) in &mut servers {
        normalize_mcp_server(server)?;
        target.insert(name.clone(), server.clone());
    }
    save_json(&path, &document)?;
    Ok(AutoConfigResult {
        kind: "mcp".into(),
        name: names.join(", "),
        message: format!("Configured MCP server(s): {}", names.join(", ")),
    })
}

fn apply_mcp_command(home: &Path, command: &str) -> Result<AutoConfigResult> {
    let parts = split_command(command);
    anyhow::ensure!(
        parts.len() >= 5
            && parts[0].eq_ignore_ascii_case("mcp")
            && parts[1].eq_ignore_ascii_case("add"),
        "usage: /mcp add <name> stdio <command> [args...] | /mcp add <name> http|sse <url>"
    );
    let name = parts[2].clone();
    let transport = parts[3].to_ascii_lowercase();
    let server = if transport == "stdio" {
        json!({"transport":"stdio","enabled":true,"command":parts[4],"args":parts[5..]})
    } else {
        anyhow::ensure!(
            matches!(transport.as_str(), "http" | "sse"),
            "unsupported MCP transport"
        );
        json!({"transport":transport,"enabled":true,"url":parts[4]})
    };
    apply_mcp(home, json!({"servers": {name: server}}))
}

/// 安装 Skill（本地目录 / GitHub URL）。github 来源的安装/失败会记录匿名统计事件
/// （install_ok / install_fail），与 UI 市场安装共用同一统计维度（owner/repo）。
async fn install_skill_as(
    home: &Path,
    source: &str,
    name_override: Option<&str>,
) -> Result<AutoConfigResult> {
    let result = install_skill_as_inner(home, source, name_override).await;
    if source.starts_with("https://github.com/") {
        let telemetry = Telemetry::new(home);
        match &result {
            Ok(_) => {
                let _ = telemetry.record("install_ok", source);
            }
            Err(_) => {
                let _ = telemetry.record("install_fail", source);
            }
        }
    }
    result
}

async fn install_skill_as_inner(
    home: &Path,
    source: &str,
    name_override: Option<&str>,
) -> Result<AutoConfigResult> {
    let skills = home.join("skills");
    fs::create_dir_all(&skills)?;
    let source_path = PathBuf::from(source);
    let (root, source_type, temporary) = if source_path.is_dir() {
        (source_path.canonicalize()?, "local", None)
    } else {
        anyhow::ensure!(
            source.starts_with("https://github.com/"),
            "Skill source was not found"
        );
        let temporary = temporary_directory(home)?;
        let output = Command::new("git")
            .args([
                "clone",
                "--depth",
                "1",
                source,
                temporary.to_string_lossy().as_ref(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        (temporary.clone(), "github", Some(temporary))
    };
    let skill_file = find_skill_file(&root).context("Skill source has no SKILL.md")?;
    let skill_root = skill_file.parent().context("Skill file has no parent")?;
    let name = name_override.map(sanitize_name).unwrap_or_else(|| {
        sanitize_name(
            skill_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill"),
        )
    });
    let destination = skills.join(&name);
    anyhow::ensure!(!destination.exists(), "Skill `{name}` is already installed");
    copy_directory(skill_root, &destination)?;
    let commit = if source_type == "github" {
        let output = Command::new("git")
            .args(["-C", root.to_string_lossy().as_ref(), "rev-parse", "HEAD"])
            .output()
            .await
            .ok();
        output
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    update_skill_metadata(home, &name, source, source_type, &destination, &commit)?;
    if let Some(temporary) = temporary {
        let _ = fs::remove_dir_all(temporary);
    }
    Ok(AutoConfigResult {
        kind: "skill".into(),
        name: name.clone(),
        message: format!("Skill `{name}` installed and enabled"),
    })
}

pub async fn update_installed_skill(home: &Path, name: &str) -> Result<AutoConfigResult> {
    let config_path = home.join("config").join("skills.json");
    let document = read_json_or_default(&config_path, json!({"skills": {}}))?;
    let record = document
        .get("skills")
        .and_then(Value::as_object)
        .and_then(|skills| skills.get(name))
        .and_then(Value::as_object)
        .with_context(|| format!("Skill `{name}` has no source metadata"))?;
    let source_type = record
        .get("source_type")
        .and_then(Value::as_str)
        .unwrap_or("untracked");
    anyhow::ensure!(
        matches!(source_type, "github" | "local"),
        "Skill `{name}` must be updated by its {source_type} installer"
    );
    let source = record
        .get("source")
        .and_then(Value::as_str)
        .filter(|source| !source.trim().is_empty())
        .with_context(|| format!("Skill `{name}` has no source"))?
        .to_owned();
    let destination = home.join("skills").join(name);
    anyhow::ensure!(destination.is_dir(), "Skill `{name}` is not installed");
    let backup = home
        .join("cache")
        .join(format!("skill-update-{name}-backup"));
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&destination, &backup)?;
    match install_skill_as(home, &source, Some(name)).await {
        Ok(result) => {
            fs::remove_dir_all(&backup)?;
            Ok(AutoConfigResult {
                message: format!("Skill `{name}` updated and enabled"),
                ..result
            })
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&destination);
            let _ = fs::rename(&backup, &destination);
            Err(error)
        }
    }
}

fn extract_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

fn looks_like_provider(value: &Value) -> bool {
    if value.get("providers").is_some() {
        return true;
    }
    let Some(object) = value.as_object() else {
        return false;
    };
    has_alias(object, &["model", "model_name"])
        && has_alias(object, &["api_key", "apikey", "key", "token"])
}

fn looks_like_mcp(value: &Value) -> bool {
    value.get("mcpServers").is_some()
        || value.get("servers").is_some()
        || value.as_object().is_some_and(|object| {
            has_alias(object, &["command", "url", "endpoint"])
                && has_alias(object, &["transport", "type", "name"])
        })
}

fn extract_mcp_servers(value: &Value) -> Result<Map<String, Value>> {
    if let Some(servers) = value
        .get("servers")
        .or_else(|| value.get("mcpServers"))
        .and_then(Value::as_object)
    {
        return Ok(servers.clone());
    }
    let object = value.as_object().context("MCP config must be an object")?;
    let name = string_alias(object, &["name", "id"]).unwrap_or_else(|| "custom-mcp".into());
    Ok(Map::from_iter([(sanitize_name(&name), value.clone())]))
}

fn normalize_mcp_server(server: &mut Value) -> Result<()> {
    let object = server
        .as_object_mut()
        .context("MCP server must be an object")?;
    let transport = object
        .get("transport")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| {
            if object.contains_key("command") {
                "stdio".into()
            } else {
                "http".into()
            }
        });
    anyhow::ensure!(
        matches!(transport.as_str(), "stdio" | "http" | "sse"),
        "unsupported MCP transport"
    );
    object.insert("transport".into(), Value::String(transport));
    object.entry("enabled").or_insert(Value::Bool(true));
    Ok(())
}

fn string_alias(object: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        object.iter().find_map(|(key, value)| {
            normalized_key(key)
                .eq(&normalized_key(name))
                .then(|| value.as_str().map(str::to_owned))
                .flatten()
        })
    })
}

fn u64_alias(object: &Map<String, Value>, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| {
        object.iter().find_map(|(key, value)| {
            normalized_key(key)
                .eq(&normalized_key(name))
                .then(|| value.as_u64())
                .flatten()
        })
    })
}

fn has_alias(object: &Map<String, Value>, names: &[&str]) -> bool {
    names.iter().any(|name| {
        object
            .keys()
            .any(|key| normalized_key(key) == normalized_key(name))
    })
}

fn normalized_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn sanitize_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(['-', '.', '_'])
        .chars()
        .take(80)
        .collect()
}

fn labeled_value(value: &str) -> &str {
    value
        .split_once([':', '\u{ff1a}'])
        .map_or(value, |(_, rest)| rest.trim())
        .trim_matches('"')
}

fn is_skill_source(value: &str) -> bool {
    value.starts_with("https://github.com/")
        || Path::new(value).is_absolute()
        || value.starts_with("./")
        || value.starts_with("../")
}

fn split_command(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|part| part.trim_matches('"').to_owned())
        .collect()
}

fn read_json_or_default(path: &Path, default: Value) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(error) => Err(error.into()),
    }
}

fn save_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn temporary_directory(home: &Path) -> Result<PathBuf> {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_nanos();
    let path = home.join("cache").join(format!("skill-install-{nonce}"));
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn find_skill_file(root: &Path) -> Option<PathBuf> {
    if root.join("SKILL.md").is_file() {
        return Some(root.join("SKILL.md"));
    }
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory).ok()?.flatten() {
            let path = entry.path();
            if path.file_name().and_then(|value| value.to_str()) == Some(".git") {
                continue;
            }
            if path.is_dir() {
                directories.push(path);
            } else if path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
                return Some(path);
            }
        }
    }
    None
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        let target = destination.join(entry.file_name());
        if path.is_dir() {
            copy_directory(&path, &target)?;
        } else {
            fs::copy(path, target)?;
        }
    }
    Ok(())
}

fn update_skill_metadata(
    home: &Path,
    name: &str,
    source: &str,
    source_type: &str,
    path: &Path,
    commit: &str,
) -> Result<()> {
    let config_path = home.join("config").join("skills.json");
    let mut document = read_json_or_default(&config_path, json!({"skills": {}}))?;
    let skills = document
        .get_mut("skills")
        .and_then(Value::as_object_mut)
        .context("skills.json has no skills object")?;
    skills.insert(name.into(), json!({"enabled":true,"path":path,"source":source,"source_type":source_type,"commit":commit}));
    save_json(&config_path, &document)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_provider_without_mistaking_plain_json() {
        assert!(matches!(
            detect_auto_config(
                r#"{"model":"deepseek","api_key":"secret","base_url":"https://example.test/v1"}"#
            ),
            Some(AutoConfigIntent::Provider(_))
        ));
        assert!(detect_auto_config(r#"{"query":"model"}"#).is_none());
    }

    #[test]
    fn detects_mcp_json_and_command() {
        assert!(matches!(
            detect_auto_config(r#"{"mcpServers":{"docs":{"command":"npx","args":["server"]}}}"#),
            Some(AutoConfigIntent::Mcp(_))
        ));
        assert!(matches!(
            detect_auto_config("/mcp add docs sse https://example.test/sse"),
            Some(AutoConfigIntent::McpCommand(_))
        ));
    }

    #[test]
    fn detects_labeled_skill_source() {
        assert!(matches!(
            detect_auto_config("skill: https://github.com/example/coomi-skill"),
            Some(AutoConfigIntent::Skill(source)) if source.ends_with("coomi-skill")
        ));
    }
}
