//! 镜像源配置：settings.json 的 mirrors 块（GitHub 前缀 / npm registry /
//! pip-uv index / docker registry）。
//!
//! 三条硬规则：
//! 1. 只作用于引擎自己拉起的子进程（环境变量注入 / 拼下载 URL），
//!    **绝不**改用户的全局 npm / pip 配置（~/.npmrc、pip.conf、环境变量都别动）；
//! 2. 每类一个 active 指针：**生效 = active 指向该条目且该条目 enabled**，
//!    两个条件缺一不可（用户把 active 指向条目但关掉它，等于该类不走镜像）；
//! 3. 内置清单永远存在：settings.json 缺字段、写坏、写半个都能被补齐成完整可用配置。
//!
//! 官方条目（id = official）表示「不注入」：走 pip / npm 自己的默认源，
//! 而不是硬把官方 URL 塞进子进程（用户自己的全局配置仍然算数）。

use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;

/// 官方条目的固定 id（各类型共用这一个 id）。
pub const OFFICIAL_ID: &str = "official";
/// 单类条目数量上限：够用，又不至于让一份 settings.json 被塞爆。
const MAX_ITEMS_PER_KIND: usize = 32;
/// 条目 id / label 的长度上限。
const MAX_ID_CHARS: usize = 64;
const MAX_LABEL_CHARS: usize = 120;
/// 注入子进程时用的镜像地址长度上限（防止把整段文本当 URL 塞进环境变量）。
const MAX_URL_CHARS: usize = 2048;

/// 镜像类型：GitHub 前缀 / npm registry / pip-uv index / docker registry。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MirrorKind {
    Github,
    Npm,
    Pip,
    Docker,
}

impl MirrorKind {
    /// 固定顺序：settings.json 的字段顺序、前端渲染顺序都用它。
    pub const ALL: [Self; 4] = [Self::Github, Self::Npm, Self::Pip, Self::Docker];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Npm => "npm",
            Self::Pip => "pip",
            Self::Docker => "docker",
        }
    }

    /// 宽松解析：pip / uv / pypi 都算 pip 类（前端可能按用途传词）。
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "github" | "gh" => Some(Self::Github),
            "npm" | "node" => Some(Self::Npm),
            "pip" | "uv" | "pypi" | "python" => Some(Self::Pip),
            "docker" | "registry" => Some(Self::Docker),
            _ => None,
        }
    }
}

/// 一条镜像：{id,label,url,type,enabled}。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MirrorEntry {
    pub id: String,
    pub label: String,
    pub url: String,
    #[serde(rename = "type")]
    pub kind: MirrorKind,
    pub enabled: bool,
}

/// 一类镜像：active 指针 + 条目列表。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MirrorGroup {
    /// 生效条目 id；条目不存在时会被规范化回内置默认值。
    pub active: String,
    pub items: Vec<MirrorEntry>,
}

/// settings.json → mirrors 的完整结构。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MirrorsSettings {
    pub github: MirrorGroup,
    pub npm: MirrorGroup,
    pub pip: MirrorGroup,
    pub docker: MirrorGroup,
}

impl MirrorsSettings {
    pub fn group(&self, kind: MirrorKind) -> &MirrorGroup {
        match kind {
            MirrorKind::Github => &self.github,
            MirrorKind::Npm => &self.npm,
            MirrorKind::Pip => &self.pip,
            MirrorKind::Docker => &self.docker,
        }
    }

    pub fn group_mut(&mut self, kind: MirrorKind) -> &mut MirrorGroup {
        match kind {
            MirrorKind::Github => &mut self.github,
            MirrorKind::Npm => &mut self.npm,
            MirrorKind::Pip => &mut self.pip,
            MirrorKind::Docker => &mut self.docker,
        }
    }

    /// 生效条目：active 指向的条目且该条目 enabled。
    pub fn effective(&self, kind: MirrorKind) -> Option<&MirrorEntry> {
        let group = self.group(kind);
        let entry = group
            .items
            .iter()
            .find(|entry| entry.id.eq_ignore_ascii_case(&group.active))?;
        entry.enabled.then_some(entry)
    }

    /// 生效的 GitHub 前缀；None = 直连 github.com（官方条目或该类未生效）。
    pub fn github_prefix(&self) -> Option<String> {
        let entry = self.effective(MirrorKind::Github)?;
        if entry.id.eq_ignore_ascii_case(OFFICIAL_ID) || entry.url.trim().is_empty() {
            return None;
        }
        Some(with_trailing_slash(entry.url.trim()))
    }

    /// 要注入子进程的环境变量（npm / pip / uv 三类）。
    ///
    /// 官方条目**不注入**：官方 = 用 pip / npm 自己的默认源，硬塞官方 URL 反而会
    /// 覆盖掉用户已经配好的全局源（我们承诺过不碰用户的全局配置）。
    pub fn env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        if let Some(entry) = mirror_entry(self, MirrorKind::Npm) {
            env.insert("npm_config_registry".to_owned(), normalize_index_url(&entry.url));
        }
        if let Some(entry) = mirror_entry(self, MirrorKind::Pip) {
            let url = normalize_index_url(&entry.url);
            env.insert("PIP_INDEX_URL".to_owned(), url.clone());
            env.insert("UV_INDEX_URL".to_owned(), url);
        }
        env
    }

    /// 生效的 docker registry 镜像；None = 官方 Docker Hub。
    /// docker 镜像只能写进 daemon.json（引擎不改用户全局配置），这里只用于展示。
    pub fn docker_registry(&self) -> Option<String> {
        let entry = self.effective(MirrorKind::Docker)?;
        if entry.id.eq_ignore_ascii_case(OFFICIAL_ID) {
            return None;
        }
        Some(entry.url.trim().trim_end_matches('/').to_owned())
    }

    /// 序列化成 settings.json 里的 mirrors 值。
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

/// 生效条目，且排除官方（官方不注入环境变量）。
fn mirror_entry<'a>(settings: &'a MirrorsSettings, kind: MirrorKind) -> Option<&'a MirrorEntry> {
    let entry = settings.effective(kind)?;
    (!entry.id.eq_ignore_ascii_case(OFFICIAL_ID)).then_some(entry)
}

fn entry(id: &str, label: &str, url: &str, kind: MirrorKind, enabled: bool) -> MirrorEntry {
    MirrorEntry {
        id: id.to_owned(),
        label: label.to_owned(),
        url: url.to_owned(),
        kind,
        enabled,
    }
}

/// 内置镜像清单：默认启用国内镜像（github / npm / pip 的 active 都指向国内源）。
///
/// docker registry 是例外：国内 Docker Hub 镜像 2024 年起大多已停服，
/// 默认仍指向官方；国内条目保留并可一键切换，但引擎不会自动改写 daemon.json。
pub fn builtin_mirrors() -> MirrorsSettings {
    MirrorsSettings {
        github: MirrorGroup {
            active: "gh-proxy".to_owned(),
            items: vec![
                entry(OFFICIAL_ID, "官方 GitHub", "https://github.com", MirrorKind::Github, true),
                entry("gh-proxy", "gh-proxy.com", "https://gh-proxy.com/", MirrorKind::Github, true),
                entry("ghfast", "ghfast.top", "https://ghfast.top/", MirrorKind::Github, true),
                entry("gh-proxy-net", "gh-proxy.net", "https://gh-proxy.net/", MirrorKind::Github, true),
                entry("gitmirror", "hub.gitmirror.com", "https://hub.gitmirror.com/", MirrorKind::Github, true),
                entry("ghp-ci", "ghp.ci", "https://ghp.ci/", MirrorKind::Github, true),
            ],
        },
        npm: MirrorGroup {
            active: "npmmirror".to_owned(),
            items: vec![
                entry(OFFICIAL_ID, "官方 npmjs", "https://registry.npmjs.org/", MirrorKind::Npm, true),
                entry("npmmirror", "npmmirror（淘宝）", "https://registry.npmmirror.com/", MirrorKind::Npm, true),
                entry("huawei", "华为云", "https://repo.huaweicloud.com/repository/npm/", MirrorKind::Npm, true),
                entry("tencent", "腾讯云", "https://mirrors.cloud.tencent.com/npm/", MirrorKind::Npm, true),
                entry("ustc", "中科大", "https://npmreg.proxy.ustclug.org/", MirrorKind::Npm, true),
            ],
        },
        pip: MirrorGroup {
            active: "tsinghua".to_owned(),
            items: vec![
                entry(OFFICIAL_ID, "官方 PyPI", "https://pypi.org/simple/", MirrorKind::Pip, true),
                entry("tsinghua", "清华 TUNA", "https://pypi.tuna.tsinghua.edu.cn/simple/", MirrorKind::Pip, true),
                entry("aliyun", "阿里云", "https://mirrors.aliyun.com/pypi/simple/", MirrorKind::Pip, true),
                entry("tencent", "腾讯云", "https://mirrors.cloud.tencent.com/pypi/simple/", MirrorKind::Pip, true),
                entry("ustc", "中科大", "https://pypi.mirrors.ustc.edu.cn/simple/", MirrorKind::Pip, true),
            ],
        },
        docker: MirrorGroup {
            active: OFFICIAL_ID.to_owned(),
            items: vec![
                entry(OFFICIAL_ID, "官方 Docker Hub", "https://registry-1.docker.io", MirrorKind::Docker, true),
                entry("ustc", "中科大", "https://docker.mirrors.ustc.edu.cn", MirrorKind::Docker, true),
                entry("netease", "网易", "https://hub-mirror.c.163.com", MirrorKind::Docker, true),
                entry("aliyun", "阿里云（个人加速器）", "https://registry.cn-hangzhou.aliyuncs.com", MirrorKind::Docker, true),
            ],
        },
    }
}

/// 把任意（可能残缺/损坏）的 mirrors 值规范化成完整配置：内置为底，用户值覆盖。
pub fn normalize_mirrors(value: &Value) -> MirrorsSettings {
    let mut settings = builtin_mirrors();
    let Some(object) = value.as_object() else {
        return settings;
    };
    for kind in MirrorKind::ALL {
        let Some(raw) = object.get(kind.as_str()) else {
            continue;
        };
        apply_group_patch(settings.group_mut(kind), raw, kind);
    }
    settings
}

/// 应用一类镜像的 patch：{active?, items?, remove?, order?, replace?}。
fn apply_group_patch(group: &mut MirrorGroup, raw: &Value, kind: MirrorKind) {
    let Some(object) = raw.as_object() else {
        return;
    };
    if let Some(items) = object.get("items").and_then(Value::as_array) {
        for item in items {
            upsert_entry(group, item, kind);
        }
    }
    if let Some(remove) = object.get("remove").and_then(Value::as_array) {
        let removable = remove
            .iter()
            .filter_map(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .collect::<Vec<_>>();
        // 内置条目永远保留（想停用就 enabled=false）：内置清单是「可对照的基准」。
        let builtin = builtin_mirrors();
        let builtin_items = &builtin.group(kind).items;
        group.items.retain(|entry| {
            let builtin_entry = builtin_items
                .iter()
                .any(|candidate| candidate.id.eq_ignore_ascii_case(&entry.id));
            builtin_entry || !removable.contains(&entry.id.to_ascii_lowercase())
        });
    }
    // 整表回传（前端把当前清单整份 PUT 回来）：清单里没有的自定义条目删掉，
    // 内置条目保留（想停用只能 enabled=false），顺序以 items 数组为准。
    if object.get("replace").and_then(Value::as_bool).unwrap_or(false)
        && let Some(items) = object.get("items").and_then(Value::as_array)
    {
        let listed = entry_ids(items);
        let builtin = builtin_mirrors();
        let builtin_items = &builtin.group(kind).items;
        group.items.retain(|entry| {
            builtin_items
                .iter()
                .any(|candidate| candidate.id.eq_ignore_ascii_case(&entry.id))
                || listed.contains(&entry.id.to_ascii_lowercase())
        });
        reorder_by(group, &listed);
    }
    // 显式排序：ids 里先出现的排前面，没列到的按原相对顺序跟在后面。
    if let Some(order) = object.get("order").and_then(Value::as_array) {
        reorder_by(group, &entry_ids(order));
    }
    if let Some(active) = object.get("active").and_then(Value::as_str) {
        let active = active.trim();
        if !active.is_empty() {
            group.active = active.to_owned();
        }
    }
    sanitize_group(group, kind);
}

/// 取出规范化的小写 id 列表（顺序保留）：既认 ["id", ...]（order 的写法），
/// 也认 [{id, ...}]（items / replace 的写法）。
fn entry_ids(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| match value {
            Value::String(id) => Some(id.as_str()),
            other => other.get("id").and_then(Value::as_str),
        })
        .map(|id| id.trim().to_ascii_lowercase())
        .filter(|id| !id.is_empty())
        .collect()
}

/// 按给定 id 顺序重排（稳定排序：没列到的条目保持原来的相对位置，排在后面）。
fn reorder_by(group: &mut MirrorGroup, order: &[String]) {
    if order.is_empty() {
        return;
    }
    group.items.sort_by_key(|entry| {
        let key = entry.id.to_ascii_lowercase();
        order.iter().position(|id| *id == key).unwrap_or(usize::MAX)
    });
}

/// 条目 upsert：同 id 覆盖（label/url/enabled），新 id 追加。
fn upsert_entry(group: &mut MirrorGroup, raw: &Value, kind: MirrorKind) {
    let Some(object) = raw.as_object() else {
        return;
    };
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !valid_id(&id) {
        return;
    }
    let label = object
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate(value, MAX_LABEL_CHARS))
        .unwrap_or_else(|| id.clone());
    // url 只在提供时覆盖：前端只改 enabled / active 时不会把内置 URL 抹掉。
    let url = object
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| truncate(value, MAX_URL_CHARS));
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if let Some(existing) = group
        .items
        .iter_mut()
        .find(|entry| entry.id.eq_ignore_ascii_case(&id))
    {
        existing.label = label;
        existing.enabled = enabled;
        existing.kind = kind;
        if let Some(url) = url.filter(|value| !value.is_empty()) {
            existing.url = url;
        }
        return;
    }
    group.items.push(MirrorEntry {
        id,
        label,
        url: url.unwrap_or_default(),
        kind,
        enabled,
    });
}

/// 落实不变量：id 合法唯一、URL 是 http(s)、active 存在、条目数有上限。
fn sanitize_group(group: &mut MirrorGroup, kind: MirrorKind) {
    let builtin = builtin_mirrors();
    let default_active = builtin.group(kind).active.clone();
    let mut seen: Vec<String> = Vec::new();
    group.items.retain_mut(|entry| {
        entry.kind = kind;
        if !valid_id(&entry.id) || !valid_url(&entry.url) {
            return false;
        }
        let key = entry.id.to_ascii_lowercase();
        if seen.contains(&key) {
            return false;
        }
        seen.push(key);
        true
    });
    group.items.truncate(MAX_ITEMS_PER_KIND);
    let active = group.active.trim().to_owned();
    let known = group
        .items
        .iter()
        .any(|entry| entry.id.eq_ignore_ascii_case(&active));
    if !known {
        // active 指向不存在的条目（用户删了它 / 写错了）：回到内置默认，不留悬空指针。
        group.active = if group
            .items
            .iter()
            .any(|entry| entry.id.eq_ignore_ascii_case(&default_active))
        {
            default_active.clone()
        } else {
            group.items.first().map(|entry| entry.id.clone()).unwrap_or_default()
        };
    }
    if group.active.is_empty() {
        group.active = default_active;
    }
}

fn valid_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn valid_url(url: &str) -> bool {
    let url = url.trim();
    !url.is_empty()
        && url.chars().count() <= MAX_URL_CHARS
        && (url.starts_with("https://") || url.starts_with("http://"))
        && !url.chars().any(char::is_whitespace)
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

/// 索引 / registry 地址统一补尾斜杠：npmmirror 与 pip 的 simple 索引都按目录语义解析。
fn normalize_index_url(url: &str) -> String {
    let url = url.trim();
    if url.ends_with('/') {
        url.to_owned()
    } else {
        format!("{url}/")
    }
}

fn with_trailing_slash(url: &str) -> String {
    normalize_index_url(url)
}

/// 用 GitHub 前缀拼下载 URL：前缀为空或目标不是 github.com 时原样返回。
pub fn apply_github_prefix(prefix: Option<&str>, url: &str) -> String {
    let Some(prefix) = prefix.map(str::trim).filter(|value| !value.is_empty()) else {
        return url.to_owned();
    };
    if url.starts_with("https://github.com/") || url.starts_with("http://github.com/") {
        format!("{}{}", with_trailing_slash(prefix), url)
    } else {
        url.to_owned()
    }
}

/// 读取 settings.json 的 mirrors 块（缺失 / 损坏一律回落内置清单）。
///
/// 存下来的 items 数组顺序就是用户定的顺序：规范化从内置清单起算，自定义条目会被
/// 追加到末尾，所以这里再按存下来的顺序排一遍，读回来的顺序才和写下去的一致
/// （否则「上移一行」保存成功、刷新后又弹回原位）。
pub fn load_mirrors(home: &Path) -> MirrorsSettings {
    let Ok(bytes) = std::fs::read(home.join("config").join("settings.json")) else {
        return builtin_mirrors();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return builtin_mirrors();
    };
    let Some(stored) = value.get("mirrors") else {
        return builtin_mirrors();
    };
    let mut settings = normalize_mirrors(stored);
    if let Some(object) = stored.as_object() {
        for kind in MirrorKind::ALL {
            let Some(items) = object
                .get(kind.as_str())
                .and_then(|group| group.get("items"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            reorder_by(settings.group_mut(kind), &entry_ids(items));
        }
    }
    settings
}

/// 生效镜像对应的子进程环境变量（MCP stdio 进程、安装任务共用）。
pub fn mirror_env(home: &Path) -> BTreeMap<String, String> {
    load_mirrors(home).env()
}

/// 生效的 GitHub 前缀（供下载 URL 拼接）。
pub fn github_prefix(home: &Path) -> Option<String> {
    load_mirrors(home).github_prefix()
}

/// 把 mirrors 写回 settings.json 的根对象（保留其它字段）。
pub fn merge_into_settings(settings: &Value, mirrors: &MirrorsSettings) -> Value {
    let mut root: Map<String, Value> = settings.as_object().cloned().unwrap_or_default();
    root.insert("mirrors".to_owned(), mirrors.to_value());
    Value::Object(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_settings(home: &Path, value: &Value) {
        let dir = home.join("config");
        std::fs::create_dir_all(&dir).expect("create config dir");
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec_pretty(value).expect("serialize settings"),
        )
        .expect("write settings");
    }

    #[test]
    fn builtin_defaults_enable_domestic_mirrors() {
        let mirrors = builtin_mirrors();
        assert_eq!(mirrors.github.active, "gh-proxy");
        assert_eq!(mirrors.npm.active, "npmmirror");
        assert_eq!(mirrors.pip.active, "tsinghua");
        assert_eq!(mirrors.github_prefix().as_deref(), Some("https://gh-proxy.com/"));
        let env = mirrors.env();
        assert_eq!(
            env.get("npm_config_registry").map(String::as_str),
            Some("https://registry.npmmirror.com/")
        );
        assert_eq!(
            env.get("PIP_INDEX_URL").map(String::as_str),
            Some("https://pypi.tuna.tsinghua.edu.cn/simple/")
        );
        assert_eq!(env.get("UV_INDEX_URL"), env.get("PIP_INDEX_URL"));
        // 每类都有官方条目 + 至少一个国内条目。
        for kind in MirrorKind::ALL {
            let group = mirrors.group(kind);
            assert!(group.items.iter().any(|e| e.id == OFFICIAL_ID), "{kind:?}");
            assert!(group.items.len() >= 2, "{kind:?}");
            assert!(mirrors.effective(kind).is_some(), "{kind:?}");
        }
    }

    #[test]
    fn official_active_never_injects_anything() {
        let value = json!({
            "npm": {"active": "official"},
            "pip": {"active": "official"},
            "github": {"active": "official"},
        });
        let mirrors = normalize_mirrors(&value);
        assert!(mirrors.env().is_empty());
        assert_eq!(mirrors.github_prefix(), None);
    }

    #[test]
    fn disabled_active_entry_is_not_effective() {
        let value = json!({"npm": {"active": "npmmirror", "items": [{"id": "npmmirror", "enabled": false}]}});
        let mirrors = normalize_mirrors(&value);
        assert!(mirrors.effective(MirrorKind::Npm).is_none());
        // 只有 npm 被停用：pip 仍然注入（两类互相独立）。
        assert!(!mirrors.env().contains_key("npm_config_registry"));
        assert!(mirrors.env().contains_key("PIP_INDEX_URL"));
        // active 指针本身保留：开关来回切不会丢失用户的选择。
        assert_eq!(mirrors.npm.active, "npmmirror");
        assert_eq!(mirrors.npm.items.len(), 5);
    }

    #[test]
    fn unknown_active_falls_back_to_builtin_and_bad_entries_are_dropped() {
        let value = json!({
            "pip": {
                "active": "does-not-exist",
                "items": [
                    {"id": "broken", "url": "file:///etc/passwd"},
                    {"id": "custom", "label": "公司内网", "url": "https://pypi.example.com/simple"},
                    {"id": "custom", "label": "重复 id", "url": "https://dup.example.com"}
                ]
            }
        });
        let mirrors = normalize_mirrors(&value);
        assert_eq!(mirrors.pip.active, "tsinghua");
        assert!(mirrors.pip.items.iter().any(|e| e.id == "custom"));
        assert_eq!(
            mirrors
                .pip
                .items
                .iter()
                .filter(|e| e.id == "custom")
                .count(),
            1
        );
        assert!(!mirrors.pip.items.iter().any(|e| e.id == "broken"));
        // 同一批里重复 id 按 upsert 语义处理：后出现的覆盖先出现的（和 PUT patch 一致）。
        let custom = mirrors
            .pip
            .items
            .iter()
            .find(|e| e.id == "custom")
            .expect("custom entry");
        assert_eq!(custom.label, "重复 id");
        assert_eq!(custom.url, "https://dup.example.com");
    }

    #[test]
    fn github_prefix_is_applied_only_to_github_urls() {
        let prefix = Some("https://ghfast.top");
        assert_eq!(
            apply_github_prefix(prefix, "https://github.com/a/b/releases/download/v1/b.ps1"),
            "https://ghfast.top/https://github.com/a/b/releases/download/v1/b.ps1"
        );
        assert_eq!(
            apply_github_prefix(prefix, "https://raw.githubusercontent.com/a/b/main/c.json"),
            "https://raw.githubusercontent.com/a/b/main/c.json"
        );
        assert_eq!(apply_github_prefix(None, "https://github.com/a/b"), "https://github.com/a/b");
    }

    #[test]
    fn load_mirrors_survives_missing_and_corrupt_settings() {
        let home = tempfile::tempdir().expect("temporary home");
        assert_eq!(load_mirrors(home.path()).github.active, "gh-proxy");
        write_settings(home.path(), &json!({"capabilities": {"memory": false}}));
        let mirrors = load_mirrors(home.path());
        assert!(!mirrors.env().is_empty());
        // 写坏的 settings.json：回落内置清单，而不是报错或空配置。
        std::fs::write(home.path().join("config").join("settings.json"), b"{not json")
            .expect("write broken settings");
        assert_eq!(load_mirrors(home.path()).pip.active, "tsinghua");
    }

    /// 往返：写进 settings.json 的顺序，读回来必须一模一样（含自定义条目）。
    #[test]
    fn stored_item_order_survives_a_reload() {
        let home = tempfile::tempdir().expect("temporary home");
        let mut mirrors = builtin_mirrors();
        mirrors.npm.items.push(MirrorEntry {
            id: "corp".to_owned(),
            label: "公司内网".to_owned(),
            url: "https://npm.corp.example/".to_owned(),
            kind: MirrorKind::Npm,
            enabled: true,
        });
        mirrors.npm.active = "corp".to_owned();
        // 手动排序：自定义条目排在最前，官方排第二。
        let wanted = json!(["corp", "official"]);
        reorder_by(&mut mirrors.npm, &entry_ids(wanted.as_array().expect("array")));
        let ordered: Vec<String> = mirrors.npm.items.iter().map(|e| e.id.clone()).collect();
        assert_eq!(ordered[0], "corp");
        assert_eq!(ordered[1], "official");
        write_settings(home.path(), &merge_into_settings(&json!({}), &mirrors));

        let reloaded = load_mirrors(home.path());
        assert_eq!(
            reloaded.npm.items.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            ordered,
            "读回来的顺序必须和写下去的一致"
        );
        assert_eq!(reloaded.npm.active, "corp");
        assert_eq!(reloaded, mirrors);
    }

    #[test]
    fn merge_into_settings_keeps_other_fields() {
        let settings = json!({"global_memory": true, "capabilities": {"memory": false}});
        let merged = merge_into_settings(&settings, &builtin_mirrors());
        assert_eq!(merged["global_memory"], json!(true));
        assert_eq!(merged["capabilities"]["memory"], json!(false));
        assert_eq!(merged["mirrors"]["github"]["active"], json!("gh-proxy"));
        assert_eq!(merged["mirrors"]["github"]["items"][1]["type"], json!("github"));
    }

    #[test]
    fn round_trip_through_settings_json_is_stable() {
        let home = tempfile::tempdir().expect("temporary home");
        let mut mirrors = builtin_mirrors();
        mirrors.npm.active = "huawei".to_owned();
        mirrors.pip.items.push(entry(
            "corp",
            "公司内网",
            "https://pypi.corp.example/simple/",
            MirrorKind::Pip,
            true,
        ));
        mirrors.pip.active = "corp".to_owned();
        let settings = merge_into_settings(&json!({"global_memory": true}), &mirrors);
        write_settings(home.path(), &settings);
        let reloaded = load_mirrors(home.path());
        assert_eq!(reloaded, mirrors);
        assert_eq!(
            reloaded.env().get("npm_config_registry").map(String::as_str),
            Some("https://repo.huaweicloud.com/repository/npm/")
        );
        assert_eq!(
            reloaded.env().get("UV_INDEX_URL").map(String::as_str),
            Some("https://pypi.corp.example/simple/")
        );
    }
}
