use super::super::*;
use coomi_tools::deck::runtime;

pub(crate) async fn tasks(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let home = state.home.clone();
    let tasks = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        runtime(&home)?
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .list()
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;
    Ok(Json(json!({"tasks": tasks})))
}
pub(crate) async fn create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let home = state.home.clone();
    let task = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        runtime(&home)?
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .create(
                body["title"].as_str().unwrap_or_default(),
                body["cwd"].as_str().unwrap_or_default(),
            )
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;
    Ok(Json(json!(task)))
}
pub(crate) async fn action(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let home = state.home.clone();
    let full_access = effective_permission_mode(&home, *state.permission.read().await) == PermissionMode::Full;
    // PTY startup and IO are blocking. Never occupy the HTTP runtime worker.
    let value = tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
        let rt = runtime(&home)?;
        let mut rt = rt.lock().unwrap_or_else(|p| p.into_inner());
        let terminal = body["terminal_id"].as_str().unwrap_or_default();
        match body["action"].as_str().unwrap_or_default() {
            "cli" => rt.cli_owned(&id, &body, full_access, full_access),
            "start" => Ok(json!(rt.start_owned(
                &id,
                body["profile"].as_str().unwrap_or("powershell"),
                body["rows"].as_u64().unwrap_or(30).clamp(2, 500) as u16,
                body["cols"].as_u64().unwrap_or(100).clamp(2, 500) as u16,
                full_access, full_access
            )?)),
            "control" => {
                let ready = body["ready"].as_bool().unwrap_or(false);
                rt.control(&id, terminal, ready)?;
                Ok(json!({"ok":true,"coomi_ready":ready}))
            }
            "input" => {
                rt.input(
                    &id,
                    terminal,
                    body["text"].as_str().unwrap_or_default(),
                    false,
                )?;
                Ok(json!({"ok":true}))
            }
            "reply" => {
                rt.reply_display(&id, terminal, body["text"].as_str().unwrap_or_default(), body["source_after"].as_u64().unwrap_or(0))?;
                Ok(json!({"ok":true}))
            }
            "read" => rt.read_display(&id, terminal, body["after"].as_u64().unwrap_or(0)),
            "resize" => {
                let rows = body["rows"].as_u64().unwrap_or(30).clamp(2, 500) as u16;
                let cols = body["cols"].as_u64().unwrap_or(100).clamp(2, 500) as u16;
                if body["repaint"].as_bool().unwrap_or(false) {
                    rt.resize(
                        &id,
                        terminal,
                        rows,
                        if cols == 500 { 499 } else { cols + 1 },
                    )?;
                }
                rt.resize(&id, terminal, rows, cols)?;
                Ok(json!({"ok":true}))
            }
            "close" => {
                rt.close(&id, terminal)?;
                Ok(json!({"ok":true}))
            }
            "stop" => {
                rt.stop(&id, terminal)?;
                Ok(json!({"ok":true}))
            }
            "finish" => {
                rt.finish(&id)?;
                Ok(json!({"ok":true}))
            }
            _ => anyhow::bail!("未知 Deck 操作"),
        }
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;
    Ok(Json(value))
}
