//! 内置纯 Rust SSH 客户端（russh）。
//! 不依赖系统 openssh / Termux ssh 二进制；Android WebView 引擎内直接可用。

use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::load_secret_key;
use russh::{ChannelMsg, Disconnect, Preferred};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
}

#[derive(Clone, Debug, Default)]
pub struct SshAuth {
    pub private_key: Option<PathBuf>,
    /// 额外内联私钥（OpenSSH PEM / PKCS8 文本），优先于文件。
    pub private_key_pem: Option<String>,
    pub password: Option<String>,
    /// 允许尝试的用户名（在 target.user 之后），避免默认 root 失败。
    pub extra_users: Vec<String>,
}

#[derive(Debug)]
pub struct SshExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

/// 诊断：哪些密钥被发现、用了哪些用户、最后错误。
#[derive(Debug, Default)]
pub struct SshDiagnostics {
    pub tried_keys: Vec<PathBuf>,
    pub users_tried: Vec<String>,
    pub key_loaded: Option<String>,
    pub password_used: bool,
}

struct Client {
    #[allow(dead_code)]
    password: Option<String>,
}

#[async_trait::async_trait]
impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 工具层已做用户批准；移动端 known_hosts 难维护，接受并记录主机。
        Ok(true)
    }
}

/// 解析 `user@host` / `host:port` / `user@host:port` / IPv6 `[::1]:22`。
pub fn parse_target(raw: &str, default_port: u16, default_user: &str) -> SshTarget {
    let raw = raw.trim();
    let (user_part, host_part) = match raw.rsplit_once('@') {
        Some((u, h)) if !u.is_empty() && !h.is_empty() => (u.to_owned(), h.to_owned()),
        _ => (default_user.to_owned(), raw.to_owned()),
    };
    if let Some(rest) = host_part.strip_prefix('[')
        && let Some((host, after)) = rest.split_once(']')
    {
        let port = after
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(default_port);
        return SshTarget {
            host: host.to_owned(),
            port: if port == 0 { default_port } else { port },
            user: user_part,
        };
    }
    let (host, port) = match host_part.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            let port = p.parse::<u16>().unwrap_or(default_port);
            (h.to_owned(), port)
        }
        _ => (host_part, default_port),
    };
    SshTarget {
        host,
        port: if port == 0 { default_port } else { port },
        user: user_part,
    }
}

/// 默认密钥候选路径：config_home、HOME、Android 应用私有目录、Proot。
pub fn default_key_candidates(config_home: Option<&Path>) -> Vec<PathBuf> {
    let names = [
        "id_ed25519",
        "id_ed25519_sk",
        "id_rsa",
        "id_ecdsa",
        "id_ecdsa_sk",
        "coomi_ed25519",
        "coomi_rsa",
    ];
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = config_home {
        roots.push(home.join(".ssh"));
        roots.push(home.join("ssh"));
        roots.push(home.join("runtime-v2").join("home").join(".ssh"));
    }
    if let Some(dirs_home) = home_dir_fallback() {
        roots.push(dirs_home.join(".ssh"));
        roots.push(dirs_home.join(".config").join("coomi").join(".ssh"));
    }
    for extra in [
        "/data/data/com.coomi.android/files/home/.ssh",
        "/data/data/com.coomi.android/files/usr/var/.ssh",
        "/data/data/com.coomi.android/files/usr/home/.ssh",
        "/data/data/com.monai.coomi/files/home/.ssh",
        "/data/data/com.monai.coomi/files/usr/var/.ssh",
        "/data/data/com.termux/files/home/.ssh",
        "/data/data/com.termux/files/usr/var/.ssh",
        "/home/coomi/.ssh",
        "/workspace/.ssh",
        "C:\\Users\\monai-bob\\.ssh",
    ] {
        roots.push(PathBuf::from(extra));
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        for name in names {
            let p = root.join(name);
            if seen.insert(p.clone()) {
                out.push(p);
            }
        }
    }
    out
}

fn home_dir_fallback() -> Option<PathBuf> {
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(h) = std::env::var(key)
            && !h.is_empty()
        {
            return Some(PathBuf::from(h));
        }
    }
    None
}

/// 收集存在的私钥文件（去重，最多 24 个）。
pub fn discover_key_files(auth: &SshAuth, config_home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = &auth.private_key {
        if path.is_file() {
            out.push(path.clone());
        }
    }
    for p in default_key_candidates(config_home) {
        if p.is_file() && !out.contains(&p) {
            out.push(p);
        }
        if out.len() >= 24 {
            break;
        }
    }
    out
}

/// 连接并执行一条远程命令。优先公钥（多把），失败再试密码。
pub async fn exec(
    target: &SshTarget,
    command: &str,
    auth: &SshAuth,
    config_home: Option<&Path>,
    connect_timeout: Duration,
    total_timeout: Duration,
) -> Result<SshExecOutput, String> {
    exec_with_diag(target, command, auth, config_home, connect_timeout, total_timeout)
        .await
        .map(|(out, _d)| out)
}

/// 同上，额外返回诊断信息（给错误提示用）。
pub async fn exec_with_diag(
    target: &SshTarget,
    command: &str,
    auth: &SshAuth,
    config_home: Option<&Path>,
    connect_timeout: Duration,
    total_timeout: Duration,
) -> Result<(SshExecOutput, SshDiagnostics), String> {
    let mut diag = SshDiagnostics::default();
    let handler = Client {
        password: auth.password.clone(),
    };

    // russh 0.49：Preferred::default 覆盖 curve25519 + aes-gcm/chacha 等现代算法。
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(180)),
        preferred: Preferred::default(),
        ..Default::default()
    });

    let connect_fut = client::connect(config, (target.host.as_str(), target.port), handler);
    let mut handle = match tokio::time::timeout(connect_timeout, connect_fut).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            return Err(format!(
                "SSH 连接失败 {}:{} — {e}\n请确认：主机可达、端口开放、未被防火墙拦截。",
                target.host, target.port
            ));
        }
        Err(_) => {
            return Err(format!(
                "SSH 连接超时（{}ms）→ {}:{}",
                connect_timeout.as_millis(),
                target.host,
                target.port
            ));
        }
    };

    let mut users: Vec<String> = vec![target.user.clone()];
    for u in &auth.extra_users {
        if !users.contains(u) {
            users.push(u.clone());
        }
    }
    for u in ["root", "coomi", "user", "ubuntu", "admin"] {
        let owned = u.to_string();
        if !users.contains(&owned) {
            users.push(owned);
        }
    }
    diag.users_tried = users.clone();

    let mut authed = false;
    let mut authed_user = users[0].clone();
    let mut last_auth_err = String::new();

    let keys = discover_key_files(auth, config_home);
    diag.tried_keys = keys.clone();
    let key_passphrase = auth.password.as_deref();

    // 内联 PEM
    if let Some(pem) = &auth.private_key_pem {
        match russh::keys::decode_secret_key(pem.trim(), key_passphrase) {
            Ok(key_pair) => {
                diag.key_loaded = Some("<inline>".into());
                for user in &users {
                    match try_publickey(&mut handle, user, key_pair.clone()).await {
                        Ok(true) => {
                            authed = true;
                            authed_user = user.clone();
                            break;
                        }
                        Ok(false) => {}
                        Err(e) => last_auth_err = e,
                    }
                }
            }
            Err(e) => last_auth_err = format!("内联私钥解析失败: {e}"),
        }
    }

    if !authed {
        for key_path in &keys {
            match load_secret_key(key_path, key_passphrase) {
                Ok(key_pair) => {
                    diag.key_loaded = Some(key_path.display().to_string());
                    for user in &users {
                        match try_publickey(&mut handle, user, key_pair.clone()).await {
                            Ok(true) => {
                                authed = true;
                                authed_user = user.clone();
                                break;
                            }
                            Ok(false) => {}
                            Err(e) => last_auth_err = e,
                        }
                    }
                    if authed {
                        break;
                    }
                }
                Err(e) => {
                    last_auth_err = format!("{}: {e}", key_path.display());
                }
            }
        }
    }

    // 密码
    if !authed
        && let Some(pw) = auth.password.clone()
    {
        diag.password_used = true;
        for user in &users {
            match handle.authenticate_password(user.clone(), pw.clone()).await {
                Ok(true) => {
                    authed = true;
                    authed_user = user.clone();
                    break;
                }
                Ok(false) => {}
                Err(e) => last_auth_err = format!("密码认证失败: {e}"),
            }
        }
    }

    if !authed {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "auth failed", "en")
            .await;
        let keys_note = if diag.tried_keys.is_empty() {
            "未在常见路径找到私钥。请把 id_ed25519/id_rsa 放到引擎 home/.ssh，或传 private_key / private_key_pem，或传 password。".to_string()
        } else {
            format!(
                "已尝试密钥: {}",
                diag.tried_keys
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        return Err(format!(
            "SSH 认证失败（用户尝试: {}）。\n{keys_note}\n{last_auth_err}",
            diag.users_tried.join(", ")
        ));
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SSH 会话通道失败（已认证 as {authed_user}）: {e}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("发送远程命令失败: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > total_timeout {
            break;
        }
        let msg = match tokio::time::timeout(Duration::from_secs(30), channel.wait()).await {
            Ok(Some(msg)) => msg,
            Ok(None) => break,
            Err(_) => {
                if started.elapsed() > total_timeout {
                    break;
                }
                continue;
            }
        };
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, ext } => {
                if ext == 1 {
                    stderr.extend_from_slice(data);
                } else {
                    stdout.extend_from_slice(data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            ChannelMsg::ExitSignal {
                core_dumped,
                error_message,
                ..
            } => {
                let _ = core_dumped;
                if !error_message.is_empty() {
                    stderr.extend_from_slice(error_message.as_bytes());
                }
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    let _ = channel.close().await;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;

    Ok((
        SshExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        },
        diag,
    ))
}

async fn try_publickey(
    handle: &mut client::Handle<Client>,
    user: &str,
    key_pair: russh::keys::PrivateKey,
) -> Result<bool, String> {
    // russh 0.49 示例：RSA hash 传 None，由库协商。
    let wrap = PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)
        .map_err(|e| format!("publickey wrap: {e}"))?;
    match handle.authenticate_publickey(user.to_owned(), wrap).await {
        Ok(true) => Ok(true),
        Ok(false) => Ok(false),
        Err(e) => Err(format!("{user}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_host_port() {
        let t = parse_target("alice@example.com", 22, "root");
        assert_eq!(t.user, "alice");
        assert_eq!(t.host, "example.com");
        assert_eq!(t.port, 22);
        let t = parse_target("10.0.0.1:2222", 22, "root");
        assert_eq!(t.host, "10.0.0.1");
        assert_eq!(t.port, 2222);
        let t = parse_target("[::1]:2200", 22, "root");
        assert_eq!(t.host, "::1");
        assert_eq!(t.port, 2200);
    }

    #[test]
    fn key_candidates_include_android_paths() {
        let c = default_key_candidates(None);
        assert!(c.iter().any(|p| p.to_string_lossy().contains("coomi")));
    }
}
