//! DeepSeek 账号客户端：登录 / 状态 / 会话 / 聊天（带 PoW）。

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::pow::{pow_header_json, solve_challenge, PowChallenge, PowSolution};

const API_BASE: &str = "https://chat.deepseek.com";

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
    pub chat_session_id: u64,
    pub chat_session_state: String,
}

const DEVICE_ID: &str = "coomi-android";

/// 密码登录。官方 2.3.1 对邮箱和手机号使用不同请求结构，不能发送 `account`。
pub async fn login(client: &Client, account: &str, password: &str) -> Result<LoginResult> {
    let account = account.trim();
    let body = if account.contains('@') {
        serde_json::json!({
            "email": account,
            "password": password,
            "device_id": DEVICE_ID,
            "os": "android"
        })
    } else {
        serde_json::json!({
            "mobile": account,
            "area_code": "+86",
            "password": password,
            "device_id": DEVICE_ID,
            "os": "android"
        })
    };
    login_request(client, "/api/v0/users/login", body).await
}

/// 请求手机号短信验证码。字段与 DeepSeek 2.3.1 的
/// CreateSmsVerificationCodeRequest 保持一致；风控需要图形验证时原样返回业务错误。
pub async fn send_sms_code(client: &Client, mobile: &str, area_code: &str) -> Result<()> {
    let full_mobile = format!("{}{}", area_code.trim(), mobile.trim())
        .replace(' ', "")
        .replace('-', "");
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
    let resp = client
        .post(format!("{API_BASE}/api/v0/users/create_sms_verification_code"))
        .header("Content-Type", "application/json")
        .header("User-Agent", "DeepSeek/2.3.1 Android")
        .json(&body)
        .send()
        .await
        .context("发送验证码请求失败")?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().await.context("解析验证码响应失败")?;
    if !status.is_success() {
        return Err(anyhow!("发送验证码失败 HTTP {status}: {value}"));
    }
    ensure_business_success(&value, "发送验证码")?;
    Ok(())
}

/// 手机号验证码登录。
pub async fn login_by_mobile_sms(
    client: &Client,
    mobile: &str,
    area_code: &str,
    code: &str,
) -> Result<LoginResult> {
    let body = serde_json::json!({
        "mobile_number": mobile.trim(),
        "sms_verification_code": code.trim(),
        "area_code": area_code.trim(),
        "device_id": DEVICE_ID,
        "os": "android"
    });
    login_request(client, "/api/v0/users/login_by_mobile_sms", body).await
}

async fn login_request(client: &Client, path: &str, body: serde_json::Value) -> Result<LoginResult> {
    let resp = client
        .post(format!("{API_BASE}{path}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", "DeepSeek/2.3.1 Android")
        .json(&body)
        .send()
        .await
        .context("登录请求失败")?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().await.context("解析登录响应失败")?;
    if !status.is_success() {
        return Err(anyhow!("登录失败 HTTP {status}: {value}"));
    }
    ensure_business_success(&value, "登录")?;
    parse_login_result(&value)
}

fn ensure_business_success(value: &serde_json::Value, action: &str) -> Result<()> {
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
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
    let resp = client
        .post(format!("{API_BASE}/api/v0/chat_session/create"))
        .header("Content-Type", "application/json")
        .header("x-auth-token", token)
        .header("User-Agent", "DeepSeek/2.3.1 Android")
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
        .or_else(|| body.pointer("/data/chat_session/id"))
        .or_else(|| body.pointer("/data/chat_session_id"));
    let session_id = value.and_then(serde_json::Value::as_u64)
        .or_else(|| value.and_then(serde_json::Value::as_str).and_then(|id| id.parse().ok()))
        .ok_or_else(|| anyhow!("会话响应无 chat_session.id: {body}"))?;
    Ok(SessionInfo {
        chat_session_id: session_id,
        chat_session_state: String::new(),
    })
}

/// 发送消息：POST /api/v0/chat/completion
/// prompt: 用户可见的整段文字（system + 历史已折叠进 prompt）
pub async fn chat_completion(
    client: &Client,
    token: &str,
    chat_session_id: u64,
    model_type: &str,
    prompt: &str,
    thinking_enabled: bool,
) -> Result<reqwest::Response> {
    let pow = solve_pow_header(client).await?;
    let solution = super::pow::solve_challenge(&pow).unwrap_or_else(|_| PowSolution {
        algorithm: pow.algorithm.clone(),
        challenge: pow.challenge.clone(),
        salt: pow.salt.clone(),
        answer: 0.0,
        signature: pow.signature.clone(),
    });
    let pow_json = pow_header_json(&solution, "/api/v0/chat/completion")?;
    let body = serde_json::json!({
        "chat_session_id": chat_session_id.to_string(),
        "parent_message_id": null,
        "prompt": prompt,
        "ref_file_ids": [],
        "thinking_enabled": thinking_enabled,
        "search_enabled": false,
        "preempt": false,
        "model_type": model_type,
    });
    client
        .post(format!("{API_BASE}/api/v0/chat/completion"))
        .header("Content-Type", "application/json")
        .header("x-auth-token", token)
        .header("User-Agent", "DeepSeek/2.3.1 Android")
        .header("X-DS-PoW-Response", pow_json)
        .json(&body)
        .send()
        .await
        .context("聊天请求失败")
}

/// 创建 PoW challenge：POST /api/v0/chat/create_pow_challenge
pub async fn create_pow_challenge(client: &Client) -> Result<PowChallenge> {
    let resp = client
        .post(format!("{API_BASE}/api/v0/chat/create_pow_challenge"))
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
pub async fn solve_pow_header(client: &Client) -> Result<PowChallenge> {
    create_pow_challenge(client).await
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
    let mut text_parts: Vec<String> = Vec::new();
    let mut reasoning_parts: Vec<String> = Vec::new();
    let mut final_value: Option<serde_json::Value> = None;
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("SSE chunk")?;
        let s = String::from_utf8_lossy(&chunk).to_string();
        for line in s.split('\n') {
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let json = &line[5..].trim();
            if json.is_empty() {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_str(json).context("解析 SSE data")?;
            // text_delta
            if let Some(s) = value.get("text_delta").and_then(serde_json::Value::as_str) {
                if !s.is_empty() {
                    text_parts.push(s.to_string());
                    observer.on_text_delta(s);
                }
            }
            // reasoning_delta (thinking)
            if let Some(s) = value.get("reasoning_delta").and_then(serde_json::Value::as_str) {
                if !s.is_empty() {
                    reasoning_parts.push(s.to_string());
                    observer.on_reasoning_delta(s);
                }
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
    // 汇总
    let combined_text = text_parts.join("");
    if !combined_text.is_empty() {
        observer.on_text_delta(&combined_text);
    }
    if combined_text.is_empty() {
        // 某些响应可能直接把 text 放在 data 里
        if let Some(ref v) = final_value {
            if let Some(t) = v.get("content").and_then(serde_json::Value::as_str) {
                if !t.is_empty() {
                    observer.on_text_delta(t);
                }
            }
        }
    }
    Ok(final_value.unwrap_or(serde_json::Value::Null))
}

#[derive(Clone)]
pub struct ChatState {
    pub chat_session_id: Option<u64>,
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