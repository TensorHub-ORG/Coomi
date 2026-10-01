use anyhow::Context;
use anyhow::Result;
use coomi_telemetry::Telemetry;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

const MCP_CATALOG: &str = include_str!("../mcp.json");
const SKILL_CATALOG: &str = include_str!("../skills.json");
const CUSTOM_ITERATION_SKILL: &str = include_str!("../coomi-custom-iteration.md");
const RUNTIME_ENVIRONMENT_SKILL: &str = include_str!("../runtime-environments.md");
const SKILL_CREATOR_SKILL: &str = include_str!("../skill-creator.md");
const COOMIDEV_ENV: &str = include_str!("../../../../tools/mobile-build/coomidev-env.sh");
const COOMIDEV_DOCTOR: &str = include_str!("../../../../tools/mobile-build/coomidev-doctor.sh");
const COOMIDEV_BUILD: &str = include_str!("../../../../tools/mobile-build/build-coomidev.sh");
const COOMIDEV_INSTALL_BUILDKIT: &str =
    include_str!("../../../../tools/mobile-build/install-coomidev-buildkit.sh");

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Catalog<T> {
    pub version: u32,
    pub entries: Vec<T>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequiredParameter {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub transport: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub required_parameters: Vec<RequiredParameter>,
    /// 支持的操作系统标识（windows/macos/linux/android）。缺省＝全部平台。
    /// 手机专用或桌面不适用的条目必须显式收窄，否则会在别的平台上装出一个
    /// 永远拉不起来的服务器（「装了但用不了」）。
    #[serde(default = "all_platforms")]
    pub platforms: Vec<String>,
    /// 除 command 之外还必须在 PATH 上找到的可执行文件（docker/kubectl/git…）。
    #[serde(default)]
    pub requires: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repository: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub subdir: String,
    /// 支持的操作系统标识（windows/macos/linux/android）。缺省＝全部平台。
    #[serde(default = "all_platforms")]
    pub platforms: Vec<String>,
}

pub fn builtin_mcp() -> Result<Catalog<McpEntry>> {
    serde_json::from_str(MCP_CATALOG).context("built-in MCP catalog is invalid")
}

pub fn builtin_skills() -> Result<Catalog<SkillEntry>> {
    serde_json::from_str(SKILL_CATALOG).context("built-in Skill catalog is invalid")
}

/// 本地中译词表条目：id → 中文名 + 中文描述。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TranslationEntry {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

const TOOLS_ZH: &str = include_str!("../tools_zh.json");

/// 内置目录的本地中译词表（前端与后端共用同一份 tools_zh.json）。
///
/// 键统一小写（与目录 id 忽略大小写匹配）；translate 接口先查词表，
/// 未命中的 id 才走免费翻译 API —— 常见条目（内置 MCP / Skill）永远不会碰网络。
pub fn builtin_translation() -> Result<BTreeMap<String, TranslationEntry>> {
    let document: Value = serde_json::from_str(TOOLS_ZH)
        .context("built-in translation dictionary is invalid")?;
    let mut out = BTreeMap::new();
    if let Some(entries) = document.get("entries").and_then(Value::as_object) {
        for (id, value) in entries {
            if let Ok(entry) = serde_json::from_value::<TranslationEntry>(value.clone()) {
                out.insert(id.to_ascii_lowercase(), entry);
            }
        }
    }
    Ok(out)
}

/// 目录条目默认支持的平台：四个宿主都支持，除非条目显式收窄。
pub const SUPPORTED_PLATFORMS: [&str; 4] = ["windows", "macos", "linux", "android"];

pub fn all_platforms() -> Vec<String> {
    SUPPORTED_PLATFORMS
        .iter()
        .map(|platform| (*platform).to_string())
        .collect()
}

/// 当前宿主的平台标识（与 platforms 字段同一套取值）。
pub fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "android" => "android",
        _ => "linux",
    }
}

/// 平台标识 → 中文名。
pub fn platform_label(platform: &str) -> &'static str {
    match platform.to_ascii_lowercase().as_str() {
        "windows" => "Windows",
        "macos" => "macOS",
        "android" => "Android",
        "linux" => "Linux",
        _ => "未知系统",
    }
}

/// 运行时可执行文件 → 中文名（用于「本机缺少 XX」这类可读提示）。
pub fn runtime_label(executable: &str) -> String {
    match executable.to_ascii_lowercase().as_str() {
        "npx" => "Node.js（npx）".into(),
        "npm" => "Node.js（npm）".into(),
        "node" => "Node.js".into(),
        "uvx" | "uv" => "uv（uvx）".into(),
        "docker" => "Docker CLI".into(),
        "kubectl" => "kubectl".into(),
        "git" => "Git".into(),
        "ffmpeg" => "FFmpeg".into(),
        "python" | "python3" => "Python".into(),
        other => other.to_string(),
    }
}

/// 条目真正需要的可执行文件：command 本身 + 显式声明的 requires（去重）。
pub fn entry_requires(entry: &McpEntry) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for executable in std::iter::once(&entry.command).chain(entry.requires.iter()) {
        let executable = executable.trim();
        if executable.is_empty() {
            continue;
        }
        if !out
            .iter()
            .any(|seen| seen.eq_ignore_ascii_case(executable))
        {
            out.push(executable.to_string());
        }
    }
    out
}

/// 按 PATH（Windows 上再按 PATHEXT）解析可执行文件的真实路径。
/// Windows 的 npx 实际是 npx.cmd，uvx 是 uvx.exe：只按文件名 spawn 会直接失败，
/// 所以「本机有没有这个运行时」必须用同一套解析逻辑判断。
pub fn find_executable(command: &str) -> Option<PathBuf> {
    find_executable_in(command, &std::env::var("PATH").unwrap_or_default())
}

fn find_executable_in(command: &str, search_path: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    if command.contains('/') || command.contains('\\') {
        return executable_candidate(Path::new(command));
    }
    std::env::split_paths(search_path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .find_map(|directory| executable_candidate(&directory.join(command)))
}

fn executable_candidate(base: &Path) -> Option<PathBuf> {
    if base.extension().is_some() {
        return base.is_file().then(|| base.to_path_buf());
    }
    if cfg!(windows) {
        // 无扩展名时必须先按 PATHEXT 找 npx.cmd / uvx.exe：Node.js 的安装目录里
        // 同时存在一个给 Git Bash 用的无扩展名 npx 脚本，先撞上它会被误判成可用。
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        for extension in pathext.split(';').map(str::trim).filter(|v| !v.is_empty()) {
            let mut name = base.as_os_str().to_os_string();
            name.push(extension);
            let candidate = PathBuf::from(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    base.is_file().then(|| base.to_path_buf())
}

/// MCP 条目在本机是否可直接使用；不可用时返回中文原因（UI 直接展示，安装接口直接拒绝）。
pub fn mcp_unavailable_reason(entry: &McpEntry) -> Option<String> {
    platform_unavailable_reason(&entry.platforms)
        .or_else(|| missing_runtimes_reason(&entry_requires(entry)))
}

/// Skill 条目在本机是否可直接使用；不可用时返回中文原因。
pub fn skill_unavailable_reason(entry: &SkillEntry) -> Option<String> {
    platform_unavailable_reason(&entry.platforms)
}

fn platform_unavailable_reason(platforms: &[String]) -> Option<String> {
    let host = host_platform();
    if platforms
        .iter()
        .any(|value| value.eq_ignore_ascii_case(host))
    {
        return None;
    }
    let names = platforms
        .iter()
        .map(|value| platform_label(value))
        .collect::<Vec<_>>()
        .join(" / ");
    Some(format!(
        "该条目仅支持 {names}，当前系统是 {}，装上也无法使用",
        platform_label(host)
    ))
}

fn missing_runtimes_reason(requires: &[String]) -> Option<String> {
    let missing = requires
        .iter()
        .filter(|executable| find_executable(executable).is_none())
        .map(|executable| runtime_label(executable))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "本机缺少运行环境：{}；装好后再安装，否则装了也用不了",
        missing.join("、")
    ))
}

/// 第三方技能清单条目（{ platform, requires }）的安装预检：
/// platforms 不适配当前系统、或 requires 声明的可执行文件本机缺失时返回中文原因
/// （None = 可以直接安装）。平台与运行时分别复用内置目录同一套判定与话术。
pub fn remote_skill_unavailable_reason(
    platforms: &[String],
    requires: &[String],
) -> Option<String> {
    platform_unavailable_reason(platforms).or_else(|| missing_runtimes_reason(requires))
}

pub struct CatalogInstaller {
    home: PathBuf,
    /// MCP 安装位置（settings.json → paths.mcpInstallDir）：
    /// 装出来的 server 用它当工作目录，让「安装位置」这个设置真正生效。
    mcp_install_dir: Option<PathBuf>,
    /// GitHub 加速前缀（设置 → 引擎与诊断 → 下载与镜像 里的镜像源）。
    /// 技能包是从 codeload.github.com 下载的，以前**完全没走镜像**——用户配了镜像也不生效。
    github_prefix: String,
}

impl CatalogInstaller {
    pub fn new(home: impl AsRef<Path>) -> Self {
        let home = home.as_ref().to_path_buf();
        // 默认就带上用户配置的 GitHub 加速前缀：技能下载走同一个镜像源。
        // （以前写死 codeload.github.com，配了镜像也不生效——用户反馈的问题。）
        // services 已经把 github_prefix 重导出到 crate 根（mirrors 模块本身是私有的）。
        let mut prefix = coomi_services::github_prefix(&home).unwrap_or_default();
        if !prefix.is_empty() && !prefix.ends_with('/') {
            prefix.push('/');
        }
        Self {
            home,
            mcp_install_dir: None,
            github_prefix: prefix,
        }
    }

    /// 指定 GitHub 加速前缀（形如 `https://gh-proxy.com/`，空串＝直连）。
    /// 由调用方从 settings.json 的镜像配置里取，模块本身不依赖镜像实现。
    pub fn with_github_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.github_prefix = prefix.into();
        self
    }

    /// 指定 MCP 安装位置：目录会被创建，装出来的条目带 cwd。
    pub fn with_mcp_install_dir(mut self, dir: impl AsRef<Path>) -> Self {
        self.mcp_install_dir = Some(dir.as_ref().to_path_buf());
        self
    }

    pub fn install_mcp(&self, id: &str, values: &BTreeMap<String, String>) -> Result<PathBuf> {
        let catalog = builtin_mcp()?;
        let entry = catalog
            .entries
            .iter()
            .find(|entry| entry.id.eq_ignore_ascii_case(id))
            .with_context(|| format!("MCP `{id}` is not in the built-in catalog"))?;
        // 平台 / 运行时预检：本机跑不起来的条目直接拒绝安装，
        // 而不是先写进 mcp_servers.json 再让用户在「已安装」里看到一个永远连接失败的条目。
        if let Some(reason) = mcp_unavailable_reason(entry) {
            anyhow::bail!("{reason}")
        }
        for parameter in &entry.required_parameters {
            if values
                .get(&parameter.key)
                .is_none_or(|value| value.trim().is_empty())
            {
                anyhow::bail!(
                    "缺少必填参数 `{}` ({})，请填写后再安装",
                    parameter.key,
                    parameter.label
                )
            }
        }

        let args = entry
            .args
            .iter()
            .map(|value| substitute(value, values))
            .collect::<Result<Vec<_>>>()?;
        let env = entry
            .env
            .iter()
            .map(|(key, value)| Ok((key.clone(), substitute(value, values)?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        // 自定义安装位置：目录先建出来，条目带上 cwd（MCP 进程就在这个目录里跑）。
        let cwd = match &self.mcp_install_dir {
            Some(dir) => {
                fs::create_dir_all(dir).with_context(|| {
                    format!("failed to create MCP install dir {}", dir.display())
                })?;
                dir.display().to_string()
            }
            None => String::new(),
        };
        let path = self.home.join("config").join("mcp_servers.json");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut document = if path.exists() {
            serde_json::from_slice::<Value>(&fs::read(&path)?)
                .with_context(|| format!("invalid MCP config {}", path.display()))?
        } else {
            json!({"version": 1, "servers": {}})
        };
        let servers = document
            .get_mut("servers")
            .and_then(Value::as_object_mut)
            .context("MCP config must contain an object named `servers`")?;
        servers.insert(
            entry.id.clone(),
            json!({
                "transport": entry.transport,
                "command": entry.command,
                "args": args,
                "env": env,
                // 空串 = 用引擎自己的工作目录（MCP runtime 会跳过空 cwd）。
                "cwd": cwd,
                "enabled": true
            }),
        );
        fs::write(&path, serde_json::to_vec_pretty(&document)?)
            .with_context(|| format!("failed to write MCP config {}", path.display()))?;
        Ok(path)
    }

    pub fn install_skill(&self, id: &str) -> Result<PathBuf> {
        if id.eq_ignore_ascii_case("skill-creator") {
            let destination = self.home.join("skills").join("skill-creator");
            fs::create_dir_all(&destination)?;
            fs::write(destination.join("SKILL.md"), SKILL_CREATOR_SKILL)?;
            save_skill_metadata(
                &self.home,
                &SkillEntry {
                    id: "skill-creator".into(),
                    name: "Skill Creator".into(),
                    description: "Create and update reusable Coomi Skills.".into(),
                    repository: "Coomi/bundled".into(),
                    git_ref: "1.4.5".into(),
                    subdir: "skill-creator".into(),
                    platforms: all_platforms(),
                },
                &destination,
                "bundled",
            )?;
            return Ok(destination);
        }
        self.install_skill_inner(id, false)
    }

    /// Install the Coomi development workflow locally without a network call.
    /// This is intentionally bundled with the bridge so the entry-point flow
    /// remains usable before GitHub/gh has been configured.
    pub fn install_custom_iteration_skill(&self) -> Result<PathBuf> {
        let destination = self.home.join("skills").join("coomi-custom-iteration");
        fs::create_dir_all(&destination)?;
        fs::write(destination.join("SKILL.md"), CUSTOM_ITERATION_SKILL)?;
        save_skill_metadata(
            &self.home,
            &SkillEntry {
                id: "coomi-custom-iteration".into(),
                name: "Coomi Custom Iteration".into(),
                description: "Safely develop Coomi, submit PRs, or build CoomiDev.".into(),
                repository: "TensorHub-ORG/Coomi".into(),
                git_ref: "main".into(),
                subdir: "".into(),
                platforms: all_platforms(),
            },
            &destination,
            "bundled",
        )?;
        Ok(destination)
    }

    /// Install the bundled runtime coordination guidance. This is local and
    /// idempotent so a fresh runtime can route Host/Termux/Proot work before
    /// any network-backed Skill installation is available.
    pub fn install_runtime_environment_skill(&self) -> Result<PathBuf> {
        let destination = self.home.join("skills").join("runtime-environments");
        fs::create_dir_all(&destination)?;
        fs::write(destination.join("SKILL.md"), RUNTIME_ENVIRONMENT_SKILL)?;
        save_skill_metadata(
            &self.home,
            &SkillEntry {
                id: "runtime-environments".into(),
                name: "Runtime Environments".into(),
                description: "Route tools across Host, Termux, and ProotLinux without mixing paths or binaries.".into(),
                repository: "TensorHub-ORG/Coomi".into(),
                git_ref: "main".into(),
                subdir: "".into(),
                platforms: all_platforms(),
            },
            &destination,
            "bundled",
        )?;
        Ok(destination)
    }

    /// Install Coomi-owned Build Kit helpers into the persistent Runtime V2
    /// home. Compiler artifacts are deliberately not bundled here: the doctor
    /// must report not-ready until a pinned, checksum-verified kit is selected.
    pub fn install_custom_iteration_buildkit(&self) -> Result<PathBuf> {
        let root = self.home.join("runtime-v2").join("home").join(".coomi-dev");
        for directory in ["bin", "toolchains", "cache", "state", "logs", "keys"] {
            fs::create_dir_all(root.join(directory))?;
        }
        write_executable(&root.join("bin/coomidev-env"), COOMIDEV_ENV)?;
        write_executable(&root.join("bin/coomidev-doctor"), COOMIDEV_DOCTOR)?;
        write_executable(&root.join("bin/coomidev-build"), COOMIDEV_BUILD)?;
        write_executable(
            &root.join("bin/coomidev-install-buildkit"),
            COOMIDEV_INSTALL_BUILDKIT,
        )?;
        Ok(root)
    }

    pub fn update_skill(&self, id: &str) -> Result<PathBuf> {
        self.install_skill_inner(id, true)
    }

    /// 安装社区注册表条目（市场）：条目来自远端 registry.json，不经内置 catalog
    /// 查找，直接按 repository/ref/subdir 走与内置目录相同的下载安装流程。
    pub fn install_remote_skill(&self, entry: &SkillEntry, replace: bool) -> Result<PathBuf> {
        self.install_entry(entry, replace)
    }

    /// 卸载 Skill：删除 skills/{id} 目录与 config/skills.json 中的条目。
    pub fn uninstall_skill(&self, id: &str) -> Result<PathBuf> {
        if id.eq_ignore_ascii_case("skill-creator") {
            anyhow::bail!("Skill `skill-creator` is built in and cannot be uninstalled");
        }
        // 与安装一致：id 必须先在内置目录中解析出合法条目，杜绝路径穿越
        // （id=".."、"%2E%2E%2F" 等经 URL 解码后越界删除任意目录）。
        let catalog = builtin_skills()?;
        let entry = catalog
            .entries
            .iter()
            .find(|entry| entry.id.eq_ignore_ascii_case(id))
            .with_context(|| format!("Skill `{id}` is not in the built-in catalog"))?;
        let destination = self.home.join("skills").join(&entry.id);
        if destination.exists() {
            fs::remove_dir_all(&destination)
                .with_context(|| format!("failed to remove {}", destination.display()))?;
        }
        let config_path = self.home.join("config").join("skills.json");
        if config_path.exists() {
            let bytes = fs::read(&config_path)
                .with_context(|| format!("failed to read {}", config_path.display()))?;
            if let Ok(mut document) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(skills) = document.get_mut("skills").and_then(Value::as_object_mut) {
                    skills.remove(id);
                    fs::write(&config_path, serde_json::to_vec_pretty(&document)?)
                        .with_context(|| format!("failed to write {}", config_path.display()))?;
                }
            }
        }
        Ok(destination)
    }

    fn install_skill_inner(&self, id: &str, replace: bool) -> Result<PathBuf> {
        let catalog = builtin_skills()?;
        let entry = catalog
            .entries
            .iter()
            .find(|entry| entry.id.eq_ignore_ascii_case(id))
            .with_context(|| format!("Skill `{id}` is not in the built-in catalog"))?;
        // 平台预检：手机专用 Skill（如 Shizuku）在桌面上装了也没用，直接拒绝。
        if let Some(reason) = skill_unavailable_reason(entry) {
            anyhow::bail!("{reason}")
        }
        self.install_entry(entry, replace)
    }

    /// 安装核心：下载 zip → 解压 subdir → 复制到 skills/{id} → 写元数据。
    /// 内置目录与社区市场共用此函数，埋点也集中在这里——无论用户手动点击
    /// 还是 Agent 自动安装，install_ok / install_fail 都在此处产生。
    fn install_entry(&self, entry: &SkillEntry, replace: bool) -> Result<PathBuf> {
        let result = self.install_entry_inner(entry, replace);
        let telemetry = Telemetry::new(&self.home);
        match &result {
            Ok(_) => {
                let _ = telemetry.record("install_ok", &entry.id);
            }
            Err(_) => {
                let _ = telemetry.record("install_fail", &entry.id);
            }
        }
        result
    }

    fn install_entry_inner(&self, entry: &SkillEntry, replace: bool) -> Result<PathBuf> {
        let destination = self.home.join("skills").join(&entry.id);
        if destination.exists() && !replace {
            anyhow::bail!("Skill `{}` is already installed", entry.id)
        }
        let cache = self
            .home
            .join("cache")
            .join(format!("skill-{}-partial", entry.id));
        if cache.exists() {
            fs::remove_dir_all(&cache)
                .with_context(|| format!("failed to clear cache {}", cache.display()))?;
        }
        if let Some(parent) = cache.parent() {
            fs::create_dir_all(parent)?;
        }
        // 通过 GitHub codeload zip 下载并解压（不依赖 git 命令：手机 bootstrap 未内置 git）。
        // **走配置的镜像前缀**：以前这里写死 codeload.github.com，用户配了镜像也不生效。
        let zip_url = format!(
            "{}https://codeload.github.com/{}/zip/refs/heads/{}",
            self.github_prefix, entry.repository, entry.git_ref
        );
        let bytes = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .user_agent("coomi-android")
            .build()
            .context("failed to build download client")?
            .get(&zip_url)
            .send()
            .context("failed to download skill archive")?
            .error_for_status()
            .context("skill archive download failed")?
            .bytes()
            .context("failed to read skill archive")?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes))
            .context("skill archive is not a valid zip")?;
        // codeload zip 的根目录形如 {repo}-{ref}/，把其中 {subdir}/ 的内容解压到目标。
        let repo_basename = entry.repository.rsplit('/').next().unwrap_or("repository");
        // GitHub normalizes slashes in branch names in codeload archive roots
        // (for example codex/feat/x becomes repo-codex-feat-x).
        let root_prefixes = [
            format!("{repo_basename}-{}/", entry.git_ref),
            format!("{repo_basename}-{}/", entry.git_ref.replace('/', "-")),
        ];
        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .with_context(|| format!("invalid zip entry #{index}"))?;
            let name = file.name().to_string();
            let Some(rest) = root_prefixes
                .iter()
                .find_map(|prefix| name.strip_prefix(prefix))
            else {
                continue;
            };
            if !matches_skill_subdir(rest, &entry.subdir) {
                continue;
            }
            // zip-slip 防护：拒绝任何越界片段。
            if rest
                .split('/')
                .any(|segment| segment.is_empty() || segment == "..")
            {
                continue;
            }
            let target = cache.join(rest);
            if file.is_dir() {
                fs::create_dir_all(&target)?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut output = std::fs::File::create(&target)
                    .with_context(|| format!("failed to write {}", target.display()))?;
                std::io::copy(&mut file, &mut output)?;
            }
        }
        let source = cache.join(&entry.subdir);
        if !source.is_dir() {
            anyhow::bail!("downloaded repository has no directory `{}`", entry.subdir)
        }
        // zip 包不带 commit hash，用 ref 名作为版本记录。
        let commit = entry.git_ref.clone();
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let backup = self
            .home
            .join("cache")
            .join(format!("skill-{}-backup", entry.id));
        if replace && destination.exists() {
            if backup.exists() {
                fs::remove_dir_all(&backup)?;
            }
            fs::rename(&destination, &backup)?;
        }
        if let Err(error) = copy_directory(&source, &destination) {
            let _ = fs::remove_dir_all(&destination);
            if backup.exists() {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(error);
        }
        if backup.exists() {
            fs::remove_dir_all(&backup)?;
        }
        save_skill_metadata(&self.home, entry, &destination, &commit)?;
        fs::remove_dir_all(&cache)
            .with_context(|| format!("failed to clear cache {}", cache.display()))?;
        Ok(destination)
    }

    /// 从本地 zip 字节安装 Skill（手动安装场景：用户选择 skill 压缩包）。
    /// zip 根目录任意（单根目录自动跳过），内容解压到 skills/{id}，带 zip-slip 防护。
    pub fn install_skill_zip(
        &self,
        id: &str,
        zip_bytes: &[u8],
        display_name: &str,
        replace: bool,
    ) -> Result<PathBuf> {
        if id.is_empty()
            || !id
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
            || id
                .chars()
                .next()
                .is_some_and(|ch| !ch.is_ascii_alphanumeric())
        {
            anyhow::bail!("invalid skill id `{id}`");
        }
        let destination = self.home.join("skills").join(id);
        if destination.exists() && !replace {
            anyhow::bail!("Skill `{id}` is already installed");
        }
        let cache = self.home.join("cache").join(format!("skill-{id}-partial"));
        if cache.exists() {
            fs::remove_dir_all(&cache)
                .with_context(|| format!("failed to clear cache {}", cache.display()))?;
        }
        if let Some(parent) = cache.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
            .context("skill archive is not a valid zip")?;
        // 识别 zip 根目录：首个目录条目名第一段。
        let mut root: Option<String> = None;
        for index in 0..archive.len() {
            let Ok(file) = archive.by_index(index) else { continue; };
            let name = file.name();
            if name.contains('/') {
                if let Some(seg) = name.split('/').next() {
                    if !seg.is_empty() && !seg.starts_with('.') {
                        root = Some(format!("{seg}/"));
                        break;
                    }
                }
            }
        }
        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .with_context(|| format!("invalid zip entry #{index}"))?;
            let name = file.name().to_string();
            if name.ends_with('/') { continue; }
            if name.split('/').any(|segment| segment.starts_with('.') && segment.len() > 1) {
                continue;
            }
            let rest = match &root {
                Some(root) => match name.strip_prefix(root.as_str()) {
                    Some(rest) => rest.to_string(),
                    None => name.clone(),
                },
                None => name.clone(),
            };
            if rest.split('/').any(|segment| segment.is_empty() || segment == "..") { continue; }
            let target = cache.join(&rest);
            if let Some(parent) = target.parent() { fs::create_dir_all(parent)?; }
            let mut output = std::fs::File::create(&target)
                .with_context(|| format!("failed to write {}", target.display()))?;
            std::io::copy(&mut file, &mut output)?;
        }
        if !cache.join("SKILL.md").is_file() {
            anyhow::bail!("skill archive must contain a SKILL.md at its root");
        }
        if destination.exists() && replace {
            let backup = self.home.join("cache").join(format!("skill-{id}-backup"));
            if backup.exists() { fs::remove_dir_all(&backup)?; }
            fs::rename(&destination, &backup)?;
            let _ = fs::remove_dir_all(&backup);
        }
        if let Some(parent) = destination.parent() { fs::create_dir_all(parent)?; }
        fs::rename(&cache, &destination)?;
        let entry = SkillEntry {
            id: id.into(),
            name: display_name.into(),
            description: "本地安装的 Skill".into(),
            repository: "local".into(),
            git_ref: "local".into(),
            subdir: "".into(),
            platforms: all_platforms(),
        };
        save_skill_metadata(&self.home, &entry, &destination, "local")?;
        Ok(destination)
    }
}

fn save_skill_metadata(
    home: &Path,
    entry: &SkillEntry,
    destination: &Path,
    commit: &str,
) -> Result<()> {
    let path = home.join("config").join("skills.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut document = if path.exists() {
        serde_json::from_slice::<Value>(&fs::read(&path)?)
            .with_context(|| format!("invalid Skill config {}", path.display()))?
    } else {
        json!({"version": 1, "skills": {}})
    };
    let skills = document
        .get_mut("skills")
        .and_then(Value::as_object_mut)
        .context("Skill config must contain an object named `skills`")?;
    // Reinstalling a bundled Skill is idempotent. Preserve a user's manual
    // disable choice instead of turning it back on during every engine start.
    let enabled = skills
        .get(&entry.id)
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    skills.insert(
        entry.id.clone(),
        json!({
            "enabled": enabled,
            "path": destination,
            "source": entry.id,
            "source_type": "catalog",
            "repository": entry.repository,
            "git_ref": entry.git_ref,
            "subdir": entry.subdir,
            "commit": commit
        }),
    );
    fs::write(&path, serde_json::to_vec_pretty(&document)?)?;
    Ok(())
}

fn substitute(template: &str, values: &BTreeMap<String, String>) -> Result<String> {
    let mut output = template.to_string();
    while let Some(start) = output.find("{{") {
        let relative_end = output[start + 2..]
            .find("}}")
            .context("unclosed catalog placeholder")?;
        let end = start + 2 + relative_end;
        let key = &output[start + 2..end];
        let value = values
            .get(key)
            .with_context(|| format!("missing catalog parameter `{key}`"))?;
        output.replace_range(start..end + 2, value);
    }
    Ok(output)
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn write_executable(path: &Path, contents: &str) -> Result<()> {
    fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_catalogs_are_valid_and_non_empty() {
        let mcp = builtin_mcp().expect("MCP catalog");
        assert!(!mcp.entries.is_empty());
        assert!(!builtin_skills().expect("Skill catalog").entries.is_empty());
        // Fetch 由引擎内置工具提供，不再出现在 MCP 安装目录中。
        assert!(mcp.entries.iter().all(|entry| entry.id != "fetch"));
    }

    #[test]
    fn entry_requires_merges_command_and_declared_dependencies() {
        let catalog = builtin_mcp().expect("MCP catalog");
        let filesystem = catalog
            .entries
            .iter()
            .find(|entry| entry.id == "filesystem")
            .expect("filesystem entry");
        // 未声明 requires 时按启动命令推断：npx 条目就是需要 npx。
        assert_eq!(entry_requires(filesystem), vec!["npx".to_string()]);
        let docker = catalog
            .entries
            .iter()
            .find(|entry| entry.id == "docker")
            .expect("docker entry");
        // 显式声明的依赖与启动命令合并，且保持顺序、去重。
        assert_eq!(
            entry_requires(docker),
            vec!["uvx".to_string(), "docker".to_string()]
        );
    }

    #[test]
    fn find_executable_resolves_launchers_through_path() {
        let home = tempfile::tempdir().expect("temporary home");
        let plain = home.path().join("coomi-probe-tool");
        fs::write(&plain, b"").expect("write plain tool");
        assert_eq!(
            find_executable_in("coomi-probe-tool", &home.path().display().to_string()),
            Some(plain.clone())
        );
        // 目录不在搜索路径上时必须解析失败，而不是瞎猜一个路径。
        assert_eq!(find_executable_in("coomi-probe-tool", ""), None);
        // Windows 上 npx 只有 npx.cmd：必须按 PATHEXT 补扩展名才找得到。
        if cfg!(windows) {
            let launcher = home.path().join("coomi-probe-launcher.cmd");
            fs::write(&launcher, "@echo off").expect("write launcher");
            // PATHEXT 里写的是大写 .CMD：解析结果的大小写取决于 PATH 的写法，比较时忽略大小写。
            let found =
                find_executable_in("coomi-probe-launcher", &home.path().display().to_string())
                    .expect("launcher must resolve through PATHEXT");
            assert_eq!(
                found.to_string_lossy().to_lowercase(),
                launcher.to_string_lossy().to_lowercase()
            );
        }
    }

    #[test]
    fn missing_runtime_is_reported_in_chinese() {
        let entry = McpEntry {
            id: "ghost".into(),
            name: "Ghost".into(),
            description: String::new(),
            transport: "stdio".into(),
            command: "coomi-definitely-missing-runtime".into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            required_parameters: Vec::new(),
            platforms: all_platforms(),
            requires: Vec::new(),
        };
        let reason = mcp_unavailable_reason(&entry).expect("unavailable reason");
        assert!(reason.contains("本机缺少运行环境"), "{reason}");
    }

    #[test]
    fn desktop_only_platform_entries_are_marked_unavailable() {
        if host_platform() == "android" {
            return;
        }
        let catalog = builtin_mcp().expect("MCP catalog");
        let entry = catalog
            .entries
            .iter()
            .find(|entry| entry.id == "playwright")
            .expect("playwright entry");
        assert!(!entry.platforms.iter().any(|value| value == "android"));
        // playwright 需要 Node：本机没装 Node 时同样应被判定为不可用。
        if find_executable("npx").is_none() {
            assert!(mcp_unavailable_reason(entry).is_some());
        }
    }

    #[test]
    fn no_catalog_skill_is_android_only() {
        // Windows 桌面适配约束：目录里不再保留 android 专用技能（shizuku 已删）。
        // 每个 Skill 都必须能在当前宿主平台安装使用，否则就显式收窄后被删除。
        let catalog = builtin_skills().expect("Skill catalog");
        let host = host_platform();
        for entry in catalog.entries.iter() {
            assert!(
                entry
                    .platforms
                    .iter()
                    .any(|platform| platform.eq_ignore_ascii_case(host)),
                "Skill `{}` 必须在当前平台 {} 可用",
                entry.id,
                host
            );
        }
        // 校验删除生效：目录里不允许存在只在 android 上可用的 Skill。
        assert!(catalog.entries.iter().all(|entry| {
            let only_android = entry
                .platforms
                .iter()
                .all(|platform| platform.eq_ignore_ascii_case("android"));
            !only_android
        }), "目录里不允许存在仅在 android 上可用的 Skill");
    }

    #[test]
    fn translation_dict_covers_all_builtin_entries() {
        let dict = builtin_translation().expect("translation dictionary");
        let mcp = builtin_mcp().expect("MCP catalog");
        for entry in mcp.entries.iter() {
            assert!(
                dict.contains_key(&entry.id.to_ascii_lowercase()),
                "中文词表缺少 MCP `{}`",
                entry.id
            );
        }
        let skills = builtin_skills().expect("Skill catalog");
        for entry in skills.entries.iter() {
            assert!(
                dict.contains_key(&entry.id.to_ascii_lowercase()),
                "中文词表缺少 Skill `{}`",
                entry.id
            );
        }
        for (id, entry) in dict.iter() {
            assert!(!entry.name.trim().is_empty(), "词表条目 `{}` 缺 name", id);
        }
    }
    #[test]
    fn installs_parameterized_mcp_config() {
        // filesystem 需要 Node（npx）；本机没有 Node 时安装会被预检拒绝，跳过。
        if find_executable("npx").is_none() {
            return;
        }
        let home = tempfile::tempdir().expect("temporary home");
        let values = BTreeMap::from([(
            "allowed_path".to_string(),
            home.path().display().to_string(),
        )]);
        let path = CatalogInstaller::new(home.path())
            .install_mcp("filesystem", &values)
            .expect("install MCP");
        let document: Value = serde_json::from_slice(&fs::read(path).expect("read MCP config"))
            .expect("parse MCP config");
        assert_eq!(
            document.pointer("/servers/filesystem/enabled"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn mcp_install_dir_is_written_as_the_server_cwd() {
        // 对应 settings.json → paths.mcpInstallDir：装出来的 MCP server 在指定目录里跑。
        if find_executable("npx").is_none() {
            return;
        }
        let home = tempfile::tempdir().expect("temporary home");
        let install_dir = home.path().join("mcp-home");
        let values = BTreeMap::from([(
            "allowed_path".to_string(),
            home.path().display().to_string(),
        )]);
        let path = CatalogInstaller::new(home.path())
            .with_mcp_install_dir(&install_dir)
            .install_mcp("filesystem", &values)
            .expect("install MCP");
        assert!(install_dir.is_dir(), "install dir must be created");
        let document: Value = serde_json::from_slice(&fs::read(path).expect("read MCP config"))
            .expect("parse MCP config");
        assert_eq!(
            document.pointer("/servers/filesystem/cwd"),
            Some(&Value::String(install_dir.display().to_string()))
        );
        // 没配置安装位置时写空串（MCP runtime 会跳过空 cwd，用引擎自己的工作目录）。
        let other = tempfile::tempdir().expect("temporary home");
        let values = BTreeMap::from([(
            "allowed_path".to_string(),
            other.path().display().to_string(),
        )]);
        let path = CatalogInstaller::new(other.path())
            .install_mcp("filesystem", &values)
            .expect("install MCP");
        let document: Value = serde_json::from_slice(&fs::read(path).expect("read MCP config"))
            .expect("parse MCP config");
        assert_eq!(
            document.pointer("/servers/filesystem/cwd"),
            Some(&Value::String(String::new()))
        );
    }

    #[test]
    fn bundled_skill_reinstall_preserves_manual_disable() {
        let home = tempfile::tempdir().expect("temporary home");
        let installer = CatalogInstaller::new(home.path());
        installer
            .install_skill("skill-creator")
            .expect("install bundled skill");

        let config_path = home.path().join("config/skills.json");
        let mut document: Value =
            serde_json::from_slice(&fs::read(&config_path).expect("read skill config"))
                .expect("parse skill config");
        document["skills"]["skill-creator"]["enabled"] = Value::Bool(false);
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&document).expect("encode skill config"),
        )
        .expect("disable skill");

        installer
            .install_skill("skill-creator")
            .expect("reinstall bundled skill");
        let updated: Value =
            serde_json::from_slice(&fs::read(config_path).expect("read updated config"))
                .expect("parse updated config");
        assert_eq!(
            updated["skills"]["skill-creator"]["enabled"],
            Value::Bool(false)
        );
    }

    #[test]
    fn installs_custom_iteration_buildkit_helpers_without_claiming_ready() {
        let home = tempfile::tempdir().expect("temporary home");
        let root = CatalogInstaller::new(home.path())
            .install_custom_iteration_buildkit()
            .expect("install Build Kit helpers");
        for helper in [
            "coomidev-env",
            "coomidev-doctor",
            "coomidev-build",
            "coomidev-install-buildkit",
        ] {
            assert!(root.join("bin").join(helper).is_file(), "missing {helper}");
        }
        assert!(root.join("toolchains").is_dir());
        assert!(!root.join("current/buildkit.json").exists());
    }

    #[test]
    fn uninstall_skill_rejects_path_traversal_ids() {
        // 卸载只接受内置目录中的合法 id：路径穿越（..、绝对路径、任意目录名）一律拒绝。
        let home = tempfile::tempdir().expect("temporary home");
        let installer = CatalogInstaller::new(home.path());
        for malicious in ["..", "../x", "/etc", "a/b", "%2e%2e"] {
            assert!(
                installer.uninstall_skill(malicious).is_err(),
                "uninstall should reject {malicious}"
            );
        }
        // 不存在的合法目录 id 不会报错（视为已卸载），但也不得删到 skills 之外。
        assert!(installer.uninstall_skill("frontend-design").is_ok());
        assert!(home.path().join("skills").is_dir() || !home.path().join("skills").exists());
    }

    #[test]
    fn root_subdir_accepts_skill_files_at_repository_root() {
        assert!(matches_skill_subdir("shizuku-skill-main/SKILL.md", "."));
        assert!(matches_skill_subdir(
            "shizuku-skill-main/agents/openai.yaml",
            "."
        ));
        assert!(!matches_skill_subdir(
            "shizuku-skill-main/other/SKILL.md",
            "agents"
        ));
    }
}

fn matches_skill_subdir(path: &str, subdir: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if subdir == "." {
        return true;
    }
    path == subdir || path.starts_with(&format!("{subdir}/"))
}
