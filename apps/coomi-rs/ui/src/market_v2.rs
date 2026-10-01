//! 插件市场 v2 辅助：多源合并、本地回滚备份、中文展示元数据。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 内置 skill 下载源预设：id → (名称, registry URL)。
/// 前端拓展广场「源切换」下拉使用；各源都是独立 registry.json。
pub fn registry_source_presets() -> Vec<(String, &'static str, &'static str)> {
    vec![
        (
            "official".into(),
            "官方源",
            "https://raw.githubusercontent.com/TensorHub-ORG/coomi-registry/main/registry.json",
        ),
        (
            "official-cdn".into(),
            "官方源 · jsDelivr CDN",
            "https://cdn.jsdelivr.net/gh/TensorHub-ORG/coomi-registry@main/registry.json",
        ),
        (
            "mirror-gh-proxy".into(),
            "官方源 · gh-proxy 镜像",
            "https://gh-proxy.com/https://raw.githubusercontent.com/TensorHub-ORG/coomi-registry/main/registry.json",
        ),
    ]
}

/// 按源 id 取 registry URL；未知 id 返回 None。
pub fn registry_url_for_source(source: &str) -> Option<String> {
    registry_source_presets()
        .into_iter()
        .find(|(id, _, _)| id == source)
        .map(|(_, _, url)| url.to_owned())
}

/// 额外注册表源：环境变量 COOMI_EXTRA_REGISTRIES 用逗号分隔 URL。
pub fn extra_registry_urls() -> Vec<String> {
    std::env::var("COOMI_EXTRA_REGISTRIES")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// 合并多个 registry.json：按 id 去重，后源覆盖同 id，保留来源标签。
pub fn merge_registries(sources: &[(String, Value)]) -> Value {
    let mut skills: HashMap<String, Value> = HashMap::new();
    let mut mcps: HashMap<String, Value> = HashMap::new();
    let mut updated_at = String::new();
    for (source, registry) in sources {
        if let Some(list) = registry.get("skills").and_then(Value::as_array) {
            for item in list {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    let mut owned = item.clone();
                    owned["source"] = json!(source);
                    skills.insert(id.to_owned(), owned);
                }
            }
        }
        if let Some(list) = registry.get("mcps").or_else(|| registry.get("mcp")).and_then(Value::as_array)
        {
            for item in list {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    let mut owned = item.clone();
                    owned["source"] = json!(source);
                    mcps.insert(id.to_owned(), owned);
                }
            }
        }
        if let Some(ts) = registry.get("updated_at").and_then(Value::as_str) {
            if ts > updated_at.as_str() {
                updated_at = ts.to_owned();
            }
        }
    }
    let mut skill_list: Vec<Value> = skills.into_values().collect();
    skill_list.sort_by_key(|v| {
        v.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
    let mut mcp_list: Vec<Value> = mcps.into_values().collect();
    mcp_list.sort_by_key(|v| {
        v.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
    json!({
        "skills": skill_list,
        "mcps": mcp_list,
        "updated_at": updated_at,
        "sources": sources.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>(),
    })
}

/// Skill 安装前备份目录，便于回滚。
pub fn backup_skill(home: &Path, skill_id: &str) -> Option<PathBuf> {
    let src = home.join("skills").join(skill_id);
    if !src.is_dir() {
        return None;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let dest = home
        .join("cache")
        .join("skill-backups")
        .join(format!("{skill_id}-{stamp}"));
    if fs::create_dir_all(&dest).is_err() {
        return None;
    }
    copy_dir(&src, &dest).ok()?;
    // 写索引
    let index_path = home.join("cache").join("skill-backups").join("index.json");
    let mut index: Value = fs::read_to_string(&index_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "entries": [] }));
    if let Some(arr) = index.get_mut("entries").and_then(Value::as_array_mut) {
        arr.push(json!({
            "skillId": skill_id,
            "backup": dest.display().to_string(),
            "at": stamp,
        }));
        while arr.len() > 20 {
            arr.remove(0);
        }
    }
    let _ = fs::write(&index_path, serde_json::to_vec_pretty(&index).unwrap_or_default());
    Some(dest)
}

/// 回滚到最近一次备份。
pub fn rollback_skill(home: &Path, skill_id: &str) -> Result<PathBuf, String> {
    let index_path = home.join("cache").join("skill-backups").join("index.json");
    let index: Value = fs::read_to_string(&index_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "entries": [] }));
    let backup = index
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .filter(|e| e.get("skillId").and_then(Value::as_str) == Some(skill_id))
                .max_by_key(|e| e.get("at").and_then(Value::as_u64).unwrap_or(0))
                .and_then(|e| e.get("backup").and_then(Value::as_str).map(str::to_owned))
        })
        .ok_or_else(|| format!("没有找到 `{skill_id}` 的备份"))?;
    let src = PathBuf::from(&backup);
    if !src.is_dir() {
        return Err("备份目录已不存在".into());
    }
    let dest = home.join("skills").join(skill_id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("清理当前目录失败: {e}"))?;
    }
    copy_dir(&src, &dest).map_err(|e| format!("恢复失败: {e}"))?;
    Ok(dest)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let target = to.join(&name);
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}
