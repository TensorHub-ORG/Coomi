//! 自定义安装位置：settings.json 的 paths 块。
//!
//! - GET  /api/settings/paths                 —— 读当前值 / 默认值 / 实际生效路径
//! - PUT  /api/settings/paths {mcpInstallDir?, workspaceRoot?}
//! - POST /api/settings/paths/migrate {kind,to} —— 复制 → 校验 → 原子切换 → 失败回滚
//!
//! 两类位置：
//! - mcpInstallDir：MCP 安装位置（市场装的 MCP server 用它当工作/安装目录）；
//! - workspaceRoot：会话隔离工作目录的根（workspaceRoot/session_id）。
//!
//! 迁移只做「复制 + 切指针」：原目录**永远保留**，切完由用户自己确认后删除，
//! 任何一步失败都不会留下半个新目录（回滚时把刚复制过去的目录删掉）。

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::web::ApiError;
use crate::web::AppState;

/// 复制时的目录层级上限：防手滑把整个盘当安装位置。
const MAX_COPY_DEPTH: usize = 24;
/// 复制时的文件数上限。
const MAX_COPY_FILES: usize = 200_000;
/// 迁移目标名（staging）前缀：与用户目录区分开。
const STAGING_PREFIX: &str = ".coomi-migrating";

/// settings.json → paths。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(in crate::web) struct PathSettings {
    /// MCP 安装位置；空串 = 用默认位置（{home}/mcp）。
    pub(in crate::web) mcp_install_dir: String,
    /// 会话工作目录根；空串 = 用默认位置（{home}/.coomi/workspaces）。
    pub(in crate::web) workspace_root: String,
}

/// 两类可迁移的位置。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::web) enum PathKind {
    McpInstallDir,
    WorkspaceRoot,
}

impl PathKind {
    const ALL: [Self; 2] = [Self::McpInstallDir, Self::WorkspaceRoot];

    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.eq_ignore_ascii_case("mcpInstallDir")
            || value.eq_ignore_ascii_case("mcp_install_dir")
            || value.eq_ignore_ascii_case("mcp")
        {
            return Some(Self::McpInstallDir);
        }
        if value.eq_ignore_ascii_case("workspaceRoot")
            || value.eq_ignore_ascii_case("workspace_root")
            || value.eq_ignore_ascii_case("workspace")
        {
            return Some(Self::WorkspaceRoot);
        }
        None
    }

    /// settings.json 里的键名（camelCase，与前端一致）。
    fn key(self) -> &'static str {
        match self {
            Self::McpInstallDir => "mcpInstallDir",
            Self::WorkspaceRoot => "workspaceRoot",
        }
    }

    /// 回执里的两种写法：camelCase 与 snake_case 都给（前端两种都认，缺一个就整块空着）。
    fn keys(self) -> [&'static str; 2] {
        match self {
            Self::McpInstallDir => ["mcpInstallDir", "mcp_install_dir"],
            Self::WorkspaceRoot => ["workspaceRoot", "workspace_root"],
        }
    }

    /// 前端还可能用的短别名（mcpDir / mcp_dir …），写配置时一并认下。
    fn aliases(self) -> [&'static str; 2] {
        match self {
            Self::McpInstallDir => ["mcpDir", "mcp_dir"],
            Self::WorkspaceRoot => ["sessionsRoot", "sessions_root"],
        }
    }

    /// 请求体里的键：两种写法 + 别名，按顺序取第一个出现的。
    fn body_keys(self) -> Vec<&'static str> {
        let mut keys = self.keys().to_vec();
        keys.extend(self.aliases());
        keys
    }

    fn label(self) -> &'static str {
        match self {
            Self::McpInstallDir => "MCP 安装位置",
            Self::WorkspaceRoot => "工作区根目录",
        }
    }

    /// 没配置时的默认位置。
    fn default_dir(self, home: &Path) -> PathBuf {
        match self {
            Self::McpInstallDir => home.join("mcp"),
            Self::WorkspaceRoot => home.join(".coomi").join("workspaces"),
        }
    }
}

/// 读取 settings.json → paths（缺失字段用空串 = 默认位置）。
pub(in crate::web) fn configured_paths(home: &Path) -> PathSettings {
    let settings = crate::web::read_settings(home);
    settings
        .get("paths")
        .cloned()
        .and_then(|value| serde_json::from_value::<PathSettings>(value).ok())
        .unwrap_or_default()
}

/// 某类位置的实际生效目录：配置过用配置值（展开 %VAR%），否则用默认值。
pub(in crate::web) fn resolved_path(home: &Path, kind: PathKind) -> PathBuf {
    let paths = configured_paths(home);
    let raw = match kind {
        PathKind::McpInstallDir => paths.mcp_install_dir,
        PathKind::WorkspaceRoot => paths.workspace_root,
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return kind.default_dir(home);
    }
    let expanded = PathBuf::from(expand_env_vars(raw));
    if expanded.is_absolute() {
        normalize_path(&expanded)
    } else {
        // 早期写坏的相对路径：不拿它当工作目录，退回默认位置。
        kind.default_dir(home)
    }
}

/// MCP 安装位置（市场安装 MCP 时用它当工作目录）。
pub(in crate::web) fn mcp_install_dir(home: &Path) -> PathBuf {
    resolved_path(home, PathKind::McpInstallDir)
}

/// 会话工作目录根。
pub(in crate::web) fn workspace_root(home: &Path) -> PathBuf {
    resolved_path(home, PathKind::WorkspaceRoot)
}

/// GET /api/settings/paths
pub(in crate::web) async fn paths_get(State(state): State<AppState>) -> Json<Value> {
    Json(paths_payload(&state.home))
}

/// PUT /api/settings/paths {mcpInstallDir?, workspaceRoot?, paths?}
///
/// 字段名 camelCase / snake_case（外加 mcpDir / mcp_dir 这类别名）都认，
/// 空字符串表示「恢复默认位置」；写入时会把目录建出来并**实写一个探针文件**校验可写，
/// 免得配置了一个永远用不了的路径。回执是归一化后的完整 payload。
pub(in crate::web) async fn paths_put(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let updates = requested_paths(&body)?;
    if updates.is_empty() {
        return Err(ApiError::bad_request(
            "body 里没有可写的位置：请给出 mcpInstallDir / workspaceRoot（snake_case 与 mcpDir 别名也认）；dataDir 是引擎数据目录，随 --home 启动参数固定，接口不可修改",
        ));
    }
    let mut paths = configured_paths(&state.home);
    let mut changed = Vec::new();
    for (kind, raw) in updates {
        let target = if raw.is_empty() {
            kind.default_dir(&state.home)
        } else {
            validate_target(&raw)?
        };
        // 目录不存在就建 + 探针实写：早失败好过「设置成功但永远用不了」。
        ensure_writable_dir(&target, kind)?;
        let stored = if raw.is_empty() {
            String::new()
        } else {
            target.display().to_string()
        };
        match kind {
            PathKind::McpInstallDir => paths.mcp_install_dir = stored,
            PathKind::WorkspaceRoot => paths.workspace_root = stored,
        }
        changed.push(kind.key());
    }
    persist_paths(&state.home, &paths, None)?;
    let mut payload = paths_payload(&state.home);
    payload["changed"] = json!(changed);
    payload["changed_keys"] = json!(changed);
    Ok(Json(payload))
}

/// 解析 PUT body 里要写的两类位置：camelCase / snake_case / mcpDir 别名都认，
/// 也接受嵌在 {"paths": {...}} 里。dataDir 只允许等于当前数据目录（它不给改）。
fn requested_paths(body: &Value) -> Result<Vec<(PathKind, String)>, ApiError> {
    // {"paths": {...}} 包裹写法：给了就必须是对象，写坏了当场报错而不是当没看见。
    let source = match body.get("paths") {
        Some(value) if value.is_object() => value,
        Some(_) => return Err(ApiError::bad_request("paths 必须是一个 JSON 对象")),
        None => body,
    };
    let object = source
        .as_object()
        .ok_or_else(|| ApiError::bad_request("paths 配置必须是一个 JSON 对象"))?;
    let mut updates = Vec::new();
    for kind in PathKind::ALL {
        for key in kind.body_keys() {
            let Some(value) = object.get(key) else {
                continue;
            };
            let raw = value
                .as_str()
                .ok_or_else(|| {
                    ApiError::bad_request(format!("paths.{key} 必须是字符串路径"))
                })?
                .trim()
                .to_owned();
            updates.push((kind, raw));
            break;
        }
    }
    Ok(updates)
}

/// 建目录 + 写探针：create_dir_all 成功不等于「能写」（只读盘 / 权限 / 被策略拦下），
/// 真写一个小文件再删掉，才算校验过可写。
fn ensure_writable_dir(target: &Path, kind: PathKind) -> Result<(), ApiError> {
    std::fs::create_dir_all(target).map_err(|error| {
        ApiError::bad_request(format!(
            "无法创建{} {}：{error}",
            kind.label(),
            target.display()
        ))
    })?;
    let probe = target.join(format!(".coomi-write-test-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&probe, b"coomi write probe").map_err(|error| {
        ApiError::bad_request(format!(
            "{} {} 不可写：{error}",
            kind.label(),
            target.display()
        ))
    })?;
    // 探针删不掉不影响结论（能写才是重点）。
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// POST /api/settings/paths/migrate
///
/// 两种写法都收：
/// - 单类：{kind, to}（to 是目标目录字符串）；
/// - 整体：{mcp_dir/mcpDir, workspace_root/workspaceRoot}（前端一次发两类，
///   也接受塞在 {"to": {...}} 里）——逐类迁移，目标与当前目录相同的类自动跳过。
///
/// 复制 → 校验 → 原子切换（rename）→ 写 settings.json；任何一步失败都会
/// 把刚复制出来的目录删掉，原目录与配置保持原样。
pub(in crate::web) async fn paths_migrate(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let targets = migrate_targets(&body)?;
    let single = targets.len() == 1 && body.get("kind").is_some();
    let mut results: Vec<Value> = Vec::new();
    let mut mcp_reloaded = false;
    for (kind, to) in targets {
        let from = resolved_path(&state.home, kind);
        if same_path(&from, &to) {
            // 整体写法里「没改的那一类」不该把整次迁移拖失败：跳过并说明。
            if single {
                return Err(ApiError::conflict(format!(
                    "目标与当前目录相同（{}），无需迁移",
                    from.display()
                )));
            }
            results.push(json!({
                "kind": kind.key(),
                "label": kind.label(),
                "from": from.display().to_string(),
                "to": to.display().to_string(),
                "skipped": true,
                "reason": "目标与当前目录相同，无需迁移",
            }));
            continue;
        }
        check_migration_pair(&from, &to)?;
        let copy_from = from.clone();
        let copy_to = to.clone();
        let outcome = tokio::task::spawn_blocking(move || migrate_directory(&copy_from, &copy_to))
            .await
            .map_err(|error| ApiError::internal(format!("migration task failed: {error}")))?
            .map_err(|error| {
                ApiError::internal(format!("迁移失败（已回滚，原目录未改动）：{error:#}"))
            })?;
        // 切指针：settings.json 写失败时把刚复制过去的目录删掉，等于没发生过。
        let mut paths = configured_paths(&state.home);
        match kind {
            PathKind::McpInstallDir => paths.mcp_install_dir = to.display().to_string(),
            PathKind::WorkspaceRoot => paths.workspace_root = to.display().to_string(),
        }
        let rollback = outcome.copied.then(|| to.clone());
        persist_paths(&state.home, &paths, rollback.as_deref())?;
        let reloaded = kind == PathKind::McpInstallDir;
        mcp_reloaded |= reloaded;
        results.push(json!({
            "kind": kind.key(),
            "label": kind.label(),
            "from": from.display().to_string(),
            "to": to.display().to_string(),
            "files": outcome.files,
            "bytes": outcome.bytes,
            "skipped_symlinks": outcome.skipped_symlinks,
            "verified": outcome.verified,
            "copied": outcome.copied,
            "skipped": false,
            "mcp_reloaded": reloaded,
        }));
    }
    // 安装位置变了：MCP 运行时按新目录重新加载（stdio 进程的 cwd 一起换）。
    if mcp_reloaded {
        state.mcp_runtime.reload(&state.home).await;
    }
    let payload = paths_payload(&state.home);
    let mut reply = json!({
        "ok": true,
        "results": results,
        "settings_updated": true,
        "source_kept": true,
        "mcp_reloaded": mcp_reloaded,
        "paths": payload,
    });
    // 单类写法保持老回执形状（老脚本读的是平铺字段）。
    if single
        && let Some(first) = reply
            .get("results")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned()
    {
        if let (Some(target), Some(source)) = (reply.as_object_mut(), first.as_object()) {
            target.insert("kind".to_owned(), source["kind"].clone());
            target.insert("label".to_owned(), source["label"].clone());
            target.insert("from".to_owned(), source["from"].clone());
            target.insert("to".to_owned(), source["to"].clone());
            for key in [
                "files",
                "bytes",
                "skipped_symlinks",
                "verified",
                "copied",
                "skipped",
                "mcp_reloaded",
            ] {
                if let Some(value) = source.get(key) {
                    target.insert(key.to_owned(), value.clone());
                }
            }
        }
    }
    Ok(Json(reply))
}

/// 解析迁移目标：老的 {kind,to} 单类写法，或前端的整体写法（两类一起逐类迁移）。
fn migrate_targets(body: &Value) -> Result<Vec<(PathKind, PathBuf)>, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("迁移请求必须是一个 JSON 对象"))?;
    // 单类：{kind, to}。to 必须是字符串（整体写法里的 to 是对象，因此不会误判）。
    if let Some(kind) = object
        .get("kind")
        .and_then(Value::as_str)
        .and_then(PathKind::parse)
    {
        let Some(raw) = object.get("to").and_then(Value::as_str) else {
            return Err(ApiError::bad_request(
                "单类迁移要给出 {kind, to}：to 是目标目录（字符串，绝对路径）",
            ));
        };
        return Ok(vec![(kind, validate_target(raw)?)]);
    }
    let source = object
        .get("paths")
        .filter(|value| value.is_object())
        .unwrap_or(body);
    let mut targets: Vec<(PathKind, PathBuf)> = Vec::new();
    for kind in PathKind::ALL {
        let mut found: Option<Value> = None;
        for key in kind.body_keys() {
            if let Some(value) = source.get(key) {
                found = Some(value.clone());
                break;
            }
        }
        if found.is_none() {
            // 前端还会把两类塞在 to / target 对象里。
            for holder in ["to", "target"] {
                let Some(map) = object.get(holder).and_then(Value::as_object) else {
                    continue;
                };
                for key in kind.body_keys() {
                    if let Some(value) = map.get(key) {
                        found = Some(value.clone());
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
        }
        let Some(value) = found else {
            continue;
        };
        let raw = value.as_str().ok_or_else(|| {
            ApiError::bad_request(format!("迁移目标 {} 必须是字符串路径", kind.key()))
        })?;
        targets.push((kind, validate_target(raw)?));
    }
    if targets.is_empty() {
        return Err(ApiError::bad_request(
            "body 里没有迁移目标：请给出 {kind,to} 或 mcp_dir / workspace_root",
        ));
    }
    Ok(targets)
}

/// 迁移结果。
#[derive(Clone, Debug, Default, Serialize)]
pub(in crate::web) struct MigrateOutcome {
    pub(in crate::web) files: usize,
    pub(in crate::web) bytes: u64,
    pub(in crate::web) skipped_symlinks: usize,
    pub(in crate::web) verified: bool,
    /// false = 源目录不存在或为空，只切了指针。
    pub(in crate::web) copied: bool,
}

/// 复制 → 校验 → 原子切换。任何一步失败都清掉临时目录，原目录不动。
pub(in crate::web) fn migrate_directory(from: &Path, to: &Path) -> anyhow::Result<MigrateOutcome> {
    if let Err(error) = check_migration_pair(from, to) {
        anyhow::bail!("迁移目标不合法：{}", error.message);
    }
    if !from.is_dir() {
        // 没有可搬的东西（例如首次使用）：只把目标目录建出来。
        std::fs::create_dir_all(to)?;
        return Ok(MigrateOutcome {
            verified: true,
            copied: false,
            ..MigrateOutcome::default()
        });
    }
    let before = scan_tree(from)?;
    if before.is_empty() {
        std::fs::create_dir_all(to)?;
        return Ok(MigrateOutcome {
            verified: true,
            copied: false,
            ..MigrateOutcome::default()
        });
    }
    if to.exists() {
        if !to.is_dir() {
            anyhow::bail!("目标 {} 已存在且不是目录", to.display());
        }
        if std::fs::read_dir(to)?.next().is_some() {
            anyhow::bail!(
                "目标 {} 已存在且非空：换一个位置，或先清空该目录（引擎不会覆盖已有内容）",
                to.display()
            );
        }
    }
    let parent = to
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("目标目录没有上级目录：{}", to.display()))?;
    std::fs::create_dir_all(&parent)?;
    let staging = parent.join(format!("{STAGING_PREFIX}-{}", uuid::Uuid::new_v4().simple()));
    let outcome = (|| -> anyhow::Result<MigrateOutcome> {
        let (files, bytes, skipped_symlinks) = copy_tree(from, &staging)?;
        // 校验：源与副本的相对路径集合 + 字节数必须完全一致，否则不切。
        let after = scan_tree(&staging)?;
        if after != before {
            let mut missing = before
                .keys()
                .filter(|path| !after.contains_key(*path))
                .take(5)
                .cloned()
                .collect::<Vec<_>>();
            if missing.is_empty() {
                missing.push("(无缺失，存在多余文件)".to_owned());
            }
            anyhow::bail!(
                "复制校验不通过（源 {} 个文件 / 副本 {} 个文件，差异示例：{:?}）",
                before.len(),
                after.len(),
                missing
            );
        }
        // 原子切换：同盘 rename。目标为空目录时先摘掉它，让 rename 占位。
        if to.exists() {
            std::fs::remove_dir(to)?;
        }
        std::fs::rename(&staging, to)?;
        Ok(MigrateOutcome {
            files,
            bytes,
            skipped_symlinks,
            verified: true,
            copied: true,
        })
    })();
    if outcome.is_err() {
        // 回滚：临时目录清掉，源目录与 settings.json 都没被动过。
        let _ = remove_dir_all(&staging);
    }
    outcome
}

/// 迁移前后的自检：目标不能等于/位于源内部，也不能是源的上级。
fn check_migration_pair(from: &Path, to: &Path) -> Result<(), ApiError> {
    let from = normalize_path(from);
    let to = normalize_path(to);
    if same_path(&from, &to) {
        return Err(ApiError::conflict(format!(
            "目标与当前目录相同（{}），无需迁移",
            from.display()
        )));
    }
    if is_inside(&from, &to) {
        return Err(ApiError::bad_request(format!(
            "目标目录不能位于源目录内部（{} 在 {} 里），否则会自我复制",
            to.display(),
            from.display()
        )));
    }
    if is_inside(&to, &from) {
        return Err(ApiError::bad_request(format!(
            "目标目录不能是源目录的上级（{} 在 {} 里）",
            from.display(),
            to.display()
        )));
    }
    Ok(())
}

/// 写入 settings.json → paths；rollback 非空时写失败要把该目录删掉（回滚复制）。
fn persist_paths(home: &Path, paths: &PathSettings, rollback: Option<&Path>) -> Result<(), ApiError> {
    let settings = crate::web::read_settings(home);
    let mut root = settings.as_object().cloned().unwrap_or_default();
    root.insert(
        "paths".to_owned(),
        serde_json::to_value(paths)
            .map_err(|error| ApiError::internal(format!("failed to serialize paths: {error}")))?,
    );
    let result = crate::web::write_settings(home, &Value::Object(root));
    if result.is_err()
        && let Some(directory) = rollback
    {
        // 回滚：settings.json 没写成功，刚复制出来的目录不该留在盘上。
        let _ = remove_dir_all(directory);
    }
    result
}

/// GET/PUT 的响应体：生效路径 + 默认值 + 配置值，字段名 camelCase / snake_case 都给。
///
/// 顶层直接给 mcpInstallDir / workspaceRoot / dataDir 与同名 snake 写法，
/// 另外给 paths / resolved / configured / defaults / exists / kinds 六张表。
/// 注意 paths 里放的是**生效值**（没配置时就是默认位置），不是空串——
/// 老实现把 settings 原样回传，空配置下前端只能看到一片空白。
fn paths_payload(home: &Path) -> Value {
    let stored = configured_paths(home);
    let mut resolved = serde_json::Map::new();
    let mut defaults = serde_json::Map::new();
    let mut exists = serde_json::Map::new();
    let mut configured = serde_json::Map::new();
    for kind in PathKind::ALL {
        let path = resolved_path(home, kind);
        let raw = match kind {
            PathKind::McpInstallDir => stored.mcp_install_dir.clone(),
            PathKind::WorkspaceRoot => stored.workspace_root.clone(),
        };
        for key in kind.keys() {
            resolved.insert(key.to_owned(), json!(path.display().to_string()));
            defaults.insert(
                key.to_owned(),
                json!(kind.default_dir(home).display().to_string()),
            );
            exists.insert(key.to_owned(), json!(path.is_dir()));
            configured.insert(key.to_owned(), json!(raw));
        }
    }
    // 引擎数据目录（--home）：settings / 记忆 / 日志都在这儿，只能随启动参数改，这里只报出来。
    let data_dir = home.display().to_string();
    for key in ["dataDir", "data_dir"] {
        resolved.insert(key.to_owned(), json!(data_dir));
        defaults.insert(key.to_owned(), json!(data_dir));
        exists.insert(key.to_owned(), json!(home.is_dir()));
        configured.insert(key.to_owned(), json!(data_dir));
    }
    let mut kinds = serde_json::Map::new();
    for (name, key, writable) in [
        ("mcp", "mcpInstallDir", true),
        ("workspace", "workspaceRoot", true),
        ("data", "dataDir", false),
    ] {
        kinds.insert(
            name.to_owned(),
            json!({
                "key": key,
                "active": resolved.get(key).cloned().unwrap_or(Value::Null),
                "default": defaults.get(key).cloned().unwrap_or(Value::Null),
                "configured": configured.get(key).cloned().unwrap_or(Value::Null),
                "exists": exists.get(key).cloned().unwrap_or(Value::Null),
                "writable": writable,
            }),
        );
    }
    let field = |key: &str| resolved.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "mcpInstallDir": field("mcpInstallDir"),
        "mcp_install_dir": field("mcp_install_dir"),
        "workspaceRoot": field("workspaceRoot"),
        "workspace_root": field("workspace_root"),
        "dataDir": field("dataDir"),
        "data_dir": field("data_dir"),
        "paths": Value::Object(resolved.clone()),
        "resolved": Value::Object(resolved),
        "configured": Value::Object(configured),
        "defaults": Value::Object(defaults),
        "exists": Value::Object(exists),
        "kinds": Value::Object(kinds),
        "settings_path": crate::web::settings_path_display(home),
        "note": "空字符串 = 用默认位置；dataDir 是引擎数据目录（--home），不可改；migrate 会复制 → 校验 → 原子切换，失败自动回滚，原目录始终保留。",
    })
}

/// 校验用户给出的目标路径：展开 %VAR%、必须是绝对路径。
fn validate_target(raw: &str) -> Result<PathBuf, ApiError> {
    let expanded = expand_env_vars(raw.trim());
    if expanded.is_empty() {
        return Err(ApiError::bad_request("路径不能为空"));
    }
    let path = PathBuf::from(&expanded);
    if !path.is_absolute() {
        return Err(ApiError::bad_request(format!(
            "路径必须是绝对路径（例如 D:/Coomi/mcp）：{expanded}"
        )));
    }
    Ok(normalize_path(&path))
}

/// 展开 %VAR%（Windows 习惯写法）；未定义的变量保持原样。
fn expand_env_vars(template: &str) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            result.push_str(&rest[start..]);
            return result.trim().to_owned();
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(value) => result.push_str(&value),
            Err(_) => {
                result.push('%');
                result.push_str(name);
                result.push('%');
            }
        }
        rest = &after[end + 1..];
    }
    result.push_str(rest);
    result.trim().to_owned()
}

/// 词法规范化：消掉 . / .. （不碰文件系统，路径不存在也能比较）。
fn normalize_path(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !output.pop() {
                    output.push("..");
                }
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

/// 是否 inner 位于 outer 内部（Windows 上大小写不敏感）。
fn is_inside(outer: &Path, inner: &Path) -> bool {
    let outer = path_key(outer);
    let inner = path_key(inner);
    inner.len() > outer.len() && inner.starts_with(&outer)
}

fn path_key(path: &Path) -> String {
    let text = normalize_path(path).display().to_string();
    let trimmed = text.trim_end_matches(|ch| ch == '\\' || ch == '/');
    if cfg!(windows) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_owned()
    }
}

fn remove_dir_all(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        Ok(())
    }
}

/// 递归扫描目录：相对路径 → 字节数（不跟随软链，跳过非普通文件）。
fn scan_tree(root: &Path) -> anyhow::Result<BTreeMap<String, u64>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_COPY_DEPTH {
            anyhow::bail!(
                "目录层级超过 {MAX_COPY_DEPTH} 层，拒绝迁移：{}",
                directory.display()
            );
        }
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                pending.push((entry.path(), depth + 1));
                continue;
            }
            if meta.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map(|path| path.display().to_string())
                    .unwrap_or_default();
                files.insert(relative, meta.len());
                if files.len() > MAX_COPY_FILES {
                    anyhow::bail!("文件数超过 {MAX_COPY_FILES}，请手动复制");
                }
            }
        }
    }
    Ok(files)
}

/// 递归复制目录内容（不跟随软链；软链只计数并跳过）。
fn copy_tree(from: &Path, to: &Path) -> anyhow::Result<(usize, u64, usize)> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut skipped_symlinks = 0usize;
    let mut pending = vec![(from.to_path_buf(), to.to_path_buf(), 0usize)];
    while let Some((source, destination, depth)) = pending.pop() {
        if depth > MAX_COPY_DEPTH {
            anyhow::bail!("目录层级超过 {MAX_COPY_DEPTH} 层，拒绝迁移：{}", source.display());
        }
        std::fs::create_dir_all(&destination)?;
        for entry in std::fs::read_dir(&source)? {
            let entry = entry?;
            let meta = std::fs::symlink_metadata(entry.path())?;
            let target = destination.join(entry.file_name());
            if meta.file_type().is_symlink() {
                skipped_symlinks += 1;
                continue;
            }
            if meta.is_dir() {
                pending.push((entry.path(), target, depth + 1));
                continue;
            }
            if meta.is_file() {
                std::fs::copy(entry.path(), &target)?;
                files += 1;
                bytes += meta.len();
                if files > MAX_COPY_FILES {
                    anyhow::bail!("文件数超过 {MAX_COPY_FILES}，请手动复制");
                }
            }
        }
    }
    Ok((files, bytes, skipped_symlinks))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, content).expect("write file");
    }

    fn seed_source(root: &Path) {
        write_file(&root.join("a.txt"), "hello");
        write_file(&root.join("nested/b.txt"), "world!");
        write_file(&root.join("nested/deep/c.bin"), "0123456789");
    }

    fn staging_leftovers(root: &Path) -> usize {
        std::fs::read_dir(root)
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(STAGING_PREFIX)
            })
            .count()
    }

    #[test]
    fn defaults_are_used_until_settings_override_them() {
        let home = tempfile::tempdir().expect("temporary home");
        assert_eq!(
            resolved_path(home.path(), PathKind::McpInstallDir),
            home.path().join("mcp")
        );
        assert_eq!(
            resolved_path(home.path(), PathKind::WorkspaceRoot),
            home.path().join(".coomi").join("workspaces")
        );
        let mut settings = crate::web::read_settings(home.path());
        settings["paths"] = json!({"mcpInstallDir": "D:\\Coomi\\mcp"});
        crate::web::write_settings(home.path(), &settings).expect("write settings");
        assert_eq!(
            resolved_path(home.path(), PathKind::McpInstallDir)
                .display()
                .to_string(),
            "D:\\Coomi\\mcp"
        );
        // 没配置的那一类照旧用默认值。
        assert_eq!(
            resolved_path(home.path(), PathKind::WorkspaceRoot),
            home.path().join(".coomi").join("workspaces")
        );
        // 空串 = 恢复默认位置。
        let mut settings = crate::web::read_settings(home.path());
        settings["paths"] = json!({"mcpInstallDir": ""});
        crate::web::write_settings(home.path(), &settings).expect("write settings");
        assert_eq!(
            resolved_path(home.path(), PathKind::McpInstallDir),
            home.path().join("mcp")
        );
    }

    #[test]
    fn environment_variables_are_expanded_and_relative_paths_rejected() {
        let home = tempfile::tempdir().expect("temporary home");
        let temp = std::env::var("TEMP").unwrap_or_default();
        if !temp.is_empty() {
            assert_eq!(
                expand_env_vars("%TEMP%\\\\coomi-mcp"),
                format!("{temp}\\\\coomi-mcp")
            );
        }
        // 未知变量原样保留，不 panic。
        assert_eq!(
            expand_env_vars("%NOT_A_REAL_VAR%\\\\x"),
            "%NOT_A_REAL_VAR%\\\\x"
        );
        assert!(validate_target("relative/path").is_err());
        assert!(validate_target("   ").is_err());
        assert!(validate_target(&home.path().display().to_string()).is_ok());
    }

    #[test]
    fn migration_copies_verifies_and_switches_atomically() {
        let root = tempfile::tempdir().expect("temporary root");
        let from = root.path().join("from");
        let to = root.path().join("to");
        seed_source(&from);
        let outcome = migrate_directory(&from, &to).expect("migrate");
        assert!(outcome.verified);
        assert!(outcome.copied);
        assert_eq!(outcome.files, 3);
        assert_eq!(outcome.bytes, 5 + 6 + 10);
        assert_eq!(
            std::fs::read_to_string(to.join("a.txt")).expect("a"),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(to.join("nested").join("deep").join("c.bin")).expect("c"),
            "0123456789"
        );
        // 源目录原样保留（迁移 = 复制 + 切指针，不删数据）。
        assert_eq!(
            std::fs::read_to_string(from.join("a.txt")).expect("a"),
            "hello"
        );
        // 不留临时目录。
        assert_eq!(staging_leftovers(root.path()), 0);
    }

    #[test]
    fn migration_refuses_non_empty_target_and_keeps_the_source() {
        let root = tempfile::tempdir().expect("temporary root");
        let from = root.path().join("from");
        let to = root.path().join("to");
        seed_source(&from);
        write_file(&to.join("existing.txt"), "keep me");
        let error = migrate_directory(&from, &to).expect_err("non-empty target");
        assert!(format!("{error:#}").contains("已存在且非空"), "{error:#}");
        assert_eq!(
            std::fs::read_to_string(to.join("existing.txt")).expect("keep"),
            "keep me"
        );
        assert_eq!(
            std::fs::read_to_string(from.join("a.txt")).expect("a"),
            "hello"
        );
        assert_eq!(staging_leftovers(root.path()), 0);
    }

    #[test]
    fn migration_with_empty_or_missing_source_only_switches() {
        let root = tempfile::tempdir().expect("temporary root");
        let from = root.path().join("from");
        let to = root.path().join("to");
        // 源目录还不存在（首次使用）：只建目标目录，不复制。
        let outcome = migrate_directory(&from, &to).expect("migrate missing source");
        assert!(!outcome.copied);
        assert!(outcome.verified);
        assert!(to.is_dir());
        // 空源目录同理；目标为空目录时也能顺利占位。
        std::fs::create_dir_all(&from).expect("create empty source");
        let outcome = migrate_directory(&from, &to).expect("migrate empty source");
        assert!(!outcome.copied);
        assert!(outcome.verified);
        assert_eq!(staging_leftovers(root.path()), 0);
    }

    #[test]
    fn migration_pair_guards_reject_self_and_nested_targets() {
        let root = tempfile::tempdir().expect("temporary root");
        let from = root.path().join("from");
        assert!(check_migration_pair(&from, &from).is_err());
        assert!(check_migration_pair(&from, &from.join("inner")).is_err());
        assert!(check_migration_pair(&from.join("inner"), &from).is_err());
        assert!(check_migration_pair(&from, &root.path().join("sibling")).is_ok());
        // 迁移函数本身也要拦住非法目标，而不是先复制再报错。
        assert!(migrate_directory(&from, &from.join("inner")).is_err());
    }

    #[test]
    fn failed_settings_write_rolls_the_copied_directory_back() {
        let home = tempfile::tempdir().expect("temporary home");
        let copied = home.path().join("copied");
        write_file(&copied.join("a.txt"), "data");
        // settings.json 位置放一个目录：写入必然失败，触发回滚。
        std::fs::create_dir_all(home.path().join("config").join("settings.json"))
            .expect("create blocking dir");
        let paths = PathSettings {
            mcp_install_dir: copied.display().to_string(),
            workspace_root: String::new(),
        };
        let error = persist_paths(home.path(), &paths, Some(&copied)).expect_err("write must fail");
        assert!(!format!("{error:?}").is_empty());
        assert!(!copied.exists(), "回滚必须删掉刚复制过去的目录");
    }

    /// 契约：回执里 camelCase 与 snake_case 两套字段都给全（前端两种都认）。
    #[test]
    fn payload_exposes_both_naming_styles() {
        let home = tempfile::tempdir().expect("temporary home");
        let mcp = home.path().join("mcp");
        let root = home.path().join(".coomi").join("workspaces");
        let payload = paths_payload(home.path());
        assert_eq!(payload["mcpInstallDir"], json!(mcp.display().to_string()));
        assert_eq!(payload["mcp_install_dir"], json!(mcp.display().to_string()));
        assert_eq!(payload["workspaceRoot"], json!(root.display().to_string()));
        assert_eq!(payload["workspace_root"], json!(root.display().to_string()));
        assert_eq!(payload["dataDir"], json!(home.path().display().to_string()));
        assert_eq!(payload["data_dir"], json!(home.path().display().to_string()));
        for key in [
            "mcpInstallDir",
            "mcp_install_dir",
            "workspaceRoot",
            "workspace_root",
            "dataDir",
            "data_dir",
        ] {
            assert!(!payload["defaults"][key].is_null(), "defaults.{key} 缺失");
            assert!(!payload["resolved"][key].is_null(), "resolved.{key} 缺失");
            assert!(!payload["paths"][key].is_null(), "paths.{key} 缺失");
            assert!(payload["exists"][key].is_boolean(), "exists.{key} 缺失");
            assert!(
                !payload["configured"][key].is_null(),
                "configured.{key} 缺失"
            );
        }
        for kind in ["mcp", "workspace", "data"] {
            assert!(payload["kinds"][kind]["key"].is_string(), "kinds.{kind}.key");
            assert!(
                !payload["kinds"][kind]["active"].is_null(),
                "kinds.{kind}.active"
            );
            assert!(
                payload["kinds"][kind]["writable"].is_boolean(),
                "kinds.{kind}.writable"
            );
        }
        assert_eq!(payload["kinds"]["data"]["writable"], json!(false));
        assert!(payload["settings_path"].is_string());
        // 配置过就回配置值，但 paths / resolved 一律是**生效值**（老实现只回空串，前端整块空着）。
        let mut settings = crate::web::read_settings(home.path());
        settings["paths"] = json!({"mcpInstallDir": mcp.display().to_string()});
        crate::web::write_settings(home.path(), &settings).expect("write settings");
        let payload = paths_payload(home.path());
        assert_eq!(payload["mcpInstallDir"], json!(mcp.display().to_string()));
        assert_eq!(payload["mcp_install_dir"], json!(mcp.display().to_string()));
        assert_eq!(payload["paths"]["mcpInstallDir"], json!(mcp.display().to_string()));
        assert_eq!(payload["configured"]["mcp_install_dir"], json!(mcp.display().to_string()));
    }

    /// PUT：snake_case / camelCase / 别名都认，dataDir 忽略，认不出就报错。
    #[test]
    fn put_body_accepts_snake_camel_and_aliases() {
        let home = tempfile::tempdir().expect("temporary home");
        let mcp = home.path().join("mcp-dir").display().to_string();
        let ws = home.path().join("ws-dir").display().to_string();
        let body = json!({"mcp_dir": mcp, "workspaceRoot": ws});
        let updates = requested_paths(&body).expect("snake + camel");
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].0, PathKind::McpInstallDir);
        assert_eq!(updates[0].1, mcp);
        assert_eq!(updates[1].0, PathKind::WorkspaceRoot);
        assert_eq!(updates[1].1, ws);

        // 嵌在 paths 里 + mcpDir 别名。
        let nested = requested_paths(&json!({"paths": {"mcpDir": mcp}})).expect("nested alias");
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].0, PathKind::McpInstallDir);
        // 空串 = 恢复默认位置。
        let empty = requested_paths(&json!({"mcpInstallDir": "  "})).expect("empty means default");
        assert_eq!(empty[0].1, "");
        // dataDir 不给改：整份 GET 回执原样 PUT 回来也不会报错，只是不动它。
        assert!(
            requested_paths(&json!({"dataDir": "D:/whatever", "mcpInstallDir": mcp}))
                .expect("dataDir ignored")
                .len()
                == 1
        );
        // 写不动的输入要当场拦下。
        assert!(requested_paths(&json!({"mcpInstallDir": 3})).is_err());
        assert!(requested_paths(&json!({"paths": 3})).is_err());
    }

    /// migrate：老的单类写法与前端的两类写法都能解析出目标。
    #[test]
    fn migrate_targets_accept_both_shapes() {
        let home = tempfile::tempdir().expect("temporary home");
        let mcp = home.path().join("mcp").display().to_string();
        let ws = home.path().join("ws").display().to_string();
        let single =
            migrate_targets(&json!({"kind": "mcpInstallDir", "to": mcp})).expect("single kind");
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].0, PathKind::McpInstallDir);

        let both = migrate_targets(&json!({
            "mcp_dir": mcp,
            "mcpDir": mcp,
            "workspace_root": ws,
            "workspaceRoot": ws,
            "from": {"mcp_dir": "", "workspace_root": ""},
            "to": {"mcp_dir": mcp, "workspace_root": ws}
        }))
        .expect("both kinds");
        assert_eq!(both.len(), 2);
        assert_eq!(both[1].0, PathKind::WorkspaceRoot);

        // 只给 to 对象也认（前端把两类塞在 to 里）。
        let nested = migrate_targets(&json!({"to": {"workspaceRoot": ws}})).expect("nested to");
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].0, PathKind::WorkspaceRoot);

        assert!(migrate_targets(&json!({"kind": "mcpInstallDir"})).is_err());
        assert!(migrate_targets(&json!({})).is_err());
        assert!(migrate_targets(&json!({"mcpDir": "relative/path"})).is_err());
        assert!(migrate_targets(&json!({"mcpDir": 3})).is_err());
    }

    /// 可写校验：目录会建出来，探针不留在盘上，被文件占位时报错。
    #[test]
    fn writable_probe_creates_the_directory_and_reports_failures() {
        let home = tempfile::tempdir().expect("temporary home");
        let target = home.path().join("fresh").join("nested");
        ensure_writable_dir(&target, PathKind::McpInstallDir).expect("creatable");
        assert!(target.is_dir());
        assert_eq!(
            std::fs::read_dir(&target).expect("read target").count(),
            0,
            "探针文件必须删掉"
        );
        // 目标位置被一个同名文件占着：必须报错，而不是静默成功。
        let blocked = home.path().join("blocked");
        write_file(&blocked, "not a dir");
        let error = ensure_writable_dir(&blocked, PathKind::WorkspaceRoot)
            .expect_err("a file in the way must fail");
        assert!(!format!("{error:?}").is_empty());
    }
}



