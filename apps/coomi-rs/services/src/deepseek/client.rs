//! DeepSeek 账号客户端：登录 / 状态 / 会话 / 聊天（带 PoW）。

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::sync::MutexGuard;

use super::pow::{pow_header_json, PowChallenge, PowSolution};

const API_BASE: &str = "https://chat.deepseek.com";
const CLIENT_VERSION: &str = "2.3.1";
const CLIENT_USER_AGENT: &str = "DeepSeek/2.3.1 Android";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepSeekUser {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub mobile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    pub token: String,
    pub user: DeepSeekUser,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    /// 新版 DeepSeek 返回 UUID 字符串，老版本是 u64；统一按字符串保存以免解析失败。
    pub chat_session_id: String,
    pub chat_session_state: String,
    /// 服务端给出的内部模型类型（新版为 `default`）。请求 completion 时原样回传。
    #[serde(default)]
    pub model_type: String,
}

const DEVICE_ID: &str = "coomi-android";

/// 账号接口的最小请求间隔。
///
/// DeepSeek 对同一账号的密集请求很敏感：连续登录、登录后立刻建会话、同一秒内重复重试，
/// 都容易被打上异常客户端标记。这里给所有账号接口加一道共用的节流闸门，把请求节奏压到
/// 接近真人在 App 里手动操作的频率，顺带把并发请求串行化。
static REQUEST_GATE: OnceLock<Mutex<Instant>> = OnceLock::new();
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(400);
static AUTH_REQUEST_GATE: OnceLock<Mutex<()>> = OnceLock::new();
static AUTH_COOLDOWN: OnceLock<std::sync::Mutex<Option<Instant>>> = OnceLock::new();

// 用户身份验证只允许一个在途请求；不伪装客户端、不循环重试平台风控。
async fn begin_auth_request() -> Result<MutexGuard<'static, ()>> {
    let guard = AUTH_REQUEST_GATE.get_or_init(|| Mutex::new(())).lock().await;
    let remaining = AUTH_COOLDOWN.get_or_init(|| std::sync::Mutex::new(None))
        .lock().unwrap_or_else(|p| p.into_inner())
        .and_then(|until| until.checked_duration_since(Instant::now()));
    if let Some(remaining) = remaining {
        return Err(anyhow!("DeepSeek 认证请求已暂停，请等待 {} 秒后再试；持续被拒绝请在官方应用完成验证", remaining.as_secs() + 1));
    }
    Ok(guard)
}

fn note_auth_rejection(value: &serde_json::Value) {
    let global = value.get("code").and_then(serde_json::Value::as_i64).unwrap_or(0);
    let biz = value.pointer("/data/biz_code").and_then(serde_json::Value::as_i64).unwrap_or(0);
    if matches!(global, 40300 | 40301 | 40302 | 40029 | 11) || biz == 11 {
        *AUTH_COOLDOWN.get_or_init(|| std::sync::Mutex::new(None))
            .lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now() + Duration::from_secs(60));
    }
}

async fn throttle_account_request() {
    let gate = REQUEST_GATE.get_or_init(|| Mutex::new(Instant::now() - MIN_REQUEST_INTERVAL));
    let mut last = gate.lock().await;
    let elapsed = last.elapsed();
    if elapsed < MIN_REQUEST_INTERVAL {
        tokio::time::sleep(MIN_REQUEST_INTERVAL - elapsed).await;
    }
    *last = Instant::now();
}

/// 密码登录。官方 2.3.1 对邮箱和手机号使用不同请求结构，不能发送 `account`。
pub async fn login(client: &Client, account: &str, password: &str, device_id: &str) -> Result<LoginResult> {
    let _auth_guard = begin_auth_request().await?;
    throttle_account_request().await;
    let account = account.trim();
    let body = if account.contains('@') {
        serde_json::json!({
            "email": account,
            "password": password,
            "device_id": device_id,
            "os": "android"
        })
    } else {
        serde_json::json!({
            "mobile": account,
            "area_code": "+86",
            "password": password,
            "device_id": device_id,
            "os": "android"
        })
    };
    login_request(client, "/api/v0/users/login", body).await
}

/// 请求手机号短信验证码。字段与 DeepSeek 2.3.1 的
/// CreateSmsVerificationCodeRequest 保持一致。
/// 注意：`mobile_number` 必须是**不带国家码**的纯号码，服务端对 `+86...` 会直接返回
/// `INVALID_MOBILE_NUMBER`（biz_code 99），因此这里不能再拼接 area_code。
pub async fn send_sms_code(client: &Client, mobile: &str, _area_code: &str) -> Result<()> {
    let _auth_guard = begin_auth_request().await?;
    throttle_account_request().await;
    let full_mobile = mobile
        .trim()
        .replace([' ', '-'], "")
        .trim_start_matches('+')
        .to_string();
    let body = serde_json::json!({
        "mobile_number": full_mobile,
        "ticket": null,
        "locale": "zh_CN",
        "shumei_verification": null,
        "hcaptcha_token": null,
        "device_id": DEVICE_ID,
        "os": "android",
        "scenario": "login"
    });
    let resp = with_client_headers(client.post(format!("{API_BASE}/api/v0/users/create_sms_verification_code")))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("发送验证码请求失败")?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().await.context("解析验证码响应失败")?;
    note_auth_rejection(&value);
    if !status.is_success() {
        return Err(anyhow!("发送验证码失败 HTTP {status}: {value}"));
    }
    ensure_business_success(&value, "发送验证码")?;
    Ok(())
}

/// 取未登录接口需要的 guest PoW 挑战。
///
/// 只有在 `pow_header_paths` 名单里的接口（验证码登录 / 注册 / 邮件验证码…）才需要它；
/// 密码登录 `users/login` 不需要。返回的 `target_path` 是服务端口径（`/v0/...`），
/// 提交时要原样回填。
pub async fn create_guest_challenge(client: &Client, target_path: &str) -> Result<PowChallenge> {
    throttle_account_request().await;
    let resp = with_client_headers(client.post(format!("{API_BASE}/api/v0/users/create_guest_challenge")))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "target_path": target_path }))
        .send()
        .await
        .context("创建 guest challenge 请求失败")?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.context("解析 guest challenge 失败")?;
    note_auth_rejection(&body);
    if !status.is_success() {
        return Err(anyhow!("创建 guest challenge 失败 HTTP {status}: {body}"));
    }
    ensure_business_success(&body, "创建 guest challenge")?;
    let challenge = body
        .pointer("/data/biz_data/guest_challenge")
        .cloned()
        .ok_or_else(|| anyhow!("guest challenge 响应结构异常: {body}"))?;
    serde_json::from_value(challenge).context("解析 guest challenge 结构失败")
}

/// 手机号验证码登录。
///
/// 该接口在服务端的 PoW 名单里，缺 `X-DS-Guest-Pow-Response` 会直接 40300 Missing Header，
/// 值给明文 JSON 是 40302，只有 base64(JSON) 才会进入真正的校验。
pub async fn login_by_mobile_sms(
    client: &Client,
    mobile: &str,
    area_code: &str,
    code: &str,
    device_id: &str,
) -> Result<LoginResult> {
    let _auth_guard = begin_auth_request().await?;
    let path = "/api/v0/users/login_by_mobile_sms";
    let challenge = create_guest_challenge(client, path).await?;
    let solution = super::pow::solve_challenge(&challenge)
        .context("无法完成 DeepSeek 风控校验（PoW），请改用密码登录")?;
    let pow_header = super::pow::guest_pow_header_json(&solution, challenge.target_path.as_deref())?;
    let body = serde_json::json!({
        "mobile_number": mobile.trim(),
        "sms_verification_code": code.trim(),
        "area_code": area_code.trim(),
        "device_id": device_id,
        "os": "android"
    });
    login_request_with_pow(client, path, body, &pow_header).await
}

async fn login_request(client: &Client, path: &str, body: serde_json::Value) -> Result<LoginResult> {
    let resp = with_client_headers(client.post(format!("{API_BASE}{path}")))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("登录请求失败")?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().await.context("解析登录响应失败")?;
    note_auth_rejection(&value);
    if !status.is_success() {
        return Err(anyhow!("登录失败 HTTP {status}: {value}"));
    }
    ensure_business_success(&value, "登录")?;
    parse_login_result(&value)
}

/// 带 guest PoW 头的登录请求（验证码登录专用）。
async fn login_request_with_pow(
    client: &Client,
    path: &str,
    body: serde_json::Value,
    pow_header: &str,
) -> Result<LoginResult> {
    throttle_account_request().await;
    let resp = with_client_headers(client.post(format!("{API_BASE}{path}")))
        .header("Content-Type", "application/json")
        .header("X-DS-Guest-Pow-Response", pow_header)
        .json(&body)
        .send()
        .await
        .context("登录请求失败")?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().await.context("解析登录响应失败")?;
    note_auth_rejection(&value);
    if !status.is_success() {
        return Err(anyhow!("登录失败 HTTP {status}: {value}"));
    }
    ensure_business_success(&value, "验证码登录")?;
    parse_login_result(&value)
}

fn ensure_business_success(value: &serde_json::Value, action: &str) -> Result<()> {
    let global_code = value.get("code")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if global_code != 0 {
        let message = value.get("msg")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("未知错误");
        if global_code == 40002 {
            return Err(anyhow!("DeepSeek 登录已失效，请重新登录（40002）：{message}"));
        }
        // 40300/40301/40302：PoW 校验未通过（客户端校验异常）。
        if matches!(global_code, 40300 | 40301 | 40302) {
            return Err(anyhow!(
                "DeepSeek 验证失败（{global_code}：{message}）。可改用密码登录，或稍后再试。"
            ));
        }
        if global_code == 40029 || message.contains("TOO_MANY_REQUESTS") {
            return Err(anyhow!("操作过于频繁，已被 DeepSeek 限流（40029）：稍等几分钟再试。"));
        }
        // 11 = RISK_DEVICE_DETECTED：设备/客户端被判定为异常环境，通常换网络或等一会儿会恢复。
        // 设备风控：11 = RISK_DEVICE_DETECTED，通常因 device_id 或客户端头被判定为异常环境。
        if global_code == 11 || message.contains("RISK_DEVICE_DETECTED") || message.contains("device") {
            return Err(anyhow!("设备风控未通过（RISK_DEVICE_DETECTED）：请更换网络环境重试，或稍后再试。{message}"));
        }
        return Err(anyhow!("{action}失败（{global_code}）：{message}"));
    }
    let code = value.pointer("/data/biz_code")
        .or_else(|| value.get("biz_code"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if code != 0 {
        let message = value.pointer("/data/biz_msg")
            .or_else(|| value.get("biz_msg"))
            .or_else(|| value.get("msg"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("未知错误");
        // 业务码逐条翻译：这些是用户最可能撞到、也最需要明确指引的情况。
        let hint = match code {
            2 => "账号或密码不正确",
            3 => "手机号不能为空",
            11 => "设备风控未通过，请更换网络环境后重试",
            99 => "手机号格式不正确（不要带 +86 等国家码前缀）",
            _ => "",
        };
        if !hint.is_empty() {
            return Err(anyhow!("{action}失败（{code}）：{hint}"));
        }
        return Err(anyhow!("{action}失败（{code}）：{message}"));
    }
    Ok(())
}

fn parse_login_result(body: &serde_json::Value) -> Result<LoginResult> {
    let user_raw = body.pointer("/data/biz_data/user")
        .or_else(|| body.pointer("/data/user"))
        .or_else(|| body.get("user"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let token = user_raw.get("token")
        .or_else(|| body.pointer("/data/biz_data/token"))
        .or_else(|| body.pointer("/data/token"))
        .or_else(|| body.get("token"))
        .or_else(|| body.pointer("/data/biz_data/access_token"))
        .or_else(|| body.pointer("/data/access_token"))
        .or_else(|| body.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("登录响应无 token: {body}"))?;
    let email = user_raw.get("email").and_then(serde_json::Value::as_str).map(str::to_string);
    let mobile = user_raw.get("mobile_number")
        .or_else(|| user_raw.get("mobile"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let username = user_raw.get("username")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| email.clone())
        .or_else(|| mobile.clone())
        .unwrap_or_default();
    Ok(LoginResult {
        token,
        user: DeepSeekUser {
            id: user_raw.get("id").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
            username,
            email,
            mobile,
        },
    })
}

/// 创建新会话：与 DeepSeek Android 2.3.1 一致，POST /api/v0/chat_session/create。
pub async fn create_session(client: &Client, token: &str) -> Result<SessionInfo> {
    throttle_account_request().await;
    let resp = authenticated(client.post(format!("{API_BASE}/api/v0/chat_session/create")), token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .context("创建会话请求失败")?;
    let status = resp.status();
    let raw = resp.text().await.context("读取会话响应失败")?;
    let body: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("解析会话响应失败（HTTP {status}，响应：{}）", raw.chars().take(240).collect::<String>()))?;
    if !status.is_success() {
        return Err(anyhow!("创建会话失败 HTTP {status}: {body}"));
    }
    ensure_business_success(&body, "创建会话")?;
    let value = body.pointer("/data/biz_data/chat_session/id")
        .or_else(|| body.pointer("/data/biz_data/chat_session/chat_session_id"))
        .or_else(|| body.pointer("/data/chat_session/id"))
        .or_else(|| body.pointer("/data/chat_session_id"));
    // 新版返回 UUID 字符串（`"id":"50d8c226-..."`），老版本返回 u64。
    // 两种都要能解析，统一转成字符串。
    let session_id = value
        .and_then(|id| match id {
            serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .ok_or_else(|| anyhow!("会话响应无 chat_session.id: {body}"))?;
    // 新版 `model_type: "default"`，老版 `"deepseek_chat"`；缺失时回退到内部默认值。
    let model_type = body
        .pointer("/data/biz_data/chat_session/model_type")
        .or_else(|| body.pointer("/data/chat_session/model_type"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("deepseek_chat")
        .to_string();
    Ok(SessionInfo {
        chat_session_id: session_id,
        chat_session_state: String::new(),
        model_type,
    })
}

/// 用官方用户设置接口验证持久化 token。该接口只读且不创建聊天会话。
pub async fn validate_token(client: &Client, token: &str) -> Result<()> {
    throttle_account_request().await;
    let resp = authenticated(client.get(format!("{API_BASE}/api/v0/users/settings")), token)
        .send()
        .await
        .context("验证登录状态请求失败")?;
    let status = resp.status();
    let raw = resp.text().await.context("读取登录状态响应失败")?;
    let body: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("解析登录状态响应失败（HTTP {status}，响应：{}）", raw.chars().take(160).collect::<String>()))?;
    if !status.is_success() {
        return Err(anyhow!("验证登录状态失败 HTTP {status}: {body}"));
    }
    ensure_business_success(&body, "验证登录状态")
}

/// 发送消息：POST /api/v0/chat/completion
/// prompt: 用户可见的整段文字（system + 历史已折叠进 prompt）
pub async fn chat_completion(
    client: &Client,
    token: &str,
    chat_session_id: &str,
    model_type: &str,
    prompt: &str,
    thinking_enabled: bool,
    search_enabled: bool,
) -> Result<reqwest::Response> {
    throttle_account_request().await;
    let pow = solve_pow_header(client, token).await?;
    let solution = super::pow::solve_challenge(&pow).unwrap_or_else(|_| PowSolution {
        algorithm: pow.algorithm.clone(),
        challenge: pow.challenge.clone(),
        salt: pow.salt.clone(),
        answer: 0.0,
        signature: pow.signature.clone(),
    });
    let pow_json = pow_header_json(&solution, "/api/v0/chat/completion")?;
    // 账号接口使用内部 model_type；Chat/Reasoner 的区别由 thinking_enabled 控制。
    // `deepseek-chat` / `deepseek-reasoner` 是开放 API 的模型名，不能原样发给这里。
    // 新版服务端把内部默认值改成了 `default`（创建会话响应里可见），原样透传；
    // 调用方通常直接传 create_session 返回的 model_type。
    let model_type = match model_type.trim() {
        "" | "deepseek-chat" | "deepseek-reasoner" | "deepseek_chat" => "deepseek_chat",
        other => other,
    };
    let body = serde_json::json!({
        "chat_session_id": chat_session_id,
        "parent_message_id": null,
        "prompt": prompt,
        "ref_file_ids": [],
        "thinking_enabled": thinking_enabled,
        "search_enabled": search_enabled,
        "preempt": false,
        "model_type": model_type,
    });
    authenticated(client.post(format!("{API_BASE}/api/v0/chat/completion")), token)
        .header("Content-Type", "application/json")
        .header("X-DS-PoW-Response", pow_json)
        .json(&body)
        .send()
        .await
        .context("聊天请求失败")
}

/// 创建 PoW challenge：POST /api/v0/chat/create_pow_challenge
pub async fn create_pow_challenge(client: &Client, token: &str) -> Result<PowChallenge> {
    let resp = authenticated(client.post(format!("{API_BASE}/api/v0/chat/create_pow_challenge")), token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"target_path": "/api/v0/chat/completion"}))
        .send()
        .await
        .context("创建 PoW challenge 失败")?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.context("解析 challenge 失败")?;
    if !status.is_success() {
        return Err(anyhow!("challenge 创建失败 HTTP {status}: {body}"));
    }
    let challenge = &body["data"]["challenge"];
    if challenge.is_null() {
        return Err(anyhow!("challenge 响应无 challenge: {body}"));
    }
    serde_json::from_value(challenge.clone()).context("解析 challenge 结构失败")
}

/// 计算 PoW 响应头（用于聊天）
pub async fn solve_pow_header(client: &Client, token: &str) -> Result<PowChallenge> {
    create_pow_challenge(client, token).await
}

fn with_client_headers(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder
        .header("User-Agent", CLIENT_USER_AGENT)
        .header("Referer", API_BASE)
        .header("x-client-platform", "android")
        .header("x-client-version", CLIENT_VERSION)
        .header("x-client-locale", "zh_CN")
        .header("x-client-bundle-id", "com.deepseek.chat")
        .header("x-client-timezone-offset", "480")
}

fn authenticated(builder: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    let token = token.trim();
    with_client_headers(builder)
        .bearer_auth(token)
        // Android 端部分接口仍读取旧头；双头兼容官方 App 与网页版鉴权链。
        .header("x-auth-token", token)
}

#[cfg(test)]
fn authenticated_request(client: &Client, token: &str) -> reqwest::Request {
    authenticated(client.get(format!("{API_BASE}/api/v0/users/settings")), token)
        .build()
        .expect("authenticated DeepSeek request")
}

fn pow_header_json_for_login(ch: &PowChallenge) -> String {
    serde_json::to_string(&serde_json::json!({
        "algorithm": ch.algorithm,
        "challenge": ch.challenge,
        "salt": ch.salt,
        "answer": 0.0,
        "signature": ch.signature,
        "target_path": "/api/v0/users/login",
    }))
    .unwrap_or_default()
}

/// 读取 SSE 响应，提取 text_delta / reasoning_delta，通过 observer 推回
pub async fn read_chat_stream(
    resp: reqwest::Response,
    observer: &dyn coomi_engine::ModelStreamObserver,
) -> Result<serde_json::Value> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp
            .text()
            .await
            .unwrap_or_else(|_| format!("HTTP {status}").to_string());
        return Err(anyhow!("聊天 SSE 失败 HTTP {status}: {body}"));
    }
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let mut final_value: Option<serde_json::Value> = None;
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("SSE chunk")?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find('\n') {
            let line = buffer[..end].trim().to_string();
            buffer.drain(..=end);
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let json = &line[5..].trim();
            if json.is_empty() {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_str(json).context("解析 SSE data")?;
            // 官方 App 的 SSE 帧在不同版本中有三种形态：顶层 delta、data.delta，
            // 以及 completion.message.fragments[].content。统一递归提取，避免工作台
            // 只收到心跳/结束帧而没有正文。
            if let Some(s) = find_delta(&value, &["text_delta", "content_delta", "text", "content"]).filter(|s| !s.is_empty()) {
                text_parts.push(s.to_string());
                observer.on_text_delta(s);
            }
            if let Some(s) = find_delta(&value, &["reasoning_delta", "thinking_delta", "think_delta"]).filter(|s| !s.is_empty()) {
                reasoning_parts.push(s.to_string());
                observer.on_reasoning_delta(s);
            }
            // finish_reason 结束标志
            let finish = value.get("finish_reason").and_then(serde_json::Value::as_str).unwrap_or("");
            if !finish.is_empty() || value.get("done").and_then(serde_json::Value::as_bool) == Some(true) {
                final_value = Some(value);
                break;
            }
        }
        if final_value.is_some() {
            break;
        }
    }
    if let Some(data) = buffer.trim().strip_prefix("data:") {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) {
            if let Some(text) = find_delta(&value, &["text_delta", "content_delta", "text", "content"]).filter(|s| !s.is_empty()) {
                text_parts.push(text.to_string()); observer.on_text_delta(text);
            }
            if let Some(text) = find_delta(&value, &["reasoning_delta", "thinking_delta", "think_delta"]).filter(|s| !s.is_empty()) {
                reasoning_parts.push(text.to_string()); observer.on_reasoning_delta(text);
            }
        }
    }
    // 汇总
    let combined_text = text_parts.join("");
    // 每个增量已经推送过，这里只汇总，不重复发送，避免 UI 内容翻倍。
    if combined_text.is_empty() {
        // 某些响应可能直接把 text 放在 data 里
        if let Some(ref v) = final_value {
            if let Some(t) = find_delta(v, &["content", "text"]).filter(|s| !s.is_empty()) {
                if !t.is_empty() {
                    observer.on_text_delta(t);
                }
            }
        }
    }
    Ok(final_value.unwrap_or(serde_json::Value::Null))
}

fn find_delta<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(text) = object.get(*key).and_then(serde_json::Value::as_str) {
                return Some(text);
            }
        }
        for child in object.values() {
            if let Some(text) = find_delta(child, keys) {
                return Some(text);
            }
        }
    } else if let Some(items) = value.as_array() {
        for child in items {
            if let Some(text) = find_delta(child, keys) {
                return Some(text);
            }
        }
    }
    None
}

#[derive(Clone)]
pub struct ChatState {
    pub chat_session_id: Option<String>,
    pub last_message_id: u64,
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            chat_session_id: None,
            last_message_id: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn auth_rejection_stops_duplicate_requests_without_network() {
        note_auth_rejection(&serde_json::json!({"code":40301}));
        assert!(begin_auth_request().await.unwrap_err().to_string().contains("认证请求已暂停"));
        *AUTH_COOLDOWN.get().unwrap().lock().unwrap() = None;
    }

    #[test]
    fn login_token_accepts_access_token_and_trims_it() {
        let value = serde_json::json!({
            "code": 0,
            "data": { "biz_data": { "access_token": "  bearer-value  ", "user": { "id": "1" } } }
        });
        assert_eq!(parse_login_result(&value).unwrap().token, "bearer-value");
    }

    #[test]
    fn missing_token_is_rejected() {
        let value = serde_json::json!({"code": 0, "data": {"biz_data": {"user": {"id": "1"}}}});
        assert!(parse_login_result(&value).unwrap_err().to_string().contains("无 token"));
    }

    #[test]
    fn missing_token_business_code_has_login_expired_message() {
        let value = serde_json::json!({"code": 40002, "data": null, "msg": "Missing Token"});
        let error = ensure_business_success(&value, "创建会话").unwrap_err().to_string();
        assert!(error.contains("登录已失效"));
        assert!(error.contains("40002"));
    }

    #[test]
    fn authenticated_requests_have_bearer_and_android_client_headers() {
        let client = Client::new();
        let request = authenticated_request(&client, " token-value ");
        let headers = request.headers();
        assert_eq!(headers.get("authorization").unwrap(), "Bearer token-value");
        assert_eq!(headers.get("x-auth-token").unwrap(), "token-value");
        assert_eq!(headers.get("x-client-bundle-id").unwrap(), "com.deepseek.chat");
        assert_eq!(headers.get("x-client-platform").unwrap(), "android");
        assert_eq!(headers.get("x-client-version").unwrap(), CLIENT_VERSION);
        assert_eq!(headers.get("x-client-timezone-offset").unwrap(), "480");
    }
}
