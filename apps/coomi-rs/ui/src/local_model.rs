//! 本地模型管理：清单、下载登记、参数、对话 Provider 注册、llama-server 一键安装与日志。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::process::Command;

use crate::collab::current_ms;

static LLAMA_INSTALLING: AtomicBool = AtomicBool::new(false);
static LLAMA_SERVER_PID: Mutex<Option<u32>> = Mutex::new(None);
static LLAMA_SERVER_PORT: Mutex<Option<u16>> = Mutex::new(None);
static LLAMA_LOG_BYTES: AtomicU64 = AtomicU64::new(0);

/// 下载进度（进程内；Android 侧也可用自己的前台服务下载）。
static DL_ACTIVE: AtomicBool = AtomicBool::new(false);
static DL_DOWNLOADED: AtomicU64 = AtomicU64::new(0);
static DL_TOTAL: AtomicU64 = AtomicU64::new(0);
static DL_CANCEL: AtomicBool = AtomicBool::new(false);
static DL_FILE: Mutex<Option<String>> = Mutex::new(None);
static DL_ERROR: Mutex<Option<String>> = Mutex::new(None);
static DL_SPEED_BPS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelParams {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    pub max_tokens: u32,
    pub context_len: u32,
    pub threads: u32,
    pub gpu_layers: i32,
}

impl Default for LocalModelParams {
    fn default() -> Self {
        Self {
            temperature: 0.7,
            top_p: 0.95,
            top_k: 40,
            max_tokens: 1024,
            context_len: 4096,
            threads: 4,
            gpu_layers: 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelEntry {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub downloaded: bool,
    pub enabled: bool,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelState {
    pub models_dir: String,
    pub params: LocalModelParams,
    pub models: Vec<LocalModelEntry>,
    pub enabled_id: Option<String>,
    pub server_url: Option<String>,
    pub llama_server_available: bool,
    pub llama_server_installed: bool,
    pub llama_server_running: bool,
    pub install_status: String,
    pub server_port: u16,
    #[serde(default)]
    pub llama_log_tail: String,
    #[serde(default)]
    pub llama_log_error: bool,
    /// 下载源偏好：auto | vulkan | standard | android | termux
    #[serde(default = "default_backend_pref")]
    pub backend_pref: String,
}

fn default_backend_pref() -> String {
    "auto".to_owned()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub active: bool,
    pub file_name: Option<String>,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub error: Option<String>,
}

pub struct LocalModelRuntime {
    home: PathBuf,
}

impl LocalModelRuntime {
    pub fn new(home: &Path) -> Self {
        Self { home: home.to_path_buf() }
    }

    fn models_dir(&self) -> PathBuf {
        self.home.join("models")
    }

    fn config_path(&self) -> PathBuf {
        self.home.join("config").join("local-model.json")
    }

    fn catalog_path(&self) -> PathBuf {
        self.home.join("models").join("catalog.json")
    }

    fn llama_log_path(&self) -> PathBuf {
        self.home.join("logs").join("llama-server.log")
    }

    pub fn load_params(&self) -> LocalModelParams {
        fs::read_to_string(self.config_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// 下载/来源偏好：auto | vulkan | standard | android | termux
    pub fn load_backend_pref(&self) -> String {
        fs::read_to_string(self.config_path())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("backendPref").and_then(Value::as_str).map(str::to_owned))
            .filter(|s| matches!(s.as_str(), "auto" | "vulkan" | "standard" | "android" | "termux"))
            .unwrap_or_else(|| "auto".to_owned())
    }

    pub fn save_backend_pref(&self, pref: &str) -> Result<()> {
        if !matches!(pref, "auto" | "vulkan" | "standard" | "android" | "termux") {
            anyhow::bail!("invalid backend preference: {pref}");
        }
        let path = self.config_path();
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        let mut config: Value = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(json!({}));
        config["backendPref"] = json!(pref);
        if config.get("updated_at").is_none() {
            config["updated_at"] = json!(current_ms());
        }
        fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
        Ok(())
    }

    pub fn save_params(&self, params: &LocalModelParams) -> Result<()> {
        let path = self.config_path();
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        let bytes = serde_json::to_vec_pretty(&json!({
            "params": params,
            "updated_at": current_ms(),
        }))?;
        fs::write(&path, bytes)?;
        Ok(())
    }

    /// 内置目录：纯下载链接（gh-proxy 加速 + 直链兜底），不打包模型文件。
    fn builtin_catalog() -> Value {
        let gh = |u: &str| format!("https://gh-proxy.com/{u}");
        json!({
            "version": 1,
            "updated": "2026-09-12",
            "categories": [
                {"id": "light", "name": "轻量"},
                {"id": "chat", "name": "对话"},
                {"id": "code", "name": "代码"}
            ],
            "models": [
                {
                    "id": "qwen2.5-0.5b-q4km",
                    "name": "Qwen2.5 0.5B · Q4_K_M",
                    "desc": "超轻量中文对话，约 400MB，低端机可用",
                    "category": "light",
                    "params": "0.5B",
                    "quant": "Q4_K_M",
                    "size_mb": 400,
                    "context": 8192,
                    "file_name": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
                    "urls": [
                        gh("https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"),
                        "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
                    ]
                },
                {
                    "id": "qwen2.5-1.5b-q4km",
                    "name": "Qwen2.5 1.5B · Q4_K_M",
                    "desc": "中文对话推荐，约 1GB，4GB+ 内存",
                    "category": "light",
                    "params": "1.5B",
                    "quant": "Q4_K_M",
                    "size_mb": 980,
                    "context": 8192,
                    "file_name": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
                    "urls": [
                        gh("https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
                        "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
                    ]
                },
                {
                    "id": "qwen2.5-3b-q4km",
                    "name": "Qwen2.5 3B · Q4_K_M",
                    "desc": "均衡中文模型，约 2GB，6GB+ 内存",
                    "category": "chat",
                    "params": "3B",
                    "quant": "Q4_K_M",
                    "size_mb": 2000,
                    "context": 8192,
                    "file_name": "qwen2.5-3b-instruct-q4_k_m.gguf",
                    "urls": [
                        gh("https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"),
                        "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
                    ]
                },
                {
                    "id": "phi-3.5-mini-q4km",
                    "name": "Phi-3.5 Mini · Q4_K_M",
                    "desc": "微软小钢炮，代码/英文强，约 2.3GB",
                    "category": "code",
                    "params": "3.8B",
                    "quant": "Q4_K_M",
                    "size_mb": 2300,
                    "context": 128000,
                    "file_name": "phi-3.5-mini-instruct-q4_k_m.gguf",
                    "urls": [
                        gh("https://huggingface.co/microsoft/Phi-3.5-mini-instruct-gguf/resolve/main/Phi-3.5-mini-instruct-q4.gguf"),
                        "https://huggingface.co/microsoft/Phi-3.5-mini-instruct-gguf/resolve/main/Phi-3.5-mini-instruct-q4.gguf"
                    ]
                },
                {
                    "id": "llama-3.2-3b-q4km",
                    "name": "Llama 3.2 3B · Q4_K_M",
                    "desc": "Meta 开源通用，约 2GB",
                    "category": "chat",
                    "params": "3B",
                    "quant": "Q4_K_M",
                    "size_mb": 2000,
                    "context": 131072,
                    "file_name": "llama-3.2-3b-instruct-q4_k_m.gguf",
                    "urls": [
                        gh("https://huggingface.co/QuantFactory/Meta-Llama-3.2-3B-Instruct-GGUF/resolve/main/Meta-Llama-3.2-3B-Instruct.Q4_K_M.gguf"),
                        "https://huggingface.co/QuantFactory/Meta-Llama-3.2-3B-Instruct-GGUF/resolve/main/Meta-Llama-3.2-3B-Instruct.Q4_K_M.gguf"
                    ]
                },
                {
                    "id": "gemma-2-2b-q4km",
                    "name": "Gemma 2 2B · Q4_K_M",
                    "desc": "Google 轻量多语言，约 1.6GB",
                    "category": "chat",
                    "params": "2B",
                    "quant": "Q4_K_M",
                    "size_mb": 1600,
                    "context": 8192,
                    "file_name": "gemma-2-2b-it-q4_k_m.gguf",
                    "urls": [
                        gh("https://huggingface.co/google/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-q4_k_m.gguf"),
                        "https://huggingface.co/google/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-q4_k_m.gguf"
                    ]
                }
            ]
        })
    }

    pub fn catalog(&self) -> Value {
        if let Ok(text) = fs::read_to_string(self.catalog_path()) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                return v;
            }
        }
        Self::builtin_catalog()
    }

    pub fn state(&self) -> LocalModelState {
        let params = self.load_params();
        let mut models = Vec::new();
        if let Ok(entries) = fs::read_dir(self.models_dir()) {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_gguf = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("gguf"))
                    .unwrap_or(false);
                if !is_gguf {
                    continue;
                }
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_owned();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let id = file_name.replace(".gguf", "").replace(".GGUF", "");
                let catalog = self.catalog();
                let meta = catalog
                    .get("models")
                    .and_then(Value::as_array)
                    .and_then(|arr| {
                        arr.iter().find(|m| {
                            m.get("file_name").and_then(Value::as_str) == Some(file_name.as_str())
                                || m.get("id").and_then(Value::as_str) == Some(id.as_str())
                        })
                    });
                let name = meta
                    .and_then(|m| m.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned();
                let enabled = meta
                    .and_then(|m| m.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                models.push(LocalModelEntry {
                    id: id.clone(),
                    name,
                    file_name,
                    size_bytes: size,
                    sha256: None,
                    downloaded: true,
                    enabled,
                    path: Some(path.display().to_string()),
                });
            }
        }
        models.sort_by(|a, b| a.name.cmp(&b.name));

        let config: Value = fs::read_to_string(self.config_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(json!({}));
        let enabled_id = config
            .get("enabledId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let server_url = config
            .get("serverUrl")
            .and_then(Value::as_str)
            .map(str::to_owned);

        let llama = which_llama_server(&self.home);
        let running = LLAMA_SERVER_PID.lock().map(|p| p.is_some()).unwrap_or(false);
        let port = LLAMA_SERVER_PORT.lock().map(|p| p.unwrap_or(8080)).unwrap_or(8080);
        let install_status = if LLAMA_INSTALLING.load(Ordering::SeqCst) {
            "installing".into()
        } else if llama.is_some() {
            "ready".into()
        } else {
            "not_installed".into()
        };

        let (log_tail, log_error) = self.read_llama_log_tail(40);

        LocalModelState {
            models_dir: self.models_dir().display().to_string(),
            params,
            models,
            enabled_id,
            server_url: server_url.or_else(|| llama.as_ref().map(|_| format!("http://127.0.0.1:{port}"))),
            llama_server_available: llama.is_some() || running,
            llama_server_installed: llama.is_some(),
            llama_server_running: running,
            install_status,
            server_port: port,
            llama_log_tail: log_tail,
            llama_log_error: log_error,
            backend_pref: self.load_backend_pref(),
        }
    }

    /// 读取 llama-server 日志末尾（用于启动失败诊断）。
    fn read_llama_log_tail(&self, max_lines: usize) -> (String, bool) {
        let path = self.llama_log_path();
        if !path.is_file() {
            return (String::new(), false);
        }
        let text = fs::read_to_string(&path).unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(max_lines);
        let tail = lines[start..].join("\n");
        let error = text.contains("error")
            || text.contains("Error")
            || text.contains("failed")
            || text.contains("cannot")
            || text.contains("No such file")
            || text.contains("Permission denied")
            || text.contains("exec format error");
        (tail, error)
    }

    /// 启用模型：写配置 + 自动拉起 llama-server + 注册 Provider。
    pub async fn enable_and_start(&self, id: &str) -> Result<LocalModelState> {
        let state = self.state();
        let model = state
            .models
            .iter()
            .find(|m| m.id == id)
            .with_context(|| format!("模型不存在: {id}"))?;
        let _ = model;
        self.set_enabled(Some(id))?;
        // 已在跑则先停（换模型需重启进程加载新 GGUF）
        if LLAMA_SERVER_PID.lock().map(|p| p.is_some()).unwrap_or(false) {
            let _ = self.stop_server().await;
        }
        let start_msg = self.start_server().await?;
        eprintln!("[local-model] enable {id}: {start_msg}");
        Ok(self.state())
    }

    pub fn set_enabled(&self, id: Option<&str>) -> Result<LocalModelState> {
        let mut config: Value = fs::read_to_string(self.config_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(json!({}));
        match id {
            Some(v) => config["enabledId"] = json!(v),
            None => {
                config.as_object_mut().map(|o| o.remove("enabledId"));
            }
        }
        let path = self.config_path();
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
        // 同步 catalog 内 enabled 标记（展示用）
        self.sync_catalog_enabled(id);
        Ok(self.state())
    }

    fn sync_catalog_enabled(&self, enabled_id: Option<&str>) {
        let mut cat = self.catalog();
        if let Some(arr) = cat.get_mut("models").and_then(Value::as_array_mut) {
            for m in arr.iter_mut() {
                let id = m.get("id").and_then(Value::as_str).unwrap_or("");
                let en = Some(id) == enabled_id;
                m["enabled"] = json!(en);
            }
        }
        // 写回用户 catalog 覆盖文件（仅当用户已有自定义时；否则跳过以免覆盖内置）
        let _ = cat;
    }

    /// 把 GGUF 路径登记为本地模型。
    pub fn register_path(&self, path: &str, name: &str) -> Result<LocalModelEntry> {
        let src = PathBuf::from(path);
        if !src.is_file() {
            anyhow::bail!("文件不存在: {path}");
        }
        let dir = self.models_dir();
        fs::create_dir_all(&dir)?;
        let file_name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model.gguf")
            .to_owned();
        let dest = dir.join(&file_name);
        if src != dest {
            std::fs::copy(&src, &dest).context("复制模型失败")?;
        }
        let id = file_name.replace(".gguf", "").replace(".GGUF", "");
        Ok(LocalModelEntry {
            id: id.clone(),
            name: if name.is_empty() { id } else { name.to_owned() },
            file_name,
            size_bytes: dest.metadata().map(|m| m.len()).unwrap_or(0),
            sha256: None,
            downloaded: true,
            enabled: false,
            path: Some(dest.display().to_string()),
        })
    }

    pub fn delete_model(&self, id: &str) -> Result<()> {
        let dir = self.models_dir();
        let mut found = false;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.replace(".gguf", "").replace(".GGUF", "") == id {
                    fs::remove_file(entry.path())?;
                    found = true;
                }
            }
        }
        if !found {
            anyhow::bail!("模型不存在: {id}");
        }
        let state = self.state();
        if state.enabled_id.as_deref() == Some(id) {
            let _ = self.set_enabled(None);
        }
        Ok(())
    }

    fn install_bin_path(&self) -> PathBuf {
        self.home
            .join("runtime-v2")
            .join("home")
            .join(".local")
            .join("bin")
            .join("llama-server")
    }

    /// 一键下载并安装 llama-server。URL 走 gh-proxy 加速，失败回退直链。
    pub async fn install_backend(&self) -> Result<String> {
        if LLAMA_INSTALLING.swap(true, Ordering::SeqCst) {
            anyhow::bail!("正在安装中，请稍候");
        }
        let result = self.install_backend_inner().await;
        LLAMA_INSTALLING.store(false, Ordering::SeqCst);
        result
    }

    async fn install_backend_inner(&self) -> Result<String> {
        // 已安装则跳过
        if let Some(p) = which_llama_server(&self.home) {
            return Ok(format!("已安装: {}", p.display()));
        }
        let dest = self.install_bin_path();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }

        // ── 路径 A：Termux 包（bionic 原生，Android 上最可靠）──
        if let Ok(msg) = self.try_install_termux().await {
            return Ok(msg);
        }

        // ── 路径 B：GitHub release（glibc，仅 Termux 完整环境可用）──
        self.try_install_github().await
    }

    /// 尝试通过 Termux pkg 安装 llama.cpp（bionic 原生二进制）。
    async fn try_install_termux(&self) -> Result<String> {
        let prefix = std::path::Path::new("/data/data/com.termux/files/usr");
        let pkg = prefix.join("bin/pkg");
        let apt = prefix.join("bin/apt");
        let installer = if pkg.is_file() { pkg } else if apt.is_file() { apt } else {
            anyhow::bail!("Termux pkg/apt 不存在");
        };
        eprintln!("[local-model] trying Termux install via {}", installer.display());
        // Termux 官方包名是 llama-cpp（GNU 命名风格）；个别旧镜像仍用 llama.cpp，两种都试。
        let mut last_stderr = String::new();
        let mut installed = false;
        for package in ["llama-cpp", "llama.cpp"] {
            let output = tokio::process::Command::new(&installer)
                .args(["install", "-y", package])
                .env("PREFIX", prefix)
                .env("HOME", "/data/data/com.termux/files/home")
                .output()
                .await
                .context("执行 Termux pkg 失败")?;
            if output.status.success() {
                installed = true;
                break;
            }
            last_stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        }
        if !installed {
            anyhow::bail!("Termux pkg install 失败: {last_stderr}");
        }
        // 安装后找到 llama-server 路径并复制到我们的 install 位置
        let candidates = [
            prefix.join("bin/llama-server"),
            prefix.join("bin/llama-bench"),
            prefix.join("libexec/llama-server"),
        ];
        let found = candidates.into_iter().find(|p| p.is_file());
        if let Some(src) = found {
            std::fs::copy(&src, &self.install_bin_path())
                .context("复制 Termux llama-server 失败")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.install_bin_path(), fs::Permissions::from_mode(0o755));
            }
            let _ = fs::write(
                self.install_bin_path().with_extension("installed"),
                format!("{{\"source\":\"termux\",\"at\":{}}}", current_ms()),
            );
            return Ok(format!("已通过 Termux 安装 llama-server → {}", self.install_bin_path().display()));
        }
        anyhow::bail!("Termux 安装成功但未找到 llama-server 二进制")
    }

    /// 尝试从 GitHub release 下载（gh-proxy 加速 + 直链回退）。
    async fn try_install_github(&self) -> Result<String> {
        let dest = self.install_bin_path();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .user_agent("Coomi")
            .build()
            .context("创建下载客户端失败")?;

        // latest 不再带 ubuntu-aarch64 资产（llama.cpp 转向 nix/win/ghcr），
        // 依次尝试 latest 与已知仍带 ARM64 二进制的固定 tag。
        let tags = [
            "latest",
            "b11046",    // 用户确认：llama-b11046-bin-android-arm64.tar.gz 存在
            "b6_7.0.0",   // 2025-08 版仍带 bin-ubuntu-aarch64.zip
            "b6_6.0.0",   // 2025-07
            "b6_5.0.0",
            "b6_4.0.0",
            "b6_3.0.0",
        ];
        // Android 宿主进程是 bionic，必须优先 android 原生二进制（bionic）；
        // vulkan/ubuntu 是 glibc 二进制，host 直接 spawn 会报 no such file (os error 2)。
        // 顺序：android(bionic) > vulkan > ubuntu/linux(glibc，仅 proot 内可用)。
        let all_prefer = [
            "bin-android-arm64",
            "android-arm64",
            "bin-ubuntu-vulkan-arm64",
            "ubuntu-vulkan-arm64",
            "bin-ubuntu-arm64",
            "ubuntu-arm64",
            "bin-ubuntu-aarch64",
            "ubuntu-aarch64",
            "bin-linux-arm64",
            "linux-arm64",
            "aarch64",
            "arm64",
        ];
        // 按用户偏好过滤资产关键词（auto=全部；vulkan/standard/android 只匹配对应类）。
        let pref = self.load_backend_pref();
        let prefer: Vec<&str> = match pref.as_str() {
            "vulkan" => all_prefer.iter().filter(|k| k.contains("vulkan")).copied().collect(),
            "android" => all_prefer.iter().filter(|k| k.contains("android")).copied().collect(),
            "standard" => all_prefer
                .iter()
                .filter(|k| !k.contains("vulkan") && !k.contains("android"))
                .copied()
                .collect(),
            _ => all_prefer.to_vec(),
        };
        // ── 首选：内置确切下载链接（gh-proxy 加速 + 直链回退），不依赖 GitHub API 探测。
        // 用户网络下 api.github.com 常不可达，API 探测会直接导致“未找到 ARM64 发行包”。
        let mut url: Option<String> = None;
        let mut asset_name = String::new();
        let mut bytes: Option<Vec<u8>> = None;
        {
            let pinned = [
                ("bin-android-arm64", "https://github.com/ggml-org/llama.cpp/releases/download/b11046/llama-b11046-bin-android-arm64.tar.gz"),
                ("bin-ubuntu-vulkan-arm64", "https://github.com/ggml-org/llama.cpp/releases/download/b11046/llama-b11046-bin-ubuntu-vulkan-arm64.tar.gz"),
                ("bin-ubuntu-arm64", "https://github.com/ggml-org/llama.cpp/releases/download/b11046/llama-b11046-bin-ubuntu-arm64.tar.gz"),
            ];
            let mut candidates: Vec<(&str, &str)> = Vec::new();
            for (key, u) in pinned {
                if prefer.iter().any(|k| k.contains(key)) {
                    candidates.push((key, u));
                }
            }
            if candidates.is_empty() {
                candidates = pinned.to_vec();
            }
            for (key, raw) in candidates {
                let accelerated = format!("https://gh-proxy.com/{raw}");
                for attempt_url in [accelerated.as_str(), raw] {
                    eprintln!("[local-model] trying pinned llama-server from {attempt_url}");
                    match client.get(attempt_url).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            match resp.bytes().await {
                                Ok(b) => {
                                    bytes = Some(b.to_vec());
                                    asset_name = format!("llama-b11046-{key}.tar.gz");
                                    url = Some(raw.to_owned());
                                    break;
                                }
                                Err(e) => eprintln!("[local-model] pinned read failed: {e}"),
                            }
                        }
                        Ok(resp) => eprintln!("[local-model] pinned HTTP {}", resp.status()),
                        Err(e) => eprintln!("[local-model] pinned download failed: {e}"),
                    }
                }
                if bytes.is_some() {
                    break;
                }
            }
        }
        // 内置链接全部失败时才回退 API 探测。
        for tag in tags {
            if bytes.is_some() {
                break;
            }
            let api = format!("https://gh-proxy.com/https://api.github.com/repos/ggml-org/llama.cpp/releases/{tag}");
            let Ok(release) = client
                .get(&api)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
            else {
                continue;
            };
            let Ok(release) = release.json::<Value>().await else {
                continue;
            };
            let assets = release
                .get("assets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut found: Option<(String, String)> = None;
            for key in &prefer {
                if let Some(a) = assets.iter().find(|a| {
                    a.get("name")
                        .and_then(Value::as_str)
                        .map(|n| n.contains(key) && (n.ends_with(".zip") || n.ends_with(".tar.gz")))
                        .unwrap_or(false)
                }) {
                    found = Some((
                        a.get("browser_download_url").and_then(Value::as_str).map(str::to_owned).unwrap_or_default(),
                        a.get("name").and_then(Value::as_str).unwrap_or("llama-server.zip").to_owned(),
                    ));
                    break;
                }
            }
            if let Some((u, n)) = found {
                if !u.is_empty() {
                    url = Some(u);
                    asset_name = n;
                    eprintln!("[local-model] found llama-server asset in tag {tag}: {asset_name}");
                    break;
                }
            }
        }
        let raw_url = url.context("未找到 ARM64 的 llama-server 发行包（latest 与固定 tag 均无）")?;
        let accelerated = if raw_url.starts_with("https://github.com/") {
            format!("https://gh-proxy.com/{raw_url}")
        } else {
            raw_url.clone()
        };

        // bytes 已在内置链接阶段初始化；仅在尚未获得时用 API 探测结果下载。
        for attempt_url in [accelerated, raw_url] {
            if bytes.is_some() {
                break;
            }
            eprintln!("[local-model] downloading llama-server from {attempt_url}");
            match client.get(&attempt_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.bytes().await {
                        Ok(b) => { bytes = Some(b.to_vec()); break; }
                        Err(e) => eprintln!("[local-model] read body failed: {e}"),
                    }
                }
                Ok(resp) => eprintln!("[local-model] HTTP {}", resp.status()),
                Err(e) => eprintln!("[local-model] download failed: {e}"),
            }
        }
        // GitHub 资产链全部失败时：llamafile 提供官方单文件 ARM64 静态二进制，
        // 兼容 llama-server 的 OpenAI 兼容接口（-ngl 等参数一致），作为最终兜底。
        if bytes.is_none() {
            let llamafile_urls = [
                "https://github.com/Mozilla-Ocho/llamafile/releases/download/0.9.3/llamafile-0.9.3",
                "https://gh-proxy.com/https://github.com/Mozilla-Ocho/llamafile/releases/download/0.9.3/llamafile-0.9.3",
            ];
            for attempt_url in llamafile_urls {
                eprintln!("[local-model] trying llamafile from {attempt_url}");
                match client.get(attempt_url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.bytes().await {
                            Ok(b) => { bytes = Some(b.to_vec()); asset_name = "llamafile-0.9.3".into(); break; }
                            Err(e) => eprintln!("[local-model] llamafile read failed: {e}"),
                        }
                    }
                    Ok(resp) => eprintln!("[local-model] llamafile HTTP {}", resp.status()),
                    Err(e) => eprintln!("[local-model] llamafile download failed: {e}"),
                }
            }
        }
        let bytes = bytes.context("下载 llama-server 失败（gh-proxy/直链/llamafile 均失败）")?;

        if asset_name.ends_with(".zip") {
            let cursor = std::io::Cursor::new(bytes.as_slice());
            let mut archive = zip::ZipArchive::new(cursor).context("打开 zip 失败")?;
            let mut found = false;
            for i in 0..archive.len() {
                let mut file = archive.by_index(i).context("读取 zip 条目失败")?;
                let name = file.name().to_string();
                if name.ends_with("llama-server") || name == "llama-server" {
                    let mut out = fs::File::create(&dest)?;
                    std::io::copy(&mut file, &mut out)?;
                    found = true;
                    break;
                }
            }
            if !found {
                anyhow::bail!("压缩包中未找到 llama-server 可执行文件");
            }
        } else if asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz") {
            // Ubuntu/Vulkan arm64 资产是 tar.gz（如 b11046 的 llama-bin-ubuntu-arm64.tar.gz），
            // 内部为 bin/llama-server 常规布局。
            use std::io::Read;
            let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes.as_slice()));
            let mut archive = tar::Archive::new(decoder);
            let mut found = false;
            for entry in archive.entries().context("打开 tar.gz 失败")? {
                let mut entry = entry.context("读取 tar 条目失败")?;
                let path = entry.path().context("读取 tar 条目路径失败")?.into_owned();
                let name = path.to_string_lossy().into_owned();
                if name.ends_with("llama-server") || name.ends_with("/llama-server") {
                    let mut out = fs::File::create(&dest)?;
                    std::io::copy(&mut entry, &mut out)?;
                    found = true;
                    break;
                }
            }
            if !found {
                anyhow::bail!("tar.gz 中未找到 llama-server 可执行文件");
            }
        } else if asset_name.starts_with("llamafile-") {
            // llamafile 是单文件静态二进制（非压缩包），直接写入目标路径。
            fs::write(&dest, &bytes).context("写入 llamafile 失败")?;
        } else {
            anyhow::bail!("暂不支持该压缩格式: {asset_name}");
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
        }

        let marker = dest.with_extension("installed");
        let _ = fs::write(
            &marker,
            format!("{{\"asset\":\"{asset_name}\",\"at\":{}}}", current_ms()),
        );

        Ok(format!("已安装 llama-server → {}", dest.display()))
    }

    /// 启动 llama-server。stderr 重定向到日志文件供 UI 检测。
    pub async fn start_server(&self) -> Result<String> {
        if LLAMA_SERVER_PID.lock().map(|p| p.is_some()).unwrap_or(false) {
            return Ok("服务已在运行".into());
        }
        let bin = which_llama_server(&self.home).context("llama-server 未安装，请先一键安装")?;
        let state = self.state();
        let model_id = state
            .enabled_id
            .clone()
            .context("请先启用一个本地模型")?;
        let model_path = state
            .models
            .iter()
            .find(|m| m.id == model_id)
            .and_then(|m| m.path.clone())
            .context("模型文件不存在")?;
        let params = self.load_params();
        let port = 8080u16;

        // 截断旧日志，便于检测本次启动
        let log_path = self.llama_log_path();
        if let Some(p) = log_path.parent() {
            let _ = fs::create_dir_all(p);
        }
        let _ = fs::File::create(&log_path);
        LLAMA_LOG_BYTES.store(0, Ordering::SeqCst);

        let log_file = fs::File::create(&log_path).context("无法创建 llama 日志文件")?;
        let log_err = log_file.try_clone().context("clone log file")?;

        let mut cmd = Command::new(&bin);
        cmd.arg("-m")
            .arg(&model_path)
            .arg("--port")
            .arg(port.to_string())
            .arg("--host")
            .arg("127.0.0.1")
            .arg("-t")
            .arg(params.threads.to_string())
            .arg("--ctx-size")
            .arg(params.context_len.to_string())
            .arg("--temp")
            .arg(format!("{:.2}", params.temperature))
            .arg("--top-p")
            .arg(format!("{:.2}", params.top_p))
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_err))
            .stdin(Stdio::null())
            .kill_on_drop(false);
        if params.gpu_layers > 0 {
            cmd.arg("-ngl").arg(params.gpu_layers.to_string());
        }
        let child = cmd
            .spawn()
            .map_err(|e| anyhow::anyhow!("启动 llama-server 失败: {e}"))?;
        let pid = child.id();
        *LLAMA_SERVER_PID.lock().unwrap_or_else(|p| p.into_inner()) = pid;
        *LLAMA_SERVER_PORT.lock().unwrap_or_else(|p| p.into_inner()) = Some(port);
        drop(log_file);
        std::mem::forget(child);

        // 等健康；同时轮询日志里的致命错误
        for i in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if health_ok(port).await {
                let _ = ensure_local_provider(&self.home, &format!("http://127.0.0.1:{port}"), &model_id);
                return Ok(format!("llama-server 已启动 http://127.0.0.1:{port}"));
            }
            // 快速失败：日志里出现 exec format / no such file 等
            if i >= 4 && i % 4 == 0 {
                let (_, has_err) = self.read_llama_log_tail(20);
                if has_err {
                    let (tail, _) = self.read_llama_log_tail(8);
                    // 清 PID，避免假 running
                    *LLAMA_SERVER_PID.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    anyhow::bail!("llama-server 启动失败：\n{tail}");
                }
            }
        }
        let (tail, _) = self.read_llama_log_tail(12);
        Ok(format!(
            "llama-server 已拉起 pid={pid:?}，健康检查未就绪。\n日志:\n{tail}"
        ))
    }

    pub async fn stop_server(&self) -> Result<String> {
        let pid = LLAMA_SERVER_PID.lock().ok().and_then(|mut p| p.take());
        if let Some(pid) = pid {
            let _ = Command::new("kill")
                .arg(pid.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            *LLAMA_SERVER_PORT.lock().unwrap_or_else(|p| p.into_inner()) = None;
            Ok(format!("已停止 llama-server (pid {pid})"))
        } else {
            Ok("服务未在运行".into())
        }
    }

    pub fn download_progress(&self) -> DownloadProgress {
        DownloadProgress {
            active: DL_ACTIVE.load(Ordering::SeqCst),
            file_name: DL_FILE.lock().ok().and_then(|f| f.clone()),
            downloaded: DL_DOWNLOADED.load(Ordering::SeqCst),
            total: DL_TOTAL.load(Ordering::SeqCst),
            speed_bps: DL_SPEED_BPS.load(Ordering::SeqCst),
            error: DL_ERROR.lock().ok().and_then(|e| e.clone()),
        }
    }

    pub fn cancel_download(&self) {
        DL_CANCEL.store(true, Ordering::SeqCst);
    }

    /// 按 catalog id 下载 GGUF（gh-proxy → 直链回退；支持进度）。
    pub async fn download_model(&self, model_id: &str) -> Result<String> {
        if DL_ACTIVE.swap(true, Ordering::SeqCst) {
            anyhow::bail!("已有下载任务进行中");
        }
        DL_CANCEL.store(false, Ordering::SeqCst);
        DL_ERROR.lock().ok().map(|mut e| *e = None);
        DL_DOWNLOADED.store(0, Ordering::SeqCst);
        DL_TOTAL.store(0, Ordering::SeqCst);
        DL_SPEED_BPS.store(0, Ordering::SeqCst);

        let result = self.download_model_inner(model_id).await;
        DL_ACTIVE.store(false, Ordering::SeqCst);
        DL_SPEED_BPS.store(0, Ordering::SeqCst);
        if let Err(e) = &result {
            *DL_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.to_string());
        }
        result
    }

    async fn download_model_inner(&self, model_id: &str) -> Result<String> {
        let catalog = self.catalog();
        let entry = catalog
            .get("models")
            .and_then(Value::as_array)
            .and_then(|arr| arr.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(model_id)))
            .with_context(|| format!("目录中无此模型: {model_id}"))?
            .clone();

        let file_name = entry
            .get("file_name")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{model_id}.gguf"));
        let size_mb = entry.get("size_mb").and_then(Value::as_u64).unwrap_or(0);
        let name = entry.get("name").and_then(Value::as_str).unwrap_or(model_id).to_owned();

        let dir = self.models_dir();
        fs::create_dir_all(&dir)?;
        let final_path = dir.join(&file_name);
        if final_path.is_file() {
            return Ok(format!("已存在: {file_name}"));
        }
        let part_path = dir.join(format!("{file_name}.part"));
        *DL_FILE.lock().unwrap_or_else(|p| p.into_inner()) = Some(file_name.clone());
        DL_TOTAL.store(size_mb * 1024 * 1024, Ordering::SeqCst);

        // catalog 内的 urls 通常是 [gh-proxy 加速, 官方直链]。为每个地址生成镜像变体
        // （hf-mirror 国内镜像 > gh-proxy > 官方直链），失败自动切下一个镜像。
        let urls: Vec<String> = entry
            .get("urls")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        let mut candidates: Vec<String> = Vec::new();
        for base in &urls {
            candidates.push(base.clone());
            if let Some(rest) = base.strip_prefix("https://huggingface.co/") {
                // hf-mirror 国内镜像（最稳），原样的 huggingface 官方路径直接换源。
                candidates.push(format!("https://hf-mirror.com/{rest}"));
            } else if let Some(rest) = base.strip_prefix("https://gh-proxy.com/https://huggingface.co/") {
                candidates.push(format!("https://hf-mirror.com/{rest}"));
            }
            if !base.starts_with("https://gh-proxy.com/") {
                candidates.push(format!("https://gh-proxy.com/{base}"));
            }
        }
        // 去重（同一地址出现多次时保留首个）。
        let mut seen = std::collections::HashSet::new();
        candidates.retain(|u| seen.insert(u.clone()));
        if candidates.is_empty() {
            anyhow::bail!("该模型没有下载链接");
        }

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(0)) // 大文件不限总超时
            .user_agent("Coomi")
            .build()?;

        let mut last_err = None;
        let mut failed_sources: Vec<String> = Vec::new();
        for (idx, url) in candidates.iter().enumerate() {
            eprintln!("[local-model] download try {idx}: {url}");
            match self.fetch_to_file(&client, url, &part_path).await {
                Ok(()) => {
                    fs::rename(&part_path, &final_path)
                        .context("重命名下载文件失败")?;
                    let _ = self.register_path(&final_path.display().to_string(), &name);
                    return Ok(format!("已下载 {file_name}（{size_mb} MB）"));
                }
                Err(e) => {
                    eprintln!("[local-model] url {idx} failed: {e}");
                    failed_sources.push(url.clone());
                    last_err = Some(e);
                    let _ = fs::remove_file(&part_path);
                    DL_DOWNLOADED.store(0, Ordering::SeqCst);
                }
            }
        }
        // 全部镜像失败：把尝试过的源列进报错，方便用户换源或反馈。
        let detail = if failed_sources.is_empty() {
            "所有下载源均失败".to_string()
        } else {
            format!("所有下载源均失败（尝试过 {} 个镜像）", failed_sources.len())
        };
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("{detail}")))
    }

    async fn fetch_to_file(
        &self,
        client: &reqwest::Client,
        url: &str,
        dest: &Path,
    ) -> Result<()> {
        // 断点续传：目标 .part 已存在部分内容时，从已写字节处继续（Range 请求 + append 写入）。
        let mut resume_from: u64 = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let mut req = client.get(url);
        if resume_from > 0 {
            req = req.header("Range", format!("bytes={resume_from}-"));
        }
        let resp = req
            .send()
            .await
            .context("请求失败")?;
        // 服务端支持断点返回 206；若忽略 Range 返回 200（完整内容）则重头写。
        match resp.status().as_u16() {
            // 服务端不支持断点续传（忽略 Range 返回 200）：直接从头完整下载。
            200 => {
                eprintln!("[local-model] server ignored Range, downloading from start");
                let resp = resp.error_for_status().context("HTTP 错误")?;
                let total = resp.content_length().unwrap_or(0);
                if total > 0 {
                    DL_TOTAL.store(total, Ordering::SeqCst);
                }
                let _ = fs::remove_file(dest);
                return self.stream_to_file(resp, dest, 0).await;
            }
            _ => {
                let resp = resp.error_for_status().context("HTTP 错误")?;
                // 206 续传：内容长度是剩余段，总进度 = 剩余 + 已续写。
                let full_total = resp.content_length().unwrap_or(0).saturating_add(resume_from);
                if full_total > 0 {
                    DL_TOTAL.store(full_total, Ordering::SeqCst);
                }
                return self.stream_to_file(resp, dest, resume_from).await;
            }
        }
    }

    /// 流式写入文件（支持从 offset 续写；dest 用 append 模式打开）。
    async fn stream_to_file(
        &self,
        resp: reqwest::Response,
        dest: &Path,
        offset: u64,
    ) -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(offset > 0)
            .write(true)
            .open(dest)?;
        if offset == 0 {
            file.set_len(0)?;
        }
        let mut stream = resp.bytes_stream();
        use futures_util::StreamExt;
        let mut downloaded: u64 = offset;
        let mut window_bytes: u64 = 0;
        let mut window_start = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            if DL_CANCEL.load(Ordering::SeqCst) {
                anyhow::bail!("已取消");
            }
            let chunk = chunk.context("读取数据块失败")?;
            file.write_all(&chunk)?;
            downloaded += chunk.len() as u64;
            window_bytes += chunk.len() as u64;
            DL_DOWNLOADED.store(downloaded, Ordering::SeqCst);
            let elapsed = window_start.elapsed().as_secs_f64();
            if elapsed >= 0.5 {
                DL_SPEED_BPS.store((window_bytes as f64 / elapsed) as u64, Ordering::SeqCst);
                window_bytes = 0;
                window_start = std::time::Instant::now();
            }
        }
        file.flush()?;
        file.sync_all()?;
        Ok(())
    }
}

async fn health_ok(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn which_llama_server(home: &Path) -> Option<PathBuf> {
    let candidates = [
        home.join("runtime-v2/home/.local/bin/llama-server"),
        home.join("runtime-v2/home/usr/bin/llama-server"),
        PathBuf::from("/usr/bin/llama-server"),
        PathBuf::from("/data/data/com.termux/files/usr/bin/llama-server"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// 注册/更新本地模型为 OpenAI 兼容 Provider。
pub fn ensure_local_provider(home: &Path, server_url: &str, model: &str) -> Result<PathBuf> {
    let path = home.join("config").join("providers.json");
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let mut doc: Value = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path)?).unwrap_or(json!({"version":1,"providers":{}}))
    } else {
        json!({"version":1,"providers":{}})
    };
    let providers = doc
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .context("providers.json 缺少 providers 对象")?;
    providers.insert(
        "local".into(),
        json!({
            "name": "本地模型",
            "type": "openai_compatible",
            "baseUrl": server_url.trim_end_matches('/').to_owned() + "/v1",
            "apiKey": "local",
            "model": model,
            "models": [model],
            "active": true,
        }),
    );
    fs::write(&path, serde_json::to_vec_pretty(&doc)?)?;
    Ok(path)
}
