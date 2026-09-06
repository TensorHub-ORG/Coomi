use anyhow::{Context, Result};
use async_trait::async_trait;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use reqwest::header::{ETAG, IF_RANGE, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::process::Stdio;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const RUNTIME_STATE_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBackendKind {
    LegacyTermux,
    ProotLinux,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeInstallStatus {
    NotInstalled,
    Downloading,
    Initializing,
    Ready,
    NeedsRepair,
    UpdateAvailable,
    RollingBack,
    Removing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeArtifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

impl RuntimeArtifact {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.url.starts_with("https://"),
            "runtime artifact URL must use HTTPS"
        );
        anyhow::ensure!(
            self.sha256.len() == 64 && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "runtime artifact SHA-256 is invalid"
        );
        anyhow::ensure!(self.size > 0, "runtime artifact size must be positive");
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeManifest {
    pub version: u32,
    pub runtime_version: String,
    pub architecture: String,
    pub proot_commit: String,
    pub proot_license: String,
    pub host: RuntimeArtifact,
    pub rootfs: RuntimeArtifact,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

impl RuntimeManifest {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.version == RUNTIME_STATE_VERSION,
            "unsupported runtime manifest version"
        );
        anyhow::ensure!(
            self.architecture == "arm64-v8a",
            "unsupported runtime architecture"
        );
        anyhow::ensure!(self.proot_commit.len() == 40, "PRoot commit must be pinned");
        anyhow::ensure!(
            self.proot_license == "GPL-2.0-or-later",
            "unexpected PRoot license"
        );
        self.host.validate()?;
        self.rootfs.validate()?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeState {
    pub version: u32,
    pub backend: RuntimeBackendKind,
    pub status: RuntimeInstallStatus,
    #[serde(default)]
    pub active_version: Option<String>,
    #[serde(default)]
    pub previous_version: Option<String>,
    #[serde(default)]
    pub installed_at_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            version: RUNTIME_STATE_VERSION,
            backend: RuntimeBackendKind::LegacyTermux,
            status: RuntimeInstallStatus::NotInstalled,
            active_version: None,
            previous_version: None,
            installed_at_ms: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct DownloadState {
    version: u32,
    url: String,
    etag: Option<String>,
    downloaded: u64,
    expected_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RuntimeDownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: u8,
    pub status: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeCommand {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Debug)]
pub struct RuntimeOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl RuntimeCommand {
    pub fn into_tokio(self) -> Command {
        let mut command = Command::new(self.program);
        command.args(self.arguments);
        command.env_clear();
        command.envs(self.environment);
        command.current_dir(self.cwd);
        command.stdin(Stdio::null());
        command
    }

    pub async fn output_limited(
        self,
        runtime_limit: Duration,
        output_limit: usize,
    ) -> Result<RuntimeOutput> {
        anyhow::ensure!(output_limit > 0, "runtime output limit must be positive");
        let mut command = self.into_tokio();
        command
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().context("failed to start runtime command")?;
        let stdout = child
            .stdout
            .take()
            .context("runtime command has no stdout")?;
        let stderr = child
            .stderr
            .take()
            .context("runtime command has no stderr")?;
        let stdout_reader = tokio::spawn(read_limited(stdout, output_limit));
        let stderr_reader = tokio::spawn(read_limited(stderr, output_limit));

        let status = match tokio::time::timeout(runtime_limit, child.wait()).await {
            Ok(status) => status.context("failed to wait for runtime command")?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = stdout_reader.await;
                let _ = stderr_reader.await;
                anyhow::bail!(
                    "runtime command exceeded {} seconds",
                    runtime_limit.as_secs()
                );
            }
        };
        let stdout = stdout_reader
            .await
            .context("runtime stdout reader stopped")??;
        let stderr = stderr_reader
            .await
            .context("runtime stderr reader stopped")??;
        anyhow::ensure!(
            stdout.len().saturating_add(stderr.len()) <= output_limit,
            "runtime command output exceeded {output_limit} bytes"
        );
        Ok(RuntimeOutput {
            status,
            stdout,
            stderr,
        })
    }
}

async fn read_limited<R>(stream: R, output_limit: usize) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let byte_limit = output_limit.saturating_add(1) as u64;
    let mut stream = stream.take(byte_limit);
    let mut output = Vec::with_capacity(output_limit.min(64 * 1024));
    stream.read_to_end(&mut output).await?;
    anyhow::ensure!(
        output.len() <= output_limit,
        "runtime command output exceeded {output_limit} bytes"
    );
    Ok(output)
}

#[async_trait]
pub trait RuntimeBackend: Send + Sync {
    fn kind(&self) -> RuntimeBackendKind;
    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand>;
    fn command_with_environment(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
        environment: &BTreeMap<String, String>,
    ) -> Result<RuntimeCommand> {
        let mut runtime_command = self.command(workspace, command, arguments)?;
        runtime_command.environment.extend(environment.clone());
        Ok(runtime_command)
    }
    async fn health_check(&self) -> Result<()>;
}

#[derive(Clone, Debug)]
pub struct LegacyTermuxBackend {
    pub prefix: PathBuf,
    pub home: PathBuf,
}

impl LegacyTermuxBackend {
    /// Resolve the Termux bootstrap roots from Coomi's config directory.
    /// Android launches the engine with COOMI_HOME at
    /// `<files>/home/.coomi`, while the bootstrap lives at `<files>/usr`.
    pub fn from_coomi_home(coomi_home: &Path) -> Self {
        let termux_home = coomi_home
            .file_name()
            .is_some_and(|name| name == ".coomi")
            .then(|| coomi_home.parent())
            .flatten()
            .filter(|home| home.file_name().is_some_and(|name| name == "home"));
        if let Some(termux_home) = termux_home
            && let Some(files_root) = termux_home.parent()
            && files_root.file_name().is_some_and(|name| name == "files")
        {
            return Self {
                prefix: files_root.join("usr"),
                home: termux_home.to_path_buf(),
            };
        }
        Self {
            prefix: coomi_home.join("files/usr"),
            home: coomi_home.join("files/home"),
        }
    }
}

#[async_trait]
impl RuntimeBackend for LegacyTermuxBackend {
    fn kind(&self) -> RuntimeBackendKind {
        RuntimeBackendKind::LegacyTermux
    }

    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand> {
        // Runtime callers use Linux-style absolute names (for example
        // `/bin/sh`).  Those names belong to the selected runtime namespace;
        // they must be resolved inside Termux's PREFIX instead of being
        // appended as an absolute host path.
        let program = termux_program_path(&self.prefix, command);
        anyhow::ensure!(
            program.is_file(),
            "Termux executable is missing at {}; resolved PREFIX is {}",
            program.display(),
            self.prefix.display()
        );
        let mut environment = minimal_environment(&self.home, &self.prefix.join("tmp"));
        environment.insert("PREFIX".into(), self.prefix.to_string_lossy().into_owned());
        environment.insert(
            "PATH".into(),
            format!("{}/bin:/system/bin", self.prefix.display()),
        );
        environment.insert(
            "LD_LIBRARY_PATH".into(),
            self.prefix.join("lib").to_string_lossy().into_owned(),
        );
        let preload = self.prefix.join("lib/libtermux-exec-ld-preload.so");
        if preload.is_file() {
            environment.insert("LD_PRELOAD".into(), preload.to_string_lossy().into_owned());
        }
        environment.insert(
            "SHELL".into(),
            self.prefix.join("bin/bash").to_string_lossy().into_owned(),
        );
        environment.insert(
            "SSL_CERT_FILE".into(),
            self.prefix
                .join("etc/tls/cert.pem")
                .to_string_lossy()
                .into_owned(),
        );
        environment.insert("COOMI_RUNTIME_BACKEND".into(), "termux".into());
        Ok(RuntimeCommand {
            program,
            arguments: arguments.to_vec(),
            environment,
            cwd: workspace.to_owned(),
        })
    }

    async fn health_check(&self) -> Result<()> {
        anyhow::ensure!(
            self.prefix.join("bin/sh").is_file(),
            "legacy shell is missing"
        );
        Ok(())
    }
}

fn termux_program_path(prefix: &Path, command: &str) -> PathBuf {
    let command = command.trim();
    let relative = command
        .strip_prefix("/bin/")
        .or_else(|| command.strip_prefix("/usr/bin/"))
        .or_else(|| command.strip_prefix('/'))
        .unwrap_or(command);
    // Termux's PREFIX already represents `/usr`; both Linux spellings map
    // to PREFIX/bin, never PREFIX/usr/bin.
    prefix.join("bin").join(relative)
}

#[derive(Clone, Debug)]
pub struct ProotLinuxBackend {
    pub runtime_root: PathBuf,
    pub version: String,
}

impl ProotLinuxBackend {
    fn version_root(&self) -> PathBuf {
        self.runtime_root.join("versions").join(&self.version)
    }

    fn proot(&self) -> PathBuf {
        self.version_root().join("bin").join("proot")
    }

    fn rootfs(&self) -> PathBuf {
        self.version_root().join("rootfs")
    }
}

#[async_trait]
impl RuntimeBackend for ProotLinuxBackend {
    fn kind(&self) -> RuntimeBackendKind {
        RuntimeBackendKind::ProotLinux
    }

    fn command(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
    ) -> Result<RuntimeCommand> {
        self.command_with_environment(workspace, command, arguments, &BTreeMap::new())
    }

    fn command_with_environment(
        &self,
        workspace: &Path,
        command: &str,
        arguments: &[String],
        guest_environment: &BTreeMap<String, String>,
    ) -> Result<RuntimeCommand> {
        let rootfs = self.rootfs();
        anyhow::ensure!(self.proot().is_file(), "PRoot host is not installed");
        anyhow::ensure!(
            rootfs.join("bin/sh").is_file(),
            "guest rootfs is incomplete"
        );
        let home = self.runtime_root.join("home");
        let build_kit = home.join(".coomi-dev");
        let tmp = self.runtime_root.join("tmp");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&build_kit)?;
        fs::create_dir_all(&tmp)?;
        let workspace = canonical_existing(workspace)?;
        let home = canonical_existing(&home)?;
        let build_kit = canonical_existing(&build_kit)?;
        let tmp = canonical_existing(&tmp)?;
        let mut proot_args = vec![
            "--kill-on-exit".into(),
            "-0".into(),
            "-r".into(),
            rootfs.to_string_lossy().into_owned(),
            "-b".into(),
            format!("{}:/workspace", workspace.display()),
            "-b".into(),
            format!("{}:/home/coomi", home.display()),
            "-b".into(),
            format!("{}:/opt/coomi-dev", build_kit.display()),
            "-b".into(),
            format!("{}:/tmp", tmp.display()),
            // Expose the same verified host launcher inside the guest so
            // `which proot` and tools that explicitly invoke PRoot resolve to
            // the Runtime V2 binary instead of falling back to Termux.
            "-b".into(),
            format!("{}:/usr/local/bin/proot", self.proot().display()),
            "-b".into(),
            "/proc".into(),
            "-b".into(),
            "/dev".into(),
            "-w".into(),
            "/workspace".into(),
            "/usr/bin/env".into(),
            "-i".into(),
            "HOME=/home/coomi".into(),
            // /home/coomi/.local/bin：pip install --user 与用户脚本的位置，
            // 不依赖 .profile 是否被加载（shell 工具用非交互 shell 启动）。
            "PATH=/home/coomi/.local/bin:/home/coomi/bin:/opt/coomi-dev/current/bin:/opt/coomi-dev/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
            "TMPDIR=/tmp".into(),
            "COOMI_RUNTIME_BACKEND=proot_linux".into(),
            "COOMI_BUILD_KIT=/opt/coomi-dev".into(),
            "COOMI_PROOT_HOST=/usr/local/bin/proot".into(),
            "LANG=C.UTF-8".into(),
            "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt".into(),
        ];
        for (key, value) in guest_environment {
            anyhow::ensure!(
                !key.is_empty()
                    && key.bytes().all(|byte| byte.is_ascii_uppercase()
                        || byte.is_ascii_digit()
                        || byte == b'_'),
                "invalid guest environment key"
            );
            anyhow::ensure!(!value.contains('\0'), "invalid guest environment value");
            proot_args.push(format!("{key}={value}"));
        }
        proot_args.push(command.into());
        proot_args.extend(arguments.iter().cloned());
        Ok(RuntimeCommand {
            program: self.proot(),
            arguments: proot_args,
            environment: {
                let mut environment = minimal_environment(&home, &tmp);
                // PRoot otherwise falls back to the compile-time Termux temp
                // path (/data/data/com.termux/...), which does not exist in
                // the standalone Coomi package.
                environment.insert(
                    "PROOT_TMP_DIR".into(),
                    tmp.to_string_lossy().into_owned(),
                );
                environment.insert(
                    "LD_LIBRARY_PATH".into(),
                    self.version_root()
                        .join("lib")
                        .to_string_lossy()
                        .into_owned(),
                );
                environment
            },
            cwd: workspace,
        })
    }

    async fn health_check(&self) -> Result<()> {
        let command = self.command(
            &self.runtime_root,
            "/bin/sh",
            &[
                "-c".into(),
                "test -x /usr/bin/apt && test -x /usr/bin/python3".into(),
            ],
        )?;
        let output = command.into_tokio().output().await?;
        anyhow::ensure!(
            output.status.success(),
            "guest health check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(())
    }
}

/// guest 环境事实（执行探测结果），供 runtime_doctor、提示词注入与前端徽标使用。
#[derive(Clone, Debug, Default, Serialize)]
pub struct GuestFacts {
    pub backend: String,
    pub sh: bool,
    pub os: Option<String>,
    pub python: Option<String>,
    pub git: Option<String>,
    pub node: Option<String>,
    pub curl: Option<String>,
    pub network: Option<String>,
    pub workspace: bool,
    pub tmp_writable: bool,
    pub error: Option<String>,
}

/// 在指定后端内实际执行一次探测：shell 可运行 + 工具链版本 + 挂载点可达。
pub async fn probe_guest_facts(
    backend: &impl RuntimeBackend,
    workspace: &Path,
) -> Result<GuestFacts> {
    let script = r#"
echo "__sh__ok"
. /etc/os-release 2>/dev/null && echo "__os__${PRETTY_NAME:-}" || echo "__os__"
test -d /workspace && echo "__workspace__ok" || echo "__workspace__missing"
test -w /tmp && echo "__tmp__ok" || echo "__tmp__no"
if command -v python3 >/dev/null 2>&1; then echo "__python__$(python3 --version 2>&1 | head -1)"; fi
if command -v git >/dev/null 2>&1; then echo "__git__$(git --version 2>&1 | head -1)"; fi
if command -v node >/dev/null 2>&1; then echo "__node__$(node -v 2>&1 | head -1)"; fi
if command -v curl >/dev/null 2>&1; then echo "__curl__$(curl --version 2>&1 | head -1)"; echo "__net__$(curl -sS -m 5 -o /dev/null -w '%{http_code}' https://coomi.septemc.com/ 2>&1)"; else echo "__net__no-curl"; fi
"#;
    let result = match backend.command_with_environment(
        workspace,
        "/bin/sh",
        &["-c".into(), script.trim().into()],
        &BTreeMap::new(),
    ) {
        Ok(command) => command.output_limited(Duration::from_secs(20), 64 * 1024).await,
        Err(error) => Err(error),
    };
    let mut facts = GuestFacts {
        backend: match backend.kind() {
            RuntimeBackendKind::ProotLinux => "proot_linux".into(),
            RuntimeBackendKind::LegacyTermux => "legacy_termux".into(),
        },
        ..GuestFacts::default()
    };
    match result {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let line = line.trim();
                if let Some(_) = line.strip_prefix("__sh__ok") {
                    facts.sh = true;
                } else if let Some(value) = line.strip_prefix("__os__") {
                    let value = value.trim();
                    if !value.is_empty() {
                        facts.os = Some(value.to_owned());
                    }
                } else if line == "__workspace__ok" {
                    facts.workspace = true;
                } else if line == "__tmp__ok" {
                    facts.tmp_writable = true;
                } else if let Some(value) = line.strip_prefix("__python__") {
                    facts.python = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__git__") {
                    facts.git = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__node__") {
                    facts.node = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__curl__") {
                    facts.curl = Some(value.trim().to_owned());
                } else if let Some(value) = line.strip_prefix("__net__") {
                    let value = value.trim();
                    facts.network = if value.is_empty() {
                        None
                    } else {
                        Some(value.to_owned())
                    };
                }
            }
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    facts.error = Some(stderr.trim().chars().take(300).collect());
                }
            }
        }
        Err(error) => {
            facts.error = Some(format!("{error:#}").chars().take(300).collect());
        }
    }
    Ok(facts)
}

#[derive(Clone, Debug)]
pub struct RuntimeManager {
    root: PathBuf,
    state_path: PathBuf,
}

impl RuntimeManager {
    pub fn open(home: &Path) -> Result<Self> {
        let root = home.join("runtime-v2");
        fs::create_dir_all(root.join("versions"))?;
        fs::create_dir_all(root.join("downloads"))?;
        let manager = Self {
            state_path: root.join("state.json"),
            root,
        };
        if !manager.state_path.exists() {
            manager.save_state(&RuntimeState::default())?;
        }
        Ok(manager)
    }

    pub fn state(&self) -> Result<RuntimeState> {
        let bytes = fs::read(&self.state_path)?;
        let state: RuntimeState = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            state.version == RUNTIME_STATE_VERSION,
            "unsupported runtime state version"
        );
        Ok(state)
    }

    pub fn download_progress(
        &self,
        name: &str,
        artifact: &RuntimeArtifact,
    ) -> RuntimeDownloadProgress {
        let target = self.root.join("downloads").join(name);
        let partial = target.with_extension("partial");
        let downloaded = if target.is_file() {
            artifact.size
        } else {
            fs::metadata(partial).map(|value| value.len()).unwrap_or(0)
        };
        let downloaded = downloaded.min(artifact.size);
        let status = if target.is_file() {
            "completed"
        } else if downloaded > 0 {
            "downloading"
        } else {
            "pending"
        };
        let percent = if artifact.size == 0 {
            0
        } else {
            ((downloaded.saturating_mul(100)) / artifact.size).min(100) as u8
        };
        RuntimeDownloadProgress {
            downloaded,
            total: artifact.size,
            percent,
            status: status.into(),
        }
    }

    pub fn begin_install(&self) -> Result<RuntimeState> {
        let mut state = self.state()?;
        anyhow::ensure!(
            matches!(
                state.status,
                RuntimeInstallStatus::NotInstalled
                    | RuntimeInstallStatus::NeedsRepair
                    | RuntimeInstallStatus::UpdateAvailable
            ),
            "runtime installation is already in progress"
        );
        state.status = RuntimeInstallStatus::Downloading;
        state.error = None;
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn fail_install(&self, error: impl Into<String>) -> Result<RuntimeState> {
        let mut state = self.state()?;
        state.status = if state.active_version.is_some() {
            RuntimeInstallStatus::NeedsRepair
        } else {
            RuntimeInstallStatus::NotInstalled
        };
        state.error = Some(error.into());
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn backend(
        &self,
        legacy_prefix: PathBuf,
        legacy_home: PathBuf,
    ) -> Result<Box<dyn RuntimeBackend>> {
        let state = self.state()?;
        if state.backend == RuntimeBackendKind::ProotLinux
            && state.status == RuntimeInstallStatus::Ready
            && let Some(version) = state.active_version
        {
            return Ok(Box::new(ProotLinuxBackend {
                runtime_root: self.root.clone(),
                version,
            }));
        }
        Ok(Box::new(LegacyTermuxBackend {
            prefix: legacy_prefix,
            home: legacy_home,
        }))
    }

    pub async fn download_artifact(
        &self,
        name: &str,
        artifact: &RuntimeArtifact,
    ) -> Result<PathBuf> {
        artifact.validate()?;
        anyhow::ensure!(
            name.chars()
                .all(|character| character.is_ascii_alphanumeric()
                    || matches!(character, '-' | '_' | '.')),
            "invalid runtime artifact name"
        );
        let target = self.root.join("downloads").join(name);
        if target.is_file() {
            if verify_artifact(&target, artifact).is_ok() {
                return Ok(target);
            }
            fs::remove_file(&target)?;
        }
        let partial = target.with_extension("partial");
        let state_path = target.with_extension("download.json");
        let mut offset = fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
        let old_state = fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DownloadState>(&bytes).ok())
            .filter(|state| state.url == artifact.url && state.expected_sha256 == artifact.sha256);
        if old_state.is_none() && partial.exists() {
            fs::remove_file(&partial)?;
            offset = 0;
        }
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .build()?;
        let mut request = client.get(&artifact.url);
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
            if let Some(etag) = old_state.as_ref().and_then(|state| state.etag.as_deref()) {
                request = request.header(IF_RANGE, etag);
            }
        }
        let response = request.send().await?;
        anyhow::ensure!(
            response.status().is_success(),
            "runtime download failed with HTTP {}",
            response.status()
        );
        let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if offset > 0 && !resumed {
            offset = 0;
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&partial)
            .await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            offset = offset.saturating_add(chunk.len() as u64);
            save_json(
                &state_path,
                &DownloadState {
                    version: 1,
                    url: artifact.url.clone(),
                    etag: etag.clone(),
                    downloaded: offset,
                    expected_sha256: artifact.sha256.clone(),
                },
            )?;
        }
        file.flush().await?;
        drop(file);
        anyhow::ensure!(offset == artifact.size, "runtime artifact size mismatch");
        anyhow::ensure!(
            sha256_file(&partial)? == artifact.sha256,
            "runtime artifact checksum mismatch"
        );
        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&partial, &target)?;
        if state_path.exists() {
            fs::remove_file(state_path)?;
        }
        Ok(target)
    }

    pub fn install(
        &self,
        manifest: &RuntimeManifest,
        host_file: &Path,
        rootfs_tar: &Path,
    ) -> Result<RuntimeState> {
        manifest.validate()?;
        verify_artifact(host_file, &manifest.host)?;
        verify_artifact(rootfs_tar, &manifest.rootfs)?;
        let mut state = self.state()?;
        state.status = RuntimeInstallStatus::Initializing;
        state.error = None;
        self.save_state(&state)?;
        let staging = self
            .root
            .join("versions")
            .join(format!("{}.staging", manifest.runtime_version));
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir_all(&staging)?;
        unpack_archive(open_archive(host_file)?, &staging)?;
        let host = staging.join("bin").join("proot");
        anyhow::ensure!(host.is_file(), "PRoot host archive has no bin/proot");
        set_executable(&host)?;
        let rootfs = staging.join("rootfs");
        fs::create_dir_all(&rootfs)?;
        unpack_archive(open_archive(rootfs_tar)?, &rootfs)?;
        anyhow::ensure!(rootfs.join("bin/sh").is_file(), "rootfs has no /bin/sh");
        let destination = self.root.join("versions").join(&manifest.runtime_version);
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        fs::rename(&staging, &destination)?;
        // 清理 Termux 时代遗留的登录脚本（可能引用 /root/.cargo/env 等失效路径），
        // 避免 guest 登录 shell（-lc）加载它们导致环境问题。
        let guest_home = self.root.join("home");
        for name in [".profile", ".bashrc", ".bash_profile", ".zshrc"] {
            let _ = fs::remove_file(guest_home.join(name));
        }
        self.ensure_guest_dns()?;
        state.previous_version = state.active_version.take();
        state.active_version = Some(manifest.runtime_version.clone());
        state.backend = RuntimeBackendKind::ProotLinux;
        state.status = RuntimeInstallStatus::Ready;
        state.installed_at_ms = Some(now_ms());
        self.save_state(&state)?;
        Ok(state)
    }

    /// 修复 guest DNS：debootstrap 产物里的 /etc/resolv.conf 可能停留在构建机
    /// （如 systemd-resolved 的 127.0.0.53），guest 内无监听者导致解析全挂。
    /// 统一重写为公共 DNS。对当前激活版本幂等。
    pub fn ensure_guest_dns(&self) -> Result<()> {
        let state = self.state()?;
        let Some(version) = state.active_version else {
            return Ok(());
        };
        let rootfs = self.root.join("versions").join(&version).join("rootfs");
        fs::create_dir_all(rootfs.join("etc"))?;
        fs::write(
            rootfs.join("etc").join("resolv.conf"),
            "# Coomi guest DNS (rewritten at install time)\n\
             nameserver 223.5.5.5\n\
             nameserver 119.29.29.29\n\
             nameserver 8.8.8.8\n",
        )?;
        Ok(())
    }

    pub fn migrate_legacy_home(&self, legacy_home: &Path) -> Result<u64> {        let destination = self.root.join("home");
        fs::create_dir_all(&destination)?;
        let copied = copy_user_tree(legacy_home, &destination)?;
        // Termux 时代的登录脚本（.profile/.bashrc 等）在 guest 里会引用 /root/.cargo/env 等
        // 不存在的路径，污染登录 shell（-lc）。迁移后统一清掉，让 guest 使用干净默认。
        for name in [".profile", ".bashrc", ".bash_profile", ".zshrc"] {
            let _ = fs::remove_file(destination.join(name));
        }
        Ok(copied)
    }

    pub fn rollback(&self) -> Result<RuntimeState> {
        let mut state = self.state()?;
        let previous = state
            .previous_version
            .clone()
            .context("no runtime version is available for rollback")?;
        anyhow::ensure!(
            self.root.join("versions").join(&previous).is_dir(),
            "rollback runtime is missing"
        );
        state.status = RuntimeInstallStatus::RollingBack;
        self.save_state(&state)?;
        let active = state.active_version.replace(previous);
        state.previous_version = active;
        state.status = RuntimeInstallStatus::Ready;
        state.error = None;
        self.save_state(&state)?;
        Ok(state)
    }

    pub fn remove(&self) -> Result<RuntimeState> {
        let mut state = self.state()?;
        state.status = RuntimeInstallStatus::Removing;
        self.save_state(&state)?;
        let versions = self.root.join("versions");
        if versions.exists() {
            fs::remove_dir_all(&versions)?;
        }
        fs::create_dir_all(versions)?;
        state = RuntimeState::default();
        self.save_state(&state)?;
        Ok(state)
    }

    fn save_state(&self, state: &RuntimeState) -> Result<()> {
        save_json(&self.state_path, state)
    }
}

fn minimal_environment(home: &Path, tmp: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        (
            "PATH".into(),
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        ),
        ("TMPDIR".into(), tmp.to_string_lossy().into_owned()),
        ("LANG".into(), "C.UTF-8".into()),
        (
            "SSL_CERT_FILE".into(),
            "/etc/ssl/certs/ca-certificates.crt".into(),
        ),
    ])
}

fn canonical_existing(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("runtime bind path does not exist: {}", path.display()))
}

fn verify_artifact(path: &Path, artifact: &RuntimeArtifact) -> Result<()> {
    anyhow::ensure!(
        fs::metadata(path)?.len() == artifact.size,
        "runtime artifact size mismatch"
    );
    anyhow::ensure!(
        sha256_file(path)? == artifact.sha256,
        "runtime artifact checksum mismatch"
    );
    Ok(())
}

fn open_archive(path: &Path) -> Result<Box<dyn Read>> {
    let file = File::open(path)?;
    if path.extension().and_then(|value| value.to_str()) == Some("gz") {
        Ok(Box::new(GzDecoder::new(file)))
    } else {
        Ok(Box::new(file))
    }
}

/// Android's app-private filesystem rejects hard-link creation. Expand tar
/// hard-link entries into ordinary file copies while retaining tar's normal
/// handling for directories, files and symlinks.
fn unpack_archive(reader: Box<dyn Read>, destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(reader);
    let mut hard_links = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_hard_link() {
            let path = archive_path(entry.path()?)?;
            let link = archive_path(entry.link_name()?.context("hard link has no target")?)?;
            hard_links.push((path, link));
            continue;
        }
        anyhow::ensure!(
            entry.unpack_in(destination)?,
            "archive path escaped destination"
        );
    }
    for (path, link) in hard_links {
        let target = destination.join(&link);
        let output = destination.join(&path);
        anyhow::ensure!(target.is_file(), "hard link target is missing: {}", link.display());
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&target, &output).with_context(|| {
            format!("failed to expand hard link {} -> {}", path.display(), link.display())
        })?;
        if let Ok(permissions) = fs::metadata(&target).map(|metadata| metadata.permissions()) {
            let _ = fs::set_permissions(&output, permissions);
        }
    }
    Ok(())
}

fn archive_path(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => clean.push(value),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                anyhow::bail!("archive path escapes destination")
            }
        }
    }
    anyhow::ensure!(!clean.as_os_str().is_empty(), "archive path is empty");
    Ok(clean)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn save_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("state path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn copy_user_tree(source: &Path, destination: &Path) -> Result<u64> {
    if !source.is_dir() {
        return Ok(0);
    }
    let mut copied = 0u64;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if matches!(
            name.to_str(),
            Some("usr" | ".cache" | ".profile" | ".bashrc" | ".bash_profile" | ".zshrc")
        ) {
            continue;
        }
        let target = destination.join(&name);
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&target)?;
            copied = copied.saturating_add(copy_user_tree(&entry.path(), &target)?);
        } else if entry.file_type()?.is_file() && !target.exists() {
            copied = copied.saturating_add(fs::copy(entry.path(), target)?);
        }
    }
    Ok(copied)
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn termux_resolves_linux_shell_names_inside_prefix() {
        let prefix = Path::new("/data/data/com.coomi.android/files/usr");
        assert_eq!(
            termux_program_path(prefix, "/bin/sh"),
            prefix.join("bin/sh")
        );
        assert_eq!(
            termux_program_path(prefix, "/usr/bin/env"),
            prefix.join("bin/env")
        );
        assert_eq!(termux_program_path(prefix, "bash"), prefix.join("bin/bash"));
    }

    #[test]
    fn termux_layout_is_derived_from_android_coomi_home() {
        let backend = LegacyTermuxBackend::from_coomi_home(Path::new(
            "/data/data/com.coomi.android/files/home/.coomi",
        ));
        assert_eq!(
            backend.prefix,
            PathBuf::from("/data/data/com.coomi.android/files/usr")
        );
        assert_eq!(
            backend.home,
            PathBuf::from("/data/data/com.coomi.android/files/home")
        );
    }

    #[test]
    fn termux_command_uses_android_native_environment() {
        let root = tempfile::tempdir().expect("temporary Termux root");
        let prefix = root.path().join("files/usr");
        let home = root.path().join("files/home");
        fs::create_dir_all(prefix.join("bin")).expect("create bin");
        fs::create_dir_all(prefix.join("lib")).expect("create lib");
        fs::create_dir_all(&home).expect("create home");
        fs::write(prefix.join("bin/sh"), b"shell").expect("create shell");
        let backend = LegacyTermuxBackend {
            prefix,
            home: home.clone(),
        };
        let command = backend
            .command(&home, "/bin/sh", &["-lc".into(), "pwd".into()])
            .expect("Termux command");
        assert_eq!(command.program, backend.prefix.join("bin/sh"));
        assert_eq!(
            command.environment.get("LD_LIBRARY_PATH").map(String::as_str),
            Some(backend.prefix.join("lib").to_string_lossy().as_ref())
        );
        assert_eq!(
            command.environment.get("COOMI_RUNTIME_BACKEND").map(String::as_str),
            Some("termux")
        );
    }

    #[tokio::test]
    async fn bounded_runtime_reader_rejects_excess_output() {
        let (mut writer, reader) = tokio::io::duplex(32);
        tokio::spawn(async move {
            writer.write_all(b"12345").await.expect("write output");
        });
        let error = read_limited(reader, 4)
            .await
            .expect_err("output over the limit must fail");
        assert!(error.to_string().contains("exceeded 4 bytes"));
    }

    #[test]
    fn validates_pinned_manifest_and_rejects_unverified_downloads() {
        let artifact = RuntimeArtifact {
            url: "https://example.test/runtime.tar".into(),
            sha256: "a".repeat(64),
            size: 1,
        };
        let manifest = RuntimeManifest {
            version: RUNTIME_STATE_VERSION,
            runtime_version: "debian-13.1-1".into(),
            architecture: "arm64-v8a".into(),
            proot_commit: "b".repeat(40),
            proot_license: "GPL-2.0-or-later".into(),
            host: artifact.clone(),
            rootfs: artifact,
            environment: BTreeMap::new(),
        };
        manifest.validate().expect("valid manifest");
        let mut invalid = manifest;
        invalid.rootfs.sha256 = "not-a-checksum".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn migrates_home_without_usr_or_existing_files() {
        let home = tempfile::tempdir().expect("temporary home");
        let legacy = home.path().join("legacy");
        fs::create_dir_all(legacy.join("usr/bin")).expect("create legacy usr");
        fs::create_dir_all(legacy.join("project")).expect("create project");
        fs::write(legacy.join("usr/bin/apt"), "old").expect("write apt");
        fs::write(legacy.join("project/main.py"), "print(1)").expect("write project");
        let manager = RuntimeManager::open(home.path()).expect("open runtime");
        manager.migrate_legacy_home(&legacy).expect("migrate");
        assert!(
            home.path()
                .join("runtime-v2/home/project/main.py")
                .is_file()
        );
        assert!(!home.path().join("runtime-v2/home/usr").exists());
    }

    #[test]
    fn persists_install_progress_and_recoverable_failure() {
        let home = tempfile::tempdir().expect("temporary home");
        let manager = RuntimeManager::open(home.path()).expect("open runtime");
        let downloading = manager.begin_install().expect("begin installation");
        assert_eq!(downloading.status, RuntimeInstallStatus::Downloading);
        assert!(manager.begin_install().is_err());

        let failed = manager
            .fail_install("network unavailable")
            .expect("record failure");
        assert_eq!(failed.status, RuntimeInstallStatus::NotInstalled);
        assert_eq!(failed.error.as_deref(), Some("network unavailable"));
    }

    #[test]
    fn proot_command_exposes_only_explicit_mounts() {
        let home = tempfile::tempdir().expect("temporary home");
        let workspace = home.path().join("workspace");
        let version = home.path().join("versions/v1");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(version.join("bin")).expect("create bin");
        fs::create_dir_all(version.join("rootfs/bin")).expect("create rootfs");
        fs::create_dir_all(home.path().join("home")).expect("create home");
        fs::create_dir_all(home.path().join("tmp")).expect("create tmp");
        fs::write(version.join("bin/proot"), "binary").expect("write proot");
        fs::write(version.join("rootfs/bin/sh"), "shell").expect("write shell");
        let backend = ProotLinuxBackend {
            runtime_root: home.path().to_owned(),
            version: "v1".into(),
        };
        let command = backend
            .command(&workspace, "/bin/sh", &["-lc".into(), "true".into()])
            .expect("build command");
        let joined = command.arguments.join(" ");
        assert!(joined.contains(":/workspace"));
        assert!(joined.contains(":/home/coomi"));
        assert!(joined.contains(":/opt/coomi-dev"));
        assert!(joined.contains(":/usr/local/bin/proot"));
        assert!(
            joined.contains("PATH=/home/coomi/.local/bin:/home/coomi/bin:/opt/coomi-dev/current/bin:/opt/coomi-dev/bin:/usr/local/sbin")
        );
        assert!(command.environment.contains_key("PROOT_TMP_DIR"));
        assert!(!joined.contains("/storage/emulated"));
    }
}
