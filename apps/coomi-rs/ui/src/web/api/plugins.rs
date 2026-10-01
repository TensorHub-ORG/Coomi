//! 插件贡献的引擎侧读取（v2 插件能力，全声明式）。
//!
//! 桌面壳在启用插件时把能力落地到 home：
//! - <home>/plugin-personas.json   —— 启用插件的 persona 提示词（personas: {pluginId: text}）；
//! - <home>/plugin-subagents.json  —— 插件子智能体模板（agents: [{id, pluginId, name, description, systemPrompt}]）；
//! - <home>/skills/{pluginId}-{skillId}/SKILL.md —— 插件技能（SkillRouter / 技能中心自动发现）；
//! - <home>/config/mcp_servers.json —— 插件 MCP 条目（键名前缀 plugin:{pluginId}，经 /api/mcp/reload 生效）。
//!
//! 这里只做读取与过滤：
//! - <home>/plugin-views.json      —— 插件页面（views: [{id, pluginId, title, icon, order, entry}]）；
//! - GET  /api/plugins/subagents     —— 插件子智能体模板（前端下拉读取）；
//! - GET  /api/plugins/views         —— 插件页面注册表（侧边栏入口，v2.1）；
//! - GET  /api/plugins/personas      —— 启用插件的 persona 提示词（供展示 / 调试）；
//! - POST /api/plugins/reindex-skills —— 立即重建 SkillRouter 索引（技能中心刷新用）。
//!
//! 所有读取都容错：文件缺失 / 坏 JSON 一律当作空结果，绝不 panic。

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::path::Path;

use coomi_engine::ChatMessage;
use coomi_engine::Role;
use coomi_engine::SessionStore;
use coomi_services::ProviderRegistry;
use coomi_tools::AgentScheduler;
use uuid::Uuid;

use crate::web::ApiError;
use crate::web::AppState;
use crate::web::load_permission_mode;
use crate::web::policy_mode_for;
use crate::web::providers_path;

/// 读启停表（<home>/plugins.json）：缺失字段视为启用（与桌面壳 plugin_list 语义一致）。
fn read_plugin_enabled(home: &Path) -> serde_json::Map<String, Value> {
    std::fs::read_to_string(home.join("plugins.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// 某插件是否启用：plugins.json 缺省视为 true。
fn plugin_enabled(enabled: &serde_json::Map<String, Value>, plugin_id: &str) -> bool {
    enabled.get(plugin_id).and_then(Value::as_bool).unwrap_or(true)
}

/// 启用且带 persona 的插件提示词列表（按插件 id 排序）。
/// 供系统提示词组装使用：每条 = (plugin_id, persona 原文)。
pub(in crate::web) fn plugin_persona_map(home: &Path) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(home.join("plugin-personas.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(personas) = value.get("personas").and_then(Value::as_object) else {
        return Vec::new();
    };
    let enabled = read_plugin_enabled(home);
    let mut out = Vec::new();
    for (plugin_id, persona) in personas {
        let persona = persona.as_str().map(str::trim).unwrap_or_default();
        if persona.is_empty() {
            continue;
        }
        if plugin_enabled(&enabled, plugin_id) {
            out.push((plugin_id.clone(), persona.to_owned()));
        }
    }
    out.sort_by(|left, right| left.0.cmp(&right.0));
    out
}

/// 启用插件的子智能体模板（<home>/plugin-subagents.json 的 agents，按启停表过滤）。
pub(in crate::web) fn plugin_subagents(home: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(home.join("plugin-subagents.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(agents) = value.get("agents").and_then(Value::as_array) else {
        return Vec::new();
    };
    let enabled = read_plugin_enabled(home);
    agents
        .iter()
        .filter(|agent| {
            let plugin_id = agent.get("pluginId").and_then(Value::as_str).unwrap_or_default();
            plugin_enabled(&enabled, plugin_id)
        })
        .cloned()
        .collect()
}

/// GET /api/plugins/subagents —— 插件子智能体模板（前端下拉读取）。
pub(in crate::web) async fn plugin_subagents_api(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "agents": plugin_subagents(&state.home) }))
}

/// 启用插件注册的**页面**（<home>/plugin-views.json 的 views，按启停表过滤、按 order 排序）。
/// v2.1：声明式插件可以在侧边栏多一个入口，页面本体是插件目录里的静态 HTML
/// （由前端用 asset:// 协议装进独立 origin 的 iframe，不给 Tauri IPC）。
pub(in crate::web) fn plugin_views(home: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(home.join("plugin-views.json")) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(views) = value.get("views").and_then(Value::as_array) else {
        return Vec::new();
    };
    let enabled = read_plugin_enabled(home);
    let mut out = views
        .iter()
        .filter(|view| {
            let plugin_id = view.get("pluginId").and_then(Value::as_str).unwrap_or_default();
            plugin_enabled(&enabled, plugin_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    out.sort_by_key(|view| view.get("order").and_then(Value::as_i64).unwrap_or(0));
    out
}

/// GET /api/plugins/views —— 插件页面注册表（前端侧边栏据此多出入口）。
pub(in crate::web) async fn plugin_views_api(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "views": plugin_views(&state.home) }))
}

/// GET /api/plugins/personas —— 启用插件的 persona 提示词（供展示 / 调试）。
pub(in crate::web) async fn plugin_personas_api(State(state): State<AppState>) -> Json<Value> {
    let personas = plugin_persona_map(&state.home)
        .into_iter()
        .map(|(plugin_id, persona)| json!({ "pluginId": plugin_id, "persona": persona }))
        .collect::<Vec<_>>();
    Json(json!({ "personas": personas }))
}

/// POST /api/plugins/reindex-skills —— 立即重建 SkillRouter 索引并落盘。
/// 桌面壳启用插件复制技能后调用，让技能中心 / 路由立刻看到新技能
/// （SkillRouter 本身每轮按需加载也会重新索引，这里提供即时刷新入口）。
pub(in crate::web) async fn plugin_reindex_skills(State(state): State<AppState>) -> Json<Value> {
    match coomi_services::SkillRouter::load(&state.home) {
        Ok(router) => Json(json!({
            "ok": true,
            "skills": router.entries().len(),
        })),
        Err(error) => Json(json!({
            "ok": false,
            "error": format!("{error:#}"),
        })),
    }
}

/// POST /api/plugins/subagents/spawn 的入参。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::web) struct PluginSubAgentSpawnRequest {
    plugin_id: String,
    template_id: String,
    session_id: Option<String>,
}

/// 从会话消息里取最新一条非内部用户提问（子智能体的任务来源；没有则回退模板字段）。
fn latest_user_task(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User && !message.internal)
        .map(|message| message.content.trim().to_owned())
        .filter(|text| !text.is_empty())
        .unwrap_or_default()
}

/// POST /api/plugins/subagents/spawn —— 按插件子智能体模板创建后台子 Agent。
///
/// 入参 {pluginId, templateId, sessionId?}：模板从 <home>/plugin-subagents.json 读取
/// （只认启用插件，与 GET /api/plugins/subagents 同一过滤）；systemPrompt 用模板的，
/// 其余参数取模板字段（name / description 拼进任务）。复用 spawn_agent 工具内部的
/// 真正创建路径（AgentScheduler::spawn → 后台 tokio 任务跑 run_agent → Agent::new），
/// 返回 {agentId}，之后可经 /api/agents 查看状态。sessionId 提供时用该会话的
/// provider/model/cwd 与父消息，否则用当前激活 provider 与引擎默认 cwd。
pub(in crate::web) async fn plugin_subagents_spawn_api(
    State(state): State<AppState>,
    Json(body): Json<PluginSubAgentSpawnRequest>,
) -> Result<Json<Value>, ApiError> {
    let plugin_id = body.plugin_id.trim().to_owned();
    let template_id = body.template_id.trim().to_owned();
    if plugin_id.is_empty() {
        return Err(ApiError::bad_request("参数缺失：pluginId 不能为空"));
    }
    if template_id.is_empty() {
        return Err(ApiError::bad_request("参数缺失：templateId 不能为空"));
    }
    // 1) 找模板（id 匹配，且属于该插件、插件已启用）。
    let template = plugin_subagents(&state.home)
        .into_iter()
        .find(|agent| {
            agent.get("pluginId").and_then(Value::as_str) == Some(plugin_id.as_str())
                && agent.get("id").and_then(Value::as_str) == Some(template_id.as_str())
        })
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "未找到插件「{plugin_id}」的子智能体模板「{template_id}」（可能插件未启用或模板不存在）"
            ))
        })?;
    let system_prompt = template
        .get("systemPrompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if system_prompt.is_empty() {
        return Err(ApiError::bad_request(format!(
            "子智能体模板「{template_id}」缺少可用的 systemPrompt"
        )));
    }
    let name = template
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::trim)
        .unwrap_or(&template_id);
    let description = template
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();

    // 2) 会话上下文：sessionId 提供时用它的 provider/model/cwd/父消息与最新提问。
    let registry = ProviderRegistry::load(&providers_path(&state.home)).map_err(ApiError::from)?;
    let mut selector: Option<String> = None;
    let mut cwd = state.cwd.clone();
    let mut parent_messages: Vec<ChatMessage> = Vec::new();
    let mut task = String::new();
    if let Some(session_id) = body.session_id.filter(|sid| !sid.trim().is_empty()) {
        let session_id = Uuid::parse_str(session_id.trim())
            .map_err(|_| ApiError::bad_request("sessionId 无效".to_string()))?;
        let store = SessionStore::new(&state.home);
        let session = store.load(session_id).map_err(|error| {
            ApiError::bad_request(format!("会话不存在或无法读取：{error:#}"))
        })?;
        if !session.provider_id.trim().is_empty() && !session.model.trim().is_empty() {
            selector = Some(format!("{}:{}", session.provider_id, session.model));
        }
        cwd = session.cwd.clone();
        parent_messages = session.messages.clone();
        task = latest_user_task(&parent_messages);
    }
    let provider = registry.resolve(selector.as_deref()).map_err(ApiError::from)?;
    if task.is_empty() {
        task = if description.is_empty() {
            format!("以插件子智能体「{name}」的身份完成任务并返回简明结果。")
        } else {
            format!("以插件子智能体「{name}」的身份执行任务：{description}")
        };
    }

    // 3) 权限沿用引擎持久化的 permissionMode（含信任档位叠加），与对话主 Agent 一致。
    let policy = policy_mode_for(&state.home, load_permission_mode(&state.home));
    // 4) 复用 spawn_agent 工具内部真正创建后台子 Agent 的路径：AgentScheduler::spawn。
    let scheduler = AgentScheduler::new(cwd, state.home.clone(), provider, policy, system_prompt.to_owned())
        .without_persistent_memory();
    let agent_id = scheduler
        .spawn(task, &parent_messages, None, None)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(json!({ "agentId": agent_id })))
}
