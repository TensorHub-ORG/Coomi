//! 本机运行时探测与一键安装。
//!
//! - GET  /api/runtime/runtimes       —— 探测（node/npx/uv/uvx/docker/kubectl/git/ffmpeg）
//! - GET  /api/runtime/install-plan   —— 确认卡数据：将执行的完整命令（引擎不执行任何东西）
//! - POST /api/runtime/install        —— 一键安装：走 TaskManager 跑 winget 安装任务
//! - GET  /api/runtime/install-status —— 安装任务的 before/after 与日志尾部
//!
//! 探测只做两件事：在 PATH（与少量常见安装目录）里找到可执行文件、跑一次版本命令。
//! 安装命令一律带 --accept-source-agreements --accept-package-agreements --scope user：
//! 装到用户目录、不弹 UAC（免提权）。日志走已有任务日志（/api/tasks/{id}/log），
//! 取消走已有 DELETE /api/tasks/{id}；Docker 这类必须人工介入的运行时只给引导文案。

use axum::Json;
use axum::extract::Query;
use axum::extract::State;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use crate::web::ApiError;
use crate::web::AppState;
use crate::web::SessionTask;
use crate::web::configured_capabilities;
use coomi_services::ResourceAccess;
use coomi_services::ResourceKey;
use coomi_services::ResourceKind;
use coomi_services::ResourceRequest;
use coomi_services::TaskManager;
use coomi_services::TaskPriority;
use coomi_services::TaskStatus;
use coomi_services::apply_github_prefix;
use coomi_services::github_prefix;
use coomi_services::mirror_env;

/// 版本命令的超时：卡住的工具（等输入、连不上集群）不能把接口一起拖住。
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// 返回给前端的版本字符串上限。
const VERSION_MAX_CHARS: usize = 120;

/// 一键安装的任务类型（任务中心用它区分「运行时工具安装」与别的任务）。
pub(in crate::web) const RUNTIME_INSTALL_KIND: &str = "runtime_tool_install";
/// 安装任务的硬超时：与 TaskManager 默认 ProcessLimits.runtime_seconds 一致。
const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// 取消检查间隔：用户点取消后最多这么久就杀掉 winget。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// 杀掉 winget 后最多再等多久排空输出（孙进程可能还攥着管道）。
const KILL_DRAIN_TIMEOUT: Duration = Duration::from_millis(1500);
/// 等安装资源锁的轮询间隔。
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 单行日志上限：winget 的进度条会吐超长单行（含 \r 与退格），截断后再落日志。
const LOG_LINE_MAX_CHARS: usize = 2000;
/// 失败摘要里附带的任务输出尾部行数。
const SUMMARY_TAIL_LINES: usize = 3;
/// 机器可读结果行前缀：install-status 靠它取回 before/after。
const RESULT_PREFIX: &str = "[coomi:install-result] ";
/// install-status 读日志尾部的行数。
const STATUS_LOG_LINES: usize = 200;

/// winget 官方引导脚本（本机没有 winget 时用它装上 App Installer）。
/// 实际地址经生效的 GitHub 前缀加速（settings.json → mirrors.github）。
const WINGET_INSTALL_SCRIPT: &str =
    "https://github.com/asheroto/winget-install/releases/latest/download/winget-install.ps1";
/// 走引导脚本安装的运行时 id（不通过 winget 装，而是跑 PowerShell 脚本）。
const WINGET_BOOTSTRAP_ID: &str = "winget";

/// 没有 winget 时的说明：一键安装会下载脚本并以管理员权限运行（弹 UAC）。
const WINGET_GUIDANCE: &str = "本机没有 winget（Windows 应用安装程序）：点确认后引擎会下载 winget-install 脚本并运行，过程中会弹 UAC 提权窗口（脚本内部会请求管理员权限），请在弹出的窗口点「是」；日志会实时回显在任务面板里。装完会自动复检。";


/// Docker 必须人工安装并首次启动登录，引擎不代装，只给这一步的引导。
const DOCKER_GUIDANCE: &str = "Docker Desktop 需要人工安装并首次启动登录，引擎不会替你装：1) 手动执行 winget install Docker.DockerDesktop；2) 装完启动 Docker Desktop，接受服务条款并等它把 WSL2 后端初始化完；3) 回到运行时列表点「重新探测」，能看到 docker 版本即算就绪。";

struct RuntimeSpec {
    id: &'static str,
    label: &'static str,
    /// 版本探测参数（绝大多数是 --version；kubectl 只问客户端，不连集群）。
    version_args: &'static [&'static str],
    /// winget 包 Id；None = 引擎不代装（当前只有 Docker，只给引导文案）。
    package: Option<&'static str>,
    /// 引擎不代装时给用户手动复制的命令。
    manual_command: &'static str,
    /// 官网 / 安装说明。
    url: &'static str,
    note: &'static str,
    /// PATH 里找不到时的常见安装路径（%VAR% 会按环境变量展开）。
    fallbacks: &'static [&'static str],
}

const SPECS: &[RuntimeSpec] = &[
    RuntimeSpec {
        id: "node",
        label: "Node.js",
        version_args: &["--version"],
        package: Some("OpenJS.NodeJS.LTS"),
        manual_command: "winget install OpenJS.NodeJS.LTS",
        url: "https://nodejs.org/en/download",
        note: "前端构建与 npx 拉起的 MCP 服务器都依赖它",
        fallbacks: &[
            "%ProgramFiles%\\nodejs\\node.exe",
            "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe",
        ],
    },
    RuntimeSpec {
        id: "npx",
        label: "npx",
        version_args: &["--version"],
        package: Some("OpenJS.NodeJS.LTS"),
        manual_command: "winget install OpenJS.NodeJS.LTS",
        url: "https://nodejs.org/en/download",
        note: "随 Node.js 一起安装，装了 node 就不用单独装它",
        fallbacks: &[
            "%ProgramFiles%\\nodejs\\npx.cmd",
            "%LOCALAPPDATA%\\Programs\\nodejs\\npx.cmd",
        ],
    },
    RuntimeSpec {
        id: "npm",
        label: "npm",
        version_args: &["--version"],
        package: Some("OpenJS.NodeJS.LTS"),
        manual_command: "winget install OpenJS.NodeJS.LTS",
        url: "https://nodejs.org/en/download",
        note: "随 Node.js 一起安装；全局包与 npx 都很依赖它",
        fallbacks: &[
            "%ProgramFiles%\\nodejs\\npm.cmd",
            "%LOCALAPPDATA%\\Programs\\nodejs\\npm.cmd",
        ],
    },
    RuntimeSpec {
        id: "uv",
        label: "uv",
        version_args: &["--version"],
        package: Some("astral-sh.uv"),
        manual_command: "winget install astral-sh.uv",
        url: "https://docs.astral.sh/uv/getting-started/installation/",
        note: "Python 包与虚拟环境管理器（pip/venv 的快速替代）",
        fallbacks: &[
            "%USERPROFILE%\\.local\\bin\\uv.exe",
            "%USERPROFILE%\\.cargo\\bin\\uv.exe",
        ],
    },
    RuntimeSpec {
        id: "uvx",
        label: "uvx",
        version_args: &["--version"],
        package: Some("astral-sh.uv"),
        manual_command: "winget install astral-sh.uv",
        url: "https://docs.astral.sh/uv/getting-started/installation/",
        note: "随 uv 一起安装（等价于 uv tool run）",
        fallbacks: &[
            "%USERPROFILE%\\.local\\bin\\uvx.exe",
            "%USERPROFILE%\\.cargo\\bin\\uvx.exe",
        ],
    },
    RuntimeSpec {
        id: "docker",
        label: "Docker",
        version_args: &["--version"],
        // 容器运行时需要人工启动与登录：自动装出来也是个连不上的空壳。
        package: None,
        manual_command: "winget install Docker.DockerDesktop",
        url: "https://www.docker.com/products/docker-desktop/",
        note: "容器化运行环境；装了还要把 Docker Desktop 启动起来",
        fallbacks: &["%ProgramFiles%\\Docker\\Docker\\resources\\bin\\docker.exe"],
    },
    RuntimeSpec {
        id: "kubectl",
        label: "kubectl",
        version_args: &["version", "--client"],
        package: Some("Kubernetes.kubectl"),
        manual_command: "winget install Kubernetes.kubectl",
        url: "https://kubernetes.io/docs/tasks/tools/",
        note: "Kubernetes 命令行；这里只问客户端版本，不连接任何集群",
        fallbacks: &["%ProgramFiles%\\Kubernetes\\kubectl.exe"],
    },
    RuntimeSpec {
        id: "git",
        label: "Git",
        version_args: &["--version"],
        package: Some("Git.Git"),
        manual_command: "winget install Git.Git",
        url: "https://git-scm.com/downloads",
        note: "版本控制；工作区差异/分支相关功能依赖它",
        fallbacks: &[
            "%ProgramFiles%\\Git\\cmd\\git.exe",
            "%ProgramFiles%\\Git\\bin\\git.exe",
            "%LOCALAPPDATA%\\Programs\\Git\\cmd\\git.exe",
        ],
    },
    RuntimeSpec {
        id: "ffmpeg",
        label: "FFmpeg",
        version_args: &["-version"],
        package: Some("Gyan.FFmpeg"),
        manual_command: "winget install Gyan.FFmpeg",
        url: "https://ffmpeg.org/download.html",
        note: "音视频转码；媒体处理类工具会用到",
        fallbacks: &[
            "%ProgramFiles%\\ffmpeg\\bin\\ffmpeg.exe",
            "C:\\ffmpeg\\bin\\ffmpeg.exe",
        ],
    },
    RuntimeSpec {
        id: WINGET_BOOTSTRAP_ID,
        label: "winget（Windows 应用安装程序）",
        version_args: &["--version"],
        // 不通过 winget 装自己：走官方 winget-install 脚本（见 winget_bootstrap_args）。
        package: None,
        manual_command: "irm https://github.com/asheroto/winget-install/releases/latest/download/winget-install.ps1 | iex",
        url: "https://github.com/asheroto/winget-install",
        note: "其它运行时一键安装的前置；本机缺失时由引擎跑官方脚本装上（会弹 UAC）",
        fallbacks: &[
            "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\winget.exe",
            "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\winget.exe",
        ],
    },
];

/// 按 id（大小写不敏感）取运行时描述。
fn spec_by_id(id: &str) -> Option<&'static RuntimeSpec> {
    let id = id.trim();
    SPECS.iter().find(|spec| spec.id.eq_ignore_ascii_case(id))
}

/// 引擎支持一键安装的运行时 id（错误提示里用）。
fn supported_ids() -> Vec<&'static str> {
    SPECS.iter().map(|spec| spec.id).collect()
}

/// winget 安装参数（不含可执行文件名）：静默接受源/包协议 + --scope user 免提权。
fn install_args(spec: &RuntimeSpec) -> Vec<String> {
    let Some(package) = spec.package else {
        return Vec::new();
    };
    vec![
        "install".to_owned(),
        package.to_owned(),
        "--accept-source-agreements".to_owned(),
        "--accept-package-agreements".to_owned(),
        "--scope".to_owned(),
        "user".to_owned(),
    ]
}

/// 完整安装命令（确认卡直接展示这一行；UI 抄的命令与实际执行的必须同源）。
fn install_command(spec: &RuntimeSpec) -> Option<String> {
    let args = install_args(spec);
    (!args.is_empty()).then(|| format!("winget {}", args.join(" ")))
}

/// 给用户复制的手动命令：引擎代装的用安装命令，不代装的用写死的手动命令。
fn manual_command(spec: &RuntimeSpec) -> String {
    install_command(spec).unwrap_or_else(|| spec.manual_command.to_owned())
}

/// 引擎不代装时的人工引导（Docker 只给文案；winget 走引导脚本，会弹 UAC）。
fn guidance_for(spec: &RuntimeSpec) -> Option<&'static str> {
    match spec.id {
        "docker" => Some(DOCKER_GUIDANCE),
        WINGET_BOOTSTRAP_ID => Some(WINGET_GUIDANCE),
        _ => None,
    }
}

/// 是否是需要跑引导脚本（而不是 winget install）的运行时：目前只有 winget 自己。
fn is_bootstrap_spec(spec: &RuntimeSpec) -> bool {
    spec.id.eq_ignore_ascii_case(WINGET_BOOTSTRAP_ID)
}

/// winget 引导脚本的最终下载地址：GitHub 前缀生效时改走镜像
/// （settings.json → mirrors.github，国内默认 gh-proxy.com）。
fn winget_script_url(home: &Path) -> String {
    apply_github_prefix(github_prefix(home).as_deref(), WINGET_INSTALL_SCRIPT)
}

/// 装 winget 的 PowerShell 参数（irm = Invoke-RestMethod，iex = Invoke-Expression）。
/// 脚本内部会自己请求管理员权限（弹 UAC），引擎这里不做提权。
fn winget_bootstrap_args(home: &Path) -> Vec<String> {
    vec![
        "-NoProfile".to_owned(),
        "-ExecutionPolicy".to_owned(),
        "Bypass".to_owned(),
        "-Command".to_owned(),
        format!("irm {} | iex", winget_script_url(home)),
    ]
}

/// 确认卡展示的完整命令：与 winget_bootstrap_args 同源，改一处两边一起变。
fn winget_bootstrap_command(home: &Path) -> String {
    format!(
        "powershell {}",
        winget_bootstrap_args(home)
            .iter()
            .map(|arg| if arg.contains(' ') || arg.contains('|') {
                format!("\"{arg}\"")
            } else {
                arg.clone()
            })
            .collect::<Vec<_>>()
            .join(" ")
    )
}

/// 找 PowerShell 解释器：pwsh（7+）优先，其次 Windows PowerShell。
fn find_powershell() -> Option<PathBuf> {
    let env = probe_env();
    for program in ["pwsh", "powershell"] {
        if let Some(path) = find_program_in(&env, program) {
            return Some(path);
        }
    }
    let candidate = PathBuf::from(env.expand(
        "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ));
    candidate.is_file().then_some(candidate)
}

/// 能力开关：settings.json → capabilities.allowRuntimeInstall（默认开）。
pub(in crate::web) fn runtime_install_allowed(home: &Path) -> bool {
    configured_capabilities(home).allow_runtime_install
}

/// GET /api/runtime/runtimes
///
/// 每项都带 `winget: {found, version, path}`：缺 winget 时前端据此提示
/// 「先装 winget」并调用 POST /api/runtime/install {id:"winget"}。
pub(crate) async fn list_runtimes(State(state): State<AppState>) -> Json<Value> {
    let home = state.home.clone();
    let runtimes = tokio::task::spawn_blocking(move || probe_all(&home))
        .await
        .unwrap_or_else(|error| {
            eprintln!("[runtimes] probe task failed: {error}");
            Vec::new()
        });
    Json(json!({ "runtimes": runtimes, "count": runtimes.len() }))
}

/// GET /api/runtime/install-plan?id=git（省略 id 时返回全部可安装项）
///
/// 只读：返回「点确认后会执行的完整命令」与前置条件（是否已装、winget 是否可用、
/// 能力开关是否放行），确认卡据此渲染；引擎在这里不执行任何东西。
pub(in crate::web) async fn install_plan(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let allowed = runtime_install_allowed(&state.home);
    let winget_available = find_winget().is_some();
    let requested = params
        .get("id")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(id) = requested {
        let spec = spec_by_id(&id).ok_or_else(|| unknown_runtime(&id))?;
        return Ok(Json(json!({
            "plan": plan_payload(spec, allowed, winget_available, &state.home),
            "allowed": allowed,
            "supported": supported_ids(),
        })));
    }
    let plans = SPECS
        .iter()
        .map(|spec| plan_payload(spec, allowed, winget_available, &state.home))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "plans": plans,
        "count": plans.len(),
        "allowed": allowed,
        "supported": supported_ids(),
    })))
}

fn unknown_runtime(id: &str) -> ApiError {
    ApiError::bad_request(format!(
        "未知的运行时 {}；可安装：{}",
        id,
        supported_ids().join(", ")
    ))
}

#[derive(Deserialize)]
pub(in crate::web) struct RuntimeInstallRequest {
    id: String,
    /// 确认卡回执：没有它一律拒绝（防止误触直接装东西）。
    #[serde(default)]
    confirm: bool,
    /// 已安装也照跑（修复 / 升级）；默认 false：已安装直接短路返回，不碰系统。
    #[serde(default)]
    force: bool,
}

/// POST /api/runtime/install {id, confirm:true, force?}
///
/// 走 TaskManager 建一个 runtime_tool_install 任务跑 winget 并返回 task_id：
/// 日志看 /api/tasks/{task_id}/log，取消用 DELETE /api/tasks/{task_id}，
/// 结束后自动重新探测，可用 /api/runtime/install-status?task_id= 取回 before/after。
pub(in crate::web) async fn install(
    State(state): State<AppState>,
    Json(request): Json<RuntimeInstallRequest>,
) -> Result<Json<Value>, ApiError> {
    let id = request.id.trim().to_ascii_lowercase();
    let spec = spec_by_id(&id).ok_or_else(|| unknown_runtime(&id))?;
    // 能力开关关掉时一律 403：设置页的开关是引擎侧权威值，不能只靠前端禁用按钮。
    if !runtime_install_allowed(&state.home) {
        return Err(ApiError::forbidden(
            "一键安装已在设置里关闭（settings.json → capabilities.allowRuntimeInstall）。\
             请在设置页打开「允许一键安装运行时」后重试，或按 install-plan 返回的命令手动安装。",
        ));
    }
    if !request.confirm {
        return Err(ApiError::bad_request(
            "需要用户在确认卡里确认后再安装：请先 GET /api/runtime/install-plan 展示命令，再带 confirm: true 重试",
        ));
    }
    let home = state.home.clone();
    let before = tokio::task::spawn_blocking(move || probe(spec, &home, &probe_winget()))
        .await
        .map_err(|error| ApiError::internal(format!("runtime probe failed: {error}")))?;
    let command = manual_command(spec);
    // winget 自己：本机没有 winget，谈不上「用 winget 装 winget」，
    // 走官方 winget-install 脚本（PowerShell + UAC），任务日志实时回显。
    if is_bootstrap_spec(spec) {
        return install_winget_bootstrap(&state, spec, before, request.force);
    }
    // Docker：引擎不代装，把引导文案交回调用方（200，不是错误）。
    if spec.package.is_none() {
        return Ok(Json(json!({
            "ok": false,
            "guided": true,
            "installable": false,
            "id": spec.id,
            "label": spec.label,
            "task_id": Value::Null,
            "command": command,
            "guidance": guidance_for(spec),
            "url": spec.url,
            "before": before,
        })));
    }
    let Some(winget) = find_winget() else {
        return Err(ApiError::bad_request(format!(
            "本机没有找到 winget（Windows 应用安装程序 / App Installer），无法一键安装 {}。\
             请先安装 App Installer（Microsoft Store 搜索「应用安装程序」），或手动执行：{command}",
            spec.label
        )));
    };
    // 已安装就短路：不为了「走一遍流程」去动用户已经装好的环境（force 才真跑）。
    if before["found"].as_bool().unwrap_or(false) && !request.force {
        return Ok(Json(json!({
            "ok": true,
            "already_installed": true,
            "installable": true,
            "id": spec.id,
            "label": spec.label,
            "task_id": Value::Null,
            "command": command,
            "before": before.clone(),
            "after": before,
            "message": format!("{} 已经安装，无需重复安装", spec.label),
        })));
    }
    let args = install_args(spec);
    start_install_task(&state, spec, winget, args, command, before, false, "user")
}

/// winget 引导安装：本机没有 winget 时，跑官方 winget-install 脚本把它装上。
///
/// 与普通安装共用同一套任务/日志/取消/复检机制，差别只有 executable 与参数：
/// program = powershell，脚本地址走生效的 GitHub 前缀。
fn install_winget_bootstrap(
    state: &AppState,
    spec: &'static RuntimeSpec,
    before: Value,
    force: bool,
) -> Result<Json<Value>, ApiError> {
    let command = winget_bootstrap_command(&state.home);
    // 已经装了就短路（force 才重跑一遍引导脚本）。
    if before["found"].as_bool().unwrap_or(false) && !force {
        return Ok(Json(json!({
            "ok": true,
            "already_installed": true,
            "installable": true,
            "id": spec.id,
            "label": spec.label,
            "task_id": Value::Null,
            "command": command,
            "before": before.clone(),
            "after": before,
            "message": format!("{} 已经安装，无需重复安装", spec.label),
        })));
    }
    let Some(powershell) = find_powershell() else {
        return Err(ApiError::bad_request(
            "本机没有找到 PowerShell（pwsh / powershell.exe）：winget 引导脚本需要它。             请手动下载 https://github.com/asheroto/winget-install/releases/latest/download/winget-install.ps1 并以管理员身份运行。",
        ));
    };
    let args = winget_bootstrap_args(&state.home);
    start_install_task(state, spec, powershell, args, command, before, true, "machine")
}

/// 建任务 → 起后台 runner → 返回确认卡回执（两条安装路径共用）。
#[allow(clippy::too_many_arguments)]
fn start_install_task(
    state: &AppState,
    spec: &'static RuntimeSpec,
    program: PathBuf,
    args: Vec<String>,
    command: String,
    before: Value,
    requires_elevation: bool,
    scope: &str,
) -> Result<Json<Value>, ApiError> {
    let record = state
        .task_manager
        .create(
            "runtime-install",
            RUNTIME_INSTALL_KIND,
            TaskPriority::High,
            vec![ResourceRequest {
                key: ResourceKey::new(ResourceKind::RuntimeInstall, spec.id),
                access: ResourceAccess::Write,
            }],
        )
        .map_err(ApiError::from)?;
    // 会话级任务表的键就用 task_id：DELETE /api/tasks/{task_id} 因此能直接取消这次安装。
    let task = state.task(&record.id);
    task.begin_turn(record.id.clone());
    task.running.store(true, Ordering::SeqCst);
    let _ = state.task_manager.transition(
        &record.id,
        TaskStatus::WaitingLock,
        Some(&format!("waiting for the runtime install slot: {command}")),
    );
    let task_id = record.id.clone();
    let runner_state = state.clone();
    let runner_task = Arc::clone(&task);
    let runner_id = record.id.clone();
    let runner_command = command.clone();
    // 探测结果同时要进响应体与后台任务，先克隆一份给任务。
    let runner_before = before.clone();
    tokio::spawn(async move {
        run_install(
            runner_state,
            runner_task,
            runner_id,
            spec,
            program,
            args,
            runner_command,
            runner_before,
        )
        .await;
    });
    Ok(Json(json!({
        "ok": true,
        "already_installed": false,
        "installable": true,
        "id": spec.id,
        "label": spec.label,
        "task_id": task_id,
        "status": "queued",
        "command": command,
        "scope": scope,
        "requires_elevation": requires_elevation,
        "before": before,
        "after": Value::Null,
        "log_url": format!("/api/tasks/{task_id}/log"),
        "status_url": format!("/api/runtime/install-status?task_id={task_id}"),
        "cancel_url": format!("/api/tasks/{task_id}"),
    })))
}

/// GET /api/runtime/install-status?task_id=...
///
/// 安装任务的进度视图：任务状态 + 完成后自动重新探测得到的 before/after
/// （取自任务日志里那行机器可读结果）+ 日志尾部。任务还在跑时 result 为 null，
/// 看 log_lines 即可。
pub(in crate::web) async fn install_status(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let task_id = params
        .get("task_id")
        .or_else(|| params.get("id"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("missing task_id"))?;
    let record = state
        .task_manager
        .get(&task_id)
        .ok_or_else(|| ApiError::not_found(format!("task {task_id} was not found")))?;
    if record.kind != RUNTIME_INSTALL_KIND {
        return Err(ApiError::bad_request(format!(
            "task {task_id} is not a runtime install task (kind: {})",
            record.kind
        )));
    }
    let path = state.task_manager.output_path(&task_id);
    let (lines, log_truncated) = if path.is_file() {
        crate::web::read_log_tail(&path, STATUS_LOG_LINES)?
    } else {
        (Vec::new(), false)
    };
    let result = lines.iter().rev().find_map(|line| {
        line.trim()
            .strip_prefix(RESULT_PREFIX)
            .and_then(|rest| serde_json::from_str::<Value>(rest).ok())
    });
    let before = result
        .as_ref()
        .and_then(|value| value.get("before").cloned())
        .unwrap_or(Value::Null);
    let after = result
        .as_ref()
        .and_then(|value| value.get("after").cloned())
        .unwrap_or(Value::Null);
    Ok(Json(json!({
        "task_id": task_id,
        "id": record.resources.first().map(|request| request.key.identity.clone()),
        "status": record.status,
        "running": !record.status.is_terminal(),
        "error": record.error,
        "created_at_ms": record.created_at_ms,
        "updated_at_ms": record.updated_at_ms,
        "before": before,
        "after": after,
        "result": result,
        "log_lines": lines,
        "log_truncated": log_truncated,
        "log_path": path.display().to_string(),
    })))
}

/// 确认卡数据：将执行的命令 + 前置条件 + 用户可见的步骤说明。
fn plan_payload(spec: &RuntimeSpec, allowed: bool, winget_available: bool, home: &Path) -> Value {
    let winget = find_winget();
    // winget 自己：确认卡展示的是引导脚本（PowerShell + UAC），不是 winget install。
    if is_bootstrap_spec(spec) {
        let command = winget_bootstrap_command(home);
        let installed = winget.is_some();
        let version = winget
            .as_ref()
            .and_then(|path| run_version(path, spec.version_args))
            .unwrap_or_default();
        let winget_path = winget
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        return json!({
            "id": spec.id,
            "label": spec.label,
            "kind": "script",
            "installable": true,
            "command": command.clone(),
            "manual_command": command,
            "program": "powershell",
            "args": winget_bootstrap_args(home),
            "script_url": winget_script_url(home),
            "github_prefix": github_prefix(home),
            "scope": "machine",
            "requires_elevation": true,
            "accept_agreements": true,
            "winget_available": winget_available,
            "winget_path": winget_path,
            "allowed": allowed,
            "already_installed": installed,
            "found": installed,
            "version": version,
            "path": winget_path,
            "guidance": guidance_for(spec),
            "note": spec.note,
            "url": spec.url,
            "steps": [
                format!("下载安装脚本：{}", winget_script_url(home)),
                "脚本会请求管理员权限：桌面弹出 UAC 窗口时点「是」".to_owned(),
                "输出实时写入任务日志，可随时取消；结束后自动复检 winget".to_owned(),
            ],
        });
    }
    let env = probe_env();
    let resolved = resolve_runtime_binary(spec, &env);
    let installed = resolved.is_ok();
    let version = resolved
        .as_ref()
        .map(|found| found.version.clone())
        .unwrap_or_default();
    let path = resolved.as_ref().ok().map(|found| found.path.clone());
    let source = resolved
        .as_ref()
        .map(|found| found.source.clone())
        .unwrap_or_default();
    let reason = resolved.as_ref().err().cloned().unwrap_or_default();
    let command = install_command(spec);
    let steps = if let Some(command) = command.as_ref() {
        vec![
            format!("执行：{command}"),
            "全程 --scope user：装到当前用户目录，不弹 UAC、不需要管理员".to_owned(),
            "输出实时写入任务日志，可随时取消；结束后自动重新探测并回报 before/after".to_owned(),
        ]
    } else {
        vec![
            "引擎不会替用户安装容器运行时（需要人工首次启动与登录）".to_owned(),
            format!("手动执行：{}", spec.manual_command),
        ]
    };
    json!({
        "id": spec.id,
        "label": spec.label,
        "kind": if command.is_some() { "winget" } else { "guided" },
        "installable": command.is_some(),
        "command": command.clone().unwrap_or_default(),
        "manual_command": manual_command(spec),
        "program": "winget",
        "args": install_args(spec),
        "scope": "user",
        "requires_elevation": false,
        "accept_agreements": true,
        "winget_available": winget_available,
        "winget_path": winget.map(|path| path.display().to_string()).unwrap_or_default(),
        "allowed": allowed,
        "already_installed": installed,
        "found": installed,
        "version": version,
        "path": path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        "resolved_path": path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        "source": source,
        "reason": reason,
        "probe_sources": env.source_label(),
        "guidance": guidance_for(spec),
        "note": spec.note,
        "url": spec.url,
        "steps": steps,
    })
}

/// 后台安装：等锁 → 跑 winget（输出进任务日志）→ 重新探测 → 落结果行 → 收敛状态。
#[allow(clippy::too_many_arguments)]
async fn run_install(
    state: AppState,
    task: Arc<SessionTask>,
    task_id: String,
    spec: &'static RuntimeSpec,
    program: PathBuf,
    args: Vec<String>,
    command: String,
    before: Value,
) {
    let manager = Arc::clone(&state.task_manager);
    // 生效镜像以环境变量注入安装子进程（npm registry / pip / uv index）：
    // 只影响这个子进程，不改用户的全局 npm/pip 配置。
    let install_env = mirror_env(&state.home);
    let probe_home = state.home.clone();
    // 1) 等资源锁（同一运行时的并发安装必须排队）。
    let lease = loop {
        if !task.running.load(Ordering::SeqCst) {
            finish_install(
                &manager,
                &task,
                &task_id,
                TaskStatus::Cancelled,
                "installing was cancelled while waiting for the install slot",
            );
            return;
        }
        match manager.acquire(&task_id) {
            Ok(Some(lease)) => break lease,
            Ok(None) => tokio::time::sleep(LOCK_POLL_INTERVAL).await,
            Err(error) => {
                // 排队阶段没有 Running → Failed 这条边：先落到 Running 再失败，
                // 否则状态机会拒绝转换，任务会永远停在 waiting_lock。
                let _ = manager.transition(
                    &task_id,
                    TaskStatus::Running,
                    Some("install aborted before the process started"),
                );
                let summary = format!("获取安装资源锁失败：{error:#}");
                push_log(&manager, &task_id, &format!("[coomi] {summary}"), &mut false);
                finish_install(&manager, &task, &task_id, TaskStatus::Failed, &summary);
                return;
            }
        }
    };
    task.set_phase("running");
    let _ = manager.transition(
        &task_id,
        TaskStatus::Running,
        Some(&format!("running: {command}")),
    );
    let mut log_full = false;
    push_log(&manager, &task_id, &format!("[coomi] $ {command}"), &mut log_full);
    let mut tail: VecDeque<String> = VecDeque::new();

    // 2) 起安装进程（winget / powershell），stdout/stderr 各一条读线程 → 频道 → 任务日志。
    let mut guard = match spawn_install(&program, &args, &install_env) {
        Ok(child) => ChildGuard::new(child),
        Err(error) => {
            let summary = format!("无法启动安装进程（{}）：{error}", program.display());
            push_log(&manager, &task_id, &format!("[coomi] {summary}"), &mut log_full);
            finish_install(&manager, &task, &task_id, TaskStatus::Failed, &summary);
            return;
        }
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if let Some(stdout) = guard.take_stdout() {
        spawn_pump(stdout, tx.clone());
    }
    if let Some(stderr) = guard.take_stderr() {
        spawn_pump(stderr, tx.clone());
    }
    drop(tx);

    let mut cancelled = false;
    let mut timed_out = false;
    // winget 会派生子安装器，杀掉它之后管道可能还被孙进程攥着：
    // 终止后最多再等这么久收尾，不能让取消莫名其妙地卡住。
    let mut killed_at: Option<Instant> = None;
    let deadline = Instant::now() + INSTALL_TIMEOUT;
    loop {
        // 取消是协作式的：不 abort 掉这条任务，才能杀掉 winget 并把结果行写完。
        if !task.running.load(Ordering::SeqCst) {
            cancelled = true;
            guard.kill();
            killed_at.get_or_insert_with(Instant::now);
        }
        tokio::select! {
            received = rx.recv() => match received {
                Some(line) => {
                    push_log(&manager, &task_id, &line, &mut log_full);
                    while tail.len() >= SUMMARY_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(sanitize_line(&line));
                }
                // 两条读线程都结束 = 管道关闭 = 进程退出。
                None => break,
            },
            () = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    guard.kill();
                    killed_at.get_or_insert_with(Instant::now);
                }
                if killed_at.is_some_and(|at| at.elapsed() >= KILL_DRAIN_TIMEOUT) {
                    break;
                }
            }
        }
    }
    let status = guard.wait();
    let success = !cancelled && !timed_out && status.as_ref().is_some_and(ExitStatus::success);

    // 3) 先刷新引擎内部探测环境（重读注册表 PATH 与已知目录）再立即复检：
    //    安装器只改注册表里的 Path，正在运行的引擎进程环境变量不会跟着变。
    let refreshed = tokio::task::spawn_blocking(refresh_probe_env)
        .await
        .map(|env| env.source_label())
        .unwrap_or_default();
    push_log(
        &manager,
        &task_id,
        &format!("[coomi] 探测环境已刷新（来源：{refreshed}），开始复检 {}", spec.label),
        &mut log_full,
    );
    // 安装命令跑完不代表工具已可用：after 以「真跑一次版本命令」的探测结果为准。
    let after = tokio::task::spawn_blocking(move || probe(spec, &probe_home, &probe_winget()))
        .await
        .unwrap_or(Value::Null);
    let after_found = after["found"].as_bool().unwrap_or(false);
    let after_version = after["version"].as_str().unwrap_or_default().to_owned();
    let result = json!({
        "task_id": task_id,
        "id": spec.id,
        "command": command,
        "cancelled": cancelled,
        "timed_out": timed_out,
        "exit_code": status.as_ref().and_then(ExitStatus::code),
        "success": success,
        "before": before,
        "after": after,
    });
    push_log(
        &manager,
        &task_id,
        &format!("{RESULT_PREFIX}{result}"),
        &mut log_full,
    );

    let tail_text = tail.iter().cloned().collect::<Vec<_>>().join(" | ");
    let (final_status, summary) = if cancelled {
        (
            TaskStatus::Cancelled,
            format!("{} 安装已取消（winget 已终止）", spec.label),
        )
    } else if timed_out {
        (
            TaskStatus::Failed,
            format!(
                "{} 安装超时（{} 分钟），已终止 winget",
                spec.label,
                INSTALL_TIMEOUT.as_secs() / 60
            ),
        )
    } else if !success {
        (
            TaskStatus::Failed,
            format!(
                "{} 安装失败（winget 退出码 {}）{}",
                spec.label,
                status
                    .as_ref()
                    .and_then(ExitStatus::code)
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_owned()),
                if tail_text.is_empty() {
                    String::new()
                } else {
                    format!("：{tail_text}")
                }
            ),
        )
    } else if after_found {
        (
            TaskStatus::Completed,
            format!("{} 安装完成：{after_version}", spec.label),
        )
    } else {
        (
            TaskStatus::Completed,
            format!(
                "{} 安装命令执行成功，但重新探测仍未找到它：可能需要重新登录或重启终端刷新 PATH",
                spec.label
            ),
        )
    };
    drop(lease);
    finish_install(&manager, &task, &task_id, final_status, &summary);
}

/// 任务收尾：会话级任务（进度面板）与 TaskManager 记录同时收敛到终态。
fn finish_install(
    manager: &Arc<TaskManager>,
    task: &Arc<SessionTask>,
    task_id: &str,
    status: TaskStatus,
    summary: &str,
) {
    task.finish(match status {
        TaskStatus::Completed => "completed",
        TaskStatus::Cancelled => "cancelled",
        _ => "failed",
    });
    // 取消路径上 stop_session_task 可能已把记录推到 cancelled；同态转换是允许的。
    let _ = manager.transition(task_id, status, Some(summary));
}

/// 输出进任务日志；日志写满（TaskManager 的 output_bytes 上限）后静默停写。
fn push_log(manager: &Arc<TaskManager>, task_id: &str, line: &str, log_full: &mut bool) {
    if *log_full {
        return;
    }
    let text = sanitize_line(line);
    if text.is_empty() {
        return;
    }
    if manager
        .append_output(task_id, format!("{text}\n").as_bytes())
        .is_err()
    {
        *log_full = true;
    }
}

/// winget 的进度条会把整屏刷进一行（含 \r、退格与 ANSI），落日志前先清干净并截断。
fn sanitize_line(line: &str) -> String {
    // 进度更新用 \r 覆盖同一行：只保留最后一段非空内容（末尾常有孤立的 \r）。
    let segment = line
        .split('\r')
        .rev()
        .map(str::trim)
        .find(|part| !part.is_empty())
        .unwrap_or_default();
    let cleaned = segment
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\t')
        .collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.chars().count() > LOG_LINE_MAX_CHARS {
        let mut truncated = cleaned.chars().take(LOG_LINE_MAX_CHARS).collect::<String>();
        truncated.push_str("...（本行已截断）");
        return truncated;
    }
    cleaned.to_owned()
}

/// stdout/stderr 各起一条线程读行，读到的行经频道送回 tokio 侧落日志。
fn spawn_pump<R: std::io::Read + Send + 'static>(
    reader: R,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

/// 带「drop 即杀进程」语义的子进程包装：任务被取消或运行时不会留下孤儿 winget。
struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.as_mut().and_then(|child| child.stdout.take())
    }

    fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.as_mut().and_then(|child| child.stderr.take())
    }

    fn kill(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
    }

    fn wait(&mut self) -> Option<ExitStatus> {
        self.child.as_mut().and_then(|child| child.wait().ok())
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 每个探测各自起一个线程：单个工具卡住也不会把整份列表拖到超时。
/// winget 只探一次，再把结果分发给每一项。
fn probe_all(home: &Path) -> Vec<Value> {
    let winget = probe_winget();
    std::thread::scope(|scope| {
        let handles = SPECS
            .iter()
            .map(|spec| {
                let winget = &winget;
                scope.spawn(move || probe(spec, home, winget))
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    json!({"id": "", "label": "", "found": false, "version": "", "path": ""})
                })
            })
            .collect()
    })
}

/// 探测 winget 自己（安装其它运行时的前置）：列表里每一项都带这份结果。
fn probe_winget() -> Value {
    let path = find_winget();
    let version = path
        .as_ref()
        .and_then(|path| run_version(path, &["--version"]))
        .unwrap_or_default();
    json!({
        "found": path.is_some(),
        "version": version,
        "path": path.map(|path| path.display().to_string()).unwrap_or_default(),
    })
}

fn probe(spec: &RuntimeSpec, home: &Path, winget: &Value) -> Value {
    let env = probe_env();
    // winget 自己：探测结果直接复用上面那一份，不再跑第二次版本命令。
    let (resolved, failure) = if is_bootstrap_spec(spec) {
        let found = winget["found"].as_bool().unwrap_or(false);
        match found.then(|| PathBuf::from(winget["path"].as_str().unwrap_or_default())) {
            Some(path) => (
                Some(ResolvedRuntime {
                    path,
                    source: SOURCE_KNOWN_DIR.to_owned(),
                    version: winget["version"].as_str().unwrap_or_default().to_owned(),
                }),
                String::new(),
            ),
            None => (
                None,
                format!(
                    "没找到 {}：已检查进程 PATH、实时注册表 PATH 与已知安装目录（来源：{}）",
                    spec.label,
                    env.source_label()
                ),
            ),
        }
    } else {
        // 统一解析：绝对路径 + 真跑一次版本命令 + 命中来源；失败给中文原因。
        match resolve_runtime_binary(spec, &env) {
            Ok(found) => (Some(found), String::new()),
            Err(reason) => (None, reason),
        }
    };
    let path = resolved.as_ref().map(|found| found.path.clone());
    let version = resolved
        .as_ref()
        .map(|found| found.version.clone())
        .unwrap_or_default();
    let source = resolved
        .as_ref()
        .map(|found| found.source.clone())
        .unwrap_or_default();
    let install = if is_bootstrap_spec(spec) {
        // winget 的「安装命令」是引导脚本，同样带上生效的 GitHub 前缀。
        json!({
            "winget": winget_bootstrap_command(home),
            "url": spec.url,
            "note": spec.note,
            "auto": true,
        })
    } else {
        // winget 字段既是给用户复制的命令，也是引擎实际执行的命令（同源）。
        json!({
            "winget": manual_command(spec),
            "url": spec.url,
            "note": spec.note,
            "auto": spec.package.is_some(),
        })
    };
    json!({
        "id": spec.id,
        "label": spec.label,
        // 只有真跑通版本命令才算 found（找到了入口但跑不起来 ≠ 可用）。
        "found": path.is_some(),
        "version": version,
        // 没找到时给空串而不是 null：前端直接渲染，不必先判空。
        "path": path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        // 解析出来的绝对路径 + 命中来源（process_path / registry_path / known_dir）。
        "resolved_path": path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        "source": source,
        // 未找到时的中文原因（说明看过哪些来源、试过几个候选）。
        "reason": failure,
        "probe_sources": env.source_label(),
        // 缺 winget 时前端提示先装 winget（POST /api/runtime/install {id:"winget"}）。
        "winget": winget,
        "install": install,
    })
}


/// 探测来源标签：命中哪个来源，前端/日志用它解释「为什么这里能找到」。
pub(in crate::web) const SOURCE_PROCESS_PATH: &str = "process_path";
pub(in crate::web) const SOURCE_REGISTRY_PATH: &str = "registry_path";
pub(in crate::web) const SOURCE_KNOWN_DIR: &str = "known_dir";

/// PATH 之外的已知安装目录：引擎进程的 PATH 是启动时的快照，用户刚装好的
/// 工具（winget 的 shim、uv 的 ~/.local/bin、cargo bin、用户级 Programs 安装）
/// 往往只有从这里才找得到。%VAR% / $VAR 按探测环境里的变量表展开。
fn known_bin_dirs(env: &ProbeEnv) -> Vec<PathBuf> {
    let templates: &[&str] = if cfg!(windows) {
        &[
            "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links",
            "%USERPROFILE%\\.local\\bin",
            "%USERPROFILE%\\.cargo\\bin",
            "%LOCALAPPDATA%\\Programs",
            "%APPDATA%\\npm",
            "%ProgramFiles%\\nodejs",
            "%LOCALAPPDATA%\\Programs\\DockerDesktop\\resources\\bin",
        ]
    } else {
        &[
            "$HOME/.local/bin",
            "$HOME/.cargo/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/opt/homebrew/bin",
        ]
    };
    let mut directories = Vec::new();
    for template in templates {
        let path = PathBuf::from(env.expand(template));
        if !path.is_dir() {
            continue;
        }
        directories.push(path.clone());
        // 用户级安装常见形态是 <Programs>\<工具名>\<工具名>.exe：只对 Programs
        // 根目录做一层受控展开（条数封顶），不扫全盘。
        if path.file_name().and_then(|name| name.to_str()) == Some("Programs")
            && let Ok(entries) = std::fs::read_dir(&path)
        {
            for entry in entries.flatten().take(64) {
                let child = entry.path();
                if child.is_dir() {
                    directories.push(child.clone());
                    directories.push(child.join("bin"));
                }
            }
        }
    }
    directories
}

/// 探测环境：进程 PATH + 实时注册表 PATH + 已知目录 + %VAR% 展开用的变量表。
///
/// 「实时读注册表」是关键：winget / uv 安装器只改注册表里的 Path，正在运行的
/// 引擎进程的环境变量不会跟着变——不读注册表就会出现「刚装完却探测不到」。
pub(in crate::web) struct ProbeEnv {
    /// 候选目录（按优先级）：进程 PATH → 注册表 PATH → 已知安装目录。
    directories: Vec<(PathBuf, &'static str)>,
    /// 变量表：进程环境 + 注册表 PATH（覆盖进程里的旧 PATH）。
    variables: BTreeMap<String, String>,
}

impl ProbeEnv {
    fn capture() -> Self {
        let variables = std::env::vars().collect::<BTreeMap<_, _>>();
        let process_path = std::env::var("PATH").unwrap_or_default();
        let mut directories = Vec::new();
        for directory in std::env::split_paths(&process_path) {
            if !directory.as_os_str().is_empty() {
                directories.push((directory, SOURCE_PROCESS_PATH));
            }
        }
        let mut env = Self {
            directories,
            variables,
        };
        if let Some(registry) = read_registry_path() {
            // 注册表里的 PATH 可能含 %USERPROFILE% 这类未展开变量。
            let expanded = env.expand(&registry);
            env.variables.insert("PATH".to_owned(), expanded.clone());
            for directory in std::env::split_paths(&expanded) {
                if directory.as_os_str().is_empty()
                    || env.directories.iter().any(|(known, _)| known == &directory)
                {
                    continue;
                }
                env.directories.push((directory, SOURCE_REGISTRY_PATH));
            }
        }
        for directory in known_bin_dirs(&env) {
            if env.directories.iter().any(|(known, _)| known == &directory) {
                continue;
            }
            env.directories.push((directory, SOURCE_KNOWN_DIR));
        }
        env
    }

    /// 展开 %VAR%（Windows）/ $VAR（其它平台），未知变量保留原样。
    fn expand(&self, template: &str) -> String {
        expand_env_with(template, &self.variables)
    }

    /// 已检查的来源标签（回给用户的中文原因里用）。
    fn source_label(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for (_, source) in &self.directories {
            if !parts.contains(source) {
                parts.push(source);
            }
        }
        parts.join("+")
    }
}

/// 引擎内部探测环境缓存：安装任务结束时 refresh_probe_env() 刷新并立即复检。
static PROBE_ENV: OnceLock<StdMutex<Option<Arc<ProbeEnv>>>> = OnceLock::new();

fn probe_env_slot() -> &'static StdMutex<Option<Arc<ProbeEnv>>> {
    PROBE_ENV.get_or_init(|| StdMutex::new(None))
}

/// 取当前探测环境（首次调用时采集，之后走缓存）。
pub(in crate::web) fn probe_env() -> Arc<ProbeEnv> {
    let slot = probe_env_slot();
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(env) = guard.as_ref() {
        return Arc::clone(env);
    }
    let env = Arc::new(ProbeEnv::capture());
    *guard = Some(Arc::clone(&env));
    env
}

/// 安装任务结束时刷新引擎内部探测环境（重读注册表 PATH 与已知目录），
/// 调用方随后立刻用新环境复检，避免「装完了却仍显示未安装」。
pub(in crate::web) fn refresh_probe_env() -> Arc<ProbeEnv> {
    let env = Arc::new(ProbeEnv::capture());
    let slot = probe_env_slot();
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(Arc::clone(&env));
    env
}

/// Windows：实时读注册表里的 Path（HKCU\Environment + HKLM 机器级 Path）。
/// 非 Windows 直接返回 None。
fn read_registry_path() -> Option<String> {
    #[cfg(windows)]
    {
        let user = read_registry_value("HKCU\\Environment", "Path");
        let machine = read_registry_value(
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            "Path",
        );
        match (user, machine) {
            (Some(user), Some(machine)) => Some(format!("{user};{machine}")),
            (Some(user), None) => Some(user),
            (None, machine) => machine,
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 跑 reg query 取一个 REG_SZ / REG_EXPAND_SZ 值；解析失败一律返回 None。
#[cfg(windows)]
fn read_registry_value(key: &str, name: &str) -> Option<String> {
    let mut command = Command::new("reg");
    command.args(["query", key, "/v", name]);
    hide_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed
            .to_ascii_lowercase()
            .starts_with(&name.to_ascii_lowercase())
        {
            continue;
        }
        let rest = &trimmed[name.len()..];
        for kind in ["REG_EXPAND_SZ", "REG_SZ", "REG_MULTI_SZ"] {
            if let Some(index) = rest.find(kind) {
                let value = rest[index + kind.len()..].trim();
                if !value.is_empty() {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}

/// 一次成功的可执行文件解析结果。
#[derive(Clone, Debug)]
pub(in crate::web) struct ResolvedRuntime {
    /// 解析出来的绝对路径（Windows 上 npx 就是 npx.cmd）。
    pub path: PathBuf,
    /// 命中来源：process_path / registry_path / known_dir。
    pub source: String,
    /// 实跑一次版本命令得到的版本行——只有真跑通才算 found。
    pub version: String,
}

/// uv/uvx/npx/npm/docker（以及 node/git/kubectl/ffmpeg/winget）统一的绝对路径解析：
///
/// 1. 按「进程 PATH → 实时注册表 PATH → 已知安装目录 → 内置兜底路径」逐目录找候选；
/// 2. 同一目录内按 PATHEXT 优先级拼扩展名（npx.cmd 先于无扩展名的 npx）；
/// 3. 每个候选都真跑一次版本命令，跑通才算找到，并回报 resolvedPath + source；
/// 4. 找不到时返回中文原因（说明看过哪些来源、试过多少个候选）。
pub(in crate::web) fn resolve_runtime_binary(
    spec: &RuntimeSpec,
    env: &ProbeEnv,
) -> Result<ResolvedRuntime, String> {
    let extensions = executable_extensions();
    let mut looked = 0usize;
    let mut found_but_failed: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    for (directory, source) in &env.directories {
        for extension in &extensions {
            candidates.push((directory.join(format!("{}{}", spec.id, extension)), source));
        }
    }
    for template in spec.fallbacks {
        candidates.push((PathBuf::from(env.expand(template)), SOURCE_KNOWN_DIR));
    }
    for (candidate, source) in candidates {
        if !seen.insert(candidate.clone()) || !candidate.is_file() {
            continue;
        }
        looked += 1;
        match run_version(&candidate, spec.version_args) {
            Some(version) => {
                return Ok(ResolvedRuntime {
                    path: candidate,
                    source: source.to_owned(),
                    version,
                });
            }
            None => found_but_failed = Some(candidate.display().to_string()),
        }
    }
    Err(match found_but_failed {
        Some(path) => format!(
            "找到过 {} 的入口 {}，但它执行版本命令失败（文件损坏、被杀软拦截或缺少运行库）：请修复或重新安装 {}",
            spec.label, path, spec.label
        ),
        None => format!(
            "没找到 {}：已检查进程 PATH、实时注册表 PATH 与已知安装目录（来源：{}），共试过 {} 个候选位置；装了新工具后请点「重新探测」，或确认安装目录已加入 PATH",
            spec.label,
            env.source_label(),
            looked
        ),
    })
}

/// 定位可执行文件：先扫 PATH（按 PATHEXT 拼扩展名），再试 winget 的 shim 目录，
/// 最后试常见安装目录。
/// 在当前探测环境的候选目录里按名字找入口（不跑版本命令，供 winget/powershell
/// 这类「先找到再决定怎么用」的调用方使用）。
fn find_program_in(env: &ProbeEnv, program: &str) -> Option<PathBuf> {
    for (directory, _) in &env.directories {
        if let Some(candidate) = find_in_directory(directory, program) {
            return Some(candidate);
        }
    }
    None
}

/// winget 的可执行入口：PATH 上找不到时再试 App Installer 的固定位置
/// （WindowsApps 别名目录与 WinGet\Links，后者是 portable 包的 shim 目录）。
fn find_winget() -> Option<PathBuf> {
    let env = probe_env();
    if let Some(path) = find_program_in(&env, "winget") {
        return Some(path);
    }
    for template in [
        "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\winget.exe",
        "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\winget.exe",
    ] {
        let candidate = PathBuf::from(env.expand(template));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_in_directory(directory: &Path, program: &str) -> Option<PathBuf> {
    for extension in executable_extensions() {
        let candidate = directory.join(format!("{program}{extension}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Windows 上按 PATHEXT 试扩展名（.cmd/.bat 也是可执行入口，npx 就是 .cmd）；
/// 其他平台可执行文件没有扩展名。
fn executable_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        // 先按 PATHEXT 试扩展名，最后才试无扩展名的名字：Node.js 会在同目录同时放
        // 无扩展名的 sh 脚本（npx）和 .cmd 版本，优先拿到的必须是能直接执行的那个。
        let mut extensions = Vec::new();
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        for item in pathext.split(';') {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            if item.starts_with('.') {
                extensions.push(item.to_ascii_lowercase());
            } else {
                extensions.push(format!(".{}", item.to_ascii_lowercase()));
            }
        }
        extensions.push(String::new());
        extensions
    }
    #[cfg(not(windows))]
    {
        vec![String::new()]
    }
}

/// 展开 %VAR%（Windows）/ $VAR（其它平台）。变量表由调用方给出（探测环境里
/// 的 PATH 已含实时注册表值），未知变量保留原样，反正 is_file() 会判 false。
fn expand_env_with(template: &str, variables: &BTreeMap<String, String>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            result.push_str(&rest[start..]);
            return result;
        };
        let name = &after[..end];
        match variables.get(name) {
            Some(value) => result.push_str(value),
            None => {
                result.push('%');
                result.push_str(name);
                result.push('%');
            }
        }
        rest = &after[end + 1..];
    }
    // 循环退出时 rest 里还压着**最后一个变量之后的全部内容**，必须补进结果。
    // 漏掉这一行会把 `%USERPROFILE%\.local\bin` 展开成 `C:\Users\<用户>`：
    // 「已知目录」整条清单的后缀会被逐条吃掉（winget / uv / cargo / npm / nodejs
    // 一个都定位不到 —— 而这份清单存在的唯一理由就是「刚装完、PATH 还没刷新时也能找到」），
    // 更糟的是用户主目录本身会被当成 bin 目录去扫。
    result.push_str(rest);
    result = expand_dollar_vars(&result, variables);
    result
}

/// 展开 $VAR / ${VAR}（非 Windows 的已知目录用得到）；$HOME 这类变量名之外的
/// 字符原样保留。
fn expand_dollar_vars(template: &str, variables: &BTreeMap<String, String>) -> String {
    if !template.contains('$') {
        return template.to_owned();
    }
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('$') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let (name, consumed) = if let Some(stripped) = after.strip_prefix('{') {
            match stripped.find('}') {
                Some(end) => (stripped[..end].to_owned(), end + 2),
                None => (String::new(), 0),
            }
        } else {
            let name = after
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .collect::<String>();
            let consumed = name.len() + 1;
            (name, consumed)
        };
        if consumed == 0 {
            result.push('$');
            rest = after;
            continue;
        }
        match variables.get(&name) {
            Some(value) => result.push_str(value),
            None => {
                result.push('$');
                result.push_str(&name);
            }
        }
        rest = &after[consumed - 1..];
    }
    result.push_str(rest);
    result
}

/// 探测/安装子进程一律不弹控制台窗口。
fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 组装版本命令。Windows 上 npx/uv 这类入口是 .cmd/.bat 脚本，
/// CreateProcess 不能直接执行它们，必须经 cmd /C 转一手（否则「找到了但没版本」）。
fn version_command(program: &Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        if is_script(program) {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(program).args(args);
            return command;
        }
    }
    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg(windows)]
fn is_script(program: &Path) -> bool {
    let extension = program
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    extension == "cmd" || extension == "bat"
}

/// 启动安装进程（winget / powershell）：不弹黑框、不读 stdin，stdout/stderr 全接管；
/// env 是生效镜像的环境变量（npm_config_registry / PIP_INDEX_URL / UV_INDEX_URL）。
fn spawn_install(
    program: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> std::io::Result<Child> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = if is_script(program) {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(program);
            command
        } else {
            Command::new(program)
        };
        // CREATE_NO_WINDOW：安装过程不该在用户桌面上闪一个控制台窗口。
        command.creation_flags(0x0800_0000);
        command.args(args);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(program);
        command.args(args);
        command
    };
    command
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

/// 跑一次版本命令并取第一行。超时直接杀掉进程并返回空（探测失败不该报错给前端）。
fn run_version(program: &Path, args: &[&str]) -> Option<String> {
    let mut command = version_command(program, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不弹黑框（探测可能发生在用户正在输入的时候）。
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(40));
            }
            // 超时或 wait 出错：杀掉，别留下孤儿进程。
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    // 退出码不为 0 一律算「跑不起来」：找到了入口但执行失败的工具不是可用工具，
    // 不能因为它在 PATH 上就报成 found。
    if !output.status.success() {
        return None;
    }
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).into_owned()
    } else {
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    Some(line.chars().take(VERSION_MAX_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str) -> &'static RuntimeSpec {
        spec_by_id(id).expect("known runtime")
    }

    #[test]
    fn install_commands_follow_the_documented_mapping() {
        // winget 包映射：node/npx→Node LTS、uv/uvx→uv、ffmpeg、git、kubectl。
        let cases = [
            ("node", "OpenJS.NodeJS.LTS"),
            ("npx", "OpenJS.NodeJS.LTS"),
            ("uv", "astral-sh.uv"),
            ("uvx", "astral-sh.uv"),
            ("ffmpeg", "Gyan.FFmpeg"),
            ("git", "Git.Git"),
            ("kubectl", "Kubernetes.kubectl"),
        ];
        for (id, package) in cases {
            let command = install_command(spec(id)).expect("auto installable");
            assert_eq!(
                command,
                format!("winget install {package} --accept-source-agreements --accept-package-agreements --scope user"),
                "unexpected command for {id}"
            );
        }
    }

    #[test]
    fn docker_is_guided_and_never_installed_by_the_engine() {
        let home = tempfile::tempdir().expect("temporary home");
        let docker = spec("docker");
        assert!(install_command(docker).is_none());
        assert!(guidance_for(docker).is_some());
        let plan = plan_payload(docker, true, true, home.path());
        assert_eq!(plan["kind"], json!("guided"));
        assert_eq!(plan["installable"], json!(false));
        assert_eq!(plan["command"], json!(""));
        assert_eq!(plan["manual_command"], json!("winget install Docker.DockerDesktop"));
    }

    #[test]
    fn winget_bootstrap_runs_the_github_script_through_the_active_prefix() {
        let home = tempfile::tempdir().expect("temporary home");
        let plan = plan_payload(spec("winget"), true, false, home.path());
        assert_eq!(plan["kind"], json!("script"));
        assert_eq!(plan["installable"], json!(true));
        assert_eq!(plan["requires_elevation"], json!(true));
        // 默认 GitHub 前缀 = gh-proxy.com：脚本地址必须走镜像。
        assert_eq!(
            plan["script_url"],
            json!("https://gh-proxy.com/https://github.com/asheroto/winget-install/releases/latest/download/winget-install.ps1")
        );
        assert_eq!(plan["github_prefix"], json!("https://gh-proxy.com/"));
        let args = plan["args"].as_array().expect("args");
        assert_eq!(args[0], json!("-NoProfile"));
        assert_eq!(args[1], json!("-ExecutionPolicy"));
        assert_eq!(args[2], json!("Bypass"));
        assert_eq!(args[3], json!("-Command"));
        assert!(
            args[4].as_str().expect("command").starts_with("irm https://gh-proxy.com/"),
            "script must be fetched through the mirror: {args:?}"
        );
        // 关掉镜像（active=official）后回落到直连 GitHub。
        let mut settings = crate::web::read_settings(home.path());
        settings["mirrors"] = json!({"github": {"active": "official"}});
        crate::web::write_settings(home.path(), &settings).expect("write settings");
        assert_eq!(
            winget_script_url(home.path()),
            WINGET_INSTALL_SCRIPT,
            "official github entry must not be prefixed"
        );
    }

    #[test]
    fn install_environment_carries_the_active_mirrors() {
        let home = tempfile::tempdir().expect("temporary home");
        let mut settings = crate::web::read_settings(home.path());
        settings["mirrors"] = json!({
            "npm": {"active": "huawei"},
            "pip": {"active": "ustc"},
        });
        crate::web::write_settings(home.path(), &settings).expect("write settings");
        let env = mirror_env(home.path());
        assert_eq!(
            env.get("npm_config_registry").map(String::as_str),
            Some("https://repo.huaweicloud.com/repository/npm/")
        );
        assert_eq!(
            env.get("PIP_INDEX_URL").map(String::as_str),
            Some("https://pypi.mirrors.ustc.edu.cn/simple/")
        );
        assert_eq!(env.get("UV_INDEX_URL"), env.get("PIP_INDEX_URL"));
    }

    #[test]
    fn spec_lookup_is_case_insensitive_and_rejects_unknown_ids() {
        assert_eq!(spec_by_id("GIT").expect("case insensitive").id, "git");
        assert_eq!(spec_by_id(" git ").expect("trimmed").id, "git");
        assert!(spec_by_id("rustc").is_none());
        assert!(supported_ids().contains(&"ffmpeg"));
    }

    #[test]
    fn allow_runtime_install_defaults_to_on_and_honours_settings() {
        let home = tempfile::tempdir().expect("temporary home");
        assert!(runtime_install_allowed(home.path()));
        let mut settings = crate::web::read_settings(home.path());
        settings["capabilities"] = json!({"allowRuntimeInstall": false});
        crate::web::write_settings(home.path(), &settings).expect("write settings");
        assert!(!runtime_install_allowed(home.path()));
        // 其他开关不受影响：缺省字段仍按默认值补齐。
        let capabilities = configured_capabilities(home.path());
        assert!(capabilities.memory);
        assert!(!capabilities.allow_runtime_install);
    }

    #[test]
    fn progress_lines_are_sanitized_before_hitting_the_log() {
        assert_eq!(sanitize_line("downloading 10%\rdownloading 90%\r"), "downloading 90%");
        assert_eq!(sanitize_line("\r\n"), "");
        let long = "x".repeat(LOG_LINE_MAX_CHARS + 50);
        let sanitized = sanitize_line(&long);
        assert!(sanitized.ends_with("...（本行已截断）"));
        assert!(sanitized.chars().count() <= LOG_LINE_MAX_CHARS + 10);
    }

    #[test]
    fn plan_payload_reports_the_exact_command_and_scope() {
        let home = tempfile::tempdir().expect("temporary home");
        let plan = plan_payload(spec("git"), false, true, home.path());
        assert_eq!(plan["id"], json!("git"));
        assert_eq!(plan["kind"], json!("winget"));
        assert_eq!(plan["scope"], json!("user"));
        assert_eq!(plan["requires_elevation"], json!(false));
        assert_eq!(plan["accept_agreements"], json!(true));
        // 能力开关关掉时计划本身仍可读，只是标记为不可执行。
        assert_eq!(plan["allowed"], json!(false));
        assert_eq!(plan["args"].as_array().expect("args").len(), 6);
    }

    /// 只含指定候选目录的探测环境：不依赖机器真实 PATH，断言才稳定。
    fn probe_env_with(directories: Vec<(PathBuf, &'static str)>) -> ProbeEnv {
        ProbeEnv {
            directories,
            variables: std::env::vars().collect(),
        }
    }

    /// 写一个真能跑通版本命令的替身（Windows 上是 .cmd）。
    #[cfg(windows)]
    fn write_stub(directory: &Path, name: &str, output: &str) -> PathBuf {
        let path = directory.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off\r\necho {output}\r\n")).expect("write stub");
        path
    }

    /// 写一个能找到、但跑版本命令必然失败的替身。
    #[cfg(windows)]
    fn write_failing_stub(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(format!("{name}.cmd"));
        std::fs::write(&path, "@echo off\r\nexit /b 1\r\n").expect("write stub");
        path
    }

    /// 每个候选都要真跑一次 --version：跑得通才算 found，并回报 path + source。
    #[cfg(windows)]
    #[test]
    fn runtime_resolution_runs_the_version_command_and_reports_the_source() {
        let dir = tempfile::tempdir().expect("temporary candidate dir");
        write_stub(dir.path(), "uv", "uv 0.9.9-stub");
        let env = probe_env_with(vec![(dir.path().to_path_buf(), SOURCE_KNOWN_DIR)]);
        let found = resolve_runtime_binary(spec("uv"), &env).expect("uv 替身必须被探测到");
        assert!(found.path.is_absolute(), "{:?}", found.path);
        assert!(found.path.ends_with("uv.cmd"), "{:?}", found.path);
        assert_eq!(found.source, SOURCE_KNOWN_DIR);
        assert_eq!(found.version, "uv 0.9.9-stub");
    }

    /// 找到了入口但跑不起来 ≠ 可用：必须报中文原因，而不是当成已安装。
    #[cfg(windows)]
    #[test]
    fn candidate_that_cannot_run_its_version_is_reported_in_chinese() {
        let dir = tempfile::tempdir().expect("temporary candidate dir");
        write_failing_stub(dir.path(), "uv");
        let env = probe_env_with(vec![(dir.path().to_path_buf(), SOURCE_PROCESS_PATH)]);
        // Test the failing candidate in isolation, without a real user's installed uv fallback.
        let isolated_spec = RuntimeSpec { fallbacks: &[], ..*spec("uv") };
        let error =
            resolve_runtime_binary(&isolated_spec, &env).expect_err("跑不通版本的候选不算 found");
        assert!(error.contains("版本命令失败"), "{error}");
        assert!(error.contains("uv"), "{error}");
    }

    /// 同目录同时有 npx（无扩展名脚本）与 npx.cmd：按 PATHEXT 优先取 npx.cmd。
    #[cfg(windows)]
    #[test]
    fn pathext_priority_prefers_the_cmd_launcher() {
        let dir = tempfile::tempdir().expect("temporary candidate dir");
        std::fs::write(dir.path().join("npx"), "#!/bin/sh\necho nope\n").expect("write shim");
        write_stub(dir.path(), "npx", "11.17.0-stub");
        let env = probe_env_with(vec![(dir.path().to_path_buf(), SOURCE_PROCESS_PATH)]);
        let found = resolve_runtime_binary(spec("npx"), &env).expect("npx 必须可解析");
        assert!(found.path.ends_with("npx.cmd"), "{:?}", found.path);
        assert_eq!(found.version, "11.17.0-stub");
    }

    /// %VAR% 展开必须保留变量**之后的全部内容**。
    ///
    /// 回归背景：这里曾经漏掉「循环结束把 rest 补进结果」这一步，于是
    /// `%USERPROFILE%\.local\bin` 被展开成 `C:\Users\<用户>` —— known_bin_dirs 里
    /// winget / uv / cargo / npm / nodejs 每一条的后缀都被吃掉，全部定位不到
    /// （而这份清单存在的唯一理由就是「刚装完、PATH 还没刷新时也能找到」），
    /// 并且用户主目录本身会被当成 bin 目录去扫。
    #[test]
    fn percent_expansion_keeps_text_after_the_variable() {
        let variables = BTreeMap::from([
            ("USERPROFILE".to_owned(), "C:\\Users\\tester".to_owned()),
            (
                "LOCALAPPDATA".to_owned(),
                "C:\\Users\\tester\\AppData\\Local".to_owned(),
            ),
        ]);
        // 变量后面还有内容：必须原样保留（这条就是漏掉的后缀）。
        assert_eq!(
            expand_env_with("%USERPROFILE%\\.local\\bin", &variables),
            "C:\\Users\\tester\\.local\\bin"
        );
        assert_eq!(
            expand_env_with("%LOCALAPPDATA%\\Microsoft\\WinGet\\Links", &variables),
            "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links"
        );
        // 裸变量（后面没有内容）照旧。
        assert_eq!(expand_env_with("%USERPROFILE%", &variables), "C:\\Users\\tester");
        // 未知变量原样保留，它后面的内容也不能丢。
        assert_eq!(expand_env_with("%NOPE%\\tail", &variables), "%NOPE%\\tail");
        // 没有配对的收尾 %：从该位起原样保留。
        assert_eq!(expand_env_with("pre%USERPROFILE", &variables), "pre%USERPROFILE");
    }
    /// 真机验证（替身存在才断言）：往 %USERPROFILE%\.local\bin 放一个 uv.cmd
    /// 替身、完全不改 PATH，探测也必须从这个已知目录里找到它。
    #[cfg(windows)]
    #[test]
    fn uv_stub_in_user_local_bin_is_discovered_without_path_changes() {
        let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) else {
            eprintln!("跳过：没有 USERPROFILE");
            return;
        };
        let stub = profile.join(".local").join("bin").join("uv.cmd");
        if !stub.is_file() {
            eprintln!("跳过：{} 不存在（本机没放 uv 替身）", stub.display());
            return;
        }
        // 只给「已知目录」一个来源：模拟 PATH/注册表里都没有 uv 的机器。
        let bin = profile.join(".local").join("bin");
        let env = probe_env_with(vec![(bin.clone(), SOURCE_KNOWN_DIR)]);
        let found = resolve_runtime_binary(spec("uv"), &env).expect("替身必须被探测到");
        assert_eq!(found.path, stub);
        assert_eq!(found.source, SOURCE_KNOWN_DIR);
        assert!(!found.version.is_empty());
        // 真实探测环境必须把该目录纳入候选。
        // 断言的是「它是候选」，**不是**「它必须打 known_dir 这个标签」：
        // 目录已经在本机 PATH 上时，capture() 的去重会把它记成 process_path ——
        // 那同样找得到，而且标签本来就该说明「为什么这里能找到」。
        // 旧写法把标签当成判据，于是「PATH 里正好有这个目录」的机器上必然失败，
        // 测的其实是环境长相而不是代码行为。
        let live = ProbeEnv::capture();
        assert!(
            live.directories
                .iter()
                .any(|(directory, _)| directory == &bin),
            "已知目录 {bin:?} 必须在探测路径里"
        );
        // 「不动 PATH 也能被找到」这一条由 known_bin_dirs 独立保证 —— 这才是本测试
        // 真正要守住的性质（已知目录清单必须覆盖 ~/.local/bin）。
        assert!(
            known_bin_dirs(&live).iter().any(|directory| directory == &bin),
            "known_bin_dirs 必须独立覆盖 {bin:?}"
        );
    }
}
