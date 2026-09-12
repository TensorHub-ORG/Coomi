//! 远程仓库与运维辅助引擎：网络诊断、存储分析、诊断包导出、宿主工具探测与凭据存储。
//!
//! 设计约定（与 `git_engine::GitEngine` 保持一致）：
//! - home / workspace 双路径由调用方注入；所有磁盘写入均落在 home 下
//!   （`diagnostics/`、`coomi-credentials.json`）。
//! - 网络探测与命令执行全部带超时（5 秒），单点失败不中断整体流程，绝不 panic。
//! - 凭据仅做文件级本地存储（0600 + 临时文件原子替换）；Android Keystore 属宿主层。
//! - 对外暴露的类型全部可序列化为 JSON（serde），供 web.rs 在 Wave 3 接线成 REST API。

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// 网络诊断固定端点列表。
const DIAGNOSTIC_ENDPOINTS: &[&str] = &[
    "https://github.com",
    "https://gitee.com",
    "https://api.github.com",
    "https://registry.npmjs.org",
];

/// 网络请求与命令执行的统一超时。
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 存储分析的文件数上限，超过即提前截断并标注 truncated。
const MAX_SCAN_FILES: usize = 20_000;

/// 大文件排行数量。
const TOP_LARGEST: usize = 15;

const CREDENTIALS_FILE: &str = "coomi-credentials.json";

/// 需要探测的常见 CLI 工具。
const GUEST_TOOLS: &[&str] = &[
    "git", "node", "npm", "python3", "pip3", "cargo", "rustc", "go", "java", "ffmpeg", "docker",
    "adb",
];

// ---------------------------------------------------------------------------
// 公开数据类型（全部可直接序列化为 JSON 返回给前端）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NetworkReport {
    /// 已设置的代理环境变量（NAME=value，仅收录非空项）。
    pub proxy_env: Vec<String>,
    pub endpoints: Vec<EndpointProbe>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EndpointProbe {
    pub host: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageReport {
    pub workspace_bytes: u64,
    pub git_dir_bytes: u64,
    pub home_bytes: u64,
    pub largest: Vec<FileSize>,
    pub categories: Vec<CategorySize>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileSize {
    pub path: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CategorySize {
    pub category: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GuestTool {
    pub name: String,
    pub version: Option<String>,
    pub available: bool,
}

// ---------------------------------------------------------------------------
// OpsEngine：网络诊断 / 存储分析 / 诊断包 / 宿主工具探测
// ---------------------------------------------------------------------------

pub struct OpsEngine {
    home: PathBuf,
    workspace: PathBuf,
    http: reqwest::Client,
}

impl OpsEngine {
    pub fn new(home: PathBuf, workspace: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .connect_timeout(PROBE_TIMEOUT)
            .user_agent("coomi-diagnostics/2.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { home, workspace, http }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    // -- 网络诊断 ----------------------------------------------------------

    /// 探测代理环境变量，并对固定端点列表逐个 GET（5 秒超时）；
    /// 单点失败不中断，整体不 panic。
    pub async fn network_diagnostics(&self) -> NetworkReport {
        let proxy_env = detect_proxy_env();
        let endpoints = futures_util::future::join_all(
            DIAGNOSTIC_ENDPOINTS.iter().map(|url| self.probe_endpoint(url)),
        )
        .await;
        NetworkReport { proxy_env, endpoints }
    }

    async fn probe_endpoint(&self, url: &str) -> EndpointProbe {
        let host = reqwest::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| url.to_owned());
        let started = Instant::now();
        let response = match self.http.get(url).send().await {
            Ok(response) => response,
            Err(error) => {
                let latency_ms = started.elapsed().as_millis() as u64;
                return EndpointProbe {
                    host,
                    ok: false,
                    latency_ms: Some(latency_ms),
                    error: Some(truncate_chars(&error.to_string(), 160)),
                };
            }
        };
        let latency_ms = started.elapsed().as_millis() as u64;
        let status = response.status();
        let ok = status.is_success();
        let error = if ok { None } else { Some(format!("HTTP {}", status)) };
        EndpointProbe { host, ok, latency_ms: Some(latency_ms), error }
    }

    // -- 存储分析 ----------------------------------------------------------

    /// 统计 workspace / home 大小、.git 目录大小、top 15 大文件与类别分组；
    /// 超过 `MAX_SCAN_FILES` 个文件时提前截断并标注 truncated。
    pub async fn storage_analysis(&self) -> StorageReport {
        let home_bytes = dir_size(&self.home);
        let mut report = StorageReport {
            workspace_bytes: 0,
            git_dir_bytes: 0,
            home_bytes,
            largest: Vec::new(),
            categories: vec![
                CategorySize { category: "node_modules".to_owned(), bytes: 0 },
                CategorySize { category: "target".to_owned(), bytes: 0 },
                CategorySize { category: ".git".to_owned(), bytes: 0 },
                CategorySize { category: "other".to_owned(), bytes: 0 },
            ],
            truncated: false,
        };
        if self.workspace.is_dir() {
            let mut scanner = Scanner::default();
            scan_dir(&self.workspace, &self.workspace, &mut scanner);
            report.workspace_bytes = scanner.workspace_bytes;
            report.git_dir_bytes = scanner.git_dir_bytes;
            report.truncated = scanner.truncated;
            report.largest = {
                let mut largest = scanner.largest;
                largest.sort_by(|a, b| b.bytes.cmp(&a.bytes));
                largest.truncate(TOP_LARGEST);
                largest
            };
            for category in &mut report.categories {
                if let Some(bytes) = scanner.category_bytes.get(category.category.as_str()) {
                    category.bytes = *bytes;
                }
            }
        }
        report
    }

    // -- 诊断包 ------------------------------------------------------------

    /// 收集 home/*.log 与 home/logs/ 下所有文件，连同运行环境摘要打成
    /// tar.gz 到 home/diagnostics/coomi-diagnose-<unix秒>.tar.gz；
    /// 无日志文件时也出包（仅含摘要）。
    pub async fn log_bundle(&self) -> Result<PathBuf> {
        let diag_dir = self.home.join("diagnostics");
        std::fs::create_dir_all(&diag_dir)
            .with_context(|| format!("failed to create {}", diag_dir.display()))?;
        let dest = diag_dir.join(format!("coomi-diagnose-{}.tar.gz", now_secs()));

        // 1. 收集日志文件。
        let mut logs: Vec<(PathBuf, String)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.home) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path.extension().and_then(|ext| ext.to_str()) == Some("log")
                {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let archive_name = format!("logs/{name}");
                        logs.push((path, archive_name));
                    }
                }
            }
        }
        let logs_dir = self.home.join("logs");
        if logs_dir.is_dir() {
            collect_dir_files(&logs_dir, &logs_dir, &mut logs);
        }

        // 2. 运行环境摘要（git 版本、os 信息、home/workspace 路径、当前时间）。
        let summary = env_summary(&self.home, &self.workspace).await;

        // 3. 打包。
        let file = std::fs::File::create(&dest)
            .with_context(|| format!("failed to create {}", dest.display()))?;
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        append_entry(&mut tar, "environment.txt", summary.as_bytes())?;
        for (path, name) in &logs {
            let Ok(bytes) = std::fs::read(path) else { continue };
            append_entry(&mut tar, name, &bytes)?;
        }
        // into_inner 会补写 tar 结束块；再 finish 掉 gzip 流。
        let encoder = tar.into_inner()?;
        encoder.finish()?;
        Ok(dest)
    }

    // -- 宿主工具探测 ------------------------------------------------------

    /// 探测常见 CLI 工具可用性与版本（`<name> --version`，5 秒超时，
    /// 输出首行截断 80 字符）。
    pub async fn guest_tools(&self) -> Vec<GuestTool> {
        futures_util::future::join_all(GUEST_TOOLS.iter().map(|name| probe_tool(name))).await
    }
}

// ---------------------------------------------------------------------------
// 网络诊断辅助
// ---------------------------------------------------------------------------

/// 探测代理环境变量（大写与小写形式），仅收录非空项，格式 `NAME=value`。
fn detect_proxy_env() -> Vec<String> {
    let mut found = Vec::new();
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        if let Some(value) = std::env::var(name).ok().filter(|v| !v.trim().is_empty()) {
            found.push(format!("{name}={value}"));
        }
    }
    found
}

// ---------------------------------------------------------------------------
// 存储分析辅助
// ---------------------------------------------------------------------------

/// 递归扫描累积器。
#[derive(Default)]
struct Scanner {
    files_seen: usize,
    workspace_bytes: u64,
    git_dir_bytes: u64,
    category_bytes: BTreeMap<String, u64>,
    largest: Vec<FileSize>,
    truncated: bool,
}

/// 递归遍历 workspace（std::fs，不跟随符号链接）；顶层 `.git` 整目录计入、
/// 不枚举其内部对象（加快扫描）；超过 `MAX_SCAN_FILES` 个文件时提前截断。
fn scan_dir(dir: &Path, root: &Path, scanner: &mut Scanner) {
    if scanner.truncated {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            if path == root.join(".git") {
                let size = dir_size(&path);
                scanner.workspace_bytes += size;
                scanner.git_dir_bytes += size;
                *scanner.category_bytes.entry(".git".to_owned()).or_insert(0) += size;
                continue;
            }
            scan_dir(&path, root, scanner);
            if scanner.truncated {
                return;
            }
        } else if file_type.is_file() {
            scanner.files_seen += 1;
            if scanner.files_seen > MAX_SCAN_FILES {
                scanner.truncated = true;
                return;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            scanner.workspace_bytes += size;
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let category = categorize(rel);
            *scanner.category_bytes.entry(category.to_owned()).or_insert(0) += size;
            scanner.largest.push(FileSize {
                path: rel.display().to_string(),
                bytes: size,
            });
        }
        // 符号链接跳过，避免环。
    }
}

/// 按路径组件归类：node_modules / target / .git / other。
fn categorize(rel: &Path) -> &'static str {
    let mut saw_node_modules = false;
    let mut saw_target = false;
    for component in rel.components() {
        match component.as_os_str().to_str() {
            Some(".git") => return ".git",
            Some("node_modules") => saw_node_modules = true,
            Some("target") => saw_target = true,
            _ => {}
        }
    }
    if saw_node_modules {
        "node_modules"
    } else if saw_target {
        "target"
    } else {
        "other"
    }
}

/// 统计目录总大小（仅普通文件；迭代式遍历避免深层递归爆栈，不跟随符号链接）。
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    total
}

// ---------------------------------------------------------------------------
// 诊断包辅助
// ---------------------------------------------------------------------------

/// 递归收集目录下所有文件的（绝对路径, 归档内相对路径）。
fn collect_dir_files(dir: &Path, root: &Path, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            collect_dir_files(&path, root, out);
        } else if file_type.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let archive_name = format!("logs/{}", rel.display());
                out.push((path, archive_name));
            }
        }
    }
}

/// 向 tar 写入一个条目（长路径由 append_data 自动走 GNU 扩展）。
fn append_entry<W: io::Write>(tar: &mut tar::Builder<W>, name: &str, bytes: &[u8]) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    tar.append_data(&mut header, name, bytes)?;
    Ok(())
}

/// 运行环境摘要：git 版本、OS 信息、home/workspace 路径与当前时间。
async fn env_summary(home: &Path, workspace: &Path) -> String {
    let git_version = git_version().await;
    let os = os_info();
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S %z").to_string();
    format!(
        "Coomi diagnostics bundle\n========================\n\
         generated_at: {now}\n\
         git_version: {git_version}\n\
         os: {os}\n\
         home: {}\n\
         workspace: {}\n",
        home.display(),
        workspace.display(),
    )
}

async fn git_version() -> String {
    let mut command = tokio::process::Command::new("git");
    command.arg("--version").kill_on_drop(true);
    let result = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await;
    match result {
        Ok(Ok(output)) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let first = text.lines().next().unwrap_or_default().trim();
            truncate_chars(first, 80)
        }
        Ok(Err(_)) => "unavailable".to_owned(),
        Err(_) => "unavailable (timeout)".to_owned(),
    }
}

fn os_info() -> String {
    let mut base = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
        for line in content.lines() {
            if let Some(pretty) = line.strip_prefix("PRETTY_NAME=") {
                base.push_str(" (");
                base.push_str(pretty.trim_matches('"'));
                base.push(')');
                break;
            }
        }
    }
    base
}

// ---------------------------------------------------------------------------
// 宿主工具探测
// ---------------------------------------------------------------------------

/// 探测单个工具：`<name> --version`，5 秒超时，输出首行截断 80 字符。
async fn probe_tool(name: &str) -> GuestTool {
    let mut command = tokio::process::Command::new(name);
    command
        .arg("--version")
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return GuestTool {
                name: name.to_owned(),
                version: None,
                available: false,
            }
        }
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await;
    let output = match result {
        Ok(Ok(output)) => output,
        // 超时：二进制存在但未在时限内返回，视为可用、版本未知。
        _ => {
            return GuestTool {
                name: name.to_owned(),
                version: None,
                available: true,
            }
        }
    };
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stderr).into_owned();
    }
    let version = if output.status.success() {
        text.lines()
            .next()
            .map(|line| truncate_chars(line.trim(), 80))
            .filter(|version| !version.is_empty())
    } else {
        None
    };
    GuestTool {
        name: name.to_owned(),
        version,
        available: true,
    }
}

// ---------------------------------------------------------------------------
// 凭据存储
// ---------------------------------------------------------------------------

/// 远程令牌的本地文件级存储（home/coomi-credentials.json，0600，临时文件原子替换）。
/// 结构：`{ "<service>": { "<key>": "<token>" } }`。
pub struct CredentialStore {
    home: PathBuf,
}

impl CredentialStore {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn path(&self) -> PathBuf {
        self.home.join(CREDENTIALS_FILE)
    }

    /// 读取全量凭据；文件不存在视为空，内容损坏返回 Err（由调用方决定保留策略）。
    fn load(&self) -> Result<BTreeMap<String, BTreeMap<String, String>>> {
        let path = self.path();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new())
            }
            Err(error) => return Err(error.into()),
        };
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// 供写操作使用：损坏时改名保留原始文件（.corrupt-<时间戳>），从空表重新开始。
    fn load_for_write(&self) -> BTreeMap<String, BTreeMap<String, String>> {
        match self.load() {
            Ok(map) => map,
            Err(_) => {
                let backup = self
                    .home
                    .join(format!("{CREDENTIALS_FILE}.corrupt-{}", now_secs()));
                let _ = std::fs::rename(self.path(), backup);
                BTreeMap::new()
            }
        }
    }

    fn save_map(&self, map: &BTreeMap<String, BTreeMap<String, String>>) -> Result<()> {
        std::fs::create_dir_all(&self.home)?;
        let path = self.path();
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(map)?;
        std::fs::write(&tmp, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&tmp)?.permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&tmp, perms)?;
        }
        // 临时文件 + rename 原子替换，避免写一半留下损坏文件。
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn save(&self, service: &str, key: &str, token: &str) -> Result<()> {
        let mut map = self.load_for_write();
        map.entry(service.to_owned())
            .or_default()
            .insert(key.to_owned(), token.to_owned());
        self.save_map(&map)
    }

    pub fn get(&self, service: &str, key: &str) -> Option<String> {
        let map = self.load().ok()?;
        map.get(service)?.get(key).cloned()
    }

    pub fn delete(&self, service: &str, key: &str) -> Result<()> {
        let mut map = self.load_for_write();
        if let Some(inner) = map.get_mut(service) {
            inner.remove(key);
            if inner.is_empty() {
                map.remove(service);
            }
        }
        self.save_map(&map)
    }

    /// 列出各 service 与其 key 清单（按 service / key 排序），不暴露 token，
    /// 供凭据管理页展示与删除用。
    pub fn list_keys(&self) -> Vec<(String, Vec<String>)> {
        self.load()
            .unwrap_or_default()
            .into_iter()
            .map(|(service, keys)| (service, keys.into_keys().collect()))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/// 按字符数截断（避免切在 UTF-8 字符中间）。
fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn guest_tools_git_available() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let engine = OpsEngine::new(tmp.path().join("home"), tmp.path().join("workspace"));
        let tools = engine.guest_tools().await;
        let git = tools.iter().find(|tool| tool.name == "git").expect("git in tool list");
        assert!(git.available, "git 必须可用");
    }

    #[tokio::test]
    async fn credential_store_save_get_delete_roundtrip() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let store = CredentialStore::new(tmp.path().join("home"));

        // 未保存时为 None。
        assert_eq!(store.get("github", "token"), None);

        // save -> get 往返。
        store.save("github", "token", "ghp_secret")?;
        assert_eq!(store.get("github", "token").as_deref(), Some("ghp_secret"));

        // 文件存在且权限为 0600。
        let path = tmp.path().join("home").join(CREDENTIALS_FILE);
        assert!(path.exists(), "凭据文件必须落盘");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)?.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "凭据文件权限必须为 0600");
        }

        // 覆盖保存。
        store.save("github", "token", "ghp_new")?;
        assert_eq!(store.get("github", "token").as_deref(), Some("ghp_new"));

        // 多服务互不干扰。
        store.save("gitee", "token", "gitee_secret")?;
        assert_eq!(store.get("github", "token").as_deref(), Some("ghp_new"));
        assert_eq!(store.get("gitee", "token").as_deref(), Some("gitee_secret"));

        // delete 后消失，其他服务不受影响。
        store.delete("github", "token")?;
        assert_eq!(store.get("github", "token"), None);
        assert_eq!(store.get("gitee", "token").as_deref(), Some("gitee_secret"));

        // 删除不存在的 key 不报错（幂等）。
        store.delete("github", "nope")?;
        store.delete("ghost-service", "x")?;
        Ok(())
    }

    #[tokio::test]
    async fn storage_analysis_counts_temp_dir() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let home = tmp.path().join("home");
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&home)?;
        std::fs::create_dir_all(workspace.join("src"))?;
        std::fs::create_dir_all(workspace.join("node_modules/pkg"))?;
        std::fs::create_dir_all(workspace.join("target/debug"))?;
        std::fs::create_dir_all(workspace.join(".git/objects/ab"))?;
        std::fs::write(workspace.join("src/main.rs"), "fn main() {}\n")?;
        std::fs::write(workspace.join("node_modules/pkg/index.js"), "export {}\n")?;
        std::fs::write(workspace.join("target/debug/app"), "binary-binary-binary")?;
        std::fs::write(workspace.join("readme.md"), "# hello\n")?;
        std::fs::write(workspace.join(".git/objects/ab/1c3"), "packed-object-bytes")?;
        std::fs::write(home.join("note.txt"), "home file")?;

        let engine = OpsEngine::new(home, workspace);
        let report = engine.storage_analysis().await;

        // 对临时目录返回非零大小。
        assert!(report.workspace_bytes > 0, "workspace 大小必须非零");
        assert!(report.home_bytes > 0, "home 大小必须非零");
        assert!(report.git_dir_bytes > 0, ".git 大小必须非零");
        assert!(!report.truncated, "小目录不应截断");

        // 类别汇总等于 workspace 总量。
        let category_sum: u64 = report.categories.iter().map(|c| c.bytes).sum();
        assert_eq!(category_sum, report.workspace_bytes);

        // .git 类别与 git_dir_bytes 一致。
        let git_category = report
            .categories
            .iter()
            .find(|c| c.category == ".git")
            .map(|c| c.bytes)
            .unwrap_or(0);
        assert_eq!(git_category, report.git_dir_bytes);

        // largest 非空、按字节降序，且不包含 .git 内部对象。
        assert!(!report.largest.is_empty());
        let sizes: Vec<u64> = report.largest.iter().map(|f| f.bytes).collect();
        let mut sorted = sizes.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(sizes, sorted, "largest 必须按字节降序");
        assert!(
            report.largest.iter().all(|f| !f.path.starts_with(".git")),
            "largest 不应包含 .git 内部对象"
        );

        // 各类别均有值。
        let category = |name: &str| {
            report
                .categories
                .iter()
                .find(|c| c.category == name)
                .map(|c| c.bytes)
                .unwrap_or(0)
        };
        assert!(category("node_modules") > 0);
        assert!(category("target") > 0);
        assert!(category("other") > 0);
        Ok(())
    }

    #[tokio::test]
    async fn log_bundle_creates_tar_gz() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join("logs"))?;
        std::fs::write(home.join("app.log"), "app log line\n")?;
        std::fs::write(home.join("logs/coomi.log"), "coomi log line\n")?;

        let engine = OpsEngine::new(home, tmp.path().join("workspace"));
        let bundle = engine.log_bundle().await?;
        assert!(bundle.exists());
        let name = bundle.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        assert!(name.starts_with("coomi-diagnose-") && name.ends_with(".tar.gz"));

        // 解包验证：摘要 + 日志文件均在包内。
        let file = std::fs::File::open(&bundle)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let mut names: Vec<String> = Vec::new();
        for entry in archive.entries()? {
            let entry = entry?;
            names.push(entry.path()?.to_string_lossy().into_owned());
        }
        assert!(names.contains(&"environment.txt".to_owned()));
        assert!(names.contains(&"logs/app.log".to_owned()));
        assert!(names.contains(&"logs/coomi.log".to_owned()));

        // 无日志文件时也出包（仅含摘要）。
        let empty_home = tmp.path().join("empty-home");
        std::fs::create_dir_all(&empty_home)?;
        let engine = OpsEngine::new(empty_home, tmp.path().join("workspace"));
        let bundle = engine.log_bundle().await?;
        let file = std::fs::File::open(&bundle)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let mut count = 0usize;
        for entry in archive.entries()? {
            let entry = entry?;
            assert_eq!(entry.path()?.to_string_lossy(), "environment.txt");
            count += 1;
        }
        assert_eq!(count, 1, "无日志时只应包含摘要");
        Ok(())
    }
}
