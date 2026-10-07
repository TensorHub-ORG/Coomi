use coomi_engine::ToolResult;
use serde_json::{json, Value};
use std::{path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};

/// File queue requests are atomically published; only Android's authorized bridge executes them.
pub async fn request(home: &std::path::Path, mut payload: Value) -> Result<Value, String> {
    let dir = home.join("control/shizuku");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let command = dir.join(format!("{id}.cmd.json"));
    let result = dir.join(format!("{id}.result.json"));
    let temp = dir.join(format!("{id}.cmd.tmp"));
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    payload["deadlineMs"] = json!(now + 10_000);
    tokio::fs::write(&temp, payload.to_string()).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&temp, &command).await.map_err(|e| e.to_string())?;
    let start = tokio::time::Instant::now();
    loop {
        if let Ok(bytes) = tokio::fs::read(&result).await {
            let _ = tokio::fs::remove_file(&result).await;
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| format!("invalid Shizuku result: {e}"))?;
            if value["ok"].as_bool() != Some(true) {
                return Err(value["error"].as_str().unwrap_or("Shizuku request failed").to_owned());
            }
            return Ok(value);
        }
        if start.elapsed() > Duration::from_secs(10) {
            let _ = tokio::fs::remove_file(&command).await;
            return Err("Shizuku 本机环境无响应，请确认引擎已启动、Shizuku 服务正在运行且已授权此应用".into());
        }
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
}

pub async fn local_shell(home: PathBuf, arguments: Value) -> ToolResult {
    let action = arguments["action"].as_str().unwrap_or("exec");
    let mut payload = arguments.clone();
    if let Some(id) = arguments["session_id"].as_str() {
        payload["session_id"] = json!(id.strip_prefix("shizuku:").unwrap_or(id));
    }
    let mut result = match request(&home, payload.clone()).await { Ok(v) => v, Err(e) => return ToolResult::error(e) };
    let id = result["session_id"].as_str().unwrap_or_default().to_owned();
    let wait = arguments["yield_time_ms"].as_u64().unwrap_or(0).min(60_000);
    let mut stdout = result["stdout"].as_str().unwrap_or("").to_owned();
    let mut stderr = result["stderr"].as_str().unwrap_or("").to_owned();
    let start = tokio::time::Instant::now();
    while result["running"].as_bool() == Some(true) && start.elapsed() < Duration::from_millis(wait) && matches!(action, "exec" | "wait" | "write") {
        tokio::time::sleep(Duration::from_millis(100)).await;
        result = match request(&home, json!({"action":"wait","session_id":id})).await { Ok(v)=>v, Err(e)=>return ToolResult::error(e) };
        stdout.push_str(result["stdout"].as_str().unwrap_or(""));
        stderr.push_str(result["stderr"].as_str().unwrap_or(""));
    }
    result["stdout"] = json!(stdout);
    result["stderr"] = json!(stderr);
    result["session_id"] = json!(format!("shizuku:{id}"));
    let text = serde_json::to_string_pretty(&result).unwrap_or_default();
    if result["running"].as_bool() == Some(false) && result["exitCode"].as_i64().unwrap_or(-1) != 0 {
        ToolResult::error(text)
    } else { ToolResult::success(text) }
}

pub async fn shell(home: PathBuf, command: String, timeout_ms: u64) -> ToolResult {
    let args = json!({"action":"exec","command":command,"timeout_ms":timeout_ms,"yield_time_ms":0});
    let mut result = match request(&home, args).await {Ok(v)=>v,Err(e)=>return ToolResult::error(e)};
    let id = result["session_id"].as_str().unwrap_or_default().to_owned();
    let start = tokio::time::Instant::now();
    let mut stdout = result["stdout"].as_str().unwrap_or("").to_owned();
    let mut stderr = result["stderr"].as_str().unwrap_or("").to_owned();
    while result["running"].as_bool() == Some(true) {
        if start.elapsed() > Duration::from_millis(timeout_ms + 2000) {
            let _ = request(&home, json!({"action":"terminate","session_id":id})).await;
            return ToolResult::error(format!("Shizuku command timed out after {timeout_ms} ms"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        result = match request(&home,json!({"action":"wait","session_id":id})).await {Ok(v)=>v,Err(e)=>return ToolResult::error(e)};
        stdout.push_str(result["stdout"].as_str().unwrap_or(""));
        stderr.push_str(result["stderr"].as_str().unwrap_or(""));
    }
    let exit = result["exitCode"].as_i64().unwrap_or(-1);
    let output = format!("{stdout}\n[stderr]\n{stderr}\nexit code: {exit}\n[environment: Android Shizuku shell]");
    if exit == 0 {ToolResult::success(output)} else {ToolResult::error(output)}
}
