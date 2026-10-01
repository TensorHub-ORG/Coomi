//! 引擎传输桥：把「界面 → 本地引擎」的 HTTP 与 WebSocket 搬进壳里（走裸 TCP + IPC）。
//!
//! 为什么需要它：界面的请求是 WebView(Chromium) 发的，会受系统策略影响 ——
//! 系统代理/PAC、新版 Chromium 的本地网络访问检查（PNA/LNA）、安全软件对
//! msedgewebview2.exe 的网络拦截。任一条命中，表现都是「引擎活得好好的、
//! 界面却说与引擎的连接已断开」，而且**只发生在部分机器上**（我们这边怎么都复现不了）。
//! 壳自己的裸 TCP 不受这些策略影响（引擎就是它拉起来的），所以把传输挪进壳里最稳。
//!
//! 用法：前端优先走直连；直连失败时自动切到这里，并通过 engine:ws-* 事件收帧。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// WS 事件名（前端 listen 这些）。
pub const WS_OPEN: &str = "engine:ws-open";
pub const WS_MESSAGE: &str = "engine:ws-message";
pub const WS_CLOSED: &str = "engine:ws-closed";

/// 只允许桥接**本地引擎**：路径必须是 / 开头，端口由壳自己传（不接受前端指定主机）。
fn local_addr(port: u16) -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
}

/// 最小 base64（WS 握手要 Sec-WebSocket-Key；不为这一处引依赖）。
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// 伪随机字节（掩码键用）。不引 rand：时间 + 地址 + 计数器混合即可，
/// 用途只是让客户端帧的掩码不重复，不涉及安全性。
fn pseudo_random(seed: u64) -> [u8; 4] {
    let mut x = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    let mut out = [0u8; 4];
    for slot in out.iter_mut() {
        x ^= x >> 33;
        x = x.wrapping_mul(0xff51afd7ed558ccd);
        *slot = (x >> 24) as u8;
    }
    out
}

#[derive(Serialize, Clone)]
pub struct EngineHttpReply {
    pub status: u16,
    pub body: String,
}

/// 通用 HTTP：前端直连失败时的兜底通道（GET/POST/PUT/DELETE + JSON body）。
#[tauri::command]
pub fn engine_http(
    port: u16,
    token: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<EngineHttpReply, String> {
    if !path.starts_with('/') {
        return Err("path must start with /".into());
    }
    let addr = local_addr(port);
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1500))
        .map_err(|error| format!("connect failed: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(30_000)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(5_000)));
    let payload = body.unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.as_bytes().len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(payload.as_bytes()))
        .map_err(|error| format!("write failed: {error}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("read failed: {error}"))?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head_part, body_part) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status = head_part
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    Ok(EngineHttpReply {
        status,
        body: body_part.to_owned(),
    })
}

struct Bridge {
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<TcpStream>>,
}

/// 每个会话一条桥。
///
/// 以前这里只保留**一条**全局桥（"切会话即换"），于是桥模式下切换/关闭任一会话
/// 都会把别的会话的推送一起掐掉 —— 多会话并行在桥模式上根本不成立。
/// 现在按 session 各留一条，互不影响。
static BRIDGES: OnceLock<Mutex<HashMap<String, Bridge>>> = OnceLock::new();

fn bridges() -> &'static Mutex<HashMap<String, Bridge>> {
    BRIDGES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 只关掉指定会话的桥，不动别人的。
fn close_bridge(session: &str) {
    let bridge = bridges().lock().ok().and_then(|mut map| map.remove(session));
    if let Some(bridge) = bridge {
        bridge.stop.store(true, Ordering::SeqCst);
        let _ = bridge
            .writer
            .lock()
            .map(|stream| stream.shutdown(std::net::Shutdown::Both));
    }
}

/// 关掉所有桥（退出/清理用）。
fn close_all_bridges() {
    let all: Vec<Bridge> = bridges()
        .lock()
        .map(|mut map| map.drain().map(|(_, bridge)| bridge).collect())
        .unwrap_or_default();
    for bridge in all {
        bridge.stop.store(true, Ordering::SeqCst);
        let _ = bridge
            .writer
            .lock()
            .map(|stream| stream.shutdown(std::net::Shutdown::Both));
    }
}

/// 打开一条到引擎的 WS 桥（同一时刻只保留一条：切会话即换）。
#[tauri::command]
pub fn engine_ws_open(
    app: AppHandle,
    port: u16,
    token: String,
    session: String,
) -> Result<(), String> {
    // 只替换**这个会话**已有的桥；别的会话的桥保持不动。
    close_bridge(&session);
    let addr = local_addr(port);
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(2000))
        .map_err(|error| format!("connect failed: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(5_000)));
    let key = base64(&pseudo_random(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    ).repeat(4).as_slice());
    let handshake = format!(
        "GET /ws/session/{session}?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://tauri.localhost\r\n\r\n"
    );
    stream
        .write_all(handshake.as_bytes())
        .map_err(|error| format!("handshake write failed: {error}"))?;
    // 读掉握手响应头（直到空行）
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return Err("engine closed the socket during handshake".into()),
            Ok(_) => {
                head.push(byte[0]);
                if head.len() >= 4 && &head[head.len() - 4..] == b"\r\n\r\n" {
                    break;
                }
                if head.len() > 8192 {
                    return Err("handshake response too large".into());
                }
            }
            Err(error) => return Err(format!("handshake read failed: {error}")),
        }
    }
    let head_text = String::from_utf8_lossy(&head).into_owned();
    if !head_text.starts_with("HTTP/1.1 101") {
        return Err(format!(
            "engine refused the websocket upgrade: {}",
            head_text.lines().next().unwrap_or("").trim()
        ));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|e| e.to_string())?));
    {
        let mut guard = bridges().lock().map_err(|_| "bridge lock poisoned")?;
        guard.insert(
            session.clone(),
            Bridge {
                stop: Arc::clone(&stop),
                writer: Arc::clone(&writer),
            },
        );
    }
    // 事件带上 session：前端可能同时开着多条桥，必须知道这一帧属于哪个会话。
    let _ = app.emit(WS_OPEN, serde_json::json!({ "session": session }));
    // 读循环：服务器 → 客户端的帧都是未掩码的文本帧；ping 回 pong。
    std::thread::spawn(move || {
        let mut buffer: Vec<u8> = Vec::new();
        // 分片消息（continuation frame，opcode 0x0）的累积缓冲：
        // 以前 opcode 落到 `_ => {}` 直接丢，分片发来的消息会整段消失。
        let mut fragment: Vec<u8> = Vec::new();
        let mut fragment_opcode: u8 = 0;
        let mut chunk = [0u8; 8192];
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(ref error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(_) => break,
            }
            loop {
                let Some((payload, used, opcode, fin)) = take_frame(&buffer) else { break };
                buffer.drain(..used);
                match opcode {
                    0x1 | 0x2 => {
                        if fin {
                            let text = String::from_utf8_lossy(&payload).into_owned();
                            let _ = app.emit(
                                WS_MESSAGE,
                                serde_json::json!({ "session": session, "data": text }),
                            );
                        } else {
                            fragment = payload;
                            fragment_opcode = opcode;
                        }
                    }
                    // 续帧：攒够最后一片再投递。
                    0x0 => {
                        fragment.extend_from_slice(&payload);
                        if fin {
                            if fragment_opcode == 0x1 {
                                let text = String::from_utf8_lossy(&fragment).into_owned();
                                let _ = app.emit(
                                    WS_MESSAGE,
                                    serde_json::json!({ "session": session, "data": text }),
                                );
                            }
                            fragment.clear();
                            fragment_opcode = 0;
                        }
                    }
                    0x8 => {
                        let _ = app.emit(
                            WS_CLOSED,
                            serde_json::json!({ "session": session, "reason": "engine closed" }),
                        );
                        stop.store(true, Ordering::SeqCst);
                        break;
                    }
                    0x9 => {
                        let _ = write_frame(&writer, 0xA, &payload);
                    }
                    _ => {}
                }
            }
        }
        stop.store(true, Ordering::SeqCst);
        // 只摘掉**还是这一条**的桥：重连时新桥可能已经先注册上，不能把新的摘掉。
        if let Ok(mut guard) = bridges().lock()
            && let Some(existing) = guard.get(&session)
            && Arc::ptr_eq(&existing.writer, &writer)
        {
            guard.remove(&session);
        }
        let _ = app.emit(WS_CLOSED, serde_json::json!({ "session": session }));
    });
    Ok(())
}

/// 从缓冲里取一帧：返回 (负载, 消耗字节数, opcode, FIN)。不足一帧返回 None。
/// FIN 必须一起返回，否则分片消息没法判断「这一片是不是最后一片」。
fn take_frame(buffer: &[u8]) -> Option<(Vec<u8>, usize, u8, bool)> {
    if buffer.len() < 2 {
        return None;
    }
    let opcode = buffer[0] & 0x0f;
    let fin = buffer[0] & 0x80 != 0;
    let masked = buffer[1] & 0x80 != 0;
    let mut length = (buffer[1] & 0x7f) as usize;
    let mut offset = 2usize;
    if length == 126 {
        if buffer.len() < 4 {
            return None;
        }
        length = u16::from_be_bytes([buffer[2], buffer[3]]) as usize;
        offset = 4;
    } else if length == 127 {
        if buffer.len() < 10 {
            return None;
        }
        length = u64::from_be_bytes([
            buffer[2], buffer[3], buffer[4], buffer[5], buffer[6], buffer[7], buffer[8], buffer[9],
        ]) as usize;
        offset = 10;
    }
    let mask = if masked {
        if buffer.len() < offset + 4 {
            return None;
        }
        let m = [
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ];
        offset += 4;
        Some(m)
    } else {
        None
    };
    if buffer.len() < offset + length {
        return None;
    }
    let mut payload = buffer[offset..offset + length].to_vec();
    if let Some(mask) = mask {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Some((payload, offset + length, opcode, fin))
}

/// 写一帧（客户端 → 服务端必须掩码）。
fn write_frame(writer: &Arc<Mutex<TcpStream>>, opcode: u8, payload: &[u8]) -> Result<(), String> {
    let mut frame = Vec::with_capacity(payload.len() + 14);
    frame.push(0x80 | opcode);
    let mask = pseudo_random(payload.len() as u64 ^ 0x9e37_79b9_7f4a_7c15);
    if payload.len() < 126 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() < 65_536 {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index % 4]);
    }
    let mut guard = writer.lock().map_err(|_| "socket lock poisoned")?;
    guard.write_all(&frame).map_err(|error| error.to_string())
}

/// 前端发一帧（文本）。
///
/// 多路复用之后必须按会话投递；session 为空时（老前端 / 只有一条桥）回退到那条唯一的桥，
/// 保证只传 frame 的调用方仍然能用。
#[tauri::command]
pub fn engine_ws_send(frame: String, session: Option<String>) -> Result<(), String> {
    let writer = {
        let guard = bridges().lock().map_err(|_| "bridge lock poisoned")?;
        match session.as_deref().filter(|value| !value.is_empty()) {
            Some(session) => guard.get(session).map(|bridge| Arc::clone(&bridge.writer)),
            None => {
                if guard.len() == 1 {
                    guard.values().next().map(|bridge| Arc::clone(&bridge.writer))
                } else {
                    None
                }
            }
        }
    };
    let Some(writer) = writer else {
        return Err("websocket bridge is not open".into());
    };
    write_frame(&writer, 0x1, frame.as_bytes())
}

/// 前端主动关闭桥（切会话 / 退出时）。不传 session 就关掉全部。
#[tauri::command]
pub fn engine_ws_close(session: Option<String>) {
    match session.as_deref().filter(|value| !value.is_empty()) {
        Some(session) => close_bridge(session),
        None => close_all_bridges(),
    }
}
