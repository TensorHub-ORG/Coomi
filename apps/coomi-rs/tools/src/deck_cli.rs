//! Fixed CLI adapters. Credentials are written to private Deck configuration,
//! never returned as tool output or passed on the process command line.
use anyhow::{Context, Result, bail, ensure};
use portable_pty::CommandBuilder;
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn user_dir() -> Result<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .context("找不到用户目录")
}
fn package(profile: &str) -> Result<&'static str> {
    match profile {
        "codex" => Ok("@openai/codex@latest"),
        "zcode" => Ok("zcode-app-cli@latest"),
        _ => bail!("仅支持 Codex 和 ZCode"),
    }
}
fn prefix(home: &Path, profile: &str) -> PathBuf {
    home.join("deck/cli/packages").join(profile)
}
fn script(home: &Path, profile: &str) -> PathBuf {
    prefix(home, profile)
        .join("node_modules")
        .join(if profile == "codex" {
            "@openai/codex/bin/codex.js"
        } else {
            "zcode-app-cli/bin/zcode.js"
        })
}
fn config_path(home: &Path, profile: &str) -> PathBuf {
    home.join("deck/cli/config")
        .join(profile)
        .join(if profile == "codex" {
            "config.toml"
        } else {
            "provider_config.json"
        })
}
fn existing_config(profile: &str) -> Result<PathBuf> {
    if profile == "codex" {
        Ok(env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or(user_dir()?.join(".codex"))
            .join("config.toml"))
    } else {
        Ok(env::var_os("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
            .map(PathBuf::from)
            .unwrap_or(user_dir()?.join(".zcode/v2/provider_config.json")))
    }
}
fn executable(name: &str) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> =
        env::split_paths(&env::var_os("PATH").unwrap_or_default()).collect();
    if let Ok(user) = user_dir() {
        roots.push(user.join("AppData/Local/Programs/OpenAI/Codex/bin"));
    }
    if let Some(roaming) = env::var_os("APPDATA") {
        roots.push(PathBuf::from(roaming).join("npm"));
    }
    roots
        .into_iter()
        .flat_map(|root| {
            let extensions: &[&str] = if cfg!(windows) {
                &[".exe", ".cmd", ""]
            } else {
                &[""]
            };
            extensions
                .iter()
                .map(move |ext| root.join(format!("{name}{ext}")))
        })
        .find(|path| path.is_file())
}
pub fn command(home: &Path, profile: &str, install: bool, full_access: bool) -> Result<CommandBuilder> {
    package(profile)?;
    let managed_script = script(home, profile);
    let mut command = if install {
        let node = executable("node").context("请先安装 Node.js 22.19 或更新版本，再安装 CLI")?;
        let mut version_command = std::process::Command::new(&node);
        version_command.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            version_command.creation_flags(0x08000000);
        }
        let version = version_command.output().context("无法检查 Node.js 版本")?;
        let version_text = String::from_utf8_lossy(&version.stdout);
        let numbers: Vec<u32> = version_text
            .trim()
            .trim_start_matches('v')
            .split('.')
            .take(2)
            .filter_map(|part| part.parse().ok())
            .collect();
        let required = if profile == "zcode" {
            (22, 19)
        } else {
            (16, 0)
        };
        ensure!(
            version.status.success() && numbers.len() == 2 && (numbers[0], numbers[1]) >= required,
            "{profile} 安装需要 Node.js {}.{} 或更新版本",
            required.0,
            required.1
        );
        let npm = executable("npm").context("找不到 npm，请安装含 npm 的 Node.js")?;
        let npm_cli = npm
            .parent()
            .context("npm 路径无效")?
            .join("node_modules/npm/bin/npm-cli.js");
        ensure!(
            npm_cli.is_file(),
            "无法定位 npm-cli.js，请修复 Node.js/npm 安装"
        );
        let mut cmd = CommandBuilder::new(node);
        cmd.arg(npm_cli);
        cmd.args([
            "install",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            "--prefix",
        ]);
        cmd.arg(prefix(home, profile));
        cmd.arg(package(profile)?);
        cmd
    } else if managed_script.exists() {
        let mut cmd = CommandBuilder::new(executable("node").context("找不到 Node.js")?);
        cmd.arg(managed_script);
        cmd
    } else {
        let path = executable(profile)
            .with_context(|| format!("{profile} 尚未安装，请打开 CLI 管理或让 Coomi 安装"))?;
        if cfg!(windows)
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd"))
        {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.args(["/d", "/c"]);
            cmd.arg(path);
            cmd
        } else {
            CommandBuilder::new(path)
        }
    };
    if !install {
        apply_permissions(&mut command, profile, full_access);
        let managed_config = config_path(home, profile);
        if managed_config.exists() {
            if profile == "codex" {
                command.env(
                    "CODEX_HOME",
                    managed_config.parent().context("配置路径无效")?,
                );
            } else {
                command.env("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", managed_config);
            }
        }
    }
    Ok(command)
}

fn apply_permissions(command: &mut CommandBuilder, profile: &str, full_access: bool) {
    if full_access {
        match profile {
            "codex" => { command.arg("--dangerously-bypass-approvals-and-sandbox"); }
            "zcode" => { command.args(["--mode", "yolo"]); }
            _ => {}
        }
    }
}
pub fn inspect(home: &Path, profile: &str) -> Result<Value> {
    let pkg = package(profile)?;
    let managed = script(home, profile).is_file();
    let installed = managed || executable(profile).is_some();
    let path = config_path(home, profile);
    let mut configuration = json!({"managed":path.exists(),"path":path});
    if path.exists() {
        let raw = fs::read_to_string(&path)?;
        if profile == "codex" {
            let doc: toml::Value = toml::from_str(&raw).context("Codex 配置无法解析")?;
            configuration["model"] = json!(doc.get("model").and_then(toml::Value::as_str));
            configuration["effort"] = json!(
                doc.get("model_reasoning_effort")
                    .and_then(toml::Value::as_str)
            );
            let provider = doc.get("model_providers").and_then(|v| v.get("coomi_deck"));
            configuration["base_url"] = json!(
                provider
                    .and_then(|v| v.get("base_url"))
                    .and_then(toml::Value::as_str)
            );
            configuration["has_api_key"] = json!(
                provider
                    .and_then(|v| v.get("experimental_bearer_token"))
                    .and_then(toml::Value::as_str)
                    .is_some_and(|key| !key.is_empty())
            );
            configuration["protocol"] = json!("openai-responses");
        } else {
            let doc: Value = serde_json::from_str(&raw).context("ZCode 配置无法解析")?;
            let rule = doc["config"]["providerConfigRules"]["providerRules"]
                .as_array()
                .and_then(|rules| rules.iter().find(|rule| rule["providerId"] == "coomi-deck"));
            configuration["model"] = doc["config"]["defaultModelSelection"]["modelId"].clone();
            configuration["effort"] =
                doc["config"]["defaultModelSelection"]["options"]["reasoningLevel"].clone();
            configuration["base_url"] = rule
                .map(|v| v["config"]["api"]["baseUrl"].clone())
                .unwrap_or(Value::Null);
            configuration["protocol"] = rule
                .map(|v| v["config"]["api"]["type"].clone())
                .unwrap_or(Value::Null);
            configuration["has_api_key"] = json!(
                rule.and_then(|v| v["config"]["access"]["apiKey"].as_str())
                    .is_some_and(|key| !key.is_empty())
            );
        }
    }
    Ok(
        json!({"profile":profile,"installed":installed,"managed_install":managed,"node_available":executable("node").is_some(),"npm_available":executable("npm").is_some(),"package":pkg,"source":if profile == "zcode" {"ZCode 社区终端客户端 (kingsword09/zcode-cli)"} else {"OpenAI Codex"},"configuration":configuration}),
    )
}
pub fn configure(home: &Path, profile: &str, args: &Value) -> Result<Value> {
    package(profile)?;
    let mut base_url = args["base_url"].as_str().unwrap_or_default().to_owned();
    let mut model = args["model"].as_str().unwrap_or_default().to_owned();
    let mut key = args["api_key"].as_str().unwrap_or_default().to_owned();
    let mut protocol = args["protocol"]
        .as_str()
        .unwrap_or(if profile == "codex" {
            "openai-responses"
        } else {
            "openai-chat-completions"
        })
        .to_owned();
    if let Some(id) = args["provider_id"].as_str().filter(|id| !id.is_empty()) {
        let document = coomi_services::ProviderDocument::load(&home.join("config/providers.json"))?;
        let provider = document.providers.get(id).context("Coomi 厂商不存在")?;
        base_url.clone_from(&provider.base_url);
        key.clone_from(&provider.api_key);
        if model.is_empty() {
            model.clone_from(&provider.model);
        }
        let kind = provider
            .tool_protocol
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&provider.provider_type)
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_");
        protocol = match kind.as_str() {
            "openai_responses" | "responses" => "openai-responses",
            "anthropic" | "anthropic_messages" => "anthropic-messages",
            "openai_compatible" | "openai" | "generic" | "deepseek" | "chat_completions" => {
                "openai-chat-completions"
            }
            _ => bail!("此 Coomi 厂商协议不适用于 CLI"),
        }
        .into();
    }
    let url = reqwest::Url::parse(&base_url).context("API 地址无效")?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "API 地址需要不含凭据或查询参数的 HTTP(S) 根地址"
    );
    ensure!(
        !model.trim().is_empty() && model.len() <= 256 && !model.chars().any(char::is_control),
        "模型 ID 无效"
    );
    ensure!(
        key.len() <= 8192 && !key.chars().any(char::is_control),
        "API Key 无效"
    );
    ensure!(
        matches!(
            protocol.as_str(),
            "openai-responses" | "openai-chat-completions" | "anthropic-messages"
        ),
        "不支持此 API 协议"
    );
    ensure!(
        profile != "codex" || protocol == "openai-responses",
        "Codex 需要支持 Responses API 的厂商，请选择对应协议的配置"
    );
    let effort = args["effort"].as_str().unwrap_or_default();
    ensure!(
        matches!(
            effort,
            "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ),
        "思考强度无效"
    );
    ensure!(
        profile != "codex" || !matches!(effort, "max" | "ultra"),
        "Codex 不支持此思考强度，请使用模型默认值或 none/minimal/low/medium/high/xhigh"
    );
    ensure!(
        profile != "zcode" || protocol != "anthropic-messages" || effort.is_empty(),
        "Anthropic 模型的思考参数请在 ZCode 内设置，此处选择默认值"
    );
    let path = config_path(home, profile);
    let source = if path.exists() {
        path.clone()
    } else {
        existing_config(profile)?
    };
    let raw = if source.exists() {
        fs::read_to_string(&source)?
    } else {
        String::new()
    };
    let content = if profile == "codex" {
        let mut doc: toml::Value = if raw.is_empty() {
            toml::Value::Table(Default::default())
        } else {
            toml::from_str(&raw).context("原 Codex 配置无效，未覆盖")?
        };
        let table = doc.as_table_mut().context("Codex 配置必须是表")?;
        table.insert("model".into(), model.clone().into());
        table.insert("model_provider".into(), "coomi_deck".into());
        // A copied named profile can override these top-level choices.
        table.remove("profile");
        if !effort.is_empty() {
            table.insert("model_reasoning_effort".into(), effort.into());
        } else {
            table.remove("model_reasoning_effort");
        }
        let providers = table
            .entry("model_providers")
            .or_insert_with(|| toml::Value::Table(Default::default()))
            .as_table_mut()
            .context("model_providers 必须是表")?;
        let mut custom = toml::Table::new();
        custom.insert("name".into(), "Coomi Deck".into());
        custom.insert("base_url".into(), base_url.into());
        custom.insert("wire_api".into(), "responses".into());
        custom.insert("requires_openai_auth".into(), false.into());
        if key.is_empty() {
            if let Some(old) = providers
                .get("coomi_deck")
                .and_then(|v| v.get("experimental_bearer_token"))
            {
                custom.insert("experimental_bearer_token".into(), old.clone());
            }
        } else {
            custom.insert("experimental_bearer_token".into(), key.into());
        }
        providers.insert("coomi_deck".into(), toml::Value::Table(custom));
        toml::to_string_pretty(&doc)?
    } else {
        let mut doc: Value = if raw.is_empty() {
            json!({"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}})
        } else {
            serde_json::from_str(&raw).context("原 ZCode 配置无效，未覆盖")?
        };
        ensure!(
            doc["schemaVersion"] == 1 && doc["config"].is_object(),
            "ZCode 配置版本不受支持，未覆盖"
        );
        let rules = doc["config"]["providerConfigRules"]["providerRules"]
            .as_array_mut()
            .context("ZCode providerRules 必须是数组")?;
        let old = rules
            .iter()
            .position(|rule| rule["providerId"] == "coomi-deck");
        if key.is_empty() {
            key = old
                .and_then(|index| rules[index]["config"]["access"]["apiKey"].as_str())
                .unwrap_or_default()
                .into();
        }
        let mut rule = old.map(|index| rules[index].clone()).unwrap_or(json!({"providerId":"coomi-deck","providerName":"Coomi Deck","enabled":true,"config":{"group":"standard-personal","personalModelIds":[],"modelOrder":[]}}));
        rule["enabled"] = json!(true);
        rule["config"]["group"] = json!("standard-personal");
        rule["config"]["access"] = json!({"type":"api-key","apiKey":key});
        rule["config"]["api"] = json!({"type":protocol,"baseUrl":base_url});
        for list in ["personalModelIds", "modelOrder"] {
            if !rule["config"][list].is_array() {
                rule["config"][list] = json!([]);
            }
            let values = rule["config"][list].as_array_mut().unwrap();
            if !values.contains(&json!(model)) {
                values.push(json!(model));
            }
        }
        if let Some(index) = old {
            rules[index] = rule;
        } else {
            rules.push(rule);
        }
        let model_rules = &mut doc["config"]["modelConfigRules"];
        if model_rules.is_null() {
            *model_rules = json!({});
        }
        if model_rules["manualProviderModelRules"].is_null() {
            model_rules["manualProviderModelRules"] = json!([]);
        }
        if model_rules["providerModelRules"].is_null() {
            model_rules["providerModelRules"] = json!([]);
        }
        let manual = model_rules["manualProviderModelRules"]
            .as_array()
            .context("manualProviderModelRules 必须是数组")?
            .iter()
            .position(|v| v["providerId"] == "coomi-deck" && v["modelId"] == model);
        let models = model_rules["providerModelRules"]
            .as_array_mut()
            .context("providerModelRules 必须是数组")?;
        let selected = if let Some(index) = manual {
            &mut model_rules["manualProviderModelRules"][index]
        } else {
            let index = models
                .iter()
                .position(|v| v["providerId"] == "coomi-deck" && v["modelId"] == model)
                .unwrap_or_else(|| {
                    models.push(json!({"providerId":"coomi-deck","modelId":model,"config":{}}));
                    models.len() - 1
                });
            &mut models[index]
        };
        selected["config"]["enabled"] = json!(true);
        if !effort.is_empty() {
            selected["config"]["optionSpecs"]["reasoningLevel"] = json!({"values":["none","minimal","low","medium","high","xhigh","max","ultra"],"map":if protocol == "openai-responses" {r#"{"reasoning":{"effort":reasoningLevel}}"#} else {r#"{"reasoning_effort":reasoningLevel}"#}});
        }
        doc["config"]["defaultModelSelection"] = json!({"providerId":"coomi-deck","modelId":model});
        if !effort.is_empty() {
            doc["config"]["defaultModelSelection"]["options"] = json!({"reasoningLevel":effort});
        }
        serde_json::to_string_pretty(&doc)?
    };
    private_write(&path, content.as_bytes())?;
    Ok(
        json!({"ok":true,"configuration":inspect(home, profile)?["configuration"],"notice":"已保存 Deck CLI 配置，下次启动终端生效；现有进程继续使用原配置。"}),
    )
}
fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("配置路径无效")?)?;
    if path.exists() {
        fs::copy(
            path,
            path.with_extension(format!("backup-{}", uuid::Uuid::new_v4())),
        )?;
    }
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(&tmp)?.write_all(bytes)?;
    fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_full_access_is_explicit() {
        for (profile, expected) in [("codex", vec!["codex", "--dangerously-bypass-approvals-and-sandbox"]), ("zcode", vec!["zcode", "--mode", "yolo"])] {
            let mut command = CommandBuilder::new(profile);
            apply_permissions(&mut command, profile, false);
            assert_eq!(command.get_argv(), &[std::ffi::OsString::from(profile)]);
            apply_permissions(&mut command, profile, true);
            assert_eq!(command.get_argv().as_slice(), expected.iter().map(std::ffi::OsString::from).collect::<Vec<_>>().as_slice());
        }
    }
    #[test]
    fn configuration_preserves_data_masks_secrets_and_backs_up() {
        let home = tempfile::tempdir().unwrap();
        for profile in ["codex", "zcode"] {
            let path = config_path(home.path(), profile);
            private_write(&path, if profile == "codex" { b"[projects.demo]\ntrust_level = 'trusted'\n" } else { br#"{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[{"providerId":"other","config":{"access":{"apiKey":"existing-secret"}}}]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}},"unrelated":true}"# }).unwrap();
            let args = json!({"base_url":"https://api.example.com/v1","model":"test-model","api_key":"test-secret","protocol":"openai-responses","effort":"high"});
            let result = configure(home.path(), profile, &args).unwrap();
            assert!(!result.to_string().contains("test-secret"));
            assert!(!result.to_string().contains("existing-secret"));
            assert_eq!(result["configuration"]["has_api_key"], true);
            assert_eq!(result["configuration"]["model"], "test-model");
            let raw = fs::read_to_string(&path).unwrap();
            assert!(raw.contains(if profile == "codex" {
                "trust_level"
            } else {
                "existing-secret"
            }));
            assert!(fs::read_dir(path.parent().unwrap()).unwrap().count() >= 2);
            let before = raw;
            assert!(
                configure(
                    home.path(),
                    profile,
                    &json!({"base_url":"https://bad.example/?key=x","model":"x"})
                )
                .is_err()
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), before);
            configure(home.path(), profile, &json!({"base_url":"https://api.example.com/v1","model":"test-model","protocol":"openai-responses","effort":""})).unwrap();
            assert!(
                inspect(home.path(), profile).unwrap()["configuration"]["effort"].is_null(),
                "default effort clears the explicit override"
            );
            assert_eq!(
                inspect(home.path(), profile).unwrap()["configuration"]["has_api_key"],
                true
            );
        }
    }
}
