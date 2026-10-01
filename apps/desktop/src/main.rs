// release 构建用 windows 子系统：否则双击 exe 会先弹一个黑色控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Coomi Desktop — Tauri 壳
// 引擎（coomi.exe serve）作为子进程托管：随壳启动、崩溃检测、退出清理。
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
// 引擎传输桥：WebView 的请求会被系统代理/PNA/安全软件拦时，改由壳走裸 TCP 转发
// （HTTP 与 WebSocket 都在这里，见 engine_bridge.rs 顶部说明）。
mod engine_bridge;
// 壳侧环境诊断：WebView/IPC 全断时，只有壳还能查清原因并写给用户（见 diagnostics.rs）。
mod diagnostics;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize)]
struct EngineInfo {
    port: u16,
    token: String,
    /// 壳实际找到的引擎可执行文件路径：环境自检要显示它（
    /// 「引擎二进制没找到」和「引擎起来了但连不上」是两种完全不同的故障）。
    exe: Option<String>,
}

#[derive(Default)]
struct EngineState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
    token: Mutex<String>,
    /// 是否已成功拉起过引擎。守护线程靠它区分「首次启动中」与「崩溃后需重启」。
    started: AtomicBool,
    /// 用户主动停止 / 壳退出：置位后守护线程不再自动拉起（否则退出时会被自己重启）。
    stop_requested: AtomicBool,
    /// 连续重启失败次数（任一次重启就绪即清零）。
    failures: AtomicU32,
    /// 守护线程状态文案（空 = 无异常）。托盘 tooltip 直接展示，让用户知道引擎出了什么事。
    guard_note: Mutex<String>,
}

/// 引擎崩溃后的重启退避序列（秒）：1/2/5/10，之后固定 10 秒。
const ENGINE_BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];
/// 连续失败达到该次数后停止自动重启，只在托盘 tooltip 提示。
const ENGINE_MAX_RESTART_FAILURES: u32 = 3;
/// 重启后等待引擎就绪的上限。冷启动（杀软扫描 15MB 引擎）可能要几十秒，
/// 期间进程若已退出则立刻判定失败，不必等满。
const ENGINE_READY_TIMEOUT: Duration = Duration::from_secs(60);
/// 重启成功后广播给前端的事件名，payload 为新的 EngineInfo（port/token）。
const ENGINE_EVENT_RESTARTED: &str = "engine:restarted";

/// 壳级偏好（关闭行为 / 开机自启）。
/// 关闭窗口事件在主线程同步处理，必须能同步读到，所以缓存在内存里、落盘只做持久化。
struct PrefsState {
    close_to_tray: Mutex<bool>,
    autostart: Mutex<bool>,
}

impl Default for PrefsState {
    fn default() -> Self {
        Self {
            // 默认关（不常驻）：关窗就退出、引擎一起停。
            // 这是产品边界 —— 它是一个 Agent 工具，不是常驻托盘程序；
            // 需要「关窗后台继续跑」的用户可以在设置里显式打开。
            close_to_tray: Mutex::new(false),
            autostart: Mutex::new(false),
        }
    }
}

/// 托盘菜单项 / 事件名。菜单项 id 同时用作 match 的模式，只在这里定义一次。
const TRAY_ID: &str = "coomi-tray";
const TRAY_MENU_SHOW: &str = "tray-show";
const TRAY_MENU_NEW_CHAT: &str = "tray-new-chat";
const TRAY_MENU_QUIT: &str = "tray-quit";
/// 托盘「新建对话」广播的事件：前端 listen 后调用 session.newSession() 即可。
const TRAY_EVENT_NEW_CHAT: &str = "tray:new-chat";

/// 开机自启（HKCU 的 Run 键，免管理员、免新依赖）。
#[cfg(target_os = "windows")]
const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_NAME: &str = "Coomi";

/// 定位引擎二进制。
/// 打包态：resources 绝对路径会被保留为 `<resource>/_root_/DSH/…/coomi.exe`；
/// 开发态：回退 workspace target 产物。
fn engine_exe(app: &tauri::AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let candidates = vec![
        // 正式形态：scripts/prepare-bundle.mjs 在打包前把引擎拷进 crate 目录，
        // resources 里就是一个平铺的 coomi.exe（不再依赖本机绝对路径）。
        res.join("coomi.exe"),
        // 兼容更早的绝对路径 resources —— Tauri 会把它们保留成 _root_/盘符/路径 结构。
        res.join("_root_")
            .join("DSH")
            .join("coomi-full-project")
            .join("apps")
            .join("coomi-rs")
            .join("target")
            .join("release")
            .join("coomi.exe"),
        // 兜底：resource 目录的上层（安装根）下的同名文件。
        res.parent().map(|p| p.join("coomi.exe")).unwrap_or_default(),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn pick_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(18131)
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("coomi-{nanos:x}-{:x}", std::process::id())
}

/// 默认工作目录：用户可见的位置，而不是藏在 %APPDATA% 里的数据目录。
/// 引擎的 `--cwd` 就是「新建对话的默认工作目录」，用户第一眼要能看懂、能打开。
fn default_cwd(home: &std::path::Path) -> PathBuf {
    let base = std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home.to_path_buf());
    let dir = base.join("Coomi");
    if std::fs::create_dir_all(&dir).is_ok() {
        dir
    } else {
        home.to_path_buf()
    }
}

/// 桌面壳自己的界面偏好：theme 决定窗口首帧背景色（避免「浅色用户重启先闪一帧深色」），
/// closeToTray / autostart 是「通用」设置里的两个开关。
fn ui_prefs_path() -> PathBuf {
    dirs_home().join("desktop-ui.json")
}

fn read_ui_prefs() -> serde_json::Value {
    std::fs::read_to_string(ui_prefs_path())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

/// 合并写入：主题与托盘开关共用同一个文件，谁都不能把对方那一项抹掉。
fn write_ui_prefs(patch: serde_json::Value) -> Result<(), String> {
    let path = ui_prefs_path();
    let mut value = read_ui_prefs();
    if let (Some(dst), Some(src)) = (value.as_object_mut(), patch.as_object()) {
        for (key, item) in src {
            dst.insert(key.clone(), item.clone());
        }
    }
    std::fs::write(&path, value.to_string()).map_err(|e| format!("write {}: {e}", path.display()))
}

fn read_theme() -> Option<String> {
    read_ui_prefs().get("theme")?.as_str().map(str::to_string)
}

fn read_close_to_tray() -> bool {
    read_ui_prefs()
        .get("closeToTray")
        .and_then(serde_json::Value::as_bool)
        // 首次运行默认关：关窗即退出（不常驻）。与 PrefsState::default 保持一致。
        .unwrap_or(false)
}

/* ── 「另存为」的默认落点 ──
   原生保存对话框每次都要我们给一个「默认目录 + 默认文件名」，这里就是那两样的来源：
   · 默认目录 = 上一次另存成功的目录（持久化在 desktop-ui.json 的 lastSaveDir），
     首次或它已经被删掉时回落「下载」目录，再不行回落用户主目录；
   · 默认文件名 = 原文件名（见 save_file_as），不是新起的名字。 */
fn read_last_save_dir() -> Option<PathBuf> {
    // 先把整份偏好接住再取字段：get/as_str 借的是它，直接接在临时值上会被当场释放。
    let prefs = read_ui_prefs();
    let raw = prefs
        .get("lastSaveDir")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(PathBuf::from(raw))
}

/// 默认保存目录：上次的（且必须还在）→ 下载目录 → 用户主目录 → 当前目录。
fn default_save_dir() -> PathBuf {
    if let Some(dir) = read_last_save_dir().filter(|d| d.is_dir()) {
        return dir;
    }
    let home = std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| dirs_home().parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let downloads = home.join("Downloads");
    if downloads.is_dir() {
        return downloads;
    }
    home
}

/// 对话框里的默认文件名：由前端给的 suggestedName 兜一道（只取文件名段，
/// 不让它带上目录：SystemFileDialog 的 set_file_name 只认文件名），空则回落原文件名。
fn save_dialog_name(suggested: &str, source: &std::path::Path) -> String {
    let from_suggested = std::path::Path::new(suggested.trim())
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !from_suggested.is_empty() {
        return from_suggested;
    }
    source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "另存为.bin".to_string())
}

/// 两个路径是不是同一个文件（Windows 下大小写不敏感）。
fn same_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    let render = |p: &std::path::Path| {
        let text = p.to_string_lossy().replace('/', "\\");
        let text = text.trim_end_matches('\\').to_string();
        if cfg!(windows) { text.to_lowercase() } else { text }
    };
    render(left) == render(right)
}

#[tauri::command]
fn save_theme(theme: String) -> Result<(), String> {
    write_ui_prefs(serde_json::json!({ "theme": theme }))
}

/// 用系统默认浏览器打开外部链接（只放行 http/https）。
#[tauri::command]
fn open_external(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }
}

/// 数据目录：`%APPDATA%\Coomi`。
///
/// 品牌从 CoomiPlus 改成 Coomi 之后，老安装的数据（provider 密钥、会话、记忆、
/// 插件）还留在 `%APPDATA%\CoomiPlus`。这里做一次性改名把它接过来：同盘 rename 是
/// 原子的，不复制字节，也不受数据量影响；失败（老目录被占用、跨盘、没权限）就原样
/// 放弃——老目录一个字节都不会动，用户也可以手工改名。
fn adopt_legacy_home(appdata: &std::path::Path, dir: &std::path::Path) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let legacy = appdata.join("CoomiPlus");
        // 只在「新目录还没有、老目录在」时动手：已经有 Coomi 数据时绝不覆盖。
        if !dir.exists() && legacy.is_dir() {
            let _ = std::fs::rename(&legacy, dir);
        }
    });
}

fn dirs_home() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    let appdata = PathBuf::from(appdata);
    let dir = appdata.join("Coomi");
    adopt_legacy_home(&appdata, &dir);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 定位前端静态目录（serve --static-dir）。
/// 打包态：resources 保留原始结构（dist 在 _root_/…/desktop-ui/dist）。
/// 桌面窗口加载 Tauri 内嵌资源，此目录只是引擎 HTTP 服务的兜底页面。
fn static_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let candidates = [
        // 正式形态：prepare-bundle.mjs 把前端产物拷成 ui-dist 一起打进 resources。
        res.join("ui-dist"),
        // 兼容更早的绝对路径 resources 与旧的资源布局。
        res.join("_root_").join("DSH").join("coomi-full-project").join("apps").join("desktop-ui-react").join("dist"),
        res.join("dist"),
        res.join("ui"),
    ];
    candidates.into_iter().find(|p| p.is_dir())
}

/// spawn 互斥锁：启动路径（setup）、重启命令（engine_restart）、守护恢复（recover）都可能并发拉起，
/// 必须串行——否则同一时刻两个引擎抢锁/端口，其中一个刚启动就被挤掉（用户看到的「刚启动就崩溃」）。
static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

static SPAWN_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 最近一次 spawn 完成的时刻（ms）：守护线程用它判断「子进程退出是不是刚被手动重启/正常启动触发」。
static LAST_SPAWN_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// 我们**主动**终止引擎（退出 / 手动重启 / 清理半截进程）时置 true，
/// 由启动路径负责随后的拉起；守护线程看到它就不再补刀、也不重复恢复。
/// 引擎自己死掉（锁冲突、崩溃）时它是 false —— 守护必须照常恢复。
static ENGINE_TERMINATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn spawn_engine(app: &tauri::AppHandle, state: &EngineState) -> Result<(), String> {
    let _guard = SPAWN_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // 已有一场 spawn 正在进行（启动/重启/守护恢复并发到达）：后到者直接跳过，
    // 绝不「先杀刚拉起来的新进程再重拉」——那是「刚启动就崩溃」的直接成因。
    if SPAWN_IN_PROGRESS.swap(true, std::sync::atomic::Ordering::SeqCst) {
        eprintln!("[coomi-desktop] spawn already in progress; skipping duplicate spawn");
        return Ok(());
    }
    let result = spawn_engine_inner(app, state);
    SPAWN_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

fn spawn_engine_inner(app: &tauri::AppHandle, state: &EngineState) -> Result<(), String> {
    // 拉起之前先清场：**绝不能出现两个引擎同时抢同一个 home 的锁**。
    // 之前没有这一步，守护/前端重启与手动重启叠加时会叠出多个 coomi.exe，
    // 它们互相抢 engine.lock、互相把对方挤掉，前端就一直显示「引擎已断开」。
    terminate_engine(app, "restart: spawn_engine clears the previous process first");
    let exe = engine_exe(app).ok_or("engine binary (coomi.exe) not found")?;
    let ui = static_dir(app).ok_or("static frontend dir (ui/) not found")?;
    let home = dirs_home();
    let workdir = default_cwd(&home);
    let port = pick_port();
    let token = random_token();

    // 引擎输出落盘：出问题时能直接看日志，而不是靠猜（之前「发消息没反应」就是这么被坑的）。
    let log_path = home.join("engine.log");
    let mut command = std::process::Command::new(&exe);
    {
        use std::fs::OpenOptions;
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&log_path) {
            if let Ok(clone) = file.try_clone() {
                command.stdout(std::process::Stdio::from(file));
                command.stderr(std::process::Stdio::from(clone));
            }
        }
    }
    let child = command
        .arg("serve")
        .arg("--port").arg(port.to_string())
        .arg("--token").arg(&token)
        .arg("--home").arg(&home)
        .arg("--cwd").arg(&workdir)
        .arg("--static-dir").arg(&ui)
        .creation_flags(0x08000000)
        .spawn()
        .map(|spawned| {
            // 记录本次 spawn 完成时刻：守护线程据此判断「子进程退出是否刚由本路径触发」。
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            LAST_SPAWN_MS.store(now, std::sync::atomic::Ordering::Relaxed);
            ENGINE_TERMINATING.store(false, std::sync::atomic::Ordering::SeqCst);
            spawned
        })
        .map_err(|e| format!("spawn engine failed: {e}"))?;

    // 不在壳里阻塞等待就绪：冷启动（首次从 Program Files 启动，杀软要扫 15MB 引擎）
    // 可能要几十秒，阻塞 setup 会让窗口迟迟不出现，阻塞 restart 会让按钮像是卡死。
    // 这里立刻落盘 {port, token}，由前端轮询 /api/runtime/health 判断“启动中/运行中”。
    *state.child.lock().unwrap() = Some(child);
    *state.port.lock().unwrap() = port;
    *state.token.lock().unwrap() = token;
    // 进程已拉起即视为「已启动」：守护线程据此判断崩溃后要不要重启。
    // 端口就绪由前端轮询 /api/runtime/health 与守护线程的就绪探测各自判定。
    state.started.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn engine_info(app: tauri::AppHandle, state: State<'_, EngineState>) -> EngineInfo {
    EngineInfo {
        port: *state.port.lock().unwrap(),
        token: state.token.lock().unwrap().clone(),
        exe: engine_exe(&app).map(|path| path.to_string_lossy().into_owned()),
    }
}

/// 结束引擎子进程（不置位任何标志）。壳退出、托盘「退出」、手动停止/重启、
/// 以及守护线程重启前的清理共用这一段。
///
/// `reason` 会写进 engine.log：以前引擎被谁杀掉、因为哪条判据，日志里一个字都没有，
/// 只看到一串莫名的重启 —— 「输出到一半就断」这类问题只能靠反推。现在每次结束都有据可查。
fn terminate_engine(app: &tauri::AppHandle, reason: &str) {
    ENGINE_TERMINATING.store(true, std::sync::atomic::Ordering::SeqCst);
    let state: State<EngineState> = app.state();
    state.started.store(false, Ordering::SeqCst);
    let had_child = state.child.lock().unwrap_or_else(|p| p.into_inner()).is_some();
    if had_child {
        log_engine_note(&format!("terminating engine: {reason}"));
    }
    if let Some(mut child) = state.child.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = child.kill();
        // 等它真的退出：不等的话下一次 spawn 会和还没死的旧进程抢 engine.lock，
        // 新进程启动失败 → 前端一直「引擎已断开」。
        let _ = child.wait();
    }
    // 注意：**不再在这里做孤儿清理**。清理会按 home 路径杀掉所有 coomi.exe，
    // 一旦与守护线程/前端的重启并发，就可能把刚拉起的新引擎一起杀掉（表现为无限重启）。
    // 清理只在壳启动时做一次，见 reap_orphan_engines 的调用点。
}

/// 交给 WebView2 的浏览器参数。两件事，都是为了让「界面 → 本地引擎」这条链路在各种机器上都能通：
///
/// 1. `--disable-features=...,LocalNetworkAccessChecks,PrivateNetworkAccessChecks`
///    新版 Chromium 会对「http://tauri.localhost（public）→ 127.0.0.1（local）」这类跨地址空间
///    请求做**本地网络访问**检查（预检要显式允许，激进版本还要用户授权）。嵌入式 WebView 里
///    既没有授权弹窗、用户也无从设置，结果就是引擎活得好好的、界面一直「与引擎的连接已断开」，
///    而且**只在 WebView2 较新的机器上出现**（同一版本、这台好那台坏）。桌面应用连自己的本地
///    服务属于正当场景，这里直接关掉该项检查；引擎侧同时补了 Access-Control-Allow-Private-Network。
/// 2. `--no-proxy-server`：本地回环流量永远不该经过系统代理（公司 PAC / VPN 客户端 / 代理工具
///    全局接管时会连 127.0.0.1 一起劫持）。
///
/// 同时保留 `msWebOOUI,msPdfOOUI,msSmartScreenProtection`（wry 的默认项，覆盖参数时不能丢），
/// 并把用户自己设的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 合并进来 —— 否则一旦由代码指定参数，
/// 环境变量就会被忽略，调试用的 `--remote-debugging-port` 那条路会断。
fn webview_browser_args() -> &'static str {
    static ARGS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ARGS.get_or_init(build_webview_browser_args).as_str()
}

fn build_webview_browser_args() -> String {
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,LocalNetworkAccessChecks,PrivateNetworkAccessChecks --no-proxy-server",
    );
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        let extra = extra.trim();
        if !extra.is_empty() {
            args.push(' ');
            args.push_str(extra);
        }
    }
    args
}

/// 前端报到：收到过就说明 Tauri 的命令通道是通的（诊断报告里最关键的一条）。
#[tauri::command]
fn write_diagnostics(app: tauri::AppHandle, state: State<'_, EngineState>) -> Result<String, String> {
    match diagnostics::write_and_open(state.inner(), &app) {
        Some(path) => Ok(path.to_string_lossy().into_owned()),
        None => Err("写诊断文件失败".to_string()),
    }
}

/// 只返回诊断文本（不写文件、不弹记事本）。
#[tauri::command]
fn collect_diagnostics(app: tauri::AppHandle, state: State<'_, EngineState>) -> String {
    diagnostics::collect(state.inner(), &app)
}

/// 本地时间戳（不引 chrono：壳的依赖越少越好，这里只要一个可读前缀）。
/// 用 SystemTime 换算本地偏移；取不到偏移就退回 UTC，日志仍可用。
fn local_time_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let offset = local_utc_offset_secs();
    let local = secs + offset;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 从 1970-01-01 起算的民用日期换算（Howard Hinnant 的天数算法，够准且无依赖）。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

/// 本机 UTC 偏移（秒）。Windows 上读注册表拿不到时退回 0（UTC）——日志差 8 小时也好过没有。
fn local_utc_offset_secs() -> i64 {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("powershell");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Date).Subtract((Get-Date).ToUniversalTime()).TotalSeconds",
        ]);
        command.creation_flags(0x0800_0000);
        if let Ok(output) = command.output() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if let Ok(value) = text.trim().parse::<f64>() {
                    return value.round() as i64;
                }
            }
        }
    }
    0
}

/// 往 engine.log 追加一行壳侧记录（与引擎自己的输出同文件，排一下时间线就能看出谁先谁后）。
fn log_engine_note(note: &str) {
    use std::io::Write;
    let home = dirs_home();
    let path = home.join("engine.log");
    let stamp = local_time_stamp();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{stamp}] [coomi-desktop] {note}");
    }
    eprintln!("[coomi-desktop] {note}");
}

/// 清掉不属于当前壳的孤儿引擎进程（上一次壳异常退出留下的）。
/// 判据是命令行里的 `--home <同一个 home>`：同一份数据只允许一个引擎在跑。
fn reap_orphan_engines() {
    let home = dirs_home();
    let needle = format!("--home {}", home.display());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // tasklist 拿不到命令行，用 wmic 的替代品（PowerShell CIM）按命令行过滤。
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"name='coomi.exe'\" | Where-Object {{ $_.CommandLine -like '*{}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
            needle.replace('\\', "\\\\")
        );
        let mut command = std::process::Command::new("powershell");
        command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        command.creation_flags(0x0800_0000);
        let _ = command.output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = needle;
    }
}

/// 用户主动结束引擎：先置位 stop_requested，守护线程才不会把我们刚杀掉的进程又拉起来。
fn kill_engine(app: &tauri::AppHandle) {
    let state: State<EngineState> = app.state();
    state.stop_requested.store(true, Ordering::SeqCst);
    state.failures.store(0, Ordering::SeqCst);
    set_guard_note(app, String::new());
    terminate_engine(app, "user stopped the engine");
}

/// 等新引擎起来的超时（冷启动可能要几十秒；这只发生在后台线程里，不挡 UI）。
const MCP_RELOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// 「重启引擎」回执：命令只做「杀掉旧进程 + 拉起新进程」两件快事（必然 5 秒内返回），
/// 等就绪与 MCP 重载都甩给后台线程，绝不阻塞 UI。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineRestartReport {
    ok: bool,
    /// 新引擎的端口 / 令牌（前端也可以用 engine_info 再读一次）。
    port: u16,
    token: String,
    /// 本次命令自身耗时（毫秒）。
    elapsed_ms: u64,
    /// 后台随后要做的三件事：等就绪 → MCP 重载 → 广播 engine:restarted。
    pending: Vec<&'static str>,
    note: &'static str,
}

/// 「重启引擎」＝ engine_restart 与 MCP reload 串成一个动作：
/// 1) 结束旧引擎进程（settings / providers / MCP 配置全部重新读）；
/// 2) 立刻拉起新引擎并落盘新的端口与令牌；
/// 3) 后台等它就绪，再 POST /api/mcp/reload 让 MCP 服务器按新配置重新握手；
/// 4) 广播 engine:restarted，前端据此重建连接。
/// 命令本身不等就绪：等它按钮就像卡死（冷启动杀软扫 15MB 引擎要几十秒）。
fn restart_engine_now(
    app: &tauri::AppHandle,
    state: &EngineState,
) -> Result<EngineRestartReport, String> {
    let started = Instant::now();
    // 手动重启等价于重新开始托管：清掉「用户主动停止」与失败计数。
    state.stop_requested.store(false, Ordering::SeqCst);
    state.failures.store(0, Ordering::SeqCst);
    set_guard_note(app, String::new());
    terminate_engine(app, "manual engine restart (UI button)");
    spawn_engine(app, state)?;
    refresh_tray_tooltip(app);
    let port = *state.port.lock().unwrap_or_else(|p| p.into_inner());
    let token = state
        .token
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let handle = app.clone();
    let background_token = token.clone();
    std::thread::spawn(move || finalize_engine_restart(handle, port, background_token));
    Ok(EngineRestartReport {
        ok: true,
        port,
        token,
        elapsed_ms: started.elapsed().as_millis() as u64,
        pending: vec!["wait_ready", "mcp_reload", "emit:engine:restarted"],
        note: "旧引擎已结束、新引擎已拉起；MCP 重载在新引擎就绪后自动完成，完成后广播 engine:restarted。",
    })
}

/// 后台收尾：等新引擎就绪 → POST /api/mcp/reload → 广播 engine:restarted。
fn finalize_engine_restart(app: tauri::AppHandle, port: u16, token: String) {
    if wait_engine_ready(&app, MCP_RELOAD_TIMEOUT) {
        match engine_http_post(port, &token, "/api/mcp/reload", "{}") {
            Some(response) => eprintln!(
                "[coomi-desktop] mcp reload after restart: {}",
                summarize_http(&response)
            ),
            None => eprintln!("[coomi-desktop] mcp reload after restart unreachable; skipped"),
        }
    } else {
        eprintln!("[coomi-desktop] engine not ready after restart; mcp reload skipped");
    }
    // 端口/令牌已变：广播新值，前端用它重建连接（engine_info 也返回同一份）。
    // 端口变了：重新注入一次（页面里那段脚本只有首次加载时跑）。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(boot_script(&app));
    }
    let _ = app.emit(
        ENGINE_EVENT_RESTARTED,
        EngineInfo {
            port,
            token,
            exe: engine_exe(&app).map(|path| path.to_string_lossy().into_owned()),
        },
    );
    refresh_tray_tooltip(&app);
}

/// 「重启引擎」：重启引擎进程 + 重载 MCP，语义清晰，5 秒内返回不阻塞 UI。
#[tauri::command]
fn restart_engine(
    app: tauri::AppHandle,
    state: State<'_, EngineState>,
) -> Result<EngineRestartReport, String> {
    restart_engine_now(&app, &state)
}

/// 老名字保留（前端 stores/engine.ts 仍在调）：与 restart_engine 完全同一套语义。
/// `engine_restart` 的 60 秒节流：防止「提示断线→连点重启 / 自动路径循环」把正在干活的引擎反复杀掉。
static LAST_ENGINE_RESTART_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
fn engine_restart(
    app: tauri::AppHandle,
    state: State<'_, EngineState>,
    source: Option<String>,
) -> Result<EngineRestartReport, String> {
    // 同一来源 60 秒内只允许一次（手动按钮第一次仍立即执行，防呆但不拖沓）。
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let last = LAST_ENGINE_RESTART_MS.load(std::sync::atomic::Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 60_000 {
        log_engine_note(&format!("engine_restart 节流：60s 内已重启过一次（来源={}），忽略本次调用", source.as_deref().unwrap_or("unknown")));
        return Err("引擎刚重启过（60 秒内），请稍后再试；引擎若真死了壳守护会自动拉起".to_string());
    }
    LAST_ENGINE_RESTART_MS.store(now, std::sync::atomic::Ordering::Relaxed);
    log_engine_note(&format!("engine_restart 由 {} 触发", source.as_deref().unwrap_or("unknown")));
    restart_engine_now(&app, &state)
}

/// 重启桌面壳（Tauri app.restart()）。
///
/// app.restart() 会退出进程、永不返回，所以命令不能直接调它：
/// 先把引擎收干净（否则新壳拉起的引擎会撞上旧进程的 home 单实例锁），立刻回执，
/// 再让后台线程延迟 400ms 触发重启——这段时间足够 IPC 回执送达前端。
#[tauri::command]
fn app_restart(
    app: tauri::AppHandle,
    state: State<'_, EngineState>,
) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    state.stop_requested.store(true, Ordering::SeqCst);
    terminate_engine(&app, "engine_stop requested by UI");
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        // 在非主线程触发：走 RunEvent::Exit 那条路重启，不会掐掉刚发出去的回执。
        handle.restart();
    });
    Ok(serde_json::json!({
        "ok": true,
        "scheduled": true,
        "delayMs": 400,
        "engineStopped": true,
        "elapsedMs": elapsed_ms,
        "note": "引擎已结束，壳将在约 0.4 秒后重启（进程退出后重新拉起）。",
    }))
}

/// 守护线程状态文案（崩溃原因 / 退避倒计时 / 放弃提示）——写内存并刷新托盘 tooltip。
fn set_guard_note(app: &tauri::AppHandle, note: String) {
    let state: State<EngineState> = app.state();
    *state.guard_note.lock().unwrap_or_else(|p| p.into_inner()) = note;
    refresh_tray_tooltip(app);
}

/// 可被「用户主动停止」打断的睡眠：返回 false 表示应放弃本次重启。
fn sleep_backoff(app: &tauri::AppHandle, seconds: u64) -> bool {
    let state: State<EngineState> = app.state();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if state.stop_requested.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !state.stop_requested.load(Ordering::SeqCst)
}

/// 等待引擎端口就绪。子进程提前退出（跑不起来 / 立刻崩）时立即返回 false，
/// 不必等满超时——否则退避重试会被拖成分钟级。
fn wait_engine_ready(app: &tauri::AppHandle, timeout: Duration) -> bool {
    let state: State<EngineState> = app.state();
    let deadline = Instant::now() + timeout;
    loop {
        if state.stop_requested.load(Ordering::SeqCst) {
            return false;
        }
        let alive = state
            .child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false);
        if !alive {
            return false;
        }
        let port = *state.port.lock().unwrap_or_else(|p| p.into_inner());
        let token = state
            .token
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if engine_http_ok(port, &token) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// 引擎崩溃后的恢复流程：按 1/2/5/10 秒退避重启，成功后 emit engine:restarted；
/// 连续 3 次失败则放弃，只在托盘 tooltip 提示（不再无限重启，避免刷屏刷日志）。
fn recover_engine(app: &tauri::AppHandle, exit_note: &str) {
    let state: State<EngineState> = app.state();
    let mut failures = state.failures.load(Ordering::SeqCst);
    while failures < ENGINE_MAX_RESTART_FAILURES {
        let delay = ENGINE_BACKOFF_SECS[(failures as usize).min(ENGINE_BACKOFF_SECS.len() - 1)];
        set_guard_note(
            app,
            format!(
                "引擎已退出（{exit_note}）· {delay} 秒后自动重启（第 {} 次）",
                failures + 1
            ),
        );
        if !sleep_backoff(app, delay) {
            return;
        }
        match spawn_engine(app, &state) {
            Ok(()) => {}
            Err(error) => {
                eprintln!("[coomi-desktop] engine restart failed: {error}");
                failures = failures.saturating_add(1);
                state.failures.store(failures, Ordering::SeqCst);
                continue;
            }
        }
        if wait_engine_ready(app, ENGINE_READY_TIMEOUT) {
            state.failures.store(0, Ordering::SeqCst);
            set_guard_note(app, String::new());
            let info = EngineInfo {
        exe: engine_exe(app).map(|path| path.to_string_lossy().into_owned()),
                port: *state.port.lock().unwrap_or_else(|p| p.into_inner()),
                token: state
                    .token
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone(),
            };
            eprintln!(
                "[coomi-desktop] engine restarted on port {} after {exit_note}",
                info.port
            );
            // 端口/令牌已变：广播新值，前端用它重建连接（engine_info 也返回同一份）。
            let _ = app.emit(ENGINE_EVENT_RESTARTED, info);
            refresh_tray_tooltip(app);
            return;
        }
        // 拉起来了但没就绪：清掉半截进程，按失败计数继续退避重试。
        eprintln!("[coomi-desktop] engine did not become ready; retrying with backoff");
        terminate_engine(app, "engine did not become ready in time");
        failures = failures.saturating_add(1);
        state.failures.store(failures, Ordering::SeqCst);
    }
    let note = format!(
        "引擎连续 {ENGINE_MAX_RESTART_FAILURES} 次启动失败，已停止自动重启（可在设置里手动重启）"
    );
    eprintln!("[coomi-desktop] {note}");
    set_guard_note(app, note);
}

/// 引擎守护线程：只认「子进程真的退出」这一种崩溃证据（try_wait 拿到退出码），
/// 然后交给 recover_engine 做退避重启。用户主动停止时整段跳过。
/// 引擎连续多少次健康探测失败就算「卡死」。
/// 卡死（进程活着、CPU 为 0、端口还在 Listen、但 HTTP 不响应）和崩溃一样致命：
/// 界面上任务停住、请求全部排队，用户只看到「引擎已断开」。
/// 引擎连续多少次「健康探测失败 **且** 没有任务在跑」才算卡死。
/// 以前是 6 次（≈30 秒就杀），对长输出的引擎太狠：正在流式生成时事件循环被同步工作
/// 占住（大工具结果压缩、JSON 序列化、落盘），探测会超时，但那是「忙」不是「死」——
/// 误杀的直接后果就是用户看到的「对话输出到一半引擎崩溃」。
const ENGINE_STALL_PROBES: u32 = 12;
/// 健康探测间隔（秒）。12 次 ≈ 60 秒，且必须「没有任务在跑」才会走到这一步。
const ENGINE_PROBE_EVERY: Duration = Duration::from_secs(5);

/// 引擎守护线程：两条证据都认 —— ①子进程真的退出（try_wait 拿到退出码）；
/// ②进程活着但连续多次健康探测失败（卡死）。两者都交给 recover_engine 做退避重启。
/// 用户主动停止时整段跳过。
fn start_engine_supervisor(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut stall_probes: u32 = 0;
        loop {
            std::thread::sleep(ENGINE_PROBE_EVERY);
            let (exited, port, token) = {
                let state: State<EngineState> = handle.state();
                if state.stop_requested.load(Ordering::SeqCst) || !state.started.load(Ordering::SeqCst) {
                    (None, 0u16, String::new())
                } else {
                    let port = *state.port.lock().unwrap_or_else(|p| p.into_inner());
                    let token = state.token.lock().unwrap_or_else(|p| p.into_inner()).clone();
                    let mut guard = state.child.lock().unwrap_or_else(|p| p.into_inner());
                    let exited = match guard.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => {
                                *guard = None;
                                Some(status.to_string())
                            }
                            _ => None,
                        },
                        None => None,
                    };
                    (exited, port, token)
                }
            };

            if let Some(exit_note) = exited {
                {
                    let state: State<EngineState> = handle.state();
                    state.started.store(false, Ordering::SeqCst);
                }
                stall_probes = 0;
                // 关键：子进程退出若发生在**10 秒内刚 spawn 过**（手动重启/正常启动路径刚拉起），
                // 说明这轮死亡由启动路径自己负责（它马上会拉起新的），守护**跳过恢复**——
                // 否则守护的 recover 会「先杀刚拉起来的新引擎再重拉」，形成「重启完立刻又死」循环。
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                let last_spawn = LAST_SPAWN_MS.load(std::sync::atomic::Ordering::Relaxed);
                // 只有「我们自己主动杀的」（退出/手动重启/清理半截进程）才跳过恢复 —— 那种情况
                // 启动路径马上会拉起新的。引擎**自己**死掉（锁冲突/崩溃）时照常恢复，
                // 否则它会一直躺着，前端永远「与引擎的连接已断开」。
                if ENGINE_TERMINATING.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    eprintln!("[coomi-desktop] engine exited right after our own terminate; startup path owns recovery, skipping");
                    continue;
                }
                let _ = now;
                eprintln!("[coomi-desktop] engine process exited ({exit_note}); supervising restart");
                recover_engine(&handle, &exit_note);
                continue;
            }

            // 进程还在：再看它到底还答不答话。启动中的引擎本来就答不上来，
            // 所以只在「已经就绪过」之后才开始累计失败次数。
            if port == 0 || !engine_ready_once(&handle) {
                continue;
            }
            if engine_http_ok(port, &token) {
                stall_probes = 0;
                continue;
            }
            // **正在干活的引擎绝不判卡死**：先问一句它是不是还有任务在跑。
            // 这是本次修复的关键一条 —— 之前只看健康探测，长输出时会被误杀。
            if engine_has_running_task(port, &token) {
                stall_probes = 0;
                continue;
            }
            stall_probes += 1;
            log_engine_note(&format!("health probe failed ({stall_probes}/{ENGINE_STALL_PROBES}), no task running"));
            if stall_probes >= ENGINE_STALL_PROBES {
                stall_probes = 0;
                // 卡死的进程 try_wait 拿不到退出码，必须先杀掉再重启，否则新进程抢不到锁。
                eprintln!("[coomi-desktop] engine unresponsive; killing and restarting");
                terminate_engine(&handle, "engine unresponsive (stalled, no task running)");
                {
                    let state: State<EngineState> = handle.state();
                    state.started.store(false, Ordering::SeqCst);
                }
                recover_engine(&handle, "engine unresponsive (stalled)");
            }
        }
    });
}

#[tauri::command]
fn engine_log_path() -> Option<String> {
    // 优先给运行日志（含启动失败原因），没有就退回崩溃日志。
    let home = dirs_home();
    let runtime = home.join("engine.log");
    if runtime.is_file() {
        return Some(runtime.to_string_lossy().into_owned());
    }
    let crash = home.join("crash_rust.log");
    crash.is_file().then(|| crash.to_string_lossy().into_owned())
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    // 与「检查更新」同源：update_check 比较的是 package_info().version。
    // 以前这里读 CARGO_PKG_VERSION、版本号在两处各自为政，会出现「设置页显示的版本」
    // 与「更新比较用的版本」不一致（导致永远没有新版本 / 反复提示同一个版本）。
    app.package_info().version.to_string()
}

#[tauri::command]
fn data_home() -> String {
    dirs_home().to_string_lossy().into_owned()
}

/* ── 更新检查（壳命令 update_check）──
   主源：GitHub 更新仓库（https://github.com/TensorHub-ORG/Coomi）coomi-desktop 分支的
   windows/latest.json：{ code, name, url, size, sha256, channel }。仓库公开、raw 链接匿名可读；
   下载地址用 refs/heads 全引用形态（raw 对短分支名有 CDN 缓存 404 的坑）。
   兜底：老发布服务形态（{base}/api/v1/info）的解析分支仍在，但 Coomi 已不自建该服务；
   留给自建/自管更新源按同形态接管（见下方两分支）。
   服务端少给东西不算错误，一律在壳里降级：
     · 缺 changelog / release_notes → notes 用固定文案「服务端未提供更新说明」；
     · 缺 sha256 与下载地址 → 按 {base}/api/v1/download/{code}/windows 拼一条；
     · 缺字节数但有 file_size_mb → 按 MB 换算成字节；
     · 版本号解析不出数字段 → 退回「字符串不同就算有更新」。
   网络不通返回可读中文原因（前端原样提示），不做静默兜底 ——「点了没反应」比报错更难查。 */

const RELEASE_BASE: &str = "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop";
const RELEASE_INFO_URL: &str = "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/latest.json";
/// GitHub raw 的加速前缀（国内网络直连 raw 常超时/被拒）：先走加速，失败再回直连。
const RELEASE_INFO_URL_PROXY: &str = "https://gh-proxy.com/https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/latest.json";
/// 第二个加速源（jsDelivr）：它按 commit 抓、缓存短，gh-proxy 这类层缓存住旧清单时靠它翻案。
const RELEASE_INFO_URL_JSDELIVR: &str = "https://cdn.jsdelivr.net/gh/TensorHub-ORG/Coomi@coomi-desktop/windows/latest.json";
/// 下载链接里的平台段（服务端 platforms 的键名）。
const RELEASE_PLATFORM: &str = "windows";
/// 服务端没写更新说明时给用户看的固定文案。
const RELEASE_NOTES_MISSING: &str = "服务端未提供更新说明";
/// 单次请求的超时（秒）：检查更新是点一下就要有结果的交互，长超时不如早报错。
const RELEASE_TIMEOUT_SECS: u64 = 12;
/// 字节换算用的 MB（服务端给的是 file_size_mb）。
const BYTES_PER_MB: f64 = 1024.0 * 1024.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckReport {
    /// 当前安装的版本：取打包配置里的版本（与应用展示的一致），不是 Cargo.toml 的 crate 版本。
    current: String,
    /// 服务端的最新版本名（缺字段时退回 platforms.windows.version_name，再退回版本号）。
    latest: String,
    has_update: bool,
    /// 应用名（服务端 app_name），给提示语用。
    name: String,
    /// 更新说明；服务端没给就是 RELEASE_NOTES_MISSING。
    notes: String,
    /// 下载直链；服务端没给就按版本号拼。空串＝连版本号都没有，前端据此禁用下载按钮。
    download_url: String,
    /// 安装包字节数；算不出来就是 None。
    size: Option<u64>,
    /// 发布时间（服务端给什么就原样带什么，不做解析）。
    published_at: Option<String>,
    /// 安装包 sha256（清单给了就带上：下载后校验用；没有就只能跳过校验并如实告知）。
    sha256: Option<String>,
    /// 清单里可选的镜像地址列表（优先按顺序试，再退回 download_url 与它的镜像改写）。
    urls: Vec<String>,
}

/// 更新包相关的三个动作（下载 / 校验 / 安装）本轮的占位返回：
/// 签名先定下来（前端与后续实现都按它对接），逻辑留给后面的版本。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateActionReport {
    /// ok / not_implemented / error 这类状态词。
    status: String,
    /// 给用户看的一句说明。
    message: String,
    /// 下载 / 校验产物的本地路径（下载与校验返回，安装不需要）。
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// 实际用的下载地址（镜像改写后）：出问题时能一眼看出走的是哪条链路。
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

/// 占位返回：三个命令共用一份文案，别各写一遍。
fn not_implemented(action: &str) -> UpdateActionReport {
    UpdateActionReport {
        status: "not_implemented".to_string(),
        message: format!("{action}尚未实现：当前版本只提供「检查更新」，安装流程会在后续版本接入。"),
        path: None,
        url: None,
    }
}

/// 大小写不敏感地从 JSON 对象里取第一个存在的键（null 一律当作没有）：
/// 服务端把 latest_version 写成 latestVersion 也照样读得到。
fn json_field<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a serde_json::Value> {
    let map = value.as_object()?;
    for key in keys {
        if let Some(found) = map.get(*key) {
            if !found.is_null() {
                return Some(found);
            }
        }
    }
    for (name, found) in map {
        if found.is_null() {
            continue;
        }
        for key in keys {
            if name.eq_ignore_ascii_case(*key) {
                return Some(found);
            }
        }
    }
    None
}

/// 取字符串字段（数字也接受，原样转成字符串；空白与 null 都算没有）。
fn json_str(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    match json_field(value, keys)? {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// 取无符号整数字段（数字、数字字符串、非负浮点都认）。
fn json_u64(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    let field = json_field(value, keys)?;
    if let Some(number) = field.as_u64() {
        return Some(number);
    }
    if let Some(number) = field.as_f64() {
        if number.is_finite() && number >= 0.0 {
            return Some(number as u64);
        }
    }
    field.as_str().and_then(|text| text.trim().parse::<u64>().ok())
}

/// 取浮点字段（数字或数字字符串）。
fn json_f64(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    let field = json_field(value, keys)?;
    if let Some(number) = field.as_f64() {
        return Some(number);
    }
    field.as_str().and_then(|text| text.trim().parse::<f64>().ok())
}

/// 版本号里的数字段：Beta0.8.6 / v1.2.3 / 0.8.6 → [0, 8, 6]。
/// 一个数字都没有（例如 Beta）返回 None，交给调用方退回字符串比较。
fn version_numbers(text: &str) -> Option<Vec<u64>> {
    let mut numbers: Vec<u64> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            numbers.push(current.parse::<u64>().unwrap_or(0));
            current.clear();
        }
    }
    if !current.is_empty() {
        numbers.push(current.parse::<u64>().unwrap_or(0));
    }
    (!numbers.is_empty()).then_some(numbers)
}

/// latest 是否比 current 新（按数字段逐段比，长度不同时短的补 0）。
/// 任一侧解析不出数字段返回 None —— 调用方据此退回字符串比较。
fn version_greater(latest: &str, current: &str) -> Option<bool> {
    let left = version_numbers(latest)?;
    let right = version_numbers(current)?;
    for index in 0..left.len().max(right.len()) {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        if a != b {
            return Some(a > b);
        }
    }
    Some(false)
}

/// 跑一个外部命令并把它当文本收回来（以 stdout 为准；失败时把 stderr 拼进可读原因）。
/// 这里不引入任何 HTTP 客户端依赖：curl 是 Windows 10 1803+ 与 macOS / 主流 Linux 都自带的，
/// Cargo.toml 因此一个 crate 都不用加（也不牵扯 TLS 后端与编译时间）。
fn run_capture(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    // Windows：CREATE_NO_WINDOW —— release 是 windows 子系统，不让子进程闪一下黑框。
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法启动 {program}：{error}"))?;
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "被中断".to_string());
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("{program} 退出码 {code}")
        } else {
            format!("{program} 退出码 {code}：{detail}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "windows")]
const CURL_BIN: &str = "curl.exe";
#[cfg(not(target_os = "windows"))]
const CURL_BIN: &str = "curl";

/// 代前端抓取远端文本（技能 / 插件市场来源用）。
///
/// 为什么不让渲染进程自己 fetch：
/// 1) **CSP** —— 放行任意 https 就等于把 connect-src 打开，CSP 形同虚设；
/// 2) **WebView 的网络不可靠** —— 系统代理 / PAC / 安全软件都会干扰（我们为 localhost
///    建传输桥就是同一个原因），壳走 curl 不受这些策略影响；
/// 3) **CORS** —— 部分市场来源不带跨域头，渲染进程直接 fetch 会被浏览器拒掉。
///
/// 只允许 http/https。**4xx/5xx 不算失败**：连同状态码与正文一起交回调用方，
/// 由它决定怎么提示（例如 PulseMCP 的 410 有专门文案）。网络层失败才返回 Err。
#[tauri::command]
async fn fetch_remote_text(url: String, timeout_ms: Option<u64>) -> Result<RemoteText, String> {
    let url = url.trim().to_owned();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只允许 http/https 地址".to_string());
    }
    let timeout_ms = timeout_ms.unwrap_or(20_000).clamp(2_000, 120_000);
    tauri::async_runtime::spawn_blocking(move || fetch_remote_text_sync(&url, timeout_ms))
        .await
        .map_err(|error| format!("取数任务失败：{error}"))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteText {
    status: u16,
    body: String,
}

fn fetch_remote_text_sync(url: &str, timeout_ms: u64) -> Result<RemoteText, String> {
    /// 状态码标记：curl 的 -w 会把 http_code 追加在正文末尾，用它切分。
    const MARKER: &str = "\n__coomi_http_status__:";
    let seconds = (timeout_ms / 1_000).max(2).to_string();
    let format = format!("{MARKER}%{{http_code}}");
    // -s 静默、-L 跟随跳转；**不用 -f**：4xx/5xx 要连同正文一起交回调用方。
    // 市场来源都是 JSON 接口，统一带上 Accept（有些源不给头会返回 HTML）。
    #[cfg(target_os = "windows")]
    let flags = [
        "-sSL", "--ssl-no-revoke", "-H", "Accept: application/json",
        "--connect-timeout", "6", "--max-time", seconds.as_str(), "-w", format.as_str(), url,
    ];
    #[cfg(not(target_os = "windows"))]
    let flags = [
        "-sSL", "-H", "Accept: application/json",
        "--connect-timeout", "6", "--max-time", seconds.as_str(), "-w", format.as_str(), url,
    ];
    let raw = run_capture(CURL_BIN, &flags)?;
    let (body, status) = match raw.rsplit_once(MARKER) {
        Some((body, code)) => (body.to_owned(), code.trim().parse::<u16>().unwrap_or(0)),
        None => (raw, 0),
    };
    Ok(RemoteText { status, body })
}

/// GET 一段文本。参数 -f 让 4xx/5xx 直接算失败（否则错误页会被当成 JSON 去解析），
/// -sS 静默但保留错误信息，-L 跟随跳转。
fn http_get_text(url: &str) -> Result<String, String> {
    let timeout = RELEASE_TIMEOUT_SECS.to_string();
    // Windows 的 schannel 默认要联网校验证书吊销状态，此机器/网络访问不了吊销服务器会
    // 直接抛 CRYPT_E_NO_REVOCATION_CHECK（用户看到的「检查更新失败 curl 35」）→ 必须 --ssl-no-revoke。
    #[cfg(target_os = "windows")]
    let flags = [
        "-fsSL", "--ssl-no-revoke",
        "--connect-timeout", "6",
        "--max-time", timeout.as_str(),
        url,
    ];
    #[cfg(not(target_os = "windows"))]
    let flags = [
        "-fsSL",
        "--connect-timeout", "6",
        "--max-time", timeout.as_str(),
        url,
    ];
    let text = run_capture(CURL_BIN, &flags)?;
    if text.trim().is_empty() {
        return Err("发布服务返回了空响应".to_string());
    }
    Ok(text)
}

/// curl 拿不到时的第二手：Windows 上用系统自带的 PowerShell（老镜像里 curl.exe 可能被裁掉）。
/// 先设 UTF-8 输出编码，中文说明才不会变成问号。
#[cfg(target_os = "windows")]
fn http_get_powershell(url: &str) -> Result<String, String> {
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Invoke-WebRequest -UseBasicParsing -TimeoutSec {RELEASE_TIMEOUT_SECS} -Uri '{url}').Content"
    );
    let text = run_capture(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", script.as_str()],
    )?;
    if text.trim().is_empty() {
        return Err("备用取数方式返回了空响应".to_string());
    }
    Ok(text)
}

/// 第二手取数（Windows 才有），失败时把第一手的错误一起带出来。
#[cfg(target_os = "windows")]
fn release_get_fallback(url: &str, primary: String) -> Result<String, String> {
    http_get_powershell(url)
        .map_err(|fallback| format!("无法连接发布服务：{primary}；备用方式也失败：{fallback}"))
}

/// 第二手取数（非 Windows 没有备用方式，原样带出第一手的错误）。
#[cfg(not(target_os = "windows"))]
fn release_get_fallback(_url: &str, primary: String) -> Result<String, String> {
    Err(format!("无法连接发布服务：{primary}"))
}

/// 拉一次发布服务的 JSON：先 curl，再备用方式，最后解析。
fn release_json(url: &str) -> Result<serde_json::Value, String> {
    let text = http_get_text(url).or_else(|primary| release_get_fallback(url, primary))?;
    serde_json::from_str(&text).map_err(|error| format!("发布服务返回的不是合法 JSON：{error}"))
}

/// 多源拉更新清单，**取 code 最大的那一份**（而不是「第一个成功的」）。
/// 为什么不能「第一个成功就用」：gh-proxy / jsDelivr 这类加速层会缓存旧清单，
/// 先返回的那一份可能还是上一个版本 —— 表现就是「更新明明发出去了，用户那边仍提示旧版本」。
/// 三个源都问一遍、比 code 取最大，从结构上免疫缓存回退（拿不到 code 的按旧服务形态兜底）。
/// 全失败才报错，把每个源的错误合并成一条可读原因。
fn release_json_best(urls: &[&str]) -> Result<serde_json::Value, String> {
    let mut errors = Vec::new();
    let mut best: Option<(u64, serde_json::Value)> = None;
    let mut codeless: Option<serde_json::Value> = None;
    for url in urls {
        match release_json(url) {
            Ok(json) => {
                // 新形态 code 在顶层；老发布服务形态在 latest_version_code / platforms.windows.version_code。
                let code = json_u64(&json, &["code", "latest_version_code"]).or_else(|| {
                    json_field(&json, &["platforms"])
                        .and_then(|platform| json_field(platform, &["windows"]))
                        .and_then(|windows| json_u64(windows, &["version_code", "code"]))
                });
                match code {
                    Some(code) => {
                        let better = best.as_ref().map(|(seen, _)| code > *seen).unwrap_or(true);
                        if better { best = Some((code, json)); }
                    }
                    // 没有 code 的响应只当兜底：任何带 code 的源都比它权威。
                    None => { if codeless.is_none() { codeless = Some(json); } }
                }
            }
            Err(error) => errors.push(format!("{url} → {error}")),
        }
    }
    if let Some((_, json)) = best { return Ok(json); }
    if let Some(json) = codeless { return Ok(json); }
    Err(format!("无法连接发布服务：{}", errors.join("；")))
}

/// 把发布服务的响应整理成前端要的那一份（缺字段一律降级，不报错）。
fn build_update_report(current: &str) -> Result<UpdateCheckReport, String> {
    let payload = release_json_best(&[
        RELEASE_INFO_URL_PROXY,
        RELEASE_INFO_URL_JSDELIVR,
        RELEASE_INFO_URL,
    ])?;

    // GitHub 更新仓库清单形态：{ code, name, url, size, sha256, channel }
    if json_u64(&payload, &["code"]).is_some() {
        let latest = json_str(&payload, &["name"]).unwrap_or_else(|| current.to_string());
        let code = json_u64(&payload, &["code"]);
        let download_url = json_str(&payload, &["url"]).unwrap_or_default();
        let size = json_u64(&payload, &["size"]);
        let notes = json_str(&payload, &["notes", "changelog", "release_notes"]).unwrap_or_else(|| RELEASE_NOTES_MISSING.to_string());
        let published_at = json_str(&payload, &["published_at", "publishedAt", "date"]);
        let has_update = match version_greater(&latest, current) {
            Some(value) => value,
            None => !latest.is_empty() && latest != current,
        };
        return Ok(UpdateCheckReport {
            current: current.to_string(),
            latest: latest.clone(),
            has_update,
            name: json_str(&payload, &["name", "app_name", "appName"]).unwrap_or_else(|| format!("Coomi {latest}")),
            notes,
            download_url,
            size,
            published_at,
            sha256: json_str(&payload, &["sha256", "hash"]),
            urls: json_str_list(&payload, "urls"),
        });
    }

    // 老发布服务形态（{base}/api/v1/info）——保留为兜底（Coomi 未自建该服务）。
    let platform = json_field(&payload, &["platforms"]).and_then(|value| json_field(value, &["windows"]));

    // 版本号：服务端的 latest_version 最准（Beta0.8.6 这种前缀会被版本比较忽略），
    // 其次是 platforms.windows.version_name，最后退回版本号。
    let latest = json_str(&payload, &["latest_version"])
        .or_else(|| platform.and_then(|value| json_str(value, &["version_name"])))
        .or_else(|| json_u64(&payload, &["latest_version_code"]).map(|code| code.to_string()))
        .unwrap_or_else(|| current.to_string());

    let code = json_u64(&payload, &["latest_version_code"])
        .or_else(|| platform.and_then(|value| json_u64(value, &["version_code"])));

    // 下载地址：服务端给了就用，没给就按 /api/v1/download/{code}/{platform} 拼。
    let download_url = platform
        .and_then(|value| json_str(value, &["download_url", "downloadUrl", "url"]))
        .or_else(|| code.map(|code| format!("{RELEASE_BASE}/api/v1/download/{code}/{RELEASE_PLATFORM}")))
        .unwrap_or_default();

    // 体积：优先字节，其次服务端的 file_size_mb。
    let size = platform
        .and_then(|value| json_u64(value, &["file_size", "size", "size_bytes", "bytes"]))
        .or_else(|| {
            platform
                .and_then(|value| json_f64(value, &["file_size_mb"]))
                .filter(|mb| mb.is_finite() && *mb > 0.0)
                .map(|mb| (mb * BYTES_PER_MB).round() as u64)
        });

    let notes = json_str(
        &payload,
        &["changelog", "release_notes", "releaseNotes", "update_notes", "notes"],
    )
    .or_else(|| platform.and_then(|value| json_str(value, &["changelog", "release_notes", "notes"])))
    .unwrap_or_else(|| RELEASE_NOTES_MISSING.to_string());

    let published_at = json_str(
        &payload,
        &["published_at", "publishedAt", "release_date", "releaseDate", "updated_at", "date"],
    )
    .or_else(|| platform.and_then(|value| json_str(value, &["published_at", "release_date", "date"])));

    let has_update = match version_greater(&latest, current) {
        Some(has_update) => has_update,
        // 版本号里一个数字都没有（服务端写了奇怪的名字）：退回「不一样就算有更新」。
        None => !latest.is_empty() && latest != current,
    };

    Ok(UpdateCheckReport {
        current: current.to_string(),
        latest,
        has_update,
        name: json_str(&payload, &["app_name", "appName", "name"]).unwrap_or_else(|| "Coomi".to_string()),
        notes,
        download_url,
        size,
        published_at,
        // 老发布服务不提供摘要与镜像列表：如实留空（前端因此跳过校验并提示一句）。
        sha256: platform.and_then(|value| json_str(value, &["sha256", "hash"])),
        urls: json_str_list(&payload, "urls"),
    })
}

/// 取 JSON 里的字符串数组（用于 latest.json 的 urls 镜像列表）：非数组 / 空串一律丢掉。
fn json_str_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 用户在设置里选中的 GitHub 镜像前缀（settings.json → mirrors.github）。
/// 与引擎 coomi_services::mirrors::github_prefix 同一套语义：官方条目或未启用即 None。
/// 壳自己读这份文件（而不是问引擎）—— 更新恰恰发生在引擎可能正忙 / 不可用的时候。
fn github_mirror_prefix(home: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join("settings.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let group = value.get("mirrors")?.get("github")?;
    let active = group.get("active").and_then(serde_json::Value::as_str)?;
    let items = group.get("items")?.as_array()?;
    let entry = items.iter().find(|item| {
        item.get("id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| id.eq_ignore_ascii_case(active))
    })?;
    if entry.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) {
        return None;
    }
    let id = entry.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
    if id.eq_ignore_ascii_case("official") {
        return None;
    }
    let url = entry.get("url").and_then(serde_json::Value::as_str)?.trim();
    if url.is_empty() {
        return None;
    }
    Some(if url.ends_with('/') { url.to_string() } else { format!("{url}/") })
}

/// 给下载地址套上镜像前缀（只对 github / raw.githubusercontent 生效，与引擎同规则）：
/// 国内直连 raw 常超时，更新包 40MB+，走镜像的差别是「能下完」和「下到一半断」。
fn apply_github_mirror(prefix: Option<&str>, url: &str) -> String {
    let Some(prefix) = prefix else { return url.to_string() };
    if url.starts_with("https://github.com/")
        || url.starts_with("https://raw.githubusercontent.com/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://codeload.github.com/")
    {
        return format!("{prefix}{url}");
    }
    url.to_string()
}

/// 候选下载地址（按顺序试）：清单给的 urls 优先 → 镜像改写后的直链 → 原直链。
/// 去重：清单里常常两条指同一个文件。
fn download_candidates(report: &UpdateCheckReport, home: &std::path::Path) -> Vec<String> {
    let prefix = github_mirror_prefix(home);
    let mut out: Vec<String> = Vec::new();
    for url in &report.urls {
        let text = url.trim();
        if text.is_empty() || out.iter().any(|seen| seen == text) {
            continue;
        }
        out.push(text.to_string());
    }
    if !report.download_url.trim().is_empty() {
        let mirrored = apply_github_mirror(prefix.as_deref(), report.download_url.trim());
        if !out.iter().any(|seen| seen == &mirrored) {
            out.push(mirrored);
        }
        let direct = report.download_url.trim().to_string();
        if !out.iter().any(|seen| seen == &direct) {
            out.push(direct);
        }
    }
    out
}

/// 检查更新：网络请求跑在阻塞线程池里（curl 是子进程，不能占住 async 运行时的线程），
/// 当前版本取打包配置里的版本 —— 用户看到的版本才是比较基准。
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<UpdateCheckReport, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || build_update_report(&current))
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
}

/// 更新进度事件名：前端订阅它显示「下载 42% · 校验中 · 安装中」。
const UPDATE_EVENT_PROGRESS: &str = "update:progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    /// download / verify / install / done
    phase: String,
    /// 已下载字节（phase=download 时有意义）。
    got: u64,
    /// 总字节（清单给了才有；0 = 未知）。
    total: u64,
    /// 速度（字节/秒，0 = 还没算出来）。
    speed: u64,
    /// 这一阶段的一句话。
    message: String,
}

fn emit_progress(app: &tauri::AppHandle, progress: UpdateProgress) {
    let _ = app.emit(UPDATE_EVENT_PROGRESS, progress);
}

/// 下载更新包（**优先走用户在设置里选的 GitHub 镜像**）。
///
/// 为什么下载也走壳而不是丢给浏览器：浏览器下载既不认镜像，也不会校验摘要，
/// 更没法在装完之后把应用拉起来 —— 一步做完才算「全自动」。
/// 传了 url 就直接用它；没传就按清单的 urls → 镜像改写 → 直连 依次重试。
#[tauri::command]
async fn download_update(app: tauri::AppHandle, url: Option<String>) -> Result<UpdateActionReport, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || download_update_sync(&handle, url))
        .await
        .map_err(|error| format!("下载更新包失败：{error}"))?
}

fn download_update_sync(
    app: &tauri::AppHandle,
    url_hint: Option<String>,
) -> Result<UpdateActionReport, String> {
    let hint = url_hint.map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
    let current = app.package_info().version.to_string();
    let candidates = match hint {
        Some(url) => vec![url],
        None => {
            let report = build_update_report(&current)?;
            download_candidates(&report, &dirs_home())
        }
    };
    if candidates.is_empty() {
        return Err("清单里没有可用的下载地址".to_string());
    }
    let dest = std::env::temp_dir().join(format!("Coomi_update_{current}.exe"));
    let mut errors: Vec<String> = Vec::new();
    for url in &candidates {
        match fetch_to_file(app, url, &dest) {
            Ok(()) => {
                let size = std::fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
                emit_progress(app, UpdateProgress {
                    phase: "download".into(),
                    got: size,
                    total: size,
                    speed: 0,
                    message: "下载完成".into(),
                });
                return Ok(UpdateActionReport {
                    status: "ok".to_string(),
                    message: format!("已下载（{:.1} MB）", size as f64 / BYTES_PER_MB),
                    path: Some(dest.to_string_lossy().to_string()),
                    url: Some(url.clone()),
                });
            }
            Err(error) => errors.push(format!("{url}：{error}")),
        }
    }
    Err(format!("下载失败（已试 {} 条链路）：{}", candidates.len(), errors.join("；")))
}

/// 用 curl 把 url 下到 dest，边下边按文件大小发进度
/// （curl 自己的进度条是回车刷新的，解析它不如直接看目标文件长了多少）。
fn fetch_to_file(app: &tauri::AppHandle, url: &str, dest: &std::path::Path) -> Result<(), String> {
    let _ = std::fs::remove_file(dest);
    let mut child = std::process::Command::new(CURL_BIN)
        .args(["-fL", "--ssl-no-revoke", "--retry", "2", "--connect-timeout", "10", "-o"])
        .arg(dest)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动下载：{error}"))?;
    let started = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let got = std::fs::metadata(dest).map(|meta| meta.len()).unwrap_or(0);
        if last_emit.elapsed() >= std::time::Duration::from_millis(600) {
            last_emit = std::time::Instant::now();
            let seconds = started.elapsed().as_secs_f64().max(0.001);
            emit_progress(app, UpdateProgress {
                phase: "download".into(),
                got,
                total: 0,
                speed: (got as f64 / seconds) as u64,
                message: format!("正在下载 {:.1} MB", got as f64 / BYTES_PER_MB),
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let mut detail = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use std::io::Read as _;
                    let _ = stderr.read_to_string(&mut detail);
                }
                let tail = detail.trim().lines().last().unwrap_or("").to_string();
                return Err(if tail.is_empty() {
                    format!("curl 退出码 {}", status.code().unwrap_or(-1))
                } else {
                    tail
                });
            }
            Ok(None) => {}
            Err(error) => return Err(format!("等待下载进程失败：{error}")),
        }
    }
}

/// 校验更新包的 sha256：清单没给摘要就如实跳过（status=skipped），不假装校验过。
#[tauri::command]
async fn verify_sha256(path: String, sha256: Option<String>) -> Result<UpdateActionReport, String> {
    tauri::async_runtime::spawn_blocking(move || verify_sha256_sync(&path, sha256))
        .await
        .map_err(|error| format!("校验安装包失败：{error}"))?
}

fn verify_sha256_sync(path: &str, expected: Option<String>) -> Result<UpdateActionReport, String> {
    let file = std::path::PathBuf::from(path);
    if !file.is_file() {
        return Err(format!("安装包不存在：{path}"));
    }
    let expected = expected.map(|text| text.trim().to_lowercase()).filter(|text| !text.is_empty());
    let Some(expected) = expected else {
        // 更新契约：清单必须带 sha256。缺摘要曾经是「跳过校验并继续安装」——
        // 那等于把「镜像/清单被换掉」直接变成静默安装任意 exe，这里改成硬拒绝。
        return Err(
            "更新清单没有提供 sha256，已拒绝安装（缺少摘要的清单不允许安装）".to_string(),
        );
    };
    let actual = sha256_file(&file)?;
    if actual != expected {
        return Err(format!("安装包校验失败（可能没下完或被改动）：期望 {expected}，实际 {actual}"));
    }
    Ok(UpdateActionReport {
        status: "ok".to_string(),
        message: "安装包校验通过".to_string(),
        path: Some(path.to_string()),
        url: None,
    })
}

/// 流式算文件摘要（40MB 级别，别整个读进内存）。
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).map_err(|error| format!("打不开安装包：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("读取安装包失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 安装更新包：NSIS 静默安装（/S）。
///
/// perMachine 安装需要管理员权限，所以先试**提权启动**（会弹一次 UAC，用户点「是」即可）；
/// 用户拒绝或提权失败时退回「正常启动安装程序」—— 让安装界面自己出来，用户点完照样能升级，
/// 比卡在一个没有反馈的错误上好。装完由安装程序自己覆盖文件并重启应用。
#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    path: String,
    sha256: Option<String>,
) -> Result<UpdateActionReport, String> {
    // 壳侧最后一道门：不假设前端一定校验过。摘要缺失或不匹配都不进入安装流程。
    // 40MB 级别的流式摘要走阻塞线程池，别占着异步运行时。
    let verify_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || verify_sha256_sync(&verify_path, sha256))
        .await
        .map_err(|error| format!("校验安装包失败：{error}"))??;
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_update_sync(&path))
        .await
        .map_err(|error| format!("启动安装程序失败：{error}"))?;
    if result.is_ok() {
        emit_progress(&app, UpdateProgress {
            phase: "install".into(),
            got: 0,
            total: 0,
            speed: 0,
            message: "安装程序已启动".into(),
        });
        // 交给安装程序接管：它要替换正在运行的 exe，先把本进程收掉
        // （1.5 秒后，让前端把「即将重启」那一帧画出来）。
        let handle = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            handle.exit(0);
        });
    }
    result
}

fn install_update_sync(path: &str) -> Result<UpdateActionReport, String> {
    let file = std::path::PathBuf::from(path);
    if !file.is_file() {
        return Err(format!("安装包不存在：{path}"));
    }
    // ① 提权静默安装（Start-Process -Verb RunAs 会弹 UAC）。
    let quoted = file.display().to_string().replace('\'', "''");
    let script = format!(
        "$p = Start-Process -FilePath '{quoted}' -ArgumentList '/S' -Verb RunAs -PassThru; if ($p) {{ Write-Output $p.Id }}"
    );
    if let Ok(text) = run_capture("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &script])
        && !text.trim().is_empty()
    {
        return Ok(UpdateActionReport {
            status: "ok".to_string(),
            message: "安装程序已以管理员身份静默启动，装完会自动打开".to_string(),
            path: Some(path.to_string()),
            url: None,
        });
    }
    // ② 可见安装：直接启动安装程序，让用户点下一步。
    std::process::Command::new(&file)
        .spawn()
        .map_err(|error| format!("无法启动安装程序：{error}"))?;
    Ok(UpdateActionReport {
        status: "ok".to_string(),
        message: "已启动安装程序（需要你点几下完成）".to_string(),
        path: Some(path.to_string()),
        url: None,
    })
}

#[tauri::command]
fn engine_stop(app: tauri::AppHandle) -> Result<(), String> {
    kill_engine(&app);
    refresh_tray_tooltip(&app);
    Ok(())
}

/// 窗口控制（自绘标题栏用）。
#[tauri::command]
fn win_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_maximize(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn win_close(window: tauri::Window) {
    let _ = window.close();
}

/// 用系统资源管理器打开路径。
#[tauri::command]
fn open_path(path: String) {
    if path.is_empty() {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
}

#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Option<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_files().map(|list| {
            list.into_iter().map(|p| p.to_string()).collect::<Vec<String>>()
        })
    })
    .await
    .ok()
    .flatten()
}

/* ── 另存为：save_file_as { source, suggestedName } → SaveAsReport ──
   流程（全部在 Tauri 侧完成，前端只给「源文件 + 建议文件名」）：
     ① 校验源文件：必须存在、必须是文件（目录要用户自己去资源管理器复制）；
     ② 原生保存对话框（tauri-plugin-dialog 的 save 对话框）：
        默认文件名 = 建议名（空则回落原文件名），默认目录 = 上次另存成功的位置（首次回落「下载」）；
        覆盖确认交给系统对话框自己处理；用户取消则返回 canceled，不当失败；
     ③ 复制：同盘优先 rename（瞬时、不占双份空间），rename 不成立（跨盘 / 目标已存在 /
        被占用）一律回退 copy，并在复制前清掉目标（覆盖语义，系统对话框已经问过用户了）；
     ④ 结果回报：新路径 + 文件名 + 大小 + 是否换了目录（前端用它提示「已另存到 …」）。 */

/// 复制失败的可读原因：权限 / 磁盘满 / 被占用 / 找不到，其余原样带上系统文案。
fn describe_save_failure(error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::PermissionDenied => "没有写入权限：目标目录受保护或文件是只读，换一个位置再试".to_string(),
        ErrorKind::NotFound => "源文件或目标目录不存在了（可能刚被移动或删除）".to_string(),
        _ => {
            let raw = error.to_string();
            if raw.contains("os error 112") {
                // ERROR_DISK_FULL：Windows 的「磁盘已满」不走 ErrorKind 的细分。
                "磁盘空间不足：换个位置或先清理空间".to_string()
            } else if raw.contains("os error 32") || raw.contains("os error 33") {
                // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION：文件被别的程序占着。
                "目标文件正被其他程序占用：关掉它再试".to_string()
            } else {
                raw
            }
        }
    }
}

/// 同盘优先 rename、失败回退 copy 的落地动作。
/// rename 之前先删一次目标：Windows 的 rename 不会覆盖已存在的文件（目标就是用户在
/// 对话框里确认过要覆盖的那个），留着它就是「另存为永远失败」。
fn save_file_at(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    if !same_path(source, target) {
        let _ = std::fs::remove_file(target);
        if std::fs::rename(source, target).is_ok() {
            return Ok(());
        }
    }
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| describe_save_failure(&error))
}

/// 另存为的回执。canceled = 用户在系统对话框里点了取消（不是失败）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveAsReport {
    canceled: bool,
    path: String,
    name: String,
    size: u64,
    /// 这次选的目录与「上一次另存的位置」不同：前端可据此换一句提示（而不是每次都报目录）。
    dir_changed: bool,
}

impl SaveAsReport {
    fn canceled() -> Self {
        Self { canceled: true, path: String::new(), name: String::new(), size: 0, dir_changed: false }
    }
}

/// 与对话框的交互（默认目录 / 默认文件名 / 返回路径）收在一处：
/// 文件与文件夹两个选择器只有「调哪个 API」这一处不同，且都要用同一个默认目录。
fn run_native_file_dialog(
    app: &tauri::AppHandle,
    name: Option<String>,
) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let directory = default_save_dir();
    let mut builder = app.dialog().file().set_directory(&directory);
    if let Some(name) = name {
        builder = builder.set_file_name(name);
    }
    builder
        .blocking_save_file()
        .and_then(|picked| picked.into_path().ok())
}

#[tauri::command]
async fn save_file_as(
    app: tauri::AppHandle,
    source: String,
    suggested_name: Option<String>,
) -> Result<SaveAsReport, String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err("没有可另存的文件：路径是空的".to_string());
    }
    let source = PathBuf::from(source);
    if !source.exists() {
        return Err(format!("源文件不存在：{}", source.display()));
    }
    if !source.is_file() {
        return Err(format!("只能另存单个文件（这是目录）：{}", source.display()));
    }

    let name = save_dialog_name(suggested_name.as_deref().unwrap_or(""), &source);
    let dialog_app = app.clone();
    let dialog_name = name.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        run_native_file_dialog(&dialog_app, Some(dialog_name))
    })
    .await
    .map_err(|error| format!("打开保存对话框失败：{error}"))?;

    let Some(target) = picked else { return Ok(SaveAsReport::canceled()) };
    if target.as_os_str().is_empty() {
        return Ok(SaveAsReport::canceled());
    }

    save_file_at(&source, &target)?;

    // 记下这次的位置：下一回另存为的默认目录就是它（写失败不影响这次另存的结果）。
    let parent = target.parent().map(|p| p.to_path_buf());
    let dir_changed = match (&parent, read_last_save_dir()) {
        (Some(dir), Some(last)) => !same_path(dir, &last),
        (Some(_), None) => true,
        (None, _) => false,
    };
    if let Some(dir) = parent {
        let _ = write_ui_prefs(serde_json::json!({ "lastSaveDir": dir.to_string_lossy() }));
    }

    let size = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    Ok(SaveAsReport {
        canceled: false,
        path: target.to_string_lossy().into_owned(),
        name: target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name),
        size,
        dir_changed,
    })
}

/// 显示并聚焦主窗口（托盘左键 / 菜单「显示主窗口」）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 引擎是否已经「就绪过一次」。守护线程用它区分两种「探测不到」：
/// 冷启动阶段（还没就绪，属正常，不能算卡死）与就绪之后突然不答话（卡死，必须自愈）。
fn engine_ready_once(app: &tauri::AppHandle) -> bool {
    let state: State<EngineState> = app.state();
    state.started.load(Ordering::SeqCst)
}

/// 引擎当前是否**还有任务在跑**（`/api/sessions/running` 返回的列表非空）。
///
/// 卡死判定必须问这一句：长输出时引擎是「忙」不是「死」，只看健康探测会把它误杀，
/// 而这正是「对话输出到一半引擎崩溃」的机制。**探测失败时一律当作「在忙」**（宁可
/// 不重启，也不要杀掉正在干活的引擎）——真死透了还有「子进程已退出」这条独立证据兜底。
fn engine_has_running_task(port: u16, token: &str) -> bool {
    match engine_http_get(port, token, "/api/sessions/running") {
        Some(body) => body.contains("\"running\":true") || body.contains("\"running\": true"),
        None => true,
    }
}

/// 最小 HTTP GET（std 实现，不引依赖），返回响应体；任何失败都返回 None。
fn engine_http_get(port: u16, token: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1000)).ok()?;
    // 读超时给足：引擎忙的时候响应会慢，但慢不等于死。
    let _ = stream.set_read_timeout(Some(Duration::from_millis(3000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1000)));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    raw.split_once("\r\n\r\n").map(|(_, body)| body.to_owned())
}

/// 引擎是否真的在监听：手写一个最小 HTTP 探针（std 即可），
/// 不为了显示一行状态引入 http 客户端依赖。
/// /api/runtime/health 允许无令牌探活，这里仍然带上令牌拿完整响应。
fn engine_http_ok(port: u16, token: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    use std::time::Duration;

    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let request = format!(
        "GET /api/runtime/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let mut filled = 0usize;
    while filled < 12 {
        match stream.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&buf[..filled]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// 给引擎发一个最小 POST（std 即可，不为一次请求引入 http 客户端）。
/// 返回整包响应文本；连不上返回 None（调用方按「尽力而为」处理）。
fn engine_http_post(port: u16, token: &str, path: &str, body: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    use std::time::Duration;

    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    // MCP 重载要等服务器握手完才回包，读超时给宽一点；这只发生在后台线程里。
    let _ = stream.set_read_timeout(Some(Duration::from_secs(90)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

/// 响应摘要：只留状态行 + body 前 200 字（日志里别塞整包）。
fn summarize_http(response: &str) -> String {
    let status = response.lines().next().unwrap_or_default().trim().to_owned();
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    if body.is_empty() {
        status
    } else {
        format!("{status} {body}")
    }
}

/// 引擎状态文案：启动中（进程还在，端口没响应）/ 运行中 / 已停止。
fn engine_status_text(app: &tauri::AppHandle) -> String {
    let state: State<EngineState> = app.state();
    let port = *state.port.lock().unwrap();
    let token = state.token.lock().unwrap().clone();
    let alive = state
        .child
        .lock()
        .unwrap()
        .as_mut()
        .map(|child| matches!(child.try_wait(), Ok(None)))
        .unwrap_or(false);

    // 守护线程的状态文案（崩溃原因 / 退避倒计时 / 已放弃自动重启）优先于通用状态：
    // 引擎没在跑时，用户最需要知道的是「它为什么没在跑、还会不会自己回来」。
    let guard_note = state
        .guard_note
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if port == 0 {
        return if guard_note.is_empty() {
            "引擎未启动".to_string()
        } else {
            guard_note
        };
    }
    if engine_http_ok(port, &token) {
        format!("引擎运行中 · 端口 {port}")
    } else if !guard_note.is_empty() {
        guard_note
    } else if alive {
        format!("引擎启动中 · 端口 {port}")
    } else {
        "引擎已停止".to_string()
    }
}

/// 托盘 tooltip：窗口隐藏时额外标注「后台运行中」，鼠标划过托盘就能确认任务没断。
fn tray_tooltip_text(app: &tauri::AppHandle) -> String {
    let background = app
        .get_webview_window("main")
        .map(|window| !window.is_visible().unwrap_or(true))
        .unwrap_or(false);
    let status = engine_status_text(app);
    if background {
        format!("Coomi（后台运行中）· {status}")
    } else {
        format!("Coomi · {status}")
    }
}

fn refresh_tray_tooltip(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tray_tooltip_text(app)));
    }
}

/// 系统托盘：图标 + 「显示主窗口 / 新建对话 / 退出」。左键单击直接切回主窗口。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let new_chat_item = MenuItem::with_id(app, TRAY_MENU_NEW_CHAT, "新建对话", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &new_chat_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键单击直接切回主窗口，右键才弹菜单（左键弹菜单会挡着「点一下就回来」的直觉）。
        .show_menu_on_left_click(false)
        .tooltip(tray_tooltip_text(app))
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW => show_main_window(app),
            TRAY_MENU_NEW_CHAT => {
                show_main_window(app);
                // 前端 listen(TRAY_EVENT_NEW_CHAT) 后调用 session.newSession()。
                let _ = app.emit(TRAY_EVENT_NEW_CHAT, ());
            }
            TRAY_MENU_QUIT => {
                // 托盘「退出」才是真退出：先结束引擎，再退出壳（复用同一段 kill 逻辑）。
                kill_engine(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 复用打包时嵌入的图标（tauri.conf.json 的 bundle.icon），不再单独放一份托盘图。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 「关闭窗口时最小化到托盘（后台运行）」开关。默认开。
/// 序列化成 camelCase，前端拿到的是 { closeToTray, autostart }。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPrefs {
    close_to_tray: bool,
    autostart: bool,
    /// 上一次「另存为」选中的目录（没另存过就是空串）：前端只做展示，真正用它的是
    /// save_file_as 的默认目录，所以这里如实回读磁盘上那一份。
    last_save_dir: String,
}

#[tauri::command]
fn desktop_prefs(state: State<'_, PrefsState>) -> DesktopPrefs {
    DesktopPrefs {
        close_to_tray: *state.close_to_tray.lock().unwrap(),
        autostart: *state.autostart.lock().unwrap(),
        last_save_dir: read_last_save_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

#[tauri::command]
fn set_close_to_tray(
    app: tauri::AppHandle,
    state: State<'_, PrefsState>,
    enabled: bool,
) -> Result<(), String> {
    *state.close_to_tray.lock().unwrap() = enabled;
    write_ui_prefs(serde_json::json!({ "closeToTray": enabled }))?;
    refresh_tray_tooltip(&app);
    Ok(())
}

#[cfg(target_os = "windows")]
fn autostart_enabled() -> bool {
    std::process::Command::new("reg")
        .args(["query", AUTOSTART_KEY, "/v", AUTOSTART_NAME])
        .creation_flags(0x08000000)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn autostart_enabled() -> bool {
    false
}

/// 开机自启开关：写 HKCU 的 Run 键（免管理员、免新 crate）。
/// 自启时带 --minimized，登录后直接进托盘，不弹窗打断用户。
#[tauri::command]
fn set_autostart(state: State<'_, PrefsState>, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        let output = if enabled {
            let value = format!("\"{}\" --minimized", exe.display());
            std::process::Command::new("reg")
                .args(["add", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/t", "REG_SZ", "/d"])
                .arg(&value)
                .arg("/f")
                .creation_flags(0x08000000)
                .output()
        } else {
            std::process::Command::new("reg")
                .args(["delete", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/f"])
                .creation_flags(0x08000000)
                .output()
        };
        let out = output.map_err(|e| format!("reg: {e}"))?;
        if !out.status.success() {
            let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if detail.is_empty() { "写入开机自启失败".into() } else { detail });
        }
        *state.autostart.lock().unwrap() = enabled;
        write_ui_prefs(serde_json::json!({ "autostart": enabled }))?;
        Ok(enabled)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, enabled);
        Err("当前平台暂不支持开机自启开关".to_string())
    }
}


/* ── 插件系统（壳侧，v2）──
   插件的家：%APPDATA%\Coomi\plugins\<id>\，每个插件目录下必须有 plugin.json
   （缺文件 / 坏 JSON 的目录在列表里直接跳过，绝不让一个坏插件拖垮整个列表）。
   启停状态单独存一份：<home>/plugins.json = { "插件id": true|false }，缺失字段视为启用。
   v2 插件能力全声明式（plugin.json 里声明，启用时注册、关闭/卸载时撤销）：
   skills / mcp / subagents / persona / slash / views（v2.1：页面注册），
   见下方 register_plugin / unregister_plugin。
   所有 IO / 网络错误都翻译成可读中文返回，绝不 panic。 */

/// 插件数据（plugin_list 的返回形态，序列化成 camelCase：hasTheme / themeName / permissions）。
/// v2 插件能力全部是声明式的（只读，不做执行）：skills / mcp / subagents / persona / slash。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    enabled: bool,
    has_theme: bool,
    theme_name: String,
    permissions: Vec<String>,
    /// theme.json 解析后的对象（前端直接用于渲染 CSS 变量覆盖）；无主题插件为 None。
    theme_data: Option<serde_json::Value>,
    /// 插件声明或目录内 skills/*.md 提供的技能（启用时复制进 home/skills/{pluginId}-{skillId}）。
    skills: Vec<PluginSkillSpec>,
    /// 插件声明的 MCP 服务器（启用时追加进 mcp_servers.json，键名前缀 plugin:{pluginId}）。
    mcp: Vec<PluginMcpSpec>,
    /// 插件声明的子智能体模板（启用时存 home/plugin-subagents.json，前端下拉读）。
    subagents: Vec<PluginSubAgentSpec>,
    /// 插件人格提示词（启用时存 home/plugin-personas.json，引擎组装系统提示词时附加）。
    persona: String,
    /// 插件声明的斜杠命令（command/description/template）。
    slash: Vec<PluginSlashSpec>,
    /// 插件声明的页面（v2.1）：启用时注册进 side bar，停用即撤销。
    views: Vec<PluginViewSpec>,
}

/// 插件页面声明（v2.1）：启用后在侧边栏多出一个入口。
/// 与其它声明式能力同一套纪律：**只读、不执行** —— 页面本体是插件目录里的静态 HTML，
/// 由前端的插件页面宿主用 asset:// 协议装进独立 origin 的 iframe（不给 Tauri IPC）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginViewSpec {
    id: String,
    title: String,
    /// 图标名（前端按名字表映射成内置图标；认不出就用默认方块图标）。
    icon: String,
    /// 排序权重（越小越靠前，核心四页始终在前）。
    order: i64,
    /// 插件目录内的相对路径，必须是 .html / .htm。
    entry: String,
}

/// 插件技能声明：id 是插件内唯一标识（启用后目录名 = {pluginId}-{skillId}），
/// body 为技能正文（SKILL.md 内容）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginSkillSpec {
    id: String,
    name: String,
    description: String,
    body: String,
}

/// 插件 MCP 声明：stdio 形态（command/args/env）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginMcpSpec {
    name: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

/// 插件子智能体模板声明：systemPrompt 即该子智能体的系统提示词。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginSubAgentSpec {
    id: String,
    name: String,
    description: String,
    system_prompt: String,
}

/// 插件斜杠命令声明（command/description/template）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginSlashSpec {
    command: String,
    description: String,
    template: String,
}

/// 插件根目录：%APPDATA%\Coomi\plugins。
fn plugins_root() -> PathBuf {
    dirs_home().join("plugins")
}

/// 启停状态文件：<home>/plugins.json（{id: bool}，缺省视为 true）。
fn plugins_json_path() -> PathBuf {
    dirs_home().join("plugins.json")
}

/// 插件 id 白名单：只允许 [A-Za-z0-9_-]。校验通过后再拼路径就不会发生「..」穿越。
/// 递归把 theme.json 里 `assets/...` 相对引用补成插件目录的绝对路径（供 convertFileSrc）。
fn absolutize_theme_assets(mut value: serde_json::Value, plugin_dir: &std::path::Path) -> serde_json::Value {
    fn walk(v: &mut serde_json::Value, prefix: &str) {
        match v {
            serde_json::Value::String(s) => {
                if s.starts_with("assets/") {
                    *s = format!("{prefix}/{s}");
                }
            }
            serde_json::Value::Array(list) => { for item in list { walk(item, prefix) } }
            serde_json::Value::Object(map) => { for (_, val) in map { walk(val, prefix) } }
            _ => {}
        }
    }
    let prefix = plugin_dir.to_string_lossy().replace('\\', "/");
    walk(&mut value, &prefix);
    value
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// 读启停表：文件缺失 / 坏 JSON 一律当作空表（此时每个插件缺省启用）。
fn read_enabled_map() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(plugins_json_path())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn save_enabled_map(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = plugins_json_path();
    let text = serde_json::to_string(map).map_err(|error| format!("序列化插件状态失败：{error}"))?;
    std::fs::write(&path, text).map_err(|error| format!("写入插件状态失败：{}（{error}）", path.display()))
}

/// 从 SKILL.md 开头提取 name / description（有 front matter 就认，没有就退回默认值）。
fn skill_front_matter(body: &str, fallback_name: &str) -> (String, String) {
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    for line in body.lines().take(64) {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("name:") {
            let value = value.trim().trim_matches(['"', '\'']);
            if !value.is_empty() {
                name = value.to_string();
            }
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            let value = value.trim().trim_matches(['"', '\'']);
            if !value.is_empty() {
                description = value.to_string();
            }
        }
        if trimmed == "---" && !name.eq(fallback_name) {
            break;
        }
    }
    (name, description)
}

/// 技能 id 安全化：只保留 [A-Za-z0-9_-]，其余替换成 '-'，空结果返回 None（调用方跳过）。
fn sanitize_skill_id(id: &str) -> Option<String> {
    let cleaned: String = id
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// 解析插件技能：目录内 skills/*.md（或 skills/<id>/SKILL.md） + plugin.json 内联 skills
/// 数组（同 id 时内联覆盖文件条目）。任何一步失败都跳过，绝不 panic。
fn parse_plugin_skills(dir: &std::path::Path, manifest: &serde_json::Map<String, serde_json::Value>) -> Vec<PluginSkillSpec> {
    let mut skills: Vec<PluginSkillSpec> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir.join("skills")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let skill_file = if path.is_dir() {
                path.join("SKILL.md")
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                path.clone()
            } else {
                continue;
            };
            if !skill_file.is_file() {
                continue;
            }
            let raw_id = skill_file
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
                .unwrap_or_default();
            let Some(id) = sanitize_skill_id(&raw_id) else {
                continue;
            };
            let body = std::fs::read_to_string(&skill_file).unwrap_or_default();
            let (name, description) = skill_front_matter(&body, &id);
            skills.push(PluginSkillSpec { id, name, description, body });
        }
    }
    if let Some(list) = manifest.get("skills").and_then(serde_json::Value::as_array) {
        for item in list {
            let Some(id) = item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .and_then(sanitize_skill_id)
            else {
                continue;
            };
            let name = item
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::trim)
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            let description = item
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .map(str::to_string)
                .unwrap_or_default();
            let body = item
                .get("body")
                .or_else(|| item.get("content"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            if let Some(existing) = skills.iter_mut().find(|s| s.id == id) {
                existing.name = name;
                existing.description = description;
                existing.body = body;
            } else {
                skills.push(PluginSkillSpec { id, name, description, body });
            }
        }
    }
    skills
}

/// 解析插件 MCP 声明（plugin.json 的 mcp 数组）。
fn parse_plugin_mcp(manifest: &serde_json::Map<String, serde_json::Value>) -> Vec<PluginMcpSpec> {
    manifest
        .get("mcp")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let name = item
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    Some(PluginMcpSpec {
                        name: name.to_string(),
                        command: item
                            .get("command")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default(),
                        args: item
                            .get("args")
                            .and_then(serde_json::Value::as_array)
                            .map(|a| {
                                a.iter()
                                    .filter_map(serde_json::Value::as_str)
                                    .map(str::to_string)
                                    .collect::<Vec<String>>()
                            })
                            .unwrap_or_default(),
                        env: item
                            .get("env")
                            .and_then(serde_json::Value::as_object)
                            .map(|o| {
                                o.iter()
                                    .map(|(k, v)| {
                                        (
                                            k.clone(),
                                            v.as_str().unwrap_or_default().to_string(),
                                        )
                                    })
                                    .collect::<BTreeMap<String, String>>()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect::<Vec<PluginMcpSpec>>()
        })
        .unwrap_or_default()
}

/// 解析插件子智能体模板声明（plugin.json 的 subagents 数组）。
fn parse_plugin_subagents(manifest: &serde_json::Map<String, serde_json::Value>) -> Vec<PluginSubAgentSpec> {
    manifest
        .get("subagents")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let id = item
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    let name = item
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .map(str::trim)
                        .map(str::to_string)
                        .unwrap_or_else(|| id.to_string());
                    let description = item
                        .get("description")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .map(str::to_string)
                        .unwrap_or_default();
                    let system_prompt = item
                        .get("systemPrompt")
                        .or_else(|| item.get("system_prompt"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_default();
                    Some(PluginSubAgentSpec { id: id.to_string(), name, description, system_prompt })
                })
                .collect::<Vec<PluginSubAgentSpec>>()
        })
        .unwrap_or_default()
}

/// 解析插件页面声明（plugin.json 的 views 数组）。
///
/// 校验（任一不合格就跳过这条，不让一个坏声明拖垮整个插件）：
///   · id 只能含 [A-Za-z0-9_-]（会拼进侧边栏 key，也用来定位注册项）；
///   · title 不能为空（侧边栏要有可读名字）；
///   · entry 必须是**插件目录内的相对路径**，且以 .html / .htm 结尾 ——
///     绝对路径、".."、盘符、UNC 一律拒绝（防越界读盘）。
fn parse_plugin_views(manifest: &serde_json::Map<String, serde_json::Value>) -> Vec<PluginViewSpec> {
    manifest
        .get("views")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let id = item
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                        return None;
                    }
                    let title = item
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    let entry = item
                        .get("entry")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .unwrap_or_default();
                    let lower = entry.to_ascii_lowercase();
                    if entry.is_empty()
                        || entry.contains("..")
                        || entry.starts_with('/')
                        || entry.starts_with('\\')
                        || entry.contains(':')
                        || !(lower.ends_with(".html") || lower.ends_with(".htm"))
                    {
                        return None;
                    }
                    let icon = item
                        .get("icon")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .unwrap_or_default()
                        .to_string();
                    let order = item.get("order").and_then(serde_json::Value::as_i64).unwrap_or(50);
                    Some(PluginViewSpec {
                        id: id.to_string(),
                        title: title.to_string(),
                        icon,
                        order,
                        entry: entry.replace('\\', "/"),
                    })
                })
                .collect::<Vec<PluginViewSpec>>()
        })
        .unwrap_or_default()
}

/// 解析插件人格（plugin.json 的 persona 字符串）。
fn parse_plugin_persona(manifest: &serde_json::Map<String, serde_json::Value>) -> String {
    manifest
        .get("persona")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .map(str::to_string)
        .unwrap_or_default()
}

/// 解析插件斜杠命令（plugin.json 的 slash 数组）。
fn parse_plugin_slash(manifest: &serde_json::Map<String, serde_json::Value>) -> Vec<PluginSlashSpec> {
    manifest
        .get("slash")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let command = item
                        .get("command")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?;
                    Some(PluginSlashSpec {
                        command: command.to_string(),
                        description: item
                            .get("description")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default(),
                        template: item
                            .get("template")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default(),
                    })
                })
                .collect::<Vec<PluginSlashSpec>>()
        })
        .unwrap_or_default()
}

/// 从插件目录读 plugin.json 并整理成列表项；任何一步失败都返回 None（由调用方跳过），
/// 字段缺省规则：name=id、version=0.0.0、description=空、themeName=空、permissions=[]。
fn plugin_info_for_dir(
    dir: &std::path::Path,
    enabled: &serde_json::Map<String, serde_json::Value>,
) -> Option<PluginInfo> {
    let text = std::fs::read_to_string(dir.join("plugin.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    let manifest = manifest.as_object()?;
    let id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && valid_plugin_id(id))?;
    let name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| id.to_string());
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "0.0.0".to_string());
    let description = manifest
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .map(str::to_string)
        .unwrap_or_default();
    let theme_name = manifest
        .get("themeName")
        .or_else(|| manifest.get("theme_name"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .map(str::to_string)
        .unwrap_or_default();
    let permissions = manifest
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    // theme.json 存在 → 解析成对象交给前端渲染（坏 JSON 时按无主题处理，不崩溃）。
    let theme_data = if dir.join("theme.json").is_file() {
        std::fs::read_to_string(dir.join("theme.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    } else {
        // 清单里直接内联了 theme 对象也认。
        manifest.get("theme").and_then(|value| value.as_object().map(|_| value.clone()))
    };
    // theme.json 里的 `assets/xxx` 是相对插件目录的路径；前端 convertFileSrc 需要**绝对路径**，
    // 否则会生成 asset://assets%2Fxxx 这种假 URL，图片全部加载失败（用户看到的就是
    // 「没有鲸鱼背景、图标消失」）。这里把所有 assets/ 引用补成插件目录的绝对路径。
    let theme_data = theme_data.map(|value| absolutize_theme_assets(value, &dir));
    // v2 插件能力：全部从清单/目录声明式读取（只读，不做执行）。
    let skills = parse_plugin_skills(dir, manifest);
    let mcp = parse_plugin_mcp(manifest);
    let subagents = parse_plugin_subagents(manifest);
    let persona = parse_plugin_persona(manifest);
    let slash = parse_plugin_slash(manifest);
    let views = parse_plugin_views(manifest);
    Some(PluginInfo {
        id: id.to_string(),
        name,
        version,
        description,
        enabled: enabled.get(id).and_then(serde_json::Value::as_bool).unwrap_or(true),
        has_theme: theme_data.is_some(),
        theme_name,
        permissions,
        theme_data,
        skills,
        mcp,
        subagents,
        persona,
        slash,
        views,
    })
}

/// 递归复制目录（安装「自文件夹」用）。任何一步失败返回中文原因，调用方负责清理半成品。
fn copy_dir_all(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("创建安装目录失败：{}（{error}）", target.display()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|error| format!("读取来源文件夹失败：{}（{error}）", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取来源文件夹失败：{error}"))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("复制 {} 失败：{error}", from.display()))?;
        }
    }
    Ok(())
}

/// 插件列表：扫 plugins 根下每个子目录的 plugin.json（缺文件 / 坏 JSON 跳过），
/// enabled 从 <home>/plugins.json 取，缺省视为 true。
#[tauri::command]
fn plugin_list() -> Vec<PluginInfo> {
    let enabled = read_enabled_map();
    let Ok(entries) = std::fs::read_dir(plugins_root()) else {
        return Vec::new();
    };
    let mut plugins: Vec<PluginInfo> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| plugin_info_for_dir(&entry.path(), &enabled))
        .collect();
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    plugins
}

/* ── v2 插件能力：启用时注册 / 关闭与卸载时撤销（全声明式）──
   启用插件（plugin_set_enabled on=true）把清单里声明的能力落地到引擎 home：
   · skills     → 复制进 <home>/skills/{pluginId}-{skillId}/SKILL.md（技能中心 / SkillRouter 自动发现）；
   · mcp        → 追加进 <home>/config/mcp_servers.json，键名前缀 plugin:{pluginId}，随后通知引擎 reload；
   · persona    → 存 <home>/plugin-personas.json，引擎组装系统提示词时把启用插件的提示词附加进去；
   · subagents  → 存 <home>/plugin-subagents.json，引擎经 /api/plugins/subagents 供前端下拉读取。
   关闭 / 卸载时全部撤销：删对应条目（技能目录 / MCP 键 / persona 键 / subagents 条目）+ MCP reload。
   所有 IO / 网络错误都翻译成可读中文返回，绝不 panic。 */

/// 读插件目录下的 plugin.json，返回顶层对象。失败给可读中文。
fn read_plugin_manifest(dir: &std::path::Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = dir.join("plugin.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| format!("读取插件清单失败：{}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("plugin.json 不是合法 JSON：{error}"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "plugin.json 顶层必须是对象".to_string())
}

/// 读 home 下 JSON 文件；不存在 / 坏 JSON 一律用缺省值（绝不 panic）。
fn read_home_json(path: &std::path::Path, default: serde_json::Value) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|value| value.is_object())
        .unwrap_or(default)
}

/// 原子写 JSON（临时文件 + rename）。任何失败给可读中文。
fn write_home_json(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| format!("序列化配置失败：{error}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败：{}（{error}）", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &text).map_err(|error| format!("写入 {} 失败：{error}", tmp.display()))?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| format!("替换 {} 失败：{error}", path.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|error| format!("提交 {} 失败：{error}", path.display()))
}

/// 插件技能在 home/skills 下的目录名前缀。
fn plugin_skill_dir_name(plugin_id: &str, skill_id: &str) -> String {
    format!("{plugin_id}-{skill_id}")
}

/// 插件 MCP 条目键名前缀（任务要求：plugin:{pluginId}）。
fn plugin_mcp_prefix(plugin_id: &str) -> String {
    format!("plugin:{plugin_id}:")
}

/// 组装技能文件内容：有 name/description 时补 front matter，让技能中心直接读到标题与描述。
fn build_skill_markdown(skill: &PluginSkillSpec) -> String {
    let mut out = String::new();
    if !skill.name.trim().is_empty() || !skill.description.trim().is_empty() {
        out.push_str("---\n");
        if !skill.name.trim().is_empty() {
            out.push_str(&format!("name: {}\n", skill.name.trim()));
        }
        if !skill.description.trim().is_empty() {
            out.push_str(&format!("description: {}\n", skill.description.trim()));
        }
        out.push_str("---\n\n");
    }
    out.push_str(skill.body.trim());
    out.push('\n');
    out
}

/// 注册插件技能：把每个技能写进 home/skills/{pluginId}-{skillId}/SKILL.md。
/// 技能中心（local_skills_list）与 SkillRouter 都按目录自动发现，无需额外索引。
fn register_plugin_skills(
    dir: &std::path::Path,
    plugin_id: &str,
    manifest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let skills = parse_plugin_skills(dir, manifest);
    let home_skills = dirs_home().join("skills");
    for skill in skills {
        if skill.body.trim().is_empty() {
            continue;
        }
        let dir_name = plugin_skill_dir_name(plugin_id, &skill.id);
        let target = home_skills.join(&dir_name);
        std::fs::create_dir_all(&target)
            .map_err(|error| format!("创建技能目录失败：{dir_name}（{error}）"))?;
        std::fs::write(target.join("SKILL.md"), build_skill_markdown(&skill))
            .map_err(|error| format!("写入技能失败：{dir_name}（{error}）"))?;
    }
    Ok(())
}

/// 撤销插件技能：按清单里的 id 删，再扫 home/skills 里以 {pluginId}- 开头的直接子目录兜底
/// （清单损坏时也能清干净）。只删 home/skills 的**直接**子目录，绝不动别处。
fn unregister_plugin_skills(
    plugin_id: &str,
    manifest: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<(), String> {
    let home_skills = dirs_home().join("skills");
    std::fs::create_dir_all(&home_skills)
        .map_err(|error| format!("创建技能目录失败：{}（{error}）", home_skills.display()))?;
    let home_skills = home_skills
        .canonicalize()
        .unwrap_or_else(|_| home_skills.clone());
    let mut to_remove: Vec<String> = Vec::new();
    if let Some(manifest) = manifest {
        for skill in parse_plugin_skills(&plugins_root().join(plugin_id), manifest) {
            to_remove.push(plugin_skill_dir_name(plugin_id, &skill.id));
        }
    }
    // 兜底扫描：{pluginId}- 前缀的直接子目录。
    if let Ok(entries) = std::fs::read_dir(&home_skills) {
        let prefix = format!("{plugin_id}-");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && !to_remove.iter().any(|item| *item == name) {
                to_remove.push(name);
            }
        }
    }
    for name in to_remove {
        if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
            continue;
        }
        let target = home_skills.join(&name);
        if !target.is_dir() {
            continue;
        }
        if target.parent() != Some(home_skills.as_path()) {
            continue;
        }
        std::fs::remove_dir_all(&target)
            .map_err(|error| format!("删除技能目录失败：{name}（{error}）"))?;
    }
    Ok(())
}

/// 注册插件 MCP：把清单 mcp 数组追加进 mcp_servers.json（键名 plugin:{pluginId}:{name}）。
/// 改动由调用方随后通知引擎 reload。
fn register_plugin_mcp(
    plugin_id: &str,
    manifest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let mcp = parse_plugin_mcp(manifest);
    if mcp.is_empty() {
        return Ok(());
    }
    let path = dirs_home().join("config").join("mcp_servers.json");
    let mut doc = read_home_json(&path, serde_json::json!({"version": 1, "servers": {}}));
    let servers = doc
        .get_mut("servers")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "mcp_servers.json 里缺少 servers 对象".to_string())?;
    for spec in mcp {
        if spec.command.trim().is_empty() {
            continue;
        }
        let key = format!("plugin:{plugin_id}:{}", spec.name);
        servers.insert(
            key,
            serde_json::json!({
                "transport": "stdio",
                "command": spec.command,
                "args": spec.args,
                "env": spec.env,
                "enabled": true,
            }),
        );
    }
    write_home_json(&path, &doc)
}

/// 撤销插件 MCP：删掉 mcp_servers.json 里 plugin:{pluginId}: 前缀的所有条目。
fn unregister_plugin_mcp(plugin_id: &str) -> Result<(), String> {
    let path = dirs_home().join("config").join("mcp_servers.json");
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_home_json(&path, serde_json::json!({"version": 1, "servers": {}}));
    let prefix = plugin_mcp_prefix(plugin_id);
    let removed = if let Some(servers) = doc.get_mut("servers").and_then(serde_json::Value::as_object_mut) {
        let before = servers.len();
        servers.retain(|key, _| !key.starts_with(&prefix));
        before != servers.len()
    } else {
        false
    };
    if removed {
        write_home_json(&path, &doc)?;
    }
    Ok(())
}

/// 写 / 更新插件人格：plugin-personas.json 的 personas[pluginId]。空 persona 视为无，直接移除键。
fn write_plugin_persona(
    plugin_id: &str,
    manifest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let persona = parse_plugin_persona(manifest);
    let path = dirs_home().join("plugin-personas.json");
    let mut doc = read_home_json(&path, serde_json::json!({"version": 1, "personas": {}}));
    let personas = doc
        .get_mut("personas")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "plugin-personas.json 里缺少 personas 对象".to_string())?;
    if persona.trim().is_empty() {
        personas.remove(plugin_id);
    } else {
        personas.insert(plugin_id.to_string(), serde_json::Value::String(persona));
    }
    write_home_json(&path, &doc)
}

/// 撤销插件人格：从 plugin-personas.json 移除该插件键。
fn remove_plugin_persona(plugin_id: &str) -> Result<(), String> {
    let path = dirs_home().join("plugin-personas.json");
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_home_json(&path, serde_json::json!({"version": 1, "personas": {}}));
    let removed = if let Some(personas) = doc.get_mut("personas").and_then(serde_json::Value::as_object_mut) {
        personas.remove(plugin_id).is_some()
    } else {
        false
    };
    if removed {
        write_home_json(&path, &doc)?;
    }
    Ok(())
}

/// 写 / 更新插件子智能体模板：plugin-subagents.json 的 agents（先清掉本插件的旧条目再追加）。
fn write_plugin_subagents(
    plugin_id: &str,
    manifest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let agents = parse_plugin_subagents(manifest);
    let path = dirs_home().join("plugin-subagents.json");
    let mut doc = read_home_json(&path, serde_json::json!({"version": 1, "agents": []}));
    let list = doc
        .get_mut("agents")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "plugin-subagents.json 里缺少 agents 数组".to_string())?;
    list.retain(|item| item.get("pluginId").and_then(serde_json::Value::as_str) != Some(plugin_id));
    for agent in agents {
        if agent.system_prompt.trim().is_empty() {
            continue;
        }
        list.push(serde_json::json!({
            "id": agent.id,
            "pluginId": plugin_id,
            "name": agent.name,
            "description": agent.description,
            "systemPrompt": agent.system_prompt,
        }));
    }
    write_home_json(&path, &doc)
}

/// 撤销插件子智能体：从 plugin-subagents.json 移除该插件的全部条目。
fn remove_plugin_subagents(plugin_id: &str) -> Result<(), String> {
    let path = dirs_home().join("plugin-subagents.json");
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_home_json(&path, serde_json::json!({"version": 1, "agents": []}));
    let changed = if let Some(list) = doc.get_mut("agents").and_then(serde_json::Value::as_array_mut) {
        let before = list.len();
        list.retain(|item| item.get("pluginId").and_then(serde_json::Value::as_str) != Some(plugin_id));
        before != list.len()
    } else {
        false
    };
    if changed {
        write_home_json(&path, &doc)?;
    }
    Ok(())
}

/// 写 / 更新插件页面注册：plugin-views.json 的 views（先清掉本插件的旧条目再追加）。
/// entry 存**绝对路径**（插件目录 + 相对路径），前端据此用 asset:// 加载页面；
/// 相对路径的合法性在 parse_plugin_views 里已经校验过。
fn write_plugin_views(
    dir: &std::path::Path,
    plugin_id: &str,
    manifest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let views = parse_plugin_views(manifest);
    let path = dirs_home().join("plugin-views.json");
    let mut doc = read_home_json(&path, serde_json::json!({ "version": 1, "views": [] }));
    let list = doc
        .get_mut("views")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "plugin-views.json 里缺少 views 数组".to_string())?;
    list.retain(|item| item.get("pluginId").and_then(serde_json::Value::as_str) != Some(plugin_id));
    for view in views {
        let full = dir.join(view.entry.replace('/', std::path::MAIN_SEPARATOR_STR));
        list.push(serde_json::json!({
            "id": view.id,
            "pluginId": plugin_id,
            "title": view.title,
            "icon": view.icon,
            "order": view.order,
            "entry": full.to_string_lossy(),
        }));
    }
    write_home_json(&path, &doc)
}

/// 撤销插件页面：从 plugin-views.json 移除该插件的全部条目。
fn remove_plugin_views(plugin_id: &str) -> Result<(), String> {
    let path = dirs_home().join("plugin-views.json");
    if !path.exists() {
        return Ok(());
    }
    let mut doc = read_home_json(&path, serde_json::json!({ "version": 1, "views": [] }));
    let changed = if let Some(list) = doc.get_mut("views").and_then(serde_json::Value::as_array_mut) {
        let before = list.len();
        list.retain(|item| item.get("pluginId").and_then(serde_json::Value::as_str) != Some(plugin_id));
        before != list.len()
    } else {
        false
    };
    if changed {
        write_home_json(&path, &doc)?;
    }
    Ok(())
}

/// 注册插件声明的能力（skills / mcp / persona / subagents / views）。任一步失败返回可读中文，
/// 调用方负责回滚（unregister_plugin 按前缀/键幂等清理）。
fn register_plugin(
    dir: &std::path::Path,
    plugin_id: &str,
    manifest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    register_plugin_skills(dir, plugin_id, manifest)?;
    register_plugin_mcp(plugin_id, manifest)?;
    write_plugin_persona(plugin_id, manifest)?;
    write_plugin_subagents(plugin_id, manifest)?;
    write_plugin_views(dir, plugin_id, manifest)?;
    Ok(())
}

/// 撤销插件声明的能力。清单读不到时也能按前缀 / 键扫描清理（幂等，可反复调用）。
fn unregister_plugin(
    plugin_id: &str,
    manifest: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    if let Err(error) = unregister_plugin_skills(plugin_id, manifest) {
        errors.push(error);
    }
    if let Err(error) = unregister_plugin_mcp(plugin_id) {
        errors.push(error);
    }
    if let Err(error) = remove_plugin_persona(plugin_id) {
        errors.push(error);
    }
    if let Err(error) = remove_plugin_subagents(plugin_id) {
        errors.push(error);
    }
    if let Err(error) = remove_plugin_views(plugin_id) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("撤销插件注册失败：{}", errors.join("；")))
    }
}

/// 通知引擎重载 MCP 配置（POST /api/mcp/reload）。尽力而为：
/// engine_http_post 可能等 MCP 握手到 90 秒，所以放在后台线程，绝不阻塞命令返回。
fn reload_engine_mcp(port: u16, token: String) {
    if port == 0 || token.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        match engine_http_post(port, &token, "/api/mcp/reload", "{}") {
            Some(response) => eprintln!(
                "[coomi-desktop] mcp reload after plugin change: {}",
                summarize_http(&response)
            ),
            None => eprintln!("[coomi-desktop] mcp reload after plugin change unreachable; skipped"),
        }
    });
}

/// 从引擎状态取 port/token（引擎没起来时两者为空，reload 自动跳过）。
fn engine_connect(state: &State<'_, EngineState>) -> (u16, String) {
    (
        *state.port.lock().unwrap_or_else(|p| p.into_inner()),
        state.token.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    )
}

/// 开启 / 关闭插件：写 <home>/plugins.json，并在开启时注册声明的能力（skills / mcp /
/// persona / subagents），关闭时全部撤销 + MCP reload。缺字段的插件视为启用状态。
#[tauri::command]
fn plugin_set_enabled(state: State<'_, EngineState>, id: String, on: bool) -> Result<bool, String> {
    let id = id.trim().to_string();
    if !valid_plugin_id(&id) {
        return Err(format!("无效的插件 id：{id}"));
    }
    let plugin_dir = plugins_root().join(&id);
    if !plugin_dir.is_dir() {
        return Err(format!("插件不存在：{id}"));
    }
    let (port, token) = engine_connect(&state);
    if on {
        let manifest = read_plugin_manifest(&plugin_dir)?;
        if let Err(error) = register_plugin(&plugin_dir, &id, &manifest) {
            // 尽力回滚已写入的部分，避免留下「半注册」状态。
            let _ = unregister_plugin(&id, Some(&manifest));
            return Err(format!("启用插件失败：{error}"));
        }
    } else {
        let manifest = read_plugin_manifest(&plugin_dir).ok();
        if let Err(error) = unregister_plugin(&id, manifest.as_ref()) {
            return Err(format!("关闭插件失败：{error}"));
        }
    }
    let mut map = read_enabled_map();
    map.insert(id.clone(), serde_json::Value::Bool(on));
    save_enabled_map(&map)?;
    reload_engine_mcp(port, token);
    Ok(on)
}

/// 从文件夹安装插件：插件 id 取自 plugin.json，并校验只能含 [A-Za-z0-9_-]
/// （防路径穿越）；目标目录已存在时报「已安装」。复制失败会清掉半成品目录再报错。
/// 新安装的插件默认启用：安装完成后立即注册其声明的能力。
#[tauri::command]
fn plugin_install_dir(state: State<'_, EngineState>, dir: String) -> Result<PluginInfo, String> {
    let dir = dir.trim().to_string();
    if dir.is_empty() {
        return Err("安装失败：文件夹路径是空的".to_string());
    }
    let source = PathBuf::from(&dir);
    if !source.is_dir() {
        return Err(format!("安装失败：不是有效的文件夹：{}", source.display()));
    }
    let text = std::fs::read_to_string(source.join("plugin.json"))
        .map_err(|_| format!("安装失败：文件夹里没有 plugin.json：{}", source.display()))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("安装失败：plugin.json 不是合法 JSON：{error}"))?;
    let id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "安装失败：plugin.json 里缺少必填的 id 字段".to_string())?;
    if !valid_plugin_id(id) {
        return Err(format!("安装失败：插件 id「{id}」只能包含字母、数字、下划线（_）和连字符（-）"));
    }
    let root = plugins_root();
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("创建插件目录失败：{}（{error}）", root.display()))?;
    let target = root.join(id);
    if target.exists() {
        return Err(format!("插件已安装：{id}（如需覆盖，请先卸载再安装）"));
    }
    if let Err(error) = copy_dir_all(&source, &target) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(error);
    }
    // 新安装的插件默认启用：注册其声明的能力；注册失败则连目录一起清理。
    let manifest = read_plugin_manifest(&target)?;
    if let Err(error) = register_plugin(&target, id, &manifest) {
        let _ = unregister_plugin(id, Some(&manifest));
        let _ = std::fs::remove_dir_all(&target);
        return Err(format!("安装失败：{error}"));
    }
    let (port, token) = engine_connect(&state);
    reload_engine_mcp(port, token);
    let enabled = read_enabled_map();
    plugin_info_for_dir(&target, &enabled).ok_or_else(|| "安装完成，但读取插件信息失败".to_string())
}

/// 卸载插件：先撤销声明的能力（skills / mcp / persona / subagents + MCP reload），
/// 再删 plugins 根下的直接子目录，并清掉 plugins.json 里的启停记录。
#[tauri::command]
fn plugin_uninstall(state: State<'_, EngineState>, id: String) -> Result<(), String> {
    let id = id.trim().to_string();
    if !valid_plugin_id(&id) {
        return Err(format!("无效的插件 id：{id}"));
    }
    let root = plugins_root();
    let target = root.join(&id);
    if !target.is_dir() {
        return Err(format!("插件不存在：{id}"));
    }
    // 再保险一道：必须是 plugins 根下的**直接**子目录（id 已校验字符集，正常走不到这里）。
    if target.parent() != Some(root.as_path()) {
        return Err(format!("拒绝卸载：{id} 不是插件根目录的直接子目录"));
    }
    // 先撤销注册（清单读不到也要按前缀/键清理），再删目录。
    let manifest = read_plugin_manifest(&target).ok();
    if let Err(error) = unregister_plugin(&id, manifest.as_ref()) {
        return Err(format!("卸载失败：撤销插件注册时出错：{error}"));
    }
    let (port, token) = engine_connect(&state);
    reload_engine_mcp(port, token);
    std::fs::remove_dir_all(&target)
        .map_err(|error| format!("删除插件目录失败：{id}（{error}）"))?;
    let mut map = read_enabled_map();
    if map.remove(&id).is_some() {
        if let Err(error) = save_enabled_map(&map) {
            eprintln!("[coomi-desktop] plugin_uninstall({id}) 状态文件清理失败：{error}");
        }
    }
    Ok(())
}

/* ── v2 插件命令：插件市场（plugin_market_list）与 URL 安装（plugin_install_from_url）── */

/// 插件市场条目（plugin_market_list 的返回形态）。字段缺失一律降级为默认值，不报错。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginMarketEntry {
    id: String,
    name: String,
    version: String,
    description: String,
    download_url: String,
    author: String,
    icon: String,
}

/// 拉取插件市场清单：GET url（JSON），数组或 {plugins|items: [...]} 两种形态都认。
/// 单条字段缺失降级：id=必填（缺失跳过）、name=id、version=0.0.0、其余空串。
fn fetch_plugin_market(url: &str) -> Result<Vec<PluginMarketEntry>, String> {
    let text = http_get_text(url).or_else(|primary| release_get_fallback(url, primary))?;
    let payload: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("插件市场返回的不是合法 JSON：{error}"))?;
    let list: Vec<&serde_json::Value> = match &payload {
        serde_json::Value::Array(items) => items.iter().collect(),
        _ => json_field(&payload, &["plugins", "items", "plugins_list", "list"])
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "插件市场清单里没有可用的插件列表（期望数组或 plugins 字段）".to_string())?
            .iter()
            .collect(),
    };
    let mut entries = Vec::new();
    for item in list {
        let Some(id) = json_str(item, &["id", "plugin_id", "pluginId", "name"]) else {
            continue;
        };
        if !valid_plugin_id(&id) {
            continue;
        }
        entries.push(PluginMarketEntry {
            id: id.clone(),
            name: json_str(item, &["name", "title", "display_name", "displayName"])
                .unwrap_or_else(|| id.clone()),
            version: json_str(item, &["version", "latest_version", "latestVersion"])
                .unwrap_or_else(|| "0.0.0".to_string()),
            description: json_str(item, &["description", "desc", "summary"]).unwrap_or_default(),
            download_url: json_str(item, &["download_url", "downloadUrl", "zip_url", "zipUrl", "url", "file_url", "fileUrl"])
                .unwrap_or_default(),
            author: json_str(item, &["author", "publisher"]).unwrap_or_default(),
            icon: json_str(item, &["icon", "icon_url", "iconUrl"]).unwrap_or_default(),
        });
    }
    Ok(entries)
}

/// 插件市场列表：GET url 返回清单数组（缺字段降级，不做执行）。
#[tauri::command]
async fn plugin_market_list(url: String) -> Result<Vec<PluginMarketEntry>, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("插件市场地址无效：必须以 http:// 或 https:// 开头".to_string());
    }
    // 网络请求（curl 子进程）跑在阻塞线程池，不占 async 运行时线程。
    tauri::async_runtime::spawn_blocking(move || fetch_plugin_market(&url))
        .await
        .map_err(|error| format!("获取插件市场失败：{error}"))?
}

/// 下载二进制文件（zip）到目标路径。先 curl（-fsSL 失败即报错），失败退回 PowerShell。
fn download_file(url: &str, target: &std::path::Path) -> Result<(), String> {
    let target_str = target
        .to_str()
        .ok_or_else(|| "下载失败：目标路径包含无法转换的字符".to_string())?;
    #[cfg(target_os = "windows")]
    let result = run_capture(
        CURL_BIN,
        &[
            "-fsSL",
            "--ssl-no-revoke",
            "--connect-timeout", "10",
            "--max-time", "180",
            "-o", target_str,
            url,
        ],
    );
    #[cfg(not(target_os = "windows"))]
    let result = run_capture(
        CURL_BIN,
        &[
            "-fsSL",
            "--connect-timeout", "10",
            "--max-time", "180",
            "-o", target_str,
            url,
        ],
    );
    match result {
        Ok(_) => Ok(()),
        Err(primary) => {
            #[cfg(target_os = "windows")]
            {
                let script = format!(
                    "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri '{}' -OutFile '{}'",
                    url.replace('\'', "''"),
                    target_str.replace('\'', "''"),
                );
                run_capture(
                    "powershell.exe",
                    &["-NoProfile", "-NonInteractive", "-Command", script.as_str()],
                )
                .map(|_| ())
                .map_err(|fallback| format!("下载失败：{primary}；备用方式也失败：{fallback}"))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(format!("下载失败：{primary}"))
            }
        }
    }
}

/// 解压 zip（PowerShell Expand-Archive：壳依赖里没有 zip crate，系统自带 PS 一定有）。
fn extract_zip(zip_path: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|error| format!("创建解压目录失败：{}（{error}）", dest.display()))?;
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        zip_path.display().to_string().replace('\'', "''"),
        dest.display().to_string().replace('\'', "''"),
    );
    run_capture(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", script.as_str()],
    )
    .map(|_| ())
    .map_err(|error| format!("解压失败：{error}"))
}

/// 在解压目录里定位 plugin.json：根目录优先，其次唯一一层子目录。
fn locate_plugin_manifest_dir(extract: &std::path::Path) -> Option<std::path::PathBuf> {
    if extract.join("plugin.json").is_file() {
        return Some(extract.to_path_buf());
    }
    let mut sub: Option<std::path::PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(extract) {
        let dirs: Vec<std::path::PathBuf> = entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.path())
            .collect();
        if dirs.len() == 1 && dirs[0].join("plugin.json").is_file() {
            sub = Some(dirs[0].clone());
        }
    }
    sub
}

/// 从 zip URL 安装插件：下载 → 解压 → 校验 plugin.json → 移入 plugins/{id} → 注册。
/// 任何一步失败都清理临时目录并返回可读中文，绝不 panic。
fn install_plugin_from_url(zip_url: &str) -> Result<PluginInfo, String> {
    let root = plugins_root();
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("创建插件目录失败：{}（{error}）", root.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp = std::env::temp_dir().join(format!("coomi-plugin-{}-{nanos}", std::process::id()));
    let zip_path = temp.join("plugin.zip");
    let extract = temp.join("extract");

    // 1) 下载
    if let Err(error) = download_file(zip_url, &zip_path) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("安装失败：{error}"));
    }
    // 2) 解压
    if let Err(error) = extract_zip(&zip_path, &extract) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("安装失败：{error}"));
    }
    // 3) 定位并校验 plugin.json
    let manifest_dir = locate_plugin_manifest_dir(&extract)
        .ok_or_else(|| "安装失败：插件包里没有 plugin.json".to_string())?;
    let text = std::fs::read_to_string(manifest_dir.join("plugin.json"))
        .map_err(|error| format!("安装失败：读取 plugin.json 失败（{error}）"))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("安装失败：plugin.json 不是合法 JSON：{error}"))?;
    let id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "安装失败：plugin.json 里缺少必填的 id 字段".to_string())?;
    if !valid_plugin_id(id) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("安装失败：插件 id「{id}」只能包含字母、数字、下划线（_）和连字符（-）"));
    }
    let target = root.join(id);
    if target.exists() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("插件已安装：{id}（如需覆盖，请先卸载再安装）"));
    }
    // 4) 移入 plugins/{id}（只复制清单所在目录，不把下载临时文件带进去）
    if let Err(error) = copy_dir_all(&manifest_dir, &target) {
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&temp);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&temp);
    let enabled = read_enabled_map();
    plugin_info_for_dir(&target, &enabled).ok_or_else(|| "安装完成，但读取插件信息失败".to_string())
}

/// 从 zip URL 安装插件（下载 → 解压 → 校验 → 移入 plugins/{id} → 注册默认启用）。
/// 网络与解压都在阻塞线程池里跑，不阻塞命令返回。
#[tauri::command]
async fn plugin_install_from_url(
    state: State<'_, EngineState>,
    zip_url: String,
) -> Result<PluginInfo, String> {
    let zip_url = zip_url.trim().to_string();
    if !(zip_url.starts_with("http://") || zip_url.starts_with("https://")) {
        return Err("安装失败：下载地址无效（必须以 http:// 或 https:// 开头）".to_string());
    }
    let (port, token) = engine_connect(&state);
    let info = tauri::async_runtime::spawn_blocking(move || install_plugin_from_url(&zip_url))
        .await
        .map_err(|error| format!("安装失败：{error}"))??;
    // 新安装的插件默认启用：注册其声明的能力；注册失败则尽力回滚。
    let plugin_dir = plugins_root().join(&info.id);
    if let Ok(manifest) = read_plugin_manifest(&plugin_dir) {
        if let Err(error) = register_plugin(&plugin_dir, &info.id, &manifest) {
            let _ = unregister_plugin(&info.id, Some(&manifest));
            return Err(error);
        }
        reload_engine_mcp(port, token);
    }
    Ok(info)
}


#[tauri::command]
async fn pick_zip_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Zip 插件包", &["zip"])
            .blocking_pick_file()
            .map(|p| p.to_string())
    })
    .await
    .ok()
    .flatten()
}

/// 从**本地 zip 文件**安装插件：解压 → 定位 plugin.json（根目录或唯一一层子目录）→ 校验 → 复制进 plugins/{id} → 注册能力。
#[tauri::command]
fn plugin_install_zip(state: State<'_, EngineState>, zip_path: String) -> Result<PluginInfo, String> {
    let zip_path = zip_path.trim().to_string();
    let zip = PathBuf::from(&zip_path);
    if !zip.is_file() || !zip_path.to_lowercase().ends_with(".zip") {
        return Err("安装失败：请选择一个存在的 .zip 文件".to_string());
    }
    // 解压到插件根目录下一个临时目录，装完清理。
    let root = plugins_root();
    std::fs::create_dir_all(&root).map_err(|error| format!("创建插件目录失败：{}（{error}）", root.display()))?;
    let temp = root.join(format!(".tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    extract_zip(&zip, &temp)?;
    let manifest_dir = locate_plugin_manifest_dir(&temp)
        .ok_or_else(|| "安装失败：zip 里找不到 plugin.json（请把 plugin.json 放在 zip 根目录）".to_string())?;
    let text = std::fs::read_to_string(manifest_dir.join("plugin.json"))
        .map_err(|_| "安装失败：无法读取 plugin.json".to_string())?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("安装失败：plugin.json 不是合法 JSON：{error}"))?;
    let id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "安装失败：plugin.json 里缺少必填的 id 字段".to_string())?;
    if !valid_plugin_id(id) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("安装失败：插件 id「{id}」只能包含字母、数字、下划线（_）和连字符（-）"));
    }
    let target = root.join(id);
    if target.exists() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("插件已安装：{id}（如需覆盖，请先卸载再安装）"));
    }
    if let Err(error) = copy_dir_all(&manifest_dir, &target) {
        let _ = std::fs::remove_dir_all(&temp);
        let _ = std::fs::remove_dir_all(&target);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&temp);
    // 新安装的插件默认启用：注册声明的能力；失败则连目录一起清理。
    let manifest = read_plugin_manifest(&target)?;
    if let Err(error) = register_plugin(&target, id, &manifest) {
        let _ = unregister_plugin(id, Some(&manifest));
        let _ = std::fs::remove_dir_all(&target);
        return Err(format!("安装失败：{error}"));
    }
    let (port, token) = engine_connect(&state);
    reload_engine_mcp(port, token);
    let enabled = read_enabled_map();
    plugin_info_for_dir(&target, &enabled).ok_or_else(|| "安装完成，但读取插件信息失败".to_string())
}
/// 壳单实例锁：create_new 原子创建 %APPDATA%\Coomi\shell.lock（内含 PID）。
/// 已有实例存活时，第二份壳（双击/开机自启/托盘残留叠加）直接退出——
/// 否则两个壳各拉一个引擎，抢锁/端口，其中一个刚启动就被挤掉（「刚启动就崩溃」的真凶）。
fn ensure_single_instance() {
    let home = dirs_home();
    std::fs::create_dir_all(&home).ok();
    let lock = home.join("shell.lock");
    let pid = std::process::id();
    for _attempt in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(mut file) => {
                use std::io::Write;
                let _ = writeln!(file, "{pid}");
                return;
            }
            Err(_) => {
                let holder = std::fs::read_to_string(&lock).ok().and_then(|s| s.trim().parse::<u32>().ok());
                let alive = holder.map(|p| pid_alive(p)).unwrap_or(false);
                if alive {
                    eprintln!("[coomi-desktop] another instance is running (pid={}); exiting", holder.unwrap_or(0));
                    std::process::exit(0);
                }
                let _ = std::fs::remove_file(&lock);
            }
        }
    }
}

/// 注入进页面的连接信息：`window.__COOMI_BOOT__ = { port, token, version }`。
///
/// **为什么要有它（这是本轮最重要的一处设计修正）**：
/// 以前前端只能通过 IPC 的 `engine_info` 拿端口/令牌。IPC 一旦被系统拦掉（我们已经在
/// 真机控制台看到过 `IPC custom protocol failed: Failed to fetch`），前端拿不到端口 →
/// 请求拼成 `http://127.0.0.1:0/...` → 控制台报 ERR_UNSAFE_PORT → 界面永远「与引擎的连接已断开」，
/// 而引擎其实好得很。端口和令牌本来就是**壳自己生成的**，没有任何理由绕一圈去问。
/// 现在在页面加载前直接注入：前端即使一个壳命令都调不动，也能直接连引擎（HTTP + WebSocket）。
fn boot_script(app: &tauri::AppHandle) -> String {
    let state: State<EngineState> = app.state();
    let port = *state.port.lock().unwrap_or_else(|p| p.into_inner());
    let token = state.token.lock().unwrap_or_else(|p| p.into_inner()).clone();
    format!(
        "window.__COOMI_BOOT__ = {{ port: {port}, token: {}, version: '{}' }};",
        serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".to_string()),
        app.package_info().version
    )
}

/// 进程探活（std 实现）：tasklist 按 PID 过滤，**并且必须是 coomi-desktop 本体**。
/// 只比 PID 会被「PID 回收复用」骗到 —— 旧壳的 PID 被系统进程拿走时，新壳会以为
/// 「已有实例在跑」而**直接退出**（用户看到的就是「双击没反应 / 刚启动就没了」）。
fn pid_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .ok();
    match out {
        Some(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            text.contains(&format!("{pid}")) && text.contains("coomi-desktop")
        }
        None => false,
    }
}

fn main() {
    // 单实例：第二份壳直接退出，杜绝双壳→双引擎→刚启动就崩溃。
    ensure_single_instance();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .manage(PrefsState::default())
        // 关闭窗口默认只是隐藏到托盘：后台任务（长生成、子代理）继续跑，引擎不退出。
        // 托盘「退出」或把「关闭窗口时最小化到托盘」关掉，才走真正的退出流程。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let prefs: State<PrefsState> = app.state();
                if *prefs.close_to_tray.lock().unwrap() {
                    api.prevent_close();
                    let _ = window.hide();
                    refresh_tray_tooltip(app);
                }
            }
        })
        .setup(|app| {
            // 启动先清一次残留引擎（上次崩溃/退出留下的孤儿 coomi.exe）：
            // 不清它们会在启动瞬间和新引擎抢锁/端口，其中一个刚起来就被挤掉。
            reap_orphan_engines();
            // 偏好要在建窗口之前读出来：它决定首帧背景色，也决定关闭按钮的行为。
            {
                let prefs: State<PrefsState> = app.state();
                *prefs.close_to_tray.lock().unwrap() = read_close_to_tray();
                *prefs.autostart.lock().unwrap() = autostart_enabled();
            }
            // 窗口在代码里创建：只有这样才能按用户上次选的主题给首帧背景色，
            // 否则浅色用户会先看到一帧深色、深色用户先看到一帧白。
            let theme = read_theme();
            let background = match theme.as_deref() {
                Some("light") => tauri::window::Color(255, 254, 253, 255),
                Some("dark") => tauri::window::Color(24, 24, 24, 255),
                // 首次运行未知主题：跟随系统亮暗（Windows 下由 tao 解析）。
                _ => tauri::window::Color(255, 254, 253, 255),
            };
            // 开机自启拉起时带 --minimized：直接进托盘，不抢焦点。
            let start_hidden = std::env::args().any(|arg| arg == "--minimized");
            // **先拉引擎，再建窗口**：spawn 只是把进程拉起来、不等待就绪（耗时与建窗口同量级），
            // 但这样建窗口时端口已经确定，可以把它注入页面 —— 前端就不必再依赖 IPC 去问。
            {
                let state: State<EngineState> = app.state();
                match spawn_engine(app.handle(), &state) {
                    Ok(()) => refresh_tray_tooltip(app.handle()),
                    Err(e) => {
                        eprintln!("[coomi-desktop] engine start failed: {e}");
                        set_guard_note(app.handle(), format!("引擎启动失败：{e}"));
                    }
                }
            }
            let boot = boot_script(app.handle());
            /* 窗口尺寸按**显示器工作区**折算（2026-09-28 DPI 事故）：
               inner_size / min_inner_size 都是**逻辑像素**，而 1920×1080 在 150% 缩放下
               只有约 1280×680 逻辑像素 —— 写死的 780 高会让窗口比屏幕还高，底部
               （输入框、向下弹出的浮层、展开的运行环境列表）直接落在屏幕外。
               取「期望值」与「工作区 - 边距」的小值，并保证 min ≤ 期望值。 */
            let (work_w, work_h) = app
                .primary_monitor()
                .ok()
                .flatten()
                .or_else(|| app.available_monitors().ok().and_then(|list| list.into_iter().next()))
                .map(|monitor| {
                    let scale = monitor.scale_factor();
                    (
                        monitor.size().width as f64 / scale,
                        monitor.size().height as f64 / scale,
                    )
                })
                .unwrap_or((1920.0, 1080.0));
            let win_w = 1180.0_f64.min(work_w - 48.0).max(880.0);
            let win_h = 780.0_f64.min(work_h - 48.0).max(520.0);
            let min_w = (work_w - 80.0).clamp(720.0, 940.0).min(win_w);
            let min_h = (work_h - 80.0).clamp(460.0, 620.0).min(win_h);
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                // 页面脚本执行前注入连接信息（见 boot_script 的说明）。
                .initialization_script(boot.as_str())
                // 浏览器参数：见 webview_browser_args 的说明（本地网络访问 + 免代理）。
                .additional_browser_args(webview_browser_args())
                .title("Coomi")
                .inner_size(win_w, win_h)
                .min_inner_size(min_w, min_h)
                // 上限＝工作区：手动拉也不能拉得比屏幕还高（否则同一条「超出屏幕」的老路又回来了）。
                .max_inner_size(work_w, work_h)
                .decorations(false)
                .center()
                .visible(!start_hidden)
                .background_color(background)
                .build()?;

            // 系统托盘：没有它「隐藏到后台」就等于把自己关在门外。
            // 托盘建不起来（极罕见）时必须把「隐藏到托盘」关掉，否则窗口一关就再也叫不回来。
            let tray_ready = match setup_tray(app.handle()) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("[coomi-desktop] tray setup failed: {e}");
                    let prefs: State<PrefsState> = app.state();
                    *prefs.close_to_tray.lock().unwrap() = false;
                    false
                }
            };

            // 托盘 tooltip 周期性刷新引擎状态（端口/运行中/启动中），后台运行时也看得见。
            if tray_ready {
                let tray_handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    refresh_tray_tooltip(&tray_handle);
                });
            }


            // 引擎守护：子进程退出 → 1/2/5/10 秒退避重启 → 就绪后 emit engine:restarted。
            start_engine_supervisor(app.handle());
            // 界面报到看门狗：启动 25 秒后前端一次都没调用过壳命令，说明 WebView↔壳的命令
            // 通道也是断的（这类机器上界面只会显示「与引擎的连接已断开」，用户拿不到任何线索）。
            // 壳自己把原因查清、写到桌面并用记事本打开 —— 不依赖 WebView 的任何一个字节。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // 先给启动留足时间（引擎冷启动 + 界面首连可能十几秒），再要求
                    // **连续 3 次（每 10 秒一次）都异常**才产出诊断：
                    // 只看一眼就弹窗会把「启动稍慢」误判成故障，健康机器也会被骚扰。
                    std::thread::sleep(Duration::from_secs(45));
                    let mut strikes = 0_u8;
                    loop {
                        let state: State<EngineState> = handle.state();
                        let engine_ok = {
                            let port = *state.port.lock().unwrap_or_else(|p| p.into_inner());
                            port > 0 && diagnostics::probe(port)
                        };
                        let reported = diagnostics::frontend_reported();
                        let frontend_says_down = diagnostics::frontend_says_disconnected();
                        let reason = if !engine_ok {
                            Some("引擎端口没有在监听")
                        } else if !reported {
                            Some("界面始终没有调用过壳命令（IPC 通道断）")
                        } else if frontend_says_down {
                            Some("壳能连上引擎，但界面自报未连接（WebView 网络层被拦）")
                        } else {
                            None
                        };
                        match reason {
                            Some(reason) => {
                                strikes += 1;
                                if strikes >= 3 {
                                    log_engine_note(&format!(
                                        "环境诊断：{reason}（连续 3 次确认，见桌面 Coomi诊断.txt）"
                                    ));
                                    let _ = diagnostics::write_and_open(state.inner(), &handle);
                                    break;
                                }
                            }
                            None => strikes = 0,
                        }
                        std::thread::sleep(Duration::from_secs(10));
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_info,
            // 代前端取远端文本（技能/插件市场来源）：绕开 CSP、CORS 与 WebView 网络策略。
            fetch_remote_text,
            // 重启引擎（重启进程 + 重载 MCP）：restart_engine 是新名字，
            // engine_restart 保留给已在用它的前端；两者完全同一套语义。
            restart_engine,
            engine_restart,
            // 重启桌面壳本身（app.restart()）：先回执，后台延迟触发。
            app_restart,
            engine_stop,
            engine_log_path,
            app_version,
            data_home,
            // 更新检查：壳直连发布服务 /api/v1/info（缺字段一律在壳里降级，见 update_check）；
            // 下载 / 校验 / 安装三个是**占位签名**，本轮统一返回 not_implemented。
            update_check,
            download_update,
            verify_sha256,
            install_update,
            win_minimize,
            win_toggle_maximize,
            win_close,
            open_path,
            open_external,
            // 传输兜底：直连失败时前端改走这两个命令（HTTP 转发 + WS 桥）。
            engine_bridge::engine_http,
            // 前端报到（证明 IPC 活着）+ 手动/自动写诊断文件。
            diagnostics::frontend_hello,
            diagnostics::frontend_status,
            // 前端操作失败记录（比如「添加厂商」被引擎 400 拒了）：诊断文件里会带上现场。
            diagnostics::frontend_note,
            write_diagnostics,
            collect_diagnostics,
            engine_bridge::engine_ws_open,
            engine_bridge::engine_ws_send,
            engine_bridge::engine_ws_close,
            save_theme,
            pick_directory,
            pick_files,
            // 另存为（原生保存对话框 + 同盘 rename / 回退 copy），前端产物卡片与预览面板都在用。
            save_file_as,
            desktop_prefs,
            set_close_to_tray,
            set_autostart,
            // 插件系统（v2）：列表（含 skills/mcp/subagents/persona/slash 声明）/ 启停（注册/撤销能力）/
            // 从文件夹或 zip URL 安装 / 卸载 / 插件市场清单。数据见 %APPDATA%\Coomi\plugins。
            plugin_list,
            plugin_set_enabled,
            plugin_install_dir,
            plugin_uninstall,
            plugin_market_list,
            plugin_install_from_url,
            pick_zip_file,
            plugin_install_zip,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 壳退出必须带走引擎：否则孤儿 coomi.exe 会一直占着 home 的单实例锁
            // 与随机端口，下一次启动会看到“上一个引擎还活着”的假象。
            // （托盘「退出」会先 kill 一次，这里 take 到的是 None，重复调用无副作用。）
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_engine(app);
            }
        });
}