//! 环境自检（壳侧）：在 WebView/IPC 全都不通的情况下，也能把故障原因说清楚。
//!
//! 背景：部分机器上界面一直显示「与引擎的连接已断开」，而引擎其实是好的（壳就是它拉起来的）。
//! 我们在本机怎么都复现不了；前端能拿到的信息又全都依赖那条已经断掉的链路（fetch / IPC）。
//! 所以诊断必须放在**壳**里做：壳自己裸 TCP 探活、自己读注册表、自己写文件，再把结论
//! 落到桌面上的一个文本文件并用记事本打开 —— 用户不需要会任何命令，点开就能发给我们。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// 前端是否成功调过壳命令（IPC 是否活着）。决定诊断结论里最关键的那一条。
static FRONTEND_TALKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 前端启动时调用：证明 IPC 通了（能调到这个命令，就说明 Tauri 的命令通道没被拦）。
#[tauri::command]
pub fn frontend_hello() {
    FRONTEND_TALKED.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 前端是否报过到（启动看门狗用）。
pub fn frontend_reported() -> bool {
    FRONTEND_TALKED.load(std::sync::atomic::Ordering::SeqCst)
}

/// 前端最近一次自报状态（连接与否 / 端口 / 传输模式 / 最后错误）。
static FRONTEND_STATUS: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 前端每 10 秒上报一次：壳据此判断「界面自己认为自己连上了没有」。
#[tauri::command]
pub fn frontend_status(status: String) {
    #[cfg(debug_assertions)]
    eprintln!("[coomi-desktop] frontend status: {status}");
    FRONTEND_TALKED.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut slot) = FRONTEND_STATUS.lock() {
        *slot = status;
    }
}

/// 前端把「用户操作失败」的现场记一份（2026-09-29「添加厂商 HTTP 400」事故）。
///
/// 为什么要有它：这类错误只活在界面的一次弹窗 / 一行红字里 —— 用户复述时只剩「HTTP 400」，
/// 引擎的错误体、当时的请求参数一个都没留下，排查只能靠猜。
/// 现在前端把「哪个操作 + 脱敏后的关键字段 + 引擎原文」记成一行，诊断文件里会带上最近若干条。
static FRONTEND_NOTES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
/// 内存与文件各留多少条（太多会把诊断文件顶长）。
const FRONTEND_NOTE_LIMIT: usize = 200;

/// 记一条前端操作失败（scope ＝ 哪个操作，message ＝ 脱敏后的现场 + 引擎原文）。
#[tauri::command]
pub fn frontend_note(scope: String, message: String) {
    FRONTEND_TALKED.store(true, std::sync::atomic::Ordering::SeqCst);
    let line = format!(
        "[{}] {} {}",
        super::local_time_stamp(),
        scope.trim(),
        message.trim().replace(['\r', '\n'], " ")
    );
    if let Ok(mut notes) = FRONTEND_NOTES.lock() {
        notes.push(line.clone());
        if notes.len() > FRONTEND_NOTE_LIMIT {
            let overflow = notes.len() - FRONTEND_NOTE_LIMIT;
            notes.drain(0..overflow);
        }
    }
    // 落盘：单独一份文件（重启后还能看），只保留最后 N 行。
    let path = super::dirs_home().join("frontend-notes.log");
    let mut lines = std::fs::read_to_string(&path)
        .map(|text| text.lines().map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    lines.push(line);
    if lines.len() > FRONTEND_NOTE_LIMIT {
        let overflow = lines.len() - FRONTEND_NOTE_LIMIT;
        lines.drain(0..overflow);
    }
    let _ = std::fs::write(&path, lines.join("\n") + "\n");
}

/// 前端操作失败记录（最近 limit 条，按时间序）。诊断文本里带上它。
pub fn frontend_notes_text(limit: usize) -> String {
    if let Ok(notes) = FRONTEND_NOTES.lock()
        && !notes.is_empty()
    {
        return notes
            .iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
    }
    // 本进程内存里没有（比如刚启动）：退回读文件。
    std::fs::read_to_string(super::dirs_home().join("frontend-notes.log"))
        .map(|text| {
            text.lines()
                .rev()
                .take(limit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// 前端自报状态（诊断文本用）。
pub fn frontend_status_text() -> String {
    FRONTEND_STATUS
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

fn desktop_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|home| PathBuf::from(home).join("Desktop"))
        .filter(|path| path.is_dir())
}

/// 探活（看门狗用）。
pub fn probe(port: u16) -> bool {
    engine_listening(port)
}

/// 前端自报「未连接」（诊断报告里 frontend_status 的 connected 字段）。
pub fn frontend_says_disconnected() -> bool {
    let status = frontend_status_text();
    if status.is_empty() {
        return false;
    }
    status.contains("\"connected\":false") || status.contains("\"connected\": false")
}

fn engine_listening(port: u16) -> bool {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

fn engine_health(port: u16, token: &str) -> Option<String> {
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let request = format!(
        "GET /api/runtime/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    raw.split_once("\r\n\r\n").map(|(_, body)| body.chars().take(200).collect())
}

fn reg_query(path: &str, value: &str) -> Option<String> {
    let output = Command::new("reg")
        .args(["query", path, "/v", value])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find(|line| line.contains(value))
        .and_then(|line| line.split_whitespace().next_back())
        .map(|value| value.to_owned())
}

fn webview2_version() -> String {
    // Edge WebView2 Runtime 的版本号写在 EdgeUpdate 客户端项里。
    for path in [
        r"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"HKEY_CURRENT_USER\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ] {
        if let Some(version) = reg_query(path, "pv") {
            return version;
        }
    }
    "(未安装或读不到)".into()
}

/// 系统代理：Chromium 走的是 WinINET 设置（HKCU）。回环有没有被放行直接决定界面能不能连引擎。
fn proxy_report() -> String {
    let enabled_raw = reg_query(
        r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "ProxyEnable",
    )
    .unwrap_or_else(|| "0".into());
    let server = reg_query(
        r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "ProxyServer",
    )
    .unwrap_or_default();
    let pac = reg_query(
        r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "AutoConfigURL",
    )
    .unwrap_or_default();
    let bypass = reg_query(
        r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "ProxyOverride",
    )
    .unwrap_or_default();
    // reg 输出形如 `ProxyEnable  REG_DWORD  0x0`：0 / 0x0 / 空 都算**没开**
    // （以前这里只跟字符串 "0" 比，0x0 被当成开了 → 误报「你在用代理」）。
    let proxy_enabled = !matches!(enabled_raw.trim().to_ascii_lowercase().as_str(), "0" | "0x0" | "false" | "");
    let mut out = String::new();
    out.push_str(&format!(
        "  代理开关 ProxyEnable = {}（原始值 {}）\n",
        if proxy_enabled { "开" } else { "关" },
        enabled_raw.trim()
    ));
    out.push_str(&format!("  代理服务器 ProxyServer = {}\n", if server.is_empty() { "(无)" } else { &server }));
    out.push_str(&format!("  PAC 脚本 AutoConfigURL = {}\n", if pac.is_empty() { "(无)" } else { &pac }));
    out.push_str(&format!("  例外列表 ProxyOverride = {}\n", if bypass.is_empty() { "(无)" } else { &bypass }));
    let loopback_exempt = bypass.to_ascii_lowercase().contains("127.0.0.1")
        || bypass.to_ascii_lowercase().contains("localhost");
    // reg 输出形如 `ProxyEnable  REG_DWORD  0x0`：0 / 0x0 / 空 都算**没开**（以前这里把 0x0 当成开了，误报）。
    let proxy_enabled = !matches!(enabled_raw.trim().to_ascii_lowercase().as_str(), "0" | "0x0" | "false" | "");
    let proxying = proxy_enabled || !pac.is_empty();
    if proxying && !loopback_exempt {
        out.push_str("  ⚠ 结论：本机启用了代理/PAC，而例外里没有 127.0.0.1 —— WebView 的请求可能被送去代理，\n");
        out.push_str("            这会让「界面 → 本地引擎」整条链路失败（引擎本身是好的）。\n");
        out.push_str("            处理：把 127.0.0.1;localhost 加进代理例外，或临时关掉代理再启动。\n");
    }
    out
}

fn elevated() -> bool {
    // 不引 win32 绑定：用 whoami 的输出里有没有高完整性级别 SID 判断。
    let output = match Command::new("whoami").args(["/groups"]).output() {
        Ok(output) => output,
        Err(_) => return false,
    };
    String::from_utf8_lossy(&output.stdout).contains("S-1-16-12288")
}

/// 生成诊断文本（不写文件，便于命令直接返回给界面）。
pub fn collect(state: &super::EngineState, app: &tauri::AppHandle) -> String {
    let port = *state.port.lock().unwrap_or_else(|p| p.into_inner());
    let token = state.token.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let mut out = String::new();
    out.push_str("==== Coomi 环境诊断 ====\n");
    out.push_str(&format!("时间: {}\n", super::local_time_stamp()));
    out.push_str(&format!("应用版本: {}\n", app.package_info().version));
    out.push_str(&format!(
        "安装目录: {}\n",
        std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
    ));
    out.push_str(&format!(
        "引擎可执行文件: {}\n",
        super::engine_exe(app).map(|p| p.display().to_string()).unwrap_or_else(|| "(没找到！引擎二进制缺失)".into())
    ));
    out.push_str(&format!("引擎端口: {port}\n"));
    out.push_str(&format!("令牌: {}\n", if token.is_empty() { "(空)" } else { "(有)" }));
    out.push_str(&format!(
        "壳→引擎 裸TCP 探活: {}\n",
        if engine_listening(port) { "通" } else { "不通（引擎没在监听 / 端口不对）" }
    ));
    if let Some(body) = engine_health(port, &token) {
        out.push_str(&format!("壳→引擎 /health: {body}\n"));
    }
    out.push_str(&format!(
        "前端是否成功调用过壳命令（IPC）: {}\n",
        if FRONTEND_TALKED.load(std::sync::atomic::Ordering::SeqCst) {
            "是 —— 说明 IPC 通，问题只在 WebView 的网络请求上"
        } else {
            "否 —— 说明界面根本没能调用壳命令（IPC 也是断的）"
        }
    ));
    out.push_str(&format!("前端自报状态: {}\n", {
        let status = frontend_status_text();
        if status.is_empty() { "(从未上报)".to_string() } else { status }
    }));
    out.push_str(&format!("WebView2 版本: {}\n", webview2_version()));
    out.push_str(&format!(
        "系统: {} (build {}), 进程是否管理员: {}\n",
        reg_query(r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName").unwrap_or_default(),
        reg_query(r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber").unwrap_or_default(),
        if elevated() { "是" } else { "否" }
    ));
    out.push_str("前端操作失败记录（最近 8 条；完整见 frontend-notes.log）:\n");
    let notes = frontend_notes_text(8);
    if notes.is_empty() {
        out.push_str("  (无)\n");
    } else {
        for line in notes.lines() {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str("系统代理设置:\n");
    out.push_str(&proxy_report());
    out.push_str("\n引擎日志尾部:\n");
    let log = super::dirs_home().join("engine.log");
    if let Ok(text) = std::fs::read_to_string(&log) {
        for line in text.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev() {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str("\n【怎么读这份报告】\n");
    out.push_str("  · 探活「不通」→ 引擎/端口问题；「通」而 IPC=否 → WebView 与 IPC 双双被拦（代理或安全软件）。\n");
    out.push_str("  · 代理段出现 ⚠ → 按它写的做（把 127.0.0.1 加进例外，或临时关代理）。\n");
    out
}

/// 写诊断文件到桌面并用记事本打开（不依赖 WebView，故障时用户也能拿到结论）。
pub fn write_and_open(state: &super::EngineState, app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = desktop_dir().unwrap_or_else(|| super::dirs_home());
    let path = dir.join("Coomi诊断.txt");
    let text = collect(state, app);
    let _ = std::fs::write(&path, text.as_bytes());
    // 桌面可能被重定向到 OneDrive：两个位置都留一份，保证附件能找到。
    let backup = super::dirs_home().join("Coomi诊断.txt");
    let _ = std::fs::write(&backup, text.as_bytes());
    // 三保险地让用户看见：记事本 + 资源管理器选中该文件 + 一个原生消息框。
    let _ = Command::new("notepad").arg(&path).spawn();
    let _ = Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    let message = format!(
        "Coomi 检测到界面与本地引擎没有连上。\n\n已把环境诊断写到：\n{}\n\n（同一份也备份在引擎数据目录下的 Coomi诊断.txt）\n\n请把这个文件内容发给开发者，它能直接指出是哪一环断了。",
        path.display()
    );
    let escaped = message.replace('\'', "''");
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &format!(
                "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{escaped}', 'Coomi') | Out-Null"
            ),
        ])
        .spawn();
    Some(path)
}
