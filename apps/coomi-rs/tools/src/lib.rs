mod agents;
mod patch;

mod processes;
mod quality;
mod ssh_client;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use coomi_catalogs::CatalogInstaller;
use coomi_engine::ApprovalHandler;
use coomi_engine::FileTransferRequest;
use coomi_engine::InputQueue;
use coomi_engine::LoopState;
use coomi_engine::LoopStatus;
use coomi_engine::PlanState;
use coomi_engine::ToolCall;
use coomi_engine::ToolResult;
use coomi_engine::ToolRuntime;
use coomi_engine::ToolSpec;
use coomi_engine::WorkflowState;
use coomi_engine::WorkflowStore;
use coomi_security::Decision;
use coomi_security::HookEvent;
use coomi_security::HookRunner;
use coomi_security::SecurityPolicy;
use coomi_services::AutoConfigIntent;
use coomi_services::LegacyTermuxBackend;
use coomi_services::McpRuntime;
use coomi_services::MemoryManager;
use coomi_services::MemoryScope;
use coomi_services::MemoryType;
use coomi_services::PathNamespace;
use coomi_services::RuntimeBackend;
use coomi_services::RuntimeBackendKind;
use coomi_services::RuntimeManager;
use coomi_services::RuntimePathMap;
use coomi_services::apply_auto_config;
use coomi_telemetry::Telemetry;
use ignore::WalkBuilder;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::process::Command;

use crate::agents::snapshots_json;
pub use crate::agents::{AgentScheduler, AgentSnapshot, ConfiguredSubAgent};
pub use crate::quality::{ToolQuality, ToolQualityConfig};
pub use crate::patch::apply_patch_for_collab;
pub use crate::processes::{ProcessManager, terminate_all_managed};

const DEFAULT_MAX_OUTPUT: usize = 48_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// 原子写文件：先写同目录临时文件再 rename，写入中途崩溃不会留下损坏的半成品文件。
async fn atomic_write_file(path: &Path, content: &str) -> std::io::Result<()> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = path.with_file_name(format!(".{file_name}.tmp.{nanos}"));
    if let Err(error) = tokio::fs::write(&tmp, content).await {
        return Err(error);
    }
    match tokio::fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(error)
        }
    }
}

/// 去掉首尾空白，并把 3 个以上连续换行压成 1 个空行（避免角色消息里出现大段空白）。
fn collapse_blank_lines(input: &str) -> String {
    let trimmed = input.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut newline_run = 0_u8;
    for ch in trimmed.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push(ch);
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out
}

fn standalone_cd_target(command: &str) -> Option<String> {
    let command = command.trim();
    if command.contains("&&")
        || command.contains(';')
        || command.contains('|')
        || command.contains('\n')
    {
        return None;
    }
    let rest = command
        .strip_prefix("cd")
        .or_else(|| command.strip_prefix("CD"))?
        .trim();
    if rest.is_empty() || !rest.starts_with('/') {
        return None;
    }
    let path = std::path::Path::new(rest);
    if path.is_dir() {
        Some(rest.to_string())
    } else {
        None
    }
}

/// 兜底的工具执行超时上限：质量层被关闭（toolEnhance=false）时仍然生效。
/// 没有它，一个卡住的工具会让整轮永不返回：进程活着、CPU 为 0、端口在听，
/// 但所有请求都排队不响应（用户侧就是「任务莫名停 + 引擎已断开 + 反复重启」）。
const FALLBACK_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub struct CoreTools {
    cwd: PathBuf,
    path_map: RuntimePathMap,
    policy: SecurityPolicy,
    skills_directory: Option<PathBuf>,
    config_home: Option<PathBuf>,
    max_output: usize,
    processes: Arc<ProcessManager>,
    plan: Arc<Mutex<Option<PlanState>>>,
    loop_state: Arc<Mutex<Option<LoopState>>>,
    agent_scheduler: Option<Arc<AgentScheduler>>,
    mcp_runtime: Option<Arc<McpRuntime>>,
    memory: Option<Arc<MemoryManager>>,
    hooks: Option<Arc<HookRunner>>,
    parent_history: Vec<coomi_engine::ChatMessage>,
    /// 协同工作台共享输入队列（agent_id → queue），供 message_agent 工具跨角色发消息。
    agent_queues: Option<Arc<Mutex<HashMap<String, Arc<InputQueue>>>>>,
    /// 当前 agent 在团队中的身份 id：message_agent 的 from 字段据此自动填写，
    /// 不依赖模型自觉填写（填错/遗忘会导致消息路由静默丢失）。
    own_agent_id: Option<String>,
    /// 查询团队文件活动日志（team_files 工具）。
    team_files_query: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,
    /// 查询团队角色实时状态（team_status 工具）。
    team_status_query: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,
    /// 拉取发给自己的消息（team_inbox 工具）。
    team_inbox_query: Option<Arc<dyn Fn(Value) -> Value + Send + Sync>>,
    /// 记录一条团队内消息（message_agent 发出后回写共享日志）。
    team_message_sink: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    /// 独立 `cd` 命令成功后回写会话工作目录。
    cwd_sink: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// 协同写互斥：(agent_id, relative_path) -> Ok(()) 或冲突错误。
    /// 用于并行/协调模式下阻止两个角色同时改同一文件。
    file_write_guard: Option<Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>>,
    /// 工具质量层（批 5）：参数校验 / 有界重试 / 超时 / 并发上限 / 结果裁剪 / 只读缓存。
    /// 为 None 时完全按旧行为执行（能力开关 toolEnhance 关闭）。
    quality: Option<Arc<ToolQuality>>,
    /// 能力开关 askUser：关闭时 `ask_user` 不出现在工具清单里（默认开）。
    ask_user: bool,
    /// 能力开关 allowSaveAsRequest：默认关，开启后 `request_save_as` 才进工具清单。
    save_as_request: bool,
}

/// shell / local_shell 的 `environment` 可选值。
///
/// Termux 与 ProotLinux **只存在于 Android**。桌面端（Windows / macOS / Linux）把它们
/// 列进工具 schema，模型就会照着调 `environment=proot` —— 而那个环境根本不存在，
/// 任务当场失败。同一条判断在 install_runtime_environment_skill 里早就有
/// （那份安卓专属指引「只对安卓安装」，见 with_config_home），工具 schema 这一侧之前漏了。
fn shell_env_choices() -> Value {
    if cfg!(target_os = "android") {
        json!(["auto", "host", "termux", "proot"])
    } else {
        json!(["auto", "host"])
    }
}
impl CoreTools {
    pub fn new(cwd: PathBuf, policy: SecurityPolicy) -> Self {
        Self {
            path_map: RuntimePathMap::new(cwd.clone()),
            cwd,
            policy,
            skills_directory: None,
            config_home: None,
            max_output: DEFAULT_MAX_OUTPUT,
            processes: Arc::new(ProcessManager::default()),
            plan: Arc::new(Mutex::new(None)),
            loop_state: Arc::new(Mutex::new(None)),
            agent_scheduler: None,
            mcp_runtime: None,
            memory: None,
            hooks: None,
            parent_history: Vec::new(),
            agent_queues: None,
            own_agent_id: None,
            team_files_query: None,
            team_status_query: None,
            team_inbox_query: None,
            team_message_sink: None,
            cwd_sink: None,
            file_write_guard: None,
            quality: None,
            // 默认值与 settings.json 的能力开关默认一致：askUser 默认开、allowSaveAsRequest 默认关。
            ask_user: true,
            save_as_request: false,
        }
    }

    /// 能力开关 askUser：控制 `ask_user` 是否出现在工具清单里。
    #[must_use]
    pub fn with_ask_user(mut self, enabled: bool) -> Self {
        self.ask_user = enabled;
        self
    }

    /// 能力开关 allowSaveAsRequest：控制 `request_save_as` 是否出现在工具清单里。
    #[must_use]
    pub fn with_save_as_request(mut self, enabled: bool) -> Self {
        self.save_as_request = enabled;
        self
    }

    /// 开启/关闭工具质量层（能力开关 toolEnhance）。开启时使用默认配置。
    #[must_use]
    pub fn with_tool_enhance(mut self, enabled: bool) -> Self {
        self.quality = enabled.then(|| Arc::new(ToolQuality::new(ToolQualityConfig::default())));
        self
    }

    /// 开启工具质量层并指定配置。
    #[must_use]
    pub fn with_tool_quality(mut self, config: ToolQualityConfig) -> Self {
        self.quality = Some(Arc::new(ToolQuality::new(config)));
        self
    }

    /// 当前工具质量层（未开启时为 None）。
    pub fn tool_quality(&self) -> Option<&Arc<ToolQuality>> {
        self.quality.as_ref()
    }

    /// 直接注入会话历史快照（context_search 的数据源）。
    /// 未显式注入时使用 with_agent_scheduler 传入的历史。
    #[must_use]
    pub fn with_conversation_history(mut self, history: Vec<coomi_engine::ChatMessage>) -> Self {
        self.parent_history = history;
        self
    }

    pub fn with_agent_queues(
        mut self,
        queues: Arc<Mutex<HashMap<String, Arc<InputQueue>>>>,
    ) -> Self {
        self.agent_queues = Some(queues);
        self
    }

    /// 记录当前 agent 的团队身份，供 message_agent 自动填写 from 字段。
    pub fn with_own_agent_id(mut self, agent_id: String) -> Self {
        self.own_agent_id = Some(agent_id);
        self
    }

    pub fn with_team_files_query(
        mut self,
        query: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Self {
        self.team_files_query = Some(query);
        self
    }

    pub fn with_team_status_query(
        mut self,
        query: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Self {
        self.team_status_query = Some(query);
        self
    }

    pub fn with_team_inbox_query(
        mut self,
        query: Arc<dyn Fn(Value) -> Value + Send + Sync>,
    ) -> Self {
        self.team_inbox_query = Some(query);
        self
    }

    pub fn with_team_message_sink(mut self, sink: Arc<dyn Fn(Value) + Send + Sync>) -> Self {
        self.team_message_sink = Some(sink);
        self
    }

    pub fn with_cwd_sink(mut self, sink: Arc<dyn Fn(String) + Send + Sync>) -> Self {
        self.cwd_sink = Some(sink);
        self
    }

    pub fn with_agent_scheduler(
        mut self,
        scheduler: Arc<AgentScheduler>,
        parent_history: Vec<coomi_engine::ChatMessage>,
    ) -> Self {
        self.agent_scheduler = Some(scheduler);
        self.parent_history = parent_history;
        self
    }

    pub fn with_session_state(
        mut self,
        plan: Option<PlanState>,
        loop_state: Option<LoopState>,
    ) -> Self {
        self.plan = Arc::new(Mutex::new(plan));
        self.loop_state = Arc::new(Mutex::new(loop_state));
        self
    }

    pub fn process_manager(&self) -> Arc<ProcessManager> {
        Arc::clone(&self.processes)
    }

    pub fn with_runtime_backend(mut self, backend: Arc<dyn RuntimeBackend>) -> Self {
        self.processes = Arc::new(ProcessManager::default().with_runtime_backend(backend));
        self
    }

    /// 注入共享的进程管理器：让上层能在取消任务时终止该工具实例启动的长进程。
    pub fn with_process_manager(mut self, manager: Arc<ProcessManager>) -> Self {
        self.processes = manager;
        self
    }

    pub fn with_skills_directory(mut self, directory: PathBuf) -> Self {
        self.skills_directory = Some(directory);
        self
    }

    /// Pin the host path for the Agent inbox directory so that imports
    /// always land in `/data/data/.../home/coomi/inbox` regardless of cwd.
    pub fn with_inbox(mut self, inbox: PathBuf) -> Self {
        self.path_map = self.path_map.with_inbox(inbox);
        self
    }

    pub fn with_config_home(mut self, home: PathBuf) -> Self {
        // runtime-environments 是「Host/Termux/ProotLinux 路由」这份安卓专属指引
        // （见 catalogs/runtime-environments.md）：桌面端（Windows / macOS / Linux）
        // 没有 Termux 与 Proot 环境，装着只会误导 Agent，故只对安卓安装。
        if cfg!(target_os = "android") {
            let _ = CatalogInstaller::new(&home).install_runtime_environment_skill();
        }
        // Bundled skill-creator is always present and enabled on first use;
        // its enabled flag remains user-controlled in config/skills.json.
        let _ = CatalogInstaller::new(&home).install_skill("skill-creator");
        let legacy = LegacyTermuxBackend::from_coomi_home(&home);
        self.policy = self.policy.clone().with_allowed_roots([
            home.join("runtime-v2").join("home"),
            home.join("runtime-v2").join("tmp"),
        ]);
        self.path_map = RuntimePathMap::new(self.cwd.clone())
            .with_runtime_root(home.join("runtime-v2"))
            .with_termux(legacy.home.clone(), legacy.prefix.clone());
        /* ── guest 后端**只对 Android 注册** ──
           桌面端（Windows / macOS / Linux）既没有 Termux 也没有 ProotLinux。
           以前这里是无条件挂一个 LegacyTermuxBackend，Proot 只是有条件地再覆盖一层；
           于是 Windows 上 environment=auto 必然命中 Termux 后端，
           shell / local_shell 就用 `/bin/sh -lc` 去起进程 —— 一个非 Windows 原生路径，
           命令要么起不来、要么行为完全不对。
           正路本来就有：ProcessManager 在后端为 None 时走 platform_shell()
           （见 processes.rs 的 runtime_shell / start），只是被这个后端永远绕开了。
           同一条平台判断在 with_config_home 上面那段 install_runtime_environment_skill 也有。 */
        let mut processes = ProcessManager::default();
        if cfg!(target_os = "android") {
            let prefix = legacy.prefix.clone();
            let legacy_home = legacy.home.clone();
            processes = processes.with_runtime_backend(Arc::new(LegacyTermuxBackend {
                prefix: prefix.clone(),
                home: legacy_home.clone(),
            }));
            if let Ok(manager) = RuntimeManager::open(&home)
                && let Ok(backend) = manager.backend(prefix, legacy_home)
                && backend.kind() == RuntimeBackendKind::ProotLinux
            {
                processes = processes.with_runtime_backend(Arc::from(backend));
            }
        }
        self.processes = Arc::new(processes);
        self.config_home = Some(home);
        self
    }

    pub fn with_mcp_runtime(mut self, runtime: Arc<McpRuntime>) -> Self {
        self.mcp_runtime = Some(runtime);
        self
    }

    pub fn with_memory(mut self, memory: Arc<MemoryManager>) -> Self {
        self.memory = Some(memory);
        self
    }

    pub fn with_hooks(mut self, hooks: Arc<HookRunner>) -> Self {
        self.hooks = Some(hooks);
        self
    }

    /// 协同工作台：写文件前的认领互斥钩子（agent_id, relative_path）。
    pub fn with_file_write_guard(
        mut self,
        guard: Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>,
    ) -> Self {
        self.file_write_guard = Some(guard);
        self
    }

    fn enforce_write_claim(&self, absolute: &Path) -> Result<(), String> {
        let Some(guard) = self.file_write_guard.as_ref() else {
            return Ok(());
        };
        let agent = self.own_agent_id.clone().unwrap_or_default();
        let rel = absolute
            .strip_prefix(&self.cwd)
            .unwrap_or(absolute)
            .to_string_lossy()
            .replace('\\', "/");
        guard(&agent, rel.trim_start_matches('/'))
    }

    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }

    async fn dispatch(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        match Self::canonical_tool_name(call.name.as_str()) {
            "read_file" => self.read_file(&call.arguments).await,
            "write_file" => self.write_file(&call.arguments).await,
            "edit_file" => self.edit_file(&call.arguments).await,
            "list_dir" => self.list_dir(&call.arguments),
            "glob_files" => self.glob_files(&call.arguments).await,
            "grep_files" | "search" => self.search(&call.arguments).await,
            "local_shell" => self.local_shell(call, approval).await,
            "shell" => self.shell(call, approval).await,
            "git_status" => self.git_status(&call.arguments).await,
            "git_diff" => self.git_diff(&call.arguments).await,
            "git_log" => self.git_log(&call.arguments).await,
            "git_commit" => self.git_commit(call, approval).await,
            "git_branch" => self.git_branch(call, approval).await,
            "apply_patch" => self.apply_patch(call, approval).await,
            "web_search" => self.web_search(&call.arguments).await,
            "fetch" | "web_fetch" => self.fetch_url(&call.arguments).await,
            "context_search" => self.context_search(&call.arguments),
            "file_search" => self.file_search(&call.arguments).await,
            "ocr_image" => self.ocr_image(call, approval).await,
            "install_ocr_deps" => self.install_ocr_deps(call, approval).await,
            "ssh_exec" => self.ssh_exec(call, approval).await,
            "view_image" => self.view_image(&call.arguments).await,
            "show_image" => self.show_image(&call.arguments).await,
            "extract_video_frames" => self.extract_video_frames(&call.arguments).await,
            "request_user_input" => self.request_user_input(&call.arguments, approval).await,
            "ask_user" => self.ask_user(&call.arguments, approval).await,
            "request_save_as" => self.request_save_as(call, approval).await,
            "request_file_import" => self.request_file_transfer(call, approval, "import").await,
            "request_file_export" => self.request_file_transfer(call, approval, "export").await,
            "update_plan" => self.update_plan(&call.arguments),
            "create_loop" => self.create_loop(&call.arguments),
            "get_loop" => self.get_loop(),
            "update_loop" => self.update_loop(&call.arguments),
            "spawn_agent" => self.spawn_agent(&call.arguments).await,
            "wait_agent" => self.wait_agent(&call.arguments).await,
            "close_agent" => self.close_agent(&call.arguments).await,
            "message_agent" => self.message_agent(&call.arguments).await,
            "team_files" => self.team_files(&call.arguments).await,
            "team_status" => self.team_status(&call.arguments).await,
            "team_inbox" => self.team_inbox(&call.arguments).await,
            "claim_task" => self.claim_task(call, approval).await,
            "list_claims" => self.list_claims().await,
            "wait_for_file" => self.wait_for_file(&call.arguments).await,
            "list_skills" => self.list_skills(),
            "read_skill" => self.read_skill(&call.arguments).await,
            "list_workflows" => self.list_workflows(),
            "create_workflow" => self.create_workflow(&call.arguments),
            "get_workflow" => self.get_workflow(&call.arguments),
            "save_workflow" => self.save_workflow(&call.arguments),
            "delete_workflow" => self.delete_workflow(&call.arguments),
            "runtime_doctor" => self.runtime_doctor().await,
            "memory_list" => self.memory_list(),
            "memory_read" => self.memory_read(&call.arguments),
            "memory_search" => self.memory_search(&call.arguments),
            "memory_write" => self.memory_write(call, approval).await,
            "memory_delete" => self.memory_delete(call, approval).await,
            "configure_mcp" => self.configure_mcp(call, approval).await,
            "list_mcp" => self.list_mcp(),
            "install_skill" => self.install_skill(call, approval).await,
            "uninstall_mcp" => self.uninstall_mcp(call, approval).await,
            "uninstall_skill" => self.uninstall_skill(call, approval).await,
            _ => {
                if let Some(runtime) = &self.mcp_runtime
                    && let Some(result) = runtime.call(&call.name, call.arguments.clone()).await
                {
                    return result;
                }
                ToolResult::error(format!("unknown tool: {}", call.name))
            }
        }
    }

    async fn configure_mcp(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(home) = &self.config_home else {
            return ToolResult::error("Coomi configuration directory is not available");
        };
        if !approval
            .approve(
                call,
                "configure_mcp will modify the Coomi MCP configuration",
            )
            .await
        {
            return ToolResult::error("MCP configuration was not approved");
        }
        if let Some(catalog_id) = string_arg(&call.arguments, "catalog_id") {
            let values = call
                .arguments
                .get("values")
                .and_then(Value::as_object)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_owned()))
                        })
                        .collect::<std::collections::BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            return match CatalogInstaller::new(home).install_mcp(catalog_id, &values) {
                Ok(path) => {
                    if let Some(runtime) = &self.mcp_runtime {
                        runtime.reload(home).await;
                    }
                    ToolResult::success(format!(
                        "Configured catalog MCP `{catalog_id}` at {}",
                        path.display()
                    ))
                }
                Err(error) => ToolResult::error(format!("{error:#}")),
            };
        }

        let Some(name) = string_arg(&call.arguments, "name") else {
            return ToolResult::error("missing string argument: name or catalog_id");
        };
        let Some(config) = call.arguments.get("config").cloned() else {
            return ToolResult::error("missing object argument: config");
        };
        if !config.is_object() {
            return ToolResult::error("config must be an MCP server object");
        }
        match apply_auto_config(
            home,
            AutoConfigIntent::Mcp(json!({"servers": {name: config}})),
        )
        .await
        {
            Ok(result) => {
                if let Some(runtime) = &self.mcp_runtime {
                    runtime.reload(home).await;
                }
                ToolResult::success(result.message)
            }
            Err(error) => ToolResult::error(format!("{error:#}")),
        }
    }

    async fn install_skill(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(home) = &self.config_home else {
            return ToolResult::error("Coomi configuration directory is not available");
        };
        if !approval
            .approve(
                call,
                "install_skill will download or copy files into the Coomi Skill directory",
            )
            .await
        {
            return ToolResult::error("Skill installation was not approved");
        }
        if let Some(catalog_id) = string_arg(&call.arguments, "catalog_id") {
            let catalog_id = catalog_id.to_owned();
            let home = home.clone();
            return match tokio::task::spawn_blocking(move || {
                CatalogInstaller::new(home).install_skill(&catalog_id)
            })
            .await
            {
                Ok(Ok(path)) => {
                    ToolResult::success(format!("Installed catalog Skill at {}", path.display()))
                }
                Ok(Err(error)) => ToolResult::error(format!("{error:#}")),
                Err(error) => ToolResult::error(format!("Skill install task failed: {error}")),
            };
        }
        let Some(source) = string_arg(&call.arguments, "source") else {
            return ToolResult::error("missing string argument: source or catalog_id");
        };
        match apply_auto_config(home, AutoConfigIntent::Skill(source.to_owned())).await {
            Ok(result) => ToolResult::success(result.message),
            Err(error) => ToolResult::error(format!("{error:#}")),
        }
    }

    /// 卸载 Skill（彻底删除：目录 + 配置记录）。与 install_skill 对应——
    /// 需求：AI 自行卸载 = 彻底删除（管理页的卸载才是停用）。
    async fn uninstall_skill(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(home) = &self.config_home else {
            return ToolResult::error("Coomi configuration directory is not available");
        };
        if !approval
            .approve(
                call,
                "uninstall_skill will permanently delete the Skill directory and its configuration",
            )
            .await
        {
            return ToolResult::error("Skill uninstall was not approved");
        }
        let Some(name) = string_arg(&call.arguments, "name") else {
            return ToolResult::error("missing string argument: name");
        };
        match coomi_services::remove_installed_skill(home, name) {
            Ok(()) => ToolResult::success(format!(
                "Uninstalled Skill `{name}`: directory and configuration removed"
            )),
            Err(error) => ToolResult::error(format!("{error:#}")),
        }
    }

    /// 卸载 MCP server（彻底删除：移除 config/mcp_servers.json 条目）。
    /// 与 configure_mcp 对应——AI 自行卸载 = 彻底删除。
    async fn uninstall_mcp(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(home) = &self.config_home else {
            return ToolResult::error("Coomi configuration directory is not available");
        };
        if !approval
            .approve(
                call,
                "uninstall_mcp will permanently remove the MCP server configuration",
            )
            .await
        {
            return ToolResult::error("MCP uninstall was not approved");
        }
        let Some(name) = string_arg(&call.arguments, "name") else {
            return ToolResult::error("missing string argument: name");
        };
        match coomi_services::remove_configured_mcp(home, name) {
            Ok(()) => {
                if let Some(runtime) = &self.mcp_runtime {
                    runtime.reload(home).await;
                }
                ToolResult::success(format!(
                    "Uninstalled MCP server `{name}`: configuration removed"
                ))
            }
            Err(error) => ToolResult::error(format!("{error:#}")),
        }
    }

    async fn spawn_agent(&self, arguments: &Value) -> ToolResult {
        let Some(scheduler) = &self.agent_scheduler else {
            return ToolResult::error("agent scheduler is not configured");
        };
        let Some(task) = string_arg(arguments, "task") else {
            return ToolResult::error("missing string argument: task");
        };
        let fork_turns = string_arg(arguments, "fork_turns");
        let sub_agent_id = string_arg(arguments, "sub_agent_id");
        match scheduler
            .spawn(
                task.to_owned(),
                &self.parent_history,
                fork_turns,
                sub_agent_id,
            )
            .await
        {
            Ok(id) => ToolResult::success(format!("agent_id: {id}")),
            Err(error) => ToolResult::error(error),
        }
    }

    async fn wait_agent(&self, arguments: &Value) -> ToolResult {
        let Some(scheduler) = &self.agent_scheduler else {
            return ToolResult::error("agent scheduler is not configured");
        };
        let ids = arguments
            .get("ids")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let timeout_ms = u64_arg(arguments, "timeout_ms").unwrap_or(30_000);
        let snapshots = scheduler.wait(&ids, timeout_ms).await;
        ToolResult::success(
            serde_json::to_string_pretty(&snapshots_json(&snapshots))
                .unwrap_or_else(|_| "[]".into()),
        )
    }

    async fn close_agent(&self, arguments: &Value) -> ToolResult {
        let Some(scheduler) = &self.agent_scheduler else {
            return ToolResult::error("agent scheduler is not configured");
        };
        let Some(id) = string_arg(arguments, "id") else {
            return ToolResult::error("missing string argument: id");
        };
        match scheduler.close(id).await {
            Ok(snapshot) => ToolResult::success(
                serde_json::to_string_pretty(&snapshots_json(&[snapshot]))
                    .unwrap_or_else(|_| "[]".into()),
            ),
            Err(error) => ToolResult::error(error),
        }
    }

    /// 给另一个角色发消息：推入其输入队列，对方在模型/工具边界接收并继续执行。
    async fn message_agent(&self, arguments: &Value) -> ToolResult {
        let Some(queues) = &self.agent_queues else {
            return ToolResult::error("inter-agent messaging is not configured");
        };
        let Some(agent_id) = string_arg(arguments, "agent_id") else {
            return ToolResult::error("missing string argument: agent_id");
        };
        let Some(raw_content) = string_arg(arguments, "content") else {
            return ToolResult::error("missing string argument: content");
        };
        let content = collapse_blank_lines(raw_content);
        if content.is_empty() {
            return ToolResult::error("content must not be empty");
        }
        // from 字段优先使用引擎注入的当前 agent 身份，忽略模型可能填错/遗忘的值。
        let from = self
            .own_agent_id
            .as_deref()
            .or_else(|| string_arg(arguments, "from"))
            .unwrap_or("teammate");
        let queue = {
            let map = queues
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            map.get(agent_id).cloned()
        };
        match queue {
            Some(queue) => {
                queue.push(format!(
                    "<teammate_message from=\"{from}\">\n{content}\n</teammate_message>"
                ));
                if let Some(sink) = &self.team_message_sink {
                    sink(json!({
                        "from": from,
                        "to": agent_id,
                        "content": content,
                    }));
                }
                ToolResult::success(format!("message delivered to {agent_id}"))
            }
            None => ToolResult::error(format!("unknown agent: {agent_id}")),
        }
    }

    /// 查询团队文件活动日志：谁创建/下载/读取/写入了哪些文件。
    async fn team_files(&self, arguments: &Value) -> ToolResult {
        let Some(query) = &self.team_files_query else {
            return ToolResult::error("team file log is not configured");
        };
        let result = query(json!({
            "agent_id": string_arg(arguments, "agent_id").unwrap_or(""),
            "path": string_arg(arguments, "path").unwrap_or(""),
            "action": string_arg(arguments, "action").unwrap_or(""),
            "limit": u64_arg(arguments, "limit").unwrap_or(50),
        }));
        ToolResult::success(
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| "[]".to_string()),
        )
    }

    /// 窥探某个/所有角色正在干什么：状态、最近输出、最近工具调用、最近文件活动。
    async fn team_status(&self, arguments: &Value) -> ToolResult {
        let Some(query) = &self.team_status_query else {
            return ToolResult::error("team status is not configured");
        };
        let result = query(json!({
            "agent_id": string_arg(arguments, "agent_id").unwrap_or(""),
        }));
        ToolResult::success(
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string()),
        )
    }

    /// 拉取发给自己的团队消息（并可标记已读）。
    async fn team_inbox(&self, arguments: &Value) -> ToolResult {
        let Some(query) = &self.team_inbox_query else {
            return ToolResult::error("team inbox is not configured");
        };
        let result = query(json!({
            "agent_id": self.own_agent_id.as_deref().unwrap_or(""),
            "mark_read": arguments.get("mark_read").and_then(Value::as_bool).unwrap_or(true),
        }));
        ToolResult::success(
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| "[]".to_string()),
        )
    }

    /// 认领协作计划中的子任务，写入 `.coomi/collab/claims.md`（追加）。
    /// 与 write claim 不同：这是计划项认领，不替代文件写互斥。
    async fn claim_task(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(item) = string_arg(&call.arguments, "task") else {
            return ToolResult::error("missing string argument: task");
        };
        let agent = self
            .own_agent_id
            .clone()
            .unwrap_or_else(|| "unknown".into());
        if !approval
            .approve(call, "claim_task will append a claim line to .coomi/collab/claims.md")
            .await
        {
            return ToolResult::error("claim_task was not approved");
        }
        let dir = self.cwd.join(".coomi").join("collab");
        if let Err(error) = std::fs::create_dir_all(&dir) {
            return ToolResult::error(format!("failed to create claim dir: {error}"));
        }
        let path = dir.join("claims.md");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let line = format!("- [{stamp}] `{agent}` claimed: {item}\n");
        use std::io::Write;
        let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(f) => f,
            Err(error) => return ToolResult::error(format!("failed to open claims.md: {error}")),
        };
        if let Err(error) = file.write_all(line.as_bytes()) {
            return ToolResult::error(format!("failed to write claim: {error}"));
        }
        ToolResult::success(format!(
            "Claimed by `{agent}`: {item}\nOther roles must not implement this item. File writes remain subject to runtime file claims."
        ))
    }

    /// 读取当前任务的计划认领列表（协作对齐用）。
    async fn list_claims(&self) -> ToolResult {
        let path = self.cwd.join(".coomi").join("collab").join("claims.md");
        match std::fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => ToolResult::success(self.truncate(text)),
            Ok(_) => ToolResult::success("（尚无认领记录）"),
            Err(_) => ToolResult::success("（尚无认领记录）"),
        }
    }

    /// 等待共享文件（契约/上游产出）出现且非空。超时返回错误，不挂死。
    async fn wait_for_file(&self, arguments: &Value) -> ToolResult {
        let Some(rel) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let timeout_ms = usize_arg(arguments, "timeout_ms").unwrap_or(60_000).clamp(1_000, 300_000);
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
        loop {
            let abs = match self.checked_path(&rel, false) {
                Ok(p) => p,
                Err(_) => {
                    if std::time::Instant::now() >= deadline {
                        return ToolResult::error(format!("wait_for_file timeout: {rel}"));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    continue;
                }
            };
            if let Ok(text) = std::fs::read_to_string(&abs)
                && !text.trim().is_empty()
            {
                return ToolResult::success(format!("ready: {rel} ({} bytes)", text.len()));
            }
            if std::time::Instant::now() >= deadline {
                return ToolResult::error(format!("wait_for_file timeout: {rel} still missing/empty"));
            }
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
    }

    fn list_dir(&self, arguments: &Value) -> ToolResult {
        let relative = string_arg(arguments, "path").unwrap_or(".");
        let path = match self.checked_path(relative, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let depth = usize_arg(arguments, "depth").unwrap_or(1).clamp(1, 8);
        let max_entries = usize_arg(arguments, "max_entries")
            .unwrap_or(500)
            .clamp(1, 2_000);
        let mut entries = WalkBuilder::new(&path)
            .max_depth(Some(depth))
            .hidden(false)
            .build()
            .flatten()
            .skip(1)
            .take(max_entries)
            .map(|entry| {
                let suffix = if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                    "/"
                } else {
                    ""
                };
                format!("{}{suffix}", self.display_path(entry.path()))
            })
            .collect::<Vec<_>>();
        entries.sort();
        if entries.is_empty() {
            ToolResult::success("directory is empty")
        } else {
            ToolResult::success(self.truncate(entries.join("\n")))
        }
    }


/// 判断一条命令是否指向「杀掉引擎自己」。AI 在工具里跑出这类命令会让引擎**静默退出**，
/// 日志里既没有 panic 也没有死因——用户看到的就是「用工具时引擎突然崩溃重启」。
/// 匹配：taskkill / Stop-Process / kill / tskill / pkill + coomi（或本进程名/进程号）。
fn is_self_kill_command(command: &str) -> bool {
    let lower = command.to_lowercase();
    let killers = [
        "taskkill",
        "stop-process",
        "tskill",
        "pkill",
        "killall",
        "kill ",
        "taskkill /f /im coomi",
        "stop-process -name coomi",
    ];
    killers
        .iter()
        .any(|k| lower.contains(k))
        && (lower.contains("coomi") || lower.contains(&std::process::id().to_string()))
}

    async fn local_shell(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let action = string_arg(&call.arguments, "action").unwrap_or("exec");
        if action == "exec" {
            let Some(command) = string_arg(&call.arguments, "command") else {
                return ToolResult::error("missing string argument: command");
            };
            match self.policy.assess_shell(command) {
                Decision::Allow => {}
                Decision::Deny(reason) => return ToolResult::error(reason),
                Decision::Ask(reason) => {
                    if !approval.approve(call, &reason).await {
                        return ToolResult::error("shell command was not approved");
                    }
                }
            }
            // 每次执行都留痕：下次引擎「突然没了」时，日志最后一行就是这个命令。
            println!("[tool] exec: {command}");
            // 自保：拒绝「杀掉引擎自己」的命令。AI 在用工具时跑出这类命令，
            // 引擎会**静默退出**（没有 panic、没有死因日志，用户看到的就是「突然崩溃重启」）。
            if Self::is_self_kill_command(command) {
                return ToolResult::error("拒绝执行：该命令会终止 Coomi 引擎自身。如需清理进程请明确指定进程名以外的目标。");
            }
        }
        let result = self.processes.execute(&self.cwd, &call.arguments).await;
        if action == "exec" && result.success {
            if let Some(command) = string_arg(&call.arguments, "command") {
                if let Some(dir) = standalone_cd_target(command) {
                    if let Some(sink) = &self.cwd_sink {
                        sink(dir);
                    }
                }
            }
        }
        result
    }

    async fn apply_patch(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(patch_text) = string_arg(&call.arguments, "patch") else {
            return ToolResult::error("missing string argument: patch");
        };
        // 生成物汇总：补丁涉及的路径先解析成宿主绝对路径，
        // 打到成功后再声明（Delete 掉的路径会在引擎侧的真实文件校验里被剔除）。
        let touched = patch::patch_paths(patch_text)
            .iter()
            .filter_map(|rel| self.checked_path(rel, true).ok())
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        if self.policy.mode() != coomi_security::AccessMode::FullAccess
            && !approval
                .approve(call, "apply_patch will modify files")
                .await
        {
            return ToolResult::error("patch was not approved");
        }
        // 协同写互斥：patch 涉及的每个路径先过 claim/权限。
        for rel in patch::patch_paths(patch_text) {
            let abs = match self.checked_path(&rel, true) {
                Ok(path) => path,
                Err(error) => return ToolResult::error(error),
            };
            if let Err(error) = self.enforce_write_claim(&abs) {
                return ToolResult::error(error);
            }
        }
        match patch::apply_patch_with_paths(&self.policy, Some(&self.path_map), patch_text) {
            Ok(output) => ToolResult::success(output).with_artifacts(touched),
            Err(error) => ToolResult::error(error),
        }
    }

    async fn web_search(&self, arguments: &Value) -> ToolResult {
        let Some(query) = string_arg(arguments, "query") else {
            return ToolResult::error("missing string argument: query");
        };
        let limit = usize_arg(arguments, "limit").unwrap_or(5).clamp(1, 10);
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return web_search_unavailable(format!(
                    "HTTP client initialization failed: {error}"
                ));
            }
        };
        let mut failures = Vec::new();

        // Preferred endpoint: Bing RSS. It returns stable, lightweight XML from mainland
        // China (cn.bing.com) without JavaScript rendering or aggressive bot detection.
        match client
            .get("https://cn.bing.com/search")
            .query(&[("format", "rss"), ("q", query)])
            .header("Accept", "application/rss+xml, application/xml, text/xml")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.7")
            .header(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36",
            )
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => match read_body_capped(response).await {
                Ok(body) => {
                    let results = parse_bing_rss(&body, limit);
                    if !results.is_empty() {
                        return ToolResult::success(results.join("\n"));
                    }
                    failures.push("Bing RSS returned no parseable items".to_string());
                }
                Err(error) => failures.push(format!("Bing RSS response read failed: {error}")),
            },
            Ok(response) => failures.push(format!("Bing RSS: HTTP {}", response.status())),
            Err(error) => failures.push(format!("Bing RSS: {error}")),
        }

        // Fallback: plain-HTML search endpoints.
        let endpoints = [
            "https://cn.bing.com/search",
            "https://html.duckduckgo.com/html/",
            "https://lite.duckduckgo.com/lite/",
        ];
        let mut html = None;
        for endpoint in endpoints {
            let response = client
                .get(endpoint)
                .query(&[("q", query)])
                .header("Accept", "text/html,application/xhtml+xml")
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.7")
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36",
                )
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    match read_body_capped(response).await {
                        Ok(body) if !body.trim().is_empty() => {
                            html = Some(body);
                            break;
                        }
                        Ok(_) => failures.push(format!("{endpoint}: empty response")),
                        Err(error) => {
                            failures.push(format!("{endpoint}: response read failed: {error}"))
                        }
                    }
                }
                Ok(response) => failures.push(format!("{endpoint}: HTTP {}", response.status())),
                Err(error) => failures.push(format!("{endpoint}: {error}")),
            }
        }
        let Some(html) = html else {
            return web_search_unavailable(failures.join("; "));
        };
        let Ok(tag_re) = Regex::new(r"<[^>]+>") else {
            return web_search_unavailable("search result parser unavailable");
        };
        let mut results = Vec::new();
        let Ok(bing_re) = Regex::new(
            r#"(?is)<li[^>]+class=['\"][^'\"]*b_algo[^'\"]*['\"][^>]*>.*?<h2[^>]*>\s*<a[^>]+href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>"#,
        ) else {
            return web_search_unavailable("search result parser unavailable");
        };
        for captures in bing_re.captures_iter(&html).take(limit) {
            let url = normalize_search_url(captures.get(1).map_or("", |value| value.as_str()));
            let title = decode_html(
                &tag_re.replace_all(captures.get(2).map_or("", |value| value.as_str()), ""),
            );
            if !title.trim().is_empty() && !url.is_empty() {
                results.push(format!("- {title}\n  {url}"));
            }
        }
        if results.is_empty() {
            let Ok(result_re) = Regex::new(
                r#"(?is)<a[^>]+(?:class=['\"][^'\"]*(?:result__a|result-link)[^'\"]*['\"][^>]*href=['\"]([^'\"]+)['\"]|href=['\"]([^'\"]+)['\"][^>]*class=['\"][^'\"]*(?:result__a|result-link)[^'\"]*['\"])[^>]*>(.*?)</a>"#,
            ) else {
                return web_search_unavailable("search result parser unavailable");
            };
            for captures in result_re.captures_iter(&html).take(limit) {
                let raw_url = captures
                    .get(1)
                    .or_else(|| captures.get(2))
                    .map_or("", |value| value.as_str());
                let url = normalize_search_url(raw_url);
                let title = captures.get(3).map_or("", |value| value.as_str());
                let title = decode_html(&tag_re.replace_all(title, ""));
                if !title.trim().is_empty() && !url.is_empty() {
                    results.push(format!("- {title}\n  {url}"));
                }
            }
        }
        if results.is_empty() {
            web_search_unavailable("search response contained no parseable results")
        } else {
            ToolResult::success(results.join("\n"))
        }
    }

    /// Built-in `fetch` tool: reads a web page over HTTP(S) and returns its readable text.
    /// This is the embedded equivalent of the mcp-server-fetch `fetch` tool so that web
    /// fetching works on Android out of the box (no python/npx runtime required).
    async fn fetch_url(&self, arguments: &Value) -> ToolResult {
        let Some(url) = string_arg(arguments, "url") else {
            return ToolResult::error("missing string argument: url");
        };
        let max_length = usize_arg(arguments, "max_length")
            .unwrap_or(20_000)
            .clamp(1_000, 100_000);
        let parsed = match reqwest::Url::parse(url.trim()) {
            Ok(parsed) => parsed,
            Err(error) => return ToolResult::error(format!("invalid URL: {error}")),
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return ToolResult::error("only http and https URLs are supported");
        }
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return ToolResult::error(format!("HTTP client initialization failed: {error}"));
            }
        };
        // Follow redirects manually so every hop can be re-checked against local/private
        // addresses (SSRF guard). Never follow more than 8 hops.
        let mut current = parsed;
        let mut response = None;
        for _ in 0..8 {
            if is_blocked_url(&current).await {
                return ToolResult::error(format!(
                    "blocked URL resolving to a local/private address: {current}"
                ));
            }
            let result = client
                .get(current.clone())
                .header(
                    "Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                )
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.7")
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36",
                )
                .send()
                .await;
            let received = match result {
                Ok(received) => received,
                Err(error) => return ToolResult::error(format!("request failed: {error}")),
            };
            if received.status().is_redirection() {
                let Some(location) = received
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                else {
                    break;
                };
                match current.join(location) {
                    Ok(next) if matches!(next.scheme(), "http" | "https") => current = next,
                    Ok(_) => {
                        return ToolResult::error("redirect to a non-http(s) URL is not allowed");
                    }
                    Err(error) => {
                        return ToolResult::error(format!("invalid redirect location: {error}"));
                    }
                }
                continue;
            }
            response = Some(received);
            break;
        }
        let Some(response) = response else {
            return ToolResult::error("too many redirects or redirect without a location header");
        };
        if !response.status().is_success() {
            return ToolResult::error(http_status_message(&current, response.status()));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if content_type.starts_with("image/")
            || content_type.starts_with("audio/")
            || content_type.starts_with("video/")
            || content_type.contains("octet-stream")
            || content_type.contains("application/zip")
            || content_type.contains("application/pdf")
        {
            return ToolResult::error(format!("unsupported binary content type: {content_type}"));
        }
        // Cap the body read to avoid OOM on huge pages (Android is memory-constrained).
        let body = match read_body_capped(response).await {
            Ok(body) => body,
            Err(error) => return ToolResult::error(error),
        };
        let text = if looks_like_html(&body) {
            html_to_text(&body)
        } else {
            collapse_whitespace(&body)
        };
        let mut text = text.trim().to_string();
        if text.is_empty() {
            return ToolResult::error("page contained no readable text");
        }
        if text.chars().count() > max_length {
            let truncated: String = text.chars().take(max_length).collect();
            text = format!("{truncated}\n\n[content truncated at {max_length} characters]");
        }
        ToolResult::success(text)
    }

    /// 在会话历史里检索（context_search）：关键词/词频打分，未命中给可读结果而不是报错。
    fn context_search(&self, arguments: &Value) -> ToolResult {
        let Some(query) = string_arg(arguments, "query") else {
            return ToolResult::error("missing string argument: query");
        };
        let query = query.trim();
        if query.is_empty() {
            return ToolResult::error("query must not be empty");
        }
        let limit = usize_arg(arguments, "limit").unwrap_or(8).clamp(1, 30);
        let role_filter = string_arg(arguments, "role")
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        if self.parent_history.is_empty() {
            return ToolResult::success("当前会话没有可检索的历史消息。");
        }
        let lowered = query.to_lowercase();
        let terms = coomi_engine::tokenize_terms(&lowered);
        let mut scored: Vec<(usize, i64, usize)> = Vec::new();
        for (index, message) in self.parent_history.iter().enumerate() {
            let role = role_name(message.role);
            if role_filter
                .as_deref()
                .is_some_and(|filter| filter != role)
            {
                continue;
            }
            let content = message.content.to_lowercase();
            if content.trim().is_empty() {
                continue;
            }
            let mut score = 0_i64;
            let mut hits = 0_usize;
            if content.contains(&lowered) {
                score += 20;
            }
            for term in &terms {
                if term.chars().count() >= 2 && content.contains(term.as_str()) {
                    hits += 1;
                    score += 2;
                }
            }
            if score == 0 {
                continue;
            }
            scored.push((index, score, hits));
        }
        scored.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        if scored.is_empty() {
            return ToolResult::success(format!(
                "会话历史里没有匹配「{query}」的消息（可直接向用户确认）。"
            ));
        }
        let total = scored.len();
        scored.truncate(limit);
        let mut out = format!(
            "在会话历史里找到 {total} 条相关消息，按相关性返回前 {} 条：",
            scored.len()
        );
        for (index, score, hits) in scored {
            let message = &self.parent_history[index];
            out.push_str(&format!(
                "\n\n[#{index} {} score={score} hits={hits}] {}",
                role_name(message.role),
                history_snippet(&message.content, &terms, 260)
            ));
        }
        ToolResult::success(self.truncate(out))
    }

    /// 在工作区里按文件名或文件内容搜索（file_search）。
    /// 跳过 .git/node_modules/target 等噪音目录，并限制扫描文件数与单文件大小。
    async fn file_search(&self, arguments: &Value) -> ToolResult {
        let Some(query) = string_arg(arguments, "query") else {
            return ToolResult::error("missing string argument: query");
        };
        let query = query.trim();
        if query.is_empty() {
            return ToolResult::error("query must not be empty");
        }
        let mode = string_arg(arguments, "mode")
            .unwrap_or("auto")
            .trim()
            .to_ascii_lowercase();
        if !matches!(mode.as_str(), "auto" | "name" | "content") {
            return ToolResult::error("mode 只支持 auto / name / content");
        }
        let relative = string_arg(arguments, "path").unwrap_or(".");
        let root = match self.checked_path(relative, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        if !root.is_dir() {
            return ToolResult::error(format!(
                "搜索目录不存在：{}",
                self.display_path(&root)
            ));
        }
        let max_results = usize_arg(arguments, "max_results").unwrap_or(40).clamp(1, 200);
        let needle = query.to_lowercase();
        // 噪音目录：依赖 ignore crate 的 .gitignore 之外，显式再挡一层。
        const IGNORED_DIRS: [&str; 14] = [
            ".git",
            ".hg",
            ".svn",
            "node_modules",
            "target",
            "dist",
            "build",
            "out",
            ".next",
            ".venv",
            "venv",
            "__pycache__",
            ".gradle",
            "vendor",
        ];
        const MAX_SCANNED_FILES: usize = 20_000;
        const MAX_FILE_BYTES: u64 = 1024 * 1024;
        const MAX_MATCHES_PER_FILE: usize = 3;
        let search_name = mode != "content";
        let search_content = mode != "name";

        let walker = WalkBuilder::new(&root)
            .hidden(true)
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
                if !is_dir {
                    return true;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                !IGNORED_DIRS.contains(&name.as_str())
            })
            .build();

        let mut name_hits: Vec<String> = Vec::new();
        let mut content_hits: Vec<String> = Vec::new();
        let mut scanned = 0_usize;
        let mut skipped_binary = 0_usize;
        let mut skipped_large = 0_usize;
        for entry in walker.flatten() {
            if name_hits.len() + content_hits.len() >= max_results || scanned >= MAX_SCANNED_FILES {
                break;
            }
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            scanned += 1;
            let display = self.display_path(entry.path()).replace('\\', "/");
            if search_name {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if name.contains(&needle) || display.to_ascii_lowercase().contains(&needle) {
                    name_hits.push(display.clone());
                    if mode == "name" {
                        continue;
                    }
                }
            }
            if !search_content {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                skipped_large += 1;
                continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            if bytes.iter().take(8_192).any(|byte| *byte == 0) {
                skipped_binary += 1;
                continue;
            }
            let Ok(content) = String::from_utf8(bytes) else {
                skipped_binary += 1;
                continue;
            };
            let mut per_file = 0_usize;
            for (line_index, line) in content.lines().enumerate() {
                if per_file >= MAX_MATCHES_PER_FILE
                    || name_hits.len() + content_hits.len() >= max_results
                {
                    break;
                }
                if line.to_ascii_lowercase().contains(&needle) {
                    content_hits.push(format!(
                        "{}:{}: {}",
                        display,
                        line_index + 1,
                        line.trim().chars().take(240).collect::<String>()
                    ));
                    per_file += 1;
                }
            }
        }

        if name_hits.is_empty() && content_hits.is_empty() {
            return ToolResult::success(format!(
                "在 {} 下没有找到匹配「{query}」的文件（已扫描 {scanned} 个文件，跳过二进制 {skipped_binary} 个、超大文件 {skipped_large} 个）。",
                self.display_path(&root)
            ));
        }
        let mut out = format!(
            "在 {} 下搜索「{query}」（mode={mode}，扫描 {scanned} 个文件）：",
            self.display_path(&root)
        );
        if !name_hits.is_empty() {
            out.push_str("\n\n按文件名匹配：");
            for hit in &name_hits {
                out.push_str("\n- ");
                out.push_str(hit);
            }
        }
        if !content_hits.is_empty() {
            out.push_str("\n\n按内容匹配：");
            for hit in &content_hits {
                out.push('\n');
                out.push_str(hit);
            }
        }
        if scanned >= MAX_SCANNED_FILES {
            out.push_str(&format!(
                "\n\n[已达扫描上限 {MAX_SCANNED_FILES} 个文件，结果可能不完整]"
            ));
        }
        ToolResult::success(self.truncate(out))
    }

    /// OCR：优先本地 tesseract（Proot/宿主）。尝试中英语言包；无则给可操作提示。
    async fn ocr_image(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(path) = string_arg(&call.arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let lang = string_arg(&call.arguments, "lang").unwrap_or("chi_sim+eng");
        let path = match self.checked_path(&path, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        if !path.is_file() {
            return ToolResult::error(format!("图片不存在: {}", path.display()));
        }
        if !approval
            .approve(call, "ocr_image will run local tesseract OCR")
            .await
        {
            return ToolResult::error("ocr_image was not approved");
        }
        // 多候选语言：用户指定 → 中英 → 英
        let langs: Vec<String> = vec![
            lang.to_owned(),
            "chi_sim+eng".into(),
            "chi_sim".into(),
            "eng".into(),
        ];
        let mut last_err = String::new();
        for lg in langs {
            match Self::run_tesseract(&path, &lg).await {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if text.is_empty() {
                        return ToolResult::success("（OCR 未识别到文字）");
                    }
                    return ToolResult::success(self.truncate(text));
                }
                Err(e) => last_err = e,
            }
        }
        if last_err.contains("No such file") || last_err.contains("not found") {
            ToolResult::error(
                "本地未找到 tesseract。请在 Proot 内安装：apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim",
            )
        } else {
            ToolResult::error(format!("本地 OCR 失败: {last_err}"))
        }
    }

    async fn run_tesseract(path: &std::path::Path, lang: &str) -> Result<String, String> {
        let mut cmd = tokio::process::Command::new("tesseract");
        cmd.arg(path).arg("stdout").arg("-l").arg(lang);
        cmd.arg("--psm").arg("3");
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        match cmd.output().await {
            Ok(output) if output.status.success() => {
                Ok(String::from_utf8_lossy(&output.stdout).into_owned())
            }
            Ok(output) => {
                let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if err.contains("No such file") || err.to_lowercase().contains("not found") {
                    Err("tesseract not found".into())
                } else {
                    Err(if err.is_empty() {
                        format!("exit={:?}", output.status.code())
                    } else {
                        err
                    })
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err("tesseract not found".into())
            }
            Err(error) => Err(format!("{error}")),
        }
    }

    /// 安装本地 OCR 依赖（Proot 内 apt）。需批准。
    async fn install_ocr_deps(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        if !approval
            .approve(call, "install_ocr_deps will run apt install tesseract-ocr in Proot")
            .await
        {
            return ToolResult::error("install_ocr_deps was not approved");
        }
        let script = "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim || true; tesseract --version 2>&1 | head -n 1";
        let shell_call = ToolCall {
            id: format!("ocr_{}", uuid::Uuid::new_v4()),
            name: "shell".into(),
            arguments: serde_json::json!({ "command": script }),
        };
        struct AlwaysAllow;
        #[async_trait::async_trait]
        impl ApprovalHandler for AlwaysAllow {
            async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
                true
            }
        }
        match self.shell(&shell_call, &AlwaysAllow).await {
            r if r.success => ToolResult::success(self.truncate(format!("OCR 依赖安装完成\n{}", r.output))),
            r => ToolResult::error(self.truncate(r.output)),
        }
    }

    /// SSH：内置 russh 客户端远程执行；无系统 openssh 也可用。
    /// 认证：优先 ~/.ssh 多把私钥 → 内联 PEM → password。始终请求用户批准。
    async fn ssh_exec(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(host) = string_arg(&call.arguments, "host") else {
            return ToolResult::error("missing string argument: host");
        };
        let Some(command) = string_arg(&call.arguments, "command") else {
            return ToolResult::error("missing string argument: command");
        };
        if host.trim().is_empty() || command.trim().is_empty() {
            return ToolResult::error("host and command are required");
        }
        let lower = command.to_lowercase();
        for banned in ["rm -rf /", "mkfs.", ":(){", "fork bomb"] {
            if lower.contains(banned) {
                return ToolResult::error(format!("拒绝执行危险远程命令：命中 `{banned}`"));
            }
        }
        if !approval
            .approve(call, &format!("ssh_exec → {host}: {command}"))
            .await
        {
            return ToolResult::error("ssh_exec was not approved");
        }

        let timeout_ms = usize_arg(&call.arguments, "timeout_ms").unwrap_or(120_000);
        let port = usize_arg(&call.arguments, "port")
            .map(|p| p.clamp(1, 65535) as u16)
            .unwrap_or(22);
        let default_user = string_arg(&call.arguments, "user").unwrap_or("");
        let target = ssh_client::parse_target(host, port, default_user);
        let private_key = string_arg(&call.arguments, "private_key").map(PathBuf::from);
        let password = string_arg(&call.arguments, "password").map(str::to_owned);
        let private_key_pem = string_arg(&call.arguments, "private_key_pem").map(str::to_owned);
        let auth = ssh_client::SshAuth {
            private_key,
            password,
            private_key_pem,
            extra_users: Vec::new(),
        };

        let total = Duration::from_millis(timeout_ms as u64);
        let connect_to = Duration::from_secs(15).min(total);

        match tokio::time::timeout(
            total,
            ssh_client::exec_with_diag(
                &target,
                command.trim(),
                &auth,
                self.config_home.as_deref(),
                connect_to,
                total,
            ),
        )
        .await
        {
            Ok(Ok((output, _diag))) => {
                let mut text = String::new();
                if !output.stdout.trim().is_empty() {
                    text.push_str(output.stdout.trim());
                }
                if !output.stderr.trim().is_empty() {
                    if !text.is_empty() {
                        text.push_str("\n\n[stderr]\n");
                    }
                    text.push_str(output.stderr.trim());
                }
                if text.is_empty() {
                    text = format!(
                        "（无输出，exit={:?} @ {}:{}）",
                        output.exit_code, target.host, target.port
                    );
                }
                match output.exit_code {
                    Some(0) | None => ToolResult::success(self.truncate(text)),
                    Some(code) => {
                        ToolResult::error(self.truncate(format!("{text}\n\nexit={code}")))
                    }
                }
            }
            Ok(Err(error)) => {
                // 内置客户端失败时，若系统有 ssh 且非 BatchMode 密码场景可回退。
                match Self::try_system_ssh(host, command, port, timeout_ms).await {
                    Ok(text) => ToolResult::success(self.truncate(text)),
                    Err(sys_err) => ToolResult::error(self.truncate(format!(
                        "内置 SSH 失败: {error}\n系统 ssh 回退: {sys_err}"
                    ))),
                }
            }
            Err(_) => ToolResult::error(format!("ssh 超时（{timeout_ms}ms）")),
        }
    }

    /// 系统 openssh 回退（仅当设备装了 ssh 二进制时有意义）。
    async fn try_system_ssh(
        host: &str,
        command: &str,
        port: u16,
        timeout_ms: usize,
    ) -> Result<String, String> {
        let mut cmd = tokio::process::Command::new("ssh");
        cmd.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=15",
            "-p",
            &port.to_string(),
            host.trim(),
            command,
        ]);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), cmd.output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let mut text = String::new();
                if !stdout.trim().is_empty() {
                    text.push_str(stdout.trim());
                }
                if !stderr.trim().is_empty() {
                    if !text.is_empty() {
                        text.push_str("\n\n[stderr]\n");
                    }
                    text.push_str(stderr.trim());
                }
                if output.status.success() {
                    Ok(text)
                } else {
                    Err(if text.is_empty() {
                        format!("exit={:?}", output.status.code())
                    } else {
                        text
                    })
                }
            }
            Ok(Err(e)) => Err(format!("无法执行系统 ssh: {e}")),
            Err(_) => Err("系统 ssh 超时".into()),
        }
    }

    async fn view_image(&self, arguments: &Value) -> ToolResult {
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let path = match self.checked_path(path, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) => return ToolResult::error(format!("failed to read image: {error}")),
        };
        let media_type = match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            _ => return ToolResult::error("supported image formats: png, jpg, gif, webp"),
        };
        if bytes.len() > 10 * 1024 * 1024 {
            return ToolResult::error("image exceeds the 10 MiB tool limit");
        }
        ToolResult::success(format!(
            "path: {}\nmedia_type: {media_type}\nbytes: {}",
            path.display(),
            bytes.len()
        ))
        .with_image(media_type, BASE64_STANDARD.encode(bytes))
    }

    /// 将本地图片展示给用户：在界面上渲染缩略图，用户可全屏预览/另存/模糊化。
    /// 与 view_image 的区别：view_image 把图片注入给支持视觉的模型，供模型"看"；
    /// show_image 仅为用户展示，不要求模型具备图像理解能力，界面默认展开图片。
    async fn show_image(&self, arguments: &Value) -> ToolResult {
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let path = match self.checked_path(path, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) => return ToolResult::error(format!("failed to read image: {error}")),
        };
        let media_type = match path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            _ => return ToolResult::error("supported image formats: png, jpg, gif, webp"),
        };
        if bytes.len() > 10 * 1024 * 1024 {
            return ToolResult::error("image exceeds the 10 MiB tool limit");
        }
        ToolResult::success(format!(
            "path: {}\nmedia_type: {media_type}\nbytes: {}",
            path.display(),
            bytes.len()
        ))
        .with_image(media_type, BASE64_STANDARD.encode(bytes))
    }

    /// 从视频抽取关键帧供视觉模型识别。
    /// 优先厂商原生视频理解（调用方直接传视频 URL/字节）；此工具用于降级：
    /// 用 ffmpeg 均匀抽帧（strategy=fps），或 PySceneDetect 场景切分（strategy=scene）。
    /// 帧输出到 <视频同目录>/coomi-frames-<时间戳>/，返回帧路径列表（可配合 view_image 逐帧查看）。
    async fn extract_video_frames(&self, arguments: &Value) -> ToolResult {
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let video = match self.checked_path(path, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        if !video.is_file() {
            return ToolResult::error(format!("video not found: {}", video.display()));
        }
        let max_frames = arguments
            .get("max_frames")
            .and_then(Value::as_u64)
            .unwrap_or(6)
            .clamp(1, 20);
        let strategy = string_arg(arguments, "strategy").unwrap_or("fps");
        let out_dir = video
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(format!(
                "coomi-frames-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0)
            ));
        if let Err(error) = tokio::fs::create_dir_all(&out_dir).await {
            return ToolResult::error(format!(
                "failed to create frame dir {}: {error}",
                out_dir.display()
            ));
        }
        // ffmpeg/ffprobe 定位：候选路径按可靠性排序，最后一个回退 PATH（依赖用户自装）。
        // 注意：引擎跑在 proot Debian rootfs 时，Termux 原生 bin 在 guest 内不可见，
        // 因此同时探测常见系统路径 + 通过 cwd 上溯 rootfs bin。
        let binary_for = |name: &str| -> String {
            let mut candidates: Vec<PathBuf> = vec![
                PathBuf::from("/data/data/com.termux/files/usr/bin").join(name),
                PathBuf::from("/usr/bin").join(name),
                PathBuf::from("/usr/local/bin").join(name),
                PathBuf::from("/bin").join(name),
            ];
            let mut dir = self.cwd.clone();
            for _ in 0..8 {
                let bin = dir.join("usr").join("bin").join(name);
                if !candidates.contains(&bin) {
                    candidates.push(bin);
                }
                if !dir.pop() {
                    break;
                }
            }
            candidates
                .into_iter()
                .find(|p| p.is_file())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| name.to_owned())
        };
        let prefix = out_dir.join("frame_%03d.jpg");
        let probe = tokio::process::Command::new(binary_for("ffprobe"))
            .args(["-v", "error", "-show_entries", "format=duration", "-of",
                   "default=noprint_wrappers=1:nokey=1", video.to_str().unwrap_or("")])
            .output()
            .await;
        let duration_secs: f64 = match &probe {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0.0)
            }
            _ => 0.0,
        };
        let interval = if duration_secs > 0.0 && max_frames > 0 {
            (duration_secs / max_frames as f64).max(0.1)
        } else {
            1.0
        };
        let args: Vec<String> = if strategy == "scene" {
            // PySceneDetect：scenedetect -i <video> -o <dir> --output-format jpg …
            vec![
                "-i".into(), video.to_string_lossy().into_owned(),
                "-o".into(), out_dir.to_string_lossy().into_owned(),
                "--output-format".into(), "jpg".into(),
                "-m".into(), "detect-content".into(),
                "--threshold".into(), "27.0".into(),
            ]
        } else {
            vec![
                "-hide_banner".into(),
                "-loglevel".into(), "error".into(),
                "-i".into(), video.to_string_lossy().into_owned(),
                "-vf".into(), format!("fps=1/{interval}"),
                "-frames:v".into(), max_frames.to_string(),
                "-q:v".into(), "2".into(),
                prefix.to_string_lossy().into_owned(),
            ]
        };
        let mut command = if strategy == "scene" {
            tokio::process::Command::new("scenedetect")
        } else {
            tokio::process::Command::new(binary_for("ffmpeg"))
        };
        let output = command
            .args(&args)
            .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/data/data/com.termux/files/home".into()))
            .output()
            .await;
        match output {
            Ok(out) if out.status.success() => {
                let mut frames = Vec::new();
                let mut read = tokio::fs::read_dir(&out_dir).await;
                if let Ok(mut entries) = read {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let p = entry.path();
                        if p.extension().is_some_and(|e| matches!(e.to_str(), Some("jpg" | "jpeg" | "png"))) {
                            frames.push(p.to_string_lossy().into_owned());
                        }
                    }
                }
                frames.sort();
                if frames.is_empty() {
                    return ToolResult::error("no frames extracted (ffmpeg ran but produced no images)");
                }
                let guest = frames
                    .iter()
                    .map(|p| {
                        self.path_map
                            .host_to_guest(std::path::Path::new(p))
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect::<Vec<_>>();
                ToolResult::success(serde_json::json!({
                    "strategy": strategy,
                    "frames": frames,
                    "frames_guest": guest,
                    "count": frames.len(),
                    "hint": "Use view_image on each frame path to inspect. Prefer video-capable models when available."
                }).to_string())
            }
            Ok(out) => ToolResult::error(format!(
                "frame extraction failed ({}): {}",
                strategy,
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(error) => ToolResult::error(format!(
                "{} not available: {error} (install ffmpeg via Termux: pkg install ffmpeg; or scenedetect via pip in proot)",
                if strategy == "scene" { "scenedetect" } else { "ffmpeg" }
            )),
        }
    }

    async fn request_user_input(
        &self,
        arguments: &Value,
        approval: &dyn ApprovalHandler,
    ) -> ToolResult {
        let request =
            match serde_json::from_value::<coomi_engine::UserInputRequest>(arguments.clone()) {
                Ok(request) => request,
                Err(error) => {
                    return ToolResult::error(format!("invalid user input request: {error}"));
                }
            };
        if let Err(error) = validate_user_input_request(&request) {
            return ToolResult::error(error);
        }
        match approval.request_user_input(&request).await {
            Some(response) => ToolResult::success(
                serde_json::to_string(&response).unwrap_or_else(|_| "{}".into()),
            ),
            None => ToolResult::error("user input request was cancelled"),
        }
    }

    /// ask_user：向用户提一个简短问题并等待回答。
    ///
    /// 走的是与 request_user_input 完全相同的人机交互通道（前端 `user_question_request`
    /// 事件 + `answer_question` 命令），本方法只负责参数校验与「通道返回什么就回什么」——
    /// 超时语义由 ApprovalHandler 实现方按 `timeout_ms` 决定（缺省 = 一直等）。
    async fn ask_user(&self, arguments: &Value, approval: &dyn ApprovalHandler) -> ToolResult {
        let request =
            match serde_json::from_value::<coomi_engine::UserAskRequest>(arguments.clone()) {
                Ok(request) => request,
                Err(error) => {
                    return ToolResult::error(format!("invalid ask_user request: {error}"));
                }
            };
        if let Err(error) = request.validate() {
            return ToolResult::error(error);
        }
        match approval.request_user_ask(&request).await {
            Some(answer) => ToolResult::success(
                serde_json::to_string(&answer).unwrap_or_else(|_| "{}".into()),
            ),
            None => ToolResult::error(
                "用户未回答该问题（被跳过、取消或等待超时）；可以换个问法，或先按最合理的默认值继续",
            ),
        }
    }

    /// request_save_as：请求前端弹系统原生「另存为」对话框。
    ///
    /// 引擎只发事件、**不写任何文件**：这里只确认源文件真实存在，然后把请求交给
    /// 交互通道（与 request_file_export 共用 file_transfer_request 事件与回执命令），
    /// 真正的落盘由用户在前端选完位置后由前端完成。
    async fn request_save_as(
        &self,
        call: &ToolCall,
        approval: &dyn ApprovalHandler,
    ) -> ToolResult {
        let Some(path) = string_arg(&call.arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let resolved = self
            .path_map
            .resolve(path, None)
            .map(|resolved| resolved.host_path)
            .unwrap_or_else(|_| PathBuf::from(path));
        if !resolved.is_file() {
            return ToolResult::error(format!(
                "request_save_as 只能对已存在的文件请求另存：{} 不存在",
                resolved.display()
            ));
        }
        let suggested_name = string_arg(&call.arguments, "suggested_name")
            .map(ToOwned::to_owned)
            .or_else(|| {
                resolved
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            });
        let request = FileTransferRequest {
            request_id: format!("saveas-{}", uuid::Uuid::new_v4()),
            operation: "export".to_owned(),
            intent: Some("save_as".to_owned()),
            path: Some(resolved.display().to_string()),
            suggested_name,
            multiple: false,
        };
        // 先取出 id 再借用 request：match 的临时值会活到整个 match 结束。
        let request_id = request.request_id.clone();
        match approval.request_file_transfer(&request).await {
            Some(paths) => ToolResult::success(
                json!({
                    "intent": "save_as",
                    "request_id": request_id,
                    "paths": paths,
                    "wrote_files": false,
                })
                .to_string(),
            ),
            None => ToolResult::error("另存为请求已取消或超时（引擎未写入任何文件）"),
        }
    }

    async fn request_file_transfer(
        &self,
        call: &ToolCall,
        approval: &dyn ApprovalHandler,
        operation: &str,
    ) -> ToolResult {
        let path = string_arg(&call.arguments, "path").and_then(|value| {
            self.path_map
                .resolve(value, None)
                .ok()
                .map(|resolved| resolved.host_path.to_string_lossy().into_owned())
                .or_else(|| Some(value.to_owned()))
        });
        let suggested_name = string_arg(&call.arguments, "suggested_name").map(ToOwned::to_owned);
        let request = FileTransferRequest {
            request_id: format!("file-{}", uuid::Uuid::new_v4()),
            operation: operation.to_owned(),
            path,
            suggested_name,
            multiple: operation == "import",
            // 只有 request_save_as 会带上 save_as 语义；import/export 保持无意图。
            intent: None,
        };
        match approval.request_file_transfer(&request).await {
            Some(paths) if !paths.is_empty() => {
                // 同时给出 guest 别名（/workspace 等），shell 环境（Termux/proot）都能访问。
                let guests = paths
                    .iter()
                    .map(|path| {
                        self.path_map
                            .host_to_guest(Path::new(path))
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect::<Vec<_>>();
                ToolResult::success(
                    serde_json::json!({
                        "operation": operation,
                        "paths": paths,
                        "paths_guest": guests,
                    })
                    .to_string(),
                )
            }
            _ if operation == "export" => ToolResult::error(
                "file export failed, was cancelled, or did not respond within 30 seconds",
            ),
            _ => ToolResult::error(format!("file {operation} was cancelled")),
        }
    }

    fn update_plan(&self, arguments: &Value) -> ToolResult {
        let plan = match serde_json::from_value::<PlanState>(arguments.clone()) {
            Ok(plan) => plan,
            Err(error) => return ToolResult::error(format!("invalid plan: {error}")),
        };
        if let Err(error) = plan.validate() {
            return ToolResult::error(error);
        }
        *self.plan.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(plan.clone());
        ToolResult::success("plan updated").with_plan(plan)
    }

    fn create_loop(&self, arguments: &Value) -> ToolResult {
        #[derive(Deserialize)]
        struct Args {
            objective: String,
            #[serde(default)]
            token_budget: Option<u64>,
        }
        let args = match serde_json::from_value::<Args>(arguments.clone()) {
            Ok(args) => args,
            Err(error) => return ToolResult::error(format!("invalid loop: {error}")),
        };
        if args.objective.trim().is_empty() {
            return ToolResult::error("loop objective must not be empty");
        }
        let mut current = self.loop_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if current
            .as_ref()
            .is_some_and(|loop_state| loop_state.status == LoopStatus::Active)
        {
            return ToolResult::error("an active loop already exists");
        }
        let loop_state = LoopState {
            objective: args.objective,
            status: LoopStatus::Active,
            token_budget: args.token_budget,
            tokens_used: 0,
            time_used_seconds: 0,
            blocked_streak: 0,
            turns_completed: 0,
        };
        *current = Some(loop_state.clone());
        ToolResult::success("loop created").with_loop(loop_state)
    }

    fn get_loop(&self) -> ToolResult {
        let current = self.loop_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match current.as_ref() {
            Some(loop_state) => ToolResult::success(
                serde_json::to_string_pretty(loop_state).unwrap_or_else(|_| "{}".into()),
            )
            .with_loop(loop_state.clone()),
            None => ToolResult::success("no loop is active"),
        }
    }

    fn update_loop(&self, arguments: &Value) -> ToolResult {
        #[derive(Deserialize)]
        struct Args {
            status: LoopStatus,
            #[serde(default)]
            objective: Option<String>,
        }
        let args = match serde_json::from_value::<Args>(arguments.clone()) {
            Ok(args) => args,
            Err(error) => return ToolResult::error(format!("invalid loop update: {error}")),
        };
        let mut current = self.loop_state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(loop_state) = current.as_mut() else {
            return ToolResult::error("no loop exists");
        };
        if let Some(objective) = args.objective {
            if objective.trim().is_empty() {
                return ToolResult::error("loop objective must not be empty");
            }
            loop_state.objective = objective;
        }
        if args.status == LoopStatus::Blocked {
            loop_state.blocked_streak = loop_state.blocked_streak.saturating_add(1);
            if loop_state.blocked_streak < 3 {
                loop_state.status = LoopStatus::Active;
                let copy = loop_state.clone();
                return ToolResult::success(format!(
                    "blocking condition recorded ({}/3); loop remains active",
                    loop_state.blocked_streak
                ))
                .with_loop(copy);
            }
        } else {
            loop_state.blocked_streak = 0;
        }
        loop_state.status = args.status;
        let copy = loop_state.clone();
        ToolResult::success("loop updated").with_loop(copy)
    }

    /// 工具名归一化：把常见别名/笔误映射到规范工具名，提升模型在
    /// 不同提供商下复用习惯命名时的鲁棒性。未命中时原样返回。
    fn canonical_tool_name(name: &str) -> &str {
        match name {
            "grep" | "search" => "grep_files",
            "ls" | "dir" | "list" | "ll" => "list_dir",
            "cat" | "read" | "view" => "read_file",
            "write" => "write_file",
            "edit" | "replace" => "edit_file",
            "patch" => "apply_patch",
            "glob" | "glob_files" | "find_files" | "find" => "glob_files",
            "todo" | "todos" | "task_list" => "update_plan",
            "git" | "run_git" => "shell",
            "git_status" | "git_diff" | "git_log" | "git_commit" | "git_branch" => name,
            "web" | "web_search" => "web_search",
            "http" | "http_get" | "browse" | "get_url" => "fetch",
            "web_fetch" | "fetch_url" | "http_fetch" => "web_fetch",
            "search_files" | "find_in_files" => "file_search",
            "history_search" | "search_history" | "conversation_search" => "context_search",
            "image_view" | "open_image" => "view_image",
            "image" | "display_image" => "show_image",
            // 注意：ask_user 现在是独立工具（单问题 + 超时），不能再归一到 request_user_input。
            "ask" => "request_user_input",
            "import_file" => "request_file_import",
            "export_file" => "request_file_export",
            "plan" => "update_plan",
            "loop" | "create_loop" => "create_loop",
            "list_mcp_servers" | "mcp_list" | "get_mcp" | "list_servers" => "list_mcp",
            "list_skills" | "skills" => "list_skills",
            "skill" => "read_skill",
            "workflows" | "list_workflows" | "list_wf" => "list_workflows",
            "create_wf" | "define_workflow" => "create_workflow",
            "get_wf" | "workflow" => "get_workflow",
            "save_wf" => "save_workflow",
            "delete_wf" | "remove_workflow" | "rm_wf" => "delete_workflow",
            "memory" | "mem_list" => "memory_list",
            // Agent 相关别名（spawn_agent 的常见叫法）
            "delegate" | "delegate_agent" | "spawn_subagent" | "agent" | "subagent"
            | "start_agent" | "run_agent" => "spawn_agent",
            "agent_result" | "wait_agent" | "join_agent" => "wait_agent",
            "close_subagent" | "kill_agent" => "close_agent",
            other => other,
        }
    }

    /// 列出当前已配置且已启用的 MCP 服务器清单（名称 + 传输方式）。
    fn list_mcp(&self) -> ToolResult {
        match &self.mcp_runtime {
            Some(runtime) => {
                let inventory = runtime.inventory();
                if inventory.trim().is_empty() {
                    ToolResult::success("no MCP servers configured")
                } else {
                    ToolResult::success(inventory)
                }
            }
            None => ToolResult::success("no MCP servers configured"),
        }
    }

    fn workflow_store(&self) -> Result<WorkflowStore, String> {
        let Some(home) = &self.config_home else {
            return Err("workflow store not available: config home not configured".into());
        };
        Ok(WorkflowStore::new(home.as_path()))
    }

    /// 列出所有已注册的可编排 workflow id。
    fn list_workflows(&self) -> ToolResult {
        let store = match self.workflow_store() {
            Ok(store) => store,
            Err(error) => return ToolResult::error(error),
        };
        match store.list_ids() {
            Ok(ids) if ids.is_empty() => ToolResult::success("no workflows registered"),
            Ok(ids) => ToolResult::success(ids.join("\n")),
            Err(error) => ToolResult::error(format!("failed to list workflows: {error}")),
        }
    }

    /// 读取（返回到描述）一个 workflow 定义。
    fn get_workflow(&self, arguments: &Value) -> ToolResult {
        let Some(id) = string_arg(arguments, "id") else {
            return ToolResult::error("missing string argument: id");
        };
        let store = match self.workflow_store() {
            Ok(store) => store,
            Err(error) => return ToolResult::error(error),
        };
        match store.read(id) {
            Ok(workflow) => {
                let pretty =
                    serde_json::to_string_pretty(&workflow).unwrap_or_else(|_| "{}".into());
                ToolResult::success(pretty)
            }
            Err(error) => ToolResult::error(format!("failed to read workflow: {error}")),
        }
    }

    /// 创建（定义）并保存一个 workflow。接收完整 workflow JSON 对象。
    fn create_workflow(&self, arguments: &Value) -> ToolResult {
        let workflow = match serde_json::from_value::<WorkflowState>(arguments.clone()) {
            Ok(workflow) => workflow,
            Err(error) => return ToolResult::error(format!("invalid workflow: {error}")),
        };
        let store = match self.workflow_store() {
            Ok(store) => store,
            Err(error) => return ToolResult::error(error),
        };
        match store.save(&workflow) {
            Ok(()) => ToolResult::success(format!("workflow `{}` created", workflow.id)),
            Err(error) => ToolResult::error(format!("failed to create workflow: {error}")),
        }
    }

    /// 覆盖更新一个 workflow 定义（与 create 共用 save）。
    fn save_workflow(&self, arguments: &Value) -> ToolResult {
        let workflow = match serde_json::from_value::<WorkflowState>(arguments.clone()) {
            Ok(workflow) => workflow,
            Err(error) => return ToolResult::error(format!("invalid workflow: {error}")),
        };
        let store = match self.workflow_store() {
            Ok(store) => store,
            Err(error) => return ToolResult::error(error),
        };
        match store.save(&workflow) {
            Ok(()) => ToolResult::success(format!("workflow `{}` saved", workflow.id)),
            Err(error) => ToolResult::error(format!("failed to save workflow: {error}")),
        }
    }

    /// 删除一个 workflow（定义文件 + 注册条目）。
    fn delete_workflow(&self, arguments: &Value) -> ToolResult {
        let Some(id) = string_arg(arguments, "id") else {
            return ToolResult::error("missing string argument: id");
        };
        let store = match self.workflow_store() {
            Ok(store) => store,
            Err(error) => return ToolResult::error(error),
        };
        match store.remove(id) {
            Ok(()) => ToolResult::success(format!("workflow `{id}` deleted")),
            Err(error) => ToolResult::error(format!("failed to delete workflow: {error}")),
        }
    }

    async fn runtime_doctor(&self) -> ToolResult {
        let runtime_home = self
            .path_map
            .host_runtime_home()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "not configured".into());
        let proot = self
            .config_home
            .as_ref()
            .map(|home| home.join("runtime-v2").join("state.json").is_file())
            .unwrap_or(false);
        // 真实执行探测：在启用的 guest 内跑 shell 收集工具链与挂载健康事实。
        let facts: Option<coomi_services::GuestFacts> = match self.config_home.as_ref() {
            Some(home) => {
                let backend = RuntimeManager::open(home)
                    .and_then(|manager| manager.state())
                    .ok()
                    .and_then(|state| {
                        let version = state.active_version.clone()?;
                        (state.status == coomi_services::RuntimeInstallStatus::Ready
                            && state.backend == RuntimeBackendKind::ProotLinux)
                            .then(|| coomi_services::ProotLinuxBackend {
                                runtime_root: home.join("runtime-v2"),
                                version,
                            })
                    });
                match backend {
                    Some(backend) => {
                        coomi_services::probe_guest_facts(&backend, Path::new(&self.cwd))
                            .await
                            .ok()
                    }
                    None => None,
                }
            }
            None => None,
        };
        let termux = self
            .config_home
            .as_ref()
            .map(|home| LegacyTermuxBackend::from_coomi_home(home));
        let termux_shell = termux.as_ref().map(|backend| backend.prefix.join("bin/sh"));
        let termux_available = termux_shell.as_ref().is_some_and(|path| path.is_file());
        let ssh = self
            .path_map
            .host_runtime_home()
            .map(|home| home.join(".ssh").is_dir())
            .unwrap_or(false);
        ToolResult::success(
            serde_json::json!({
                "environments": {
                    "host": {"available": true, "role": "Android file APIs and exports"},
                    "termux": {
                        "available": termux_available,
                        "role": "Android-native tools",
                        "prefix": termux.as_ref().map(|backend| backend.prefix.display().to_string()),
                        "home": termux.as_ref().map(|backend| backend.home.display().to_string()),
                        "shell": termux_shell.map(|path| path.display().to_string())
                    },
                    "proot": {"available": proot, "role": "Linux userland tools"}
                },
                "paths": {
                    "host_workspace": self.cwd,
                    "guest_workspace": "/workspace",
                    "host_runtime_home": runtime_home,
                    "guest_home": "/home/coomi",
                    "guest_build_kit": "/opt/coomi-dev",
                    "guest_tmp": "/tmp"
                },
                "ssh": {"guest_home_ssh_directory": ssh, "recommended_known_hosts": "/home/coomi/.ssh/known_hosts"},
                "facts": facts
            })
            .to_string(),
        )
    }

    fn list_skills(&self) -> ToolResult {
        let Some(directory) = &self.skills_directory else {
            return ToolResult::error("Skill directory is not configured");
        };
        let Ok(entries) = std::fs::read_dir(directory) else {
            return ToolResult::success("no installed skills");
        };
        let mut names = entries
            .flatten()
            .filter(|entry| {
                entry.path().join("SKILL.md").is_file()
                    && self.skill_is_enabled(&entry.file_name().to_string_lossy())
            })
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        if names.is_empty() {
            ToolResult::success("no installed skills")
        } else {
            ToolResult::success(names.join("\n"))
        }
    }

    async fn read_skill(&self, arguments: &Value) -> ToolResult {
        let Some(name) = string_arg(arguments, "name") else {
            return ToolResult::error("missing string argument: name");
        };
        if name.is_empty()
            || PathBuf::from(name).components().count() != 1
            || name == "."
            || name == ".."
        {
            return ToolResult::error("Skill name must be one directory name");
        }
        let Some(directory) = &self.skills_directory else {
            return ToolResult::error("Skill directory is not configured");
        };
        if !self.skill_is_enabled(name) {
            return ToolResult::error(format!("Skill `{name}` is disabled"));
        }
        let root = match directory.canonicalize() {
            Ok(root) => root,
            Err(_) => return ToolResult::error("no installed skills"),
        };
        let path = directory.join(name).join("SKILL.md");
        let canonical = match path.canonicalize() {
            Ok(path) if path.starts_with(&root) => path,
            Ok(_) => return ToolResult::error("Skill path escapes the installed Skill directory"),
            Err(error) => {
                return ToolResult::error(format!("failed to open Skill `{name}`: {error}"));
            }
        };
        match tokio::fs::read_to_string(&canonical).await {
            Ok(content) => {
                // 匿名使用统计：skill 首次被读取（使用）时上报一次 first_use。
                // 统计 id 从 skills.json 元数据推导（catalog -> id，github -> owner/repo），
                // 与安装事件同维度，Agent 驱动的使用与用户手动使用都能覆盖。
                if let Some(home) = directory.parent() {
                    let telemetry = Telemetry::new(home);
                    let stat_id = telemetry
                        .mark_first_use(name)
                        .then(|| self.installed_stat_id(home, name))
                        .flatten();
                    if let Some(stat_id) = stat_id {
                        let _ = telemetry.record("first_use", &stat_id);
                    }
                }
                ToolResult::success(self.truncate(content))
            }
            Err(error) => ToolResult::error(format!("failed to read Skill `{name}`: {error}")),
        }
    }

    /// 已安装 skill 的统计 id：读 config/skills.json 元数据推导；
    /// 未知来源（本地目录等）退回目录名。
    fn installed_stat_id(&self, home: &std::path::Path, name: &str) -> Option<String> {
        let bytes = std::fs::read(home.join("config").join("skills.json")).ok()?;
        let document: Value = serde_json::from_slice(&bytes).ok()?;
        let record = document.get("skills")?.get(name)?;
        let stat_id = record
            .get("source_type")
            .and_then(Value::as_str)
            .zip(record.get("source").and_then(Value::as_str))
            .and_then(|(source_type, source)| coomi_telemetry::stat_id_for(source_type, source));
        stat_id.or_else(|| coomi_telemetry::normalize_skill_id(name))
    }

    fn skill_is_enabled(&self, name: &str) -> bool {
        let Some(directory) = &self.skills_directory else {
            return false;
        };
        let Some(home) = directory.parent() else {
            return true;
        };
        let path = home.join("config").join("skills.json");
        let Ok(bytes) = std::fs::read(path) else {
            return true;
        };
        serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|document| {
                document
                    .pointer(&format!("/skills/{name}/enabled"))
                    .and_then(Value::as_bool)
            })
            .unwrap_or(true)
    }

    fn memory_list(&self) -> ToolResult {
        let Some(memory) = &self.memory else {
            return ToolResult::error("Memory is not configured");
        };
        let entries = memory
            .list()
            .into_iter()
            .map(|entry| {
                format!(
                    "- {} [{:?}/{:?}]{}: {}",
                    entry.name,
                    entry.scope.unwrap_or(MemoryScope::Project),
                    entry.memory_type,
                    if entry.stale { " stale" } else { "" },
                    entry.description
                )
            })
            .collect::<Vec<_>>();
        ToolResult::success(if entries.is_empty() {
            "no memories".into()
        } else {
            entries.join("\n")
        })
    }

    fn memory_read(&self, arguments: &Value) -> ToolResult {
        let Some(memory) = &self.memory else {
            return ToolResult::error("Memory is not configured");
        };
        let Some(name) = string_arg(arguments, "name") else {
            return ToolResult::error("missing string argument: name");
        };
        match memory.get(name) {
            Some(entry) => ToolResult::success(format!(
                "# {}\n\n{}\n\n{}",
                entry.name, entry.description, entry.content
            )),
            None => ToolResult::error(format!("memory `{name}` was not found")),
        }
    }

    fn memory_search(&self, arguments: &Value) -> ToolResult {
        let Some(memory) = &self.memory else {
            return ToolResult::error("Memory is not configured");
        };
        let Some(query) = string_arg(arguments, "query") else {
            return ToolResult::error("missing string argument: query");
        };
        let entries = memory.search(query, usize_arg(arguments, "limit").unwrap_or(5));
        ToolResult::success(
            entries
                .into_iter()
                .map(|entry| {
                    format!(
                        "## {}\n{}\n\n{}",
                        entry.name, entry.description, entry.content
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    }

    async fn memory_write(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        #[derive(Deserialize)]
        struct Args {
            name: String,
            description: String,
            #[serde(rename = "type")]
            memory_type: MemoryType,
            content: String,
            #[serde(default = "default_memory_scope")]
            scope: MemoryScope,
        }
        let Some(memory) = &self.memory else {
            return ToolResult::error("Memory is not configured");
        };
        let args = match serde_json::from_value::<Args>(call.arguments.clone()) {
            Ok(args) => args,
            Err(error) => return ToolResult::error(format!("invalid memory: {error}")),
        };
        if args.scope != MemoryScope::Local
            && !approval
                .approve(call, "memory_write will update persistent user data")
                .await
        {
            return ToolResult::error("memory write was not approved");
        }
        match memory.save(
            args.scope,
            &args.name,
            &args.description,
            args.memory_type,
            &args.content,
        ) {
            Ok(path) => ToolResult::success(format!("saved {}", path.display())),
            Err(error) => ToolResult::error(error.to_string()),
        }
    }

    async fn memory_delete(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(memory) = &self.memory else {
            return ToolResult::error("Memory is not configured");
        };
        let Some(name) = string_arg(&call.arguments, "name") else {
            return ToolResult::error("missing string argument: name");
        };
        if !approval
            .approve(call, "memory_delete will remove persistent user data")
            .await
        {
            return ToolResult::error("memory deletion was not approved");
        }
        match memory.delete(name) {
            Ok(true) => ToolResult::success(format!("deleted memory `{name}`")),
            Ok(false) => ToolResult::error(format!("memory `{name}` was not found")),
            Err(error) => ToolResult::error(error.to_string()),
        }
    }

    async fn read_file(&self, arguments: &Value) -> ToolResult {
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let path = match self.checked_path(path, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let offset = usize_arg(arguments, "offset").unwrap_or(1).max(1);
        let limit = usize_arg(arguments, "limit").unwrap_or(500).clamp(1, 2_000);

        // 单行超长截断：避免单行巨行（压缩 JSON / 长日志）撑爆输出与上下文。
        const MAX_LINE_CHARS: usize = 4_096;
        // 小文件阈值：≤ 2 MiB 全量读入内存、按行索引。
        const SMALL_FILE: u64 = 2 * 1024 * 1024;
        // 大文件默认只读前 64 KiB（约 1.6 万字符 / 4k token），其余用 offset 分批读取。
        const CHUNK: u64 = 64 * 1024;

        use tokio::io::{AsyncBufReadExt, AsyncReadExt};

        let handle = match tokio::fs::File::open(&path).await {
            Ok(handle) => handle,
            Err(error) => {
                return ToolResult::error(format!("failed to read {}: {error}", path.display()));
            }
        };
        let total = match handle.metadata().await {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                return ToolResult::error(format!("failed to stat {}: {error}", path.display()));
            }
        };

        let mut output = String::new();

        if total <= SMALL_FILE {
            // ---- 小文件：全量读入，行级 offset/limit ----
            let mut bytes = Vec::new();
            if let Err(error) = handle.take(total + 1).read_to_end(&mut bytes).await {
                return ToolResult::error(format!("failed to read {}: {error}", path.display()));
            }
            let content = String::from_utf8_lossy(&bytes);
            let total_lines = content.lines().count();
            let mut shown = 0usize;
            for (index, line) in content.lines().enumerate() {
                let lineno = index + 1;
                if lineno < offset {
                    continue;
                }
                if shown >= limit {
                    break;
                }
                output.push_str(&format!("{lineno:>6}  "));
                if line.chars().count() > MAX_LINE_CHARS {
                    let head: String = line.chars().take(MAX_LINE_CHARS).collect();
                    output.push_str(&head);
                    output.push_str(&format!(
                        "…（本行共 {} 字符，已截断）",
                        line.chars().count()
                    ));
                } else {
                    output.push_str(line);
                }
                output.push('\n');
                shown += 1;
            }
            let end = offset + shown - 1;
            if total_lines > end {
                output.push_str(&format!(
                    "…（文件共 {total} 字节 · {total_lines} 行，已显示第 {offset}–{end} 行；继续用 offset={} 读取）",
                    end + 1
                ));
            } else {
                output.push_str(&format!(
                    "（文件共 {total} 字节 · {total_lines} 行，已到末尾）"
                ));
            }
        } else if offset == 1 {
            // ---- 大文件：默认只读前 CHUNK 字节，绝不整读 ----
            let mut bytes = Vec::new();
            if let Err(error) = handle.take(CHUNK).read_to_end(&mut bytes).await {
                return ToolResult::error(format!("failed to read {}: {error}", path.display()));
            }
            let content = String::from_utf8_lossy(&bytes);
            let mut shown = 0usize;
            for (index, line) in content.lines().enumerate() {
                if shown >= limit {
                    break;
                }
                output.push_str(&format!("{:>6}  ", index + 1));
                if line.chars().count() > MAX_LINE_CHARS {
                    let head: String = line.chars().take(MAX_LINE_CHARS).collect();
                    output.push_str(&head);
                    output.push_str(&format!(
                        "…（本行共 {} 字符，已截断）",
                        line.chars().count()
                    ));
                } else {
                    output.push_str(line);
                }
                output.push('\n');
                shown += 1;
            }
            output.push_str(&format!(
                "…（大文件共 {total} 字节，已显示前 {shown} 行（前 {} KiB）；可用 offset/limit 继续分批读取）",
                CHUNK / 1024
            ));
        } else {
            // ---- 大文件：按行跳转到 offset，再读 limit 行 ----
            let mut reader = tokio::io::BufReader::new(handle);
            let mut buf = Vec::new();
            let mut skipped = 0usize;
            while skipped < offset - 1 {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => {
                        return ToolResult::error(format!(
                            "offset {offset} 超出文件末尾（文件共 {total} 字节）"
                        ));
                    }
                    Ok(_) => skipped += 1,
                    Err(error) => {
                        return ToolResult::error(format!(
                            "failed to read {}: {error}",
                            path.display()
                        ));
                    }
                }
            }
            let mut shown = 0usize;
            while shown < limit {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) => {
                        return ToolResult::error(format!(
                            "failed to read {}: {error}",
                            path.display()
                        ));
                    }
                }
                let line = String::from_utf8_lossy(&buf);
                let line = line.strip_suffix('\n').unwrap_or(line.as_ref());
                let line = line.strip_suffix('\r').unwrap_or(line);
                output.push_str(&format!("{:>6}  ", offset + shown));
                if line.chars().count() > MAX_LINE_CHARS {
                    let head: String = line.chars().take(MAX_LINE_CHARS).collect();
                    output.push_str(&head);
                    output.push_str(&format!(
                        "…（本行共 {} 字符，已截断）",
                        line.chars().count()
                    ));
                } else {
                    output.push_str(line);
                }
                output.push('\n');
                shown += 1;
            }
            if shown >= limit {
                output.push_str(&format!(
                    "…（文件共 {total} 字节，已显示第 {offset}–{} 行；继续用 offset={} 读取）",
                    offset + shown - 1,
                    offset + shown
                ));
            } else {
                output.push_str(&format!("（文件共 {total} 字节，已到末尾）"));
            }
        }

        ToolResult::success(self.truncate(output))
    }

    async fn write_file(&self, arguments: &Value) -> ToolResult {
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let Some(content) = string_arg(arguments, "content") else {
            return ToolResult::error("missing string argument: content");
        };
        let path = match self.checked_path(path, true) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        if let Err(error) = self.enforce_write_claim(&path) {
            return ToolResult::error(error);
        }
        if let Some(parent) = path.parent()
            && let Err(error) = tokio::fs::create_dir_all(parent).await
        {
            return ToolResult::error(format!(
                "failed to create directory {}: {error}",
                parent.display()
            ));
        }
        match atomic_write_file(&path, content).await {
            Ok(()) => ToolResult::success(format!(
                "wrote {} bytes to {}",
                content.len(),
                path.display()
            ))
            // 生成物汇总的数据源：工具自己声明真正落盘的文件（宿主绝对路径）。
            .with_artifact(path.display().to_string()),
            Err(error) => ToolResult::error(format!("failed to write {}: {error}", path.display())),
        }
    }

    async fn edit_file(&self, arguments: &Value) -> ToolResult {
        // 批量编辑：edits: [{old_string, new_string, replace_all?}] —— 减少多轮往返。
        if let Some(edits) = arguments.get("edits").and_then(Value::as_array)
            && !edits.is_empty()
        {
            return self.edit_file_batch(arguments, edits).await;
        }
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let Some(old_string) = string_arg(arguments, "old_string") else {
            return ToolResult::error("missing string argument: old_string");
        };
        let Some(new_string) = string_arg(arguments, "new_string") else {
            return ToolResult::error("missing string argument: new_string");
        };
        if old_string.is_empty() {
            return ToolResult::error("old_string must not be empty");
        }
        let path = match self.checked_path(path, true) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        if let Err(error) = self.enforce_write_claim(&path) {
            return ToolResult::error(error);
        }
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(content) => content,
            Err(error) => {
                return ToolResult::error(format!("failed to read {}: {error}", path.display()));
            }
        };
        let matches = content.matches(old_string).count();
        if matches == 0 {
            // 二级：换行 / 行尾空白规范化匹配（Windows CRLF、编辑器自动修剪行尾空格等场景）。
            if let Some((from, to)) = fuzzy_normalized_range(&content, &old_string) {
                let mut updated = String::with_capacity(content.len() + new_string.len());
                updated.push_str(&content[..from]);
                updated.push_str(new_string);
                updated.push_str(&content[to..]);
                return match atomic_write_file(&path, &updated).await {
                    Ok(()) => ToolResult::success(format!("edited {}", path.display()))
                        .with_artifact(path.display().to_string()),
                    Err(error) => {
                        ToolResult::error(format!("failed to edit {}: {error}", path.display()))
                    }
                };
            }
            return ToolResult::error(
                "old_string was not found. 文件可能已变化：请先 use read_file 读取当前内容，\
                 复制与文件完全一致的片段（包含换行与缩进）后再调用 edit_file；\
                 若只需行级修改请改用 apply_patch",
            );
        }
        let replace_all = arguments
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if matches > 1 && !replace_all {
            return ToolResult::error(format!(
                "old_string matched {matches} locations; set replace_all=true or provide more context"
            ));
        }
        let updated = if replace_all {
            content.replace(old_string, new_string)
        } else {
            content.replacen(old_string, new_string, 1)
        };
        match atomic_write_file(&path, &updated).await {
            Ok(()) => ToolResult::success(format!("edited {}", path.display()))
                .with_artifact(path.display().to_string()),
            Err(error) => ToolResult::error(format!("failed to edit {}: {error}", path.display())),
        }
    }

    /// 在同一文件上顺序应用多处替换；任一处失败则整批回滚（未写入）。
    async fn edit_file_batch(&self, arguments: &Value, edits: &[Value]) -> ToolResult {
        let Some(path) = string_arg(arguments, "path") else {
            return ToolResult::error("missing string argument: path");
        };
        let path = match self.checked_path(path, true) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        if let Err(error) = self.enforce_write_claim(&path) {
            return ToolResult::error(error);
        }
        let mut content = match tokio::fs::read_to_string(&path).await {
            Ok(content) => content,
            Err(error) => {
                return ToolResult::error(format!("failed to read {}: {error}", path.display()));
            }
        };
        let mut applied = 0usize;
        for (i, edit) in edits.iter().enumerate() {
            let old = edit
                .get("old_string")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let new = edit
                .get("new_string")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let replace_all = edit
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if old.is_empty() {
                return ToolResult::error(format!("edits[{i}].old_string must not be empty"));
            }
            let count = content.matches(old).count();
            if count == 0 {
                if let Some((from, to)) = fuzzy_normalized_range(&content, old) {
                    let mut next = String::with_capacity(content.len() + new.len());
                    next.push_str(&content[..from]);
                    next.push_str(new);
                    next.push_str(&content[to..]);
                    content = next;
                    applied += 1;
                    continue;
                }
                return ToolResult::error(format!(
                    "edits[{i}].old_string not found; re-read the file and supply exact text"
                ));
            }
            if count > 1 && !replace_all {
                return ToolResult::error(format!(
                    "edits[{i}].old_string matched {count} locations; set replace_all or more context"
                ));
            }
            content = if replace_all {
                content.replace(old, new)
            } else {
                content.replacen(old, new, 1)
            };
            applied += 1;
        }
        match atomic_write_file(&path, &content).await {
            Ok(()) => ToolResult::success(format!(
                "edited {} ({applied} replacements)",
                path.display()
            ))
            .with_artifact(path.display().to_string()),
            Err(error) => ToolResult::error(format!("failed to edit {}: {error}", path.display())),
        }
    }

    /// 按 glob 模式在工作区内查找文件（支持 *、**、?）。
    async fn glob_files(&self, arguments: &Value) -> ToolResult {
        let Some(pattern) = string_arg(arguments, "pattern") else {
            return ToolResult::error("missing string argument: pattern");
        };
        let pattern = pattern.trim().replace('\\', "/");
        if pattern.is_empty() {
            return ToolResult::error("pattern must not be empty");
        }
        let relative = string_arg(arguments, "path").unwrap_or(".");
        let root = match self.checked_path(relative, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let max_results = usize_arg(arguments, "max_results")
            .unwrap_or(200)
            .clamp(1, 2_000);
        let regex = match glob_pattern_to_regex(&pattern) {
            Ok(regex) => regex,
            Err(error) => return ToolResult::error(error),
        };
        let mut matches: Vec<String> = Vec::new();
        for entry in WalkBuilder::new(&root).hidden(false).build().flatten() {
            if matches.len() >= max_results {
                break;
            }
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let rel = self.display_path(entry.path()).replace('\\', "/");
            let rel = rel.trim_start_matches("./");
            if regex.is_match(rel) || regex.is_match(&format!("/{}", rel)) {
                matches.push(rel.to_owned());
            }
        }
        matches.sort();
        if matches.is_empty() {
            return ToolResult::success(format!(
                "no files matched pattern `{pattern}` under {}",
                self.display_path(&root)
            ));
        }
        let truncated = matches.len() >= max_results;
        let mut out = matches.join("\n");
        if truncated {
            out.push_str("\n...[truncated]");
        }
        ToolResult::success(out)
    }

    async fn search(&self, arguments: &Value) -> ToolResult {
        let Some(query) = string_arg(arguments, "query") else {
            return ToolResult::error("missing string argument: query");
        };
        let regex = match Regex::new(query) {
            Ok(regex) => regex,
            Err(error) => return ToolResult::error(format!("invalid regex: {error}")),
        };
        let relative = string_arg(arguments, "path").unwrap_or(".");
        let root = match self.checked_path(relative, false) {
            Ok(path) => path,
            Err(error) => return ToolResult::error(error),
        };
        let max_results = usize_arg(arguments, "max_results")
            .unwrap_or(200)
            .clamp(1, 1_000);
        let mut output = Vec::new();

        for entry in WalkBuilder::new(&root).hidden(false).build().flatten() {
            if output.len() >= max_results {
                break;
            }
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            for (line_index, line) in content.lines().enumerate() {
                if regex.is_match(line) {
                    output.push(format!(
                        "{}:{}:{line}",
                        self.display_path(entry.path()),
                        line_index + 1
                    ));
                    if output.len() >= max_results {
                        break;
                    }
                }
            }
        }

        if output.is_empty() {
            ToolResult::success("no matches")
        } else {
            ToolResult::success(self.truncate(output.join("\n")))
        }
    }

    async fn shell(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(command) = string_arg(&call.arguments, "command") else {
            return ToolResult::error("missing string argument: command");
        };
        match self.policy.assess_shell(command) {
            Decision::Allow => {}
            Decision::Deny(reason) => return ToolResult::error(reason),
            Decision::Ask(reason) => {
                if !approval.approve(call, &reason).await {
                    return ToolResult::error("shell command was not approved");
                }
            }
        }
        println!("[tool] exec: {command}");
        if Self::is_self_kill_command(command) {
            return ToolResult::error("拒绝执行：该命令会终止 Coomi 引擎自身。");
        }

        let timeout_ms = u64_arg(&call.arguments, "timeout_ms")
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, 300_000);
        let environment = call.arguments.get("environment").and_then(Value::as_str);
        let mut process = match self
            .processes
            .runtime_shell(&self.cwd, command, environment)
        {
            Ok(Some(process)) => process,
            Ok(None) => platform_shell(command),
            Err(error) => {
                return ToolResult::error(format!("failed to prepare runtime shell: {error:#}"));
            }
        };
        process
            .current_dir(&self.cwd)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x0000_0200); // CREATE_NEW_PROCESS_GROUP
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.process_group(0);
        }
        let output = match tokio::time::timeout(Duration::from_millis(timeout_ms), process.output())
            .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => return ToolResult::error(format!("failed to start shell: {error}")),
            Err(_) => return ToolResult::error(format!("shell timed out after {timeout_ms} ms")),
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let rendered = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
            (true, true) => format!("exit code: {}", output.status),
            (false, true) => stdout.into_owned(),
            (true, false) => stderr.into_owned(),
            (false, false) => format!("{stdout}\n[stderr]\n{stderr}"),
        };
        if output.status.success() {
            ToolResult::success(self.truncate(rendered))
        } else {
            ToolResult::error(self.truncate(format!("exit code: {}\n{rendered}", output.status)))
        }
    }

    /// 在工作区执行只读 git 查询（status/diff/log），失败给出明确提示。
    async fn git_readonly(&self, args: &[&str]) -> Result<String, String> {
        let cmd = format!("git {}", args.join(" "));
        let mut process = match self.processes.runtime_shell(&self.cwd, &cmd, None) {
            Ok(Some(p)) => p,
            Ok(None) => platform_shell(&cmd),
            Err(e) => return Err(format!("runtime shell: {e:#}")),
        };
        process
            .current_dir(&self.cwd)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = process
            .output()
            .await
            .map_err(|e| format!("git 执行失败: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() && stdout.trim().is_empty() {
            return Err(if stderr.trim().is_empty() {
                format!(
                    "git {} 失败（exit={:?}）",
                    args.join(" "),
                    output.status.code()
                )
            } else {
                stderr.trim().to_owned()
            });
        }
        let text = if stdout.trim().is_empty() {
            stderr.into_owned()
        } else if stderr.trim().is_empty() {
            stdout.into_owned()
        } else {
            format!("{stdout}\n[stderr]\n{stderr}")
        };
        Ok(text)
    }

    async fn git_status(&self, _arguments: &Value) -> ToolResult {
        match self.git_readonly(&["status", "--short", "--branch"]).await {
            Ok(text) => ToolResult::success(self.truncate(text)),
            Err(e) => ToolResult::error(e),
        }
    }

    async fn git_diff(&self, arguments: &Value) -> ToolResult {
        let mut args: Vec<String> = vec!["diff".into()];
        if arguments
            .get("staged")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            args.push("--cached".into());
        }
        if let Some(path) = arguments.get("path").and_then(Value::as_str) {
            args.push("--".into());
            args.push(path.to_owned());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match self.git_readonly(&refs).await {
            Ok(text) => {
                if text.trim().is_empty() {
                    ToolResult::success("没有差异（工作区干净）")
                } else {
                    ToolResult::success(self.truncate(text))
                }
            }
            Err(e) => ToolResult::error(e),
        }
    }

    async fn git_log(&self, arguments: &Value) -> ToolResult {
        let n = usize_arg(arguments, "n").unwrap_or(15).clamp(1, 100);
        let count = format!("-{n}");
        let args = ["log", &count.as_str(), "--oneline", "--decorate"];
        match self.git_readonly(&args).await {
            Ok(text) => ToolResult::success(self.truncate(text)),
            Err(e) => ToolResult::error(e),
        }
    }

    async fn git_commit(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let message = match string_arg(&call.arguments, "message") {
            Some(m) if !m.trim().is_empty() => m.trim().to_owned(),
            _ => return ToolResult::error("missing string argument: message"),
        };
        if !approval
            .approve(call, &format!("git commit -m {message}"))
            .await
        {
            return ToolResult::error("git_commit was not approved");
        }
        let add_all = call
            .arguments
            .get("add_all")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut script = String::new();
        if add_all {
            script.push_str("git add -A && ");
        }
        script.push_str(&format!(
            "git commit -m \"{}\"",
            message.replace('\\', "\\\\").replace('"', "\\\"")
        ));
        let commit_call = ToolCall {
            id: format!("git_{}", uuid::Uuid::new_v4()),
            name: "shell".into(),
            arguments: serde_json::json!({ "command": script }),
        };
        // 已经过用户批准，直接调用 shell 内部路径
        struct AlwaysAllow;
        #[async_trait::async_trait]
        impl ApprovalHandler for AlwaysAllow {
            async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
                true
            }
        }
        match self.shell(&commit_call, &AlwaysAllow).await {
            r if r.success => ToolResult::success(self.truncate(r.output)),
            r => ToolResult::error(self.truncate(r.output)),
        }
    }

    async fn git_branch(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let action = string_arg(&call.arguments, "action").unwrap_or("list");
        match action {
            "list" | "ls" => match self.git_readonly(&["branch", "-vv"]).await {
                Ok(t) => ToolResult::success(self.truncate(t)),
                Err(e) => ToolResult::error(e),
            },
            "create" | "checkout" | "switch" => {
                let name = match string_arg(&call.arguments, "name") {
                    Some(n) if !n.trim().is_empty() => n.trim().to_owned(),
                    _ => return ToolResult::error("create/checkout 需要 name"),
                };
                if !approval
                    .approve(call, &format!("git switch/checkout {name}"))
                    .await
                {
                    return ToolResult::error("git_branch was not approved");
                }
                let script = format!(
                    "git switch \"{n}\" 2>/dev/null || git checkout \"{n}\"",
                    n = name.replace('"', "\\\"")
                );
                let branch_call = ToolCall {
                    id: format!("git_{}", uuid::Uuid::new_v4()),
                    name: "shell".into(),
                    arguments: serde_json::json!({ "command": script }),
                };
                struct AlwaysAllow;
                #[async_trait::async_trait]
                impl ApprovalHandler for AlwaysAllow {
                    async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
                        true
                    }
                }
                match self.shell(&branch_call, &AlwaysAllow).await {
                    r if r.success => ToolResult::success(self.truncate(r.output)),
                    r => ToolResult::error(self.truncate(r.output)),
                }
            }
            other => ToolResult::error(format!(
                "未知 action `{other}`，支持 list | create | checkout"
            )),
        }
    }

    fn checked_path(&self, value: &str, write: bool) -> Result<PathBuf, String> {
        let requested_namespace = match string_namespace(value) {
            Some(namespace) => Some(namespace),
            None => None,
        };
        let resolved = self
            .path_map
            .resolve(value, requested_namespace)
            .map_err(|error| error.to_string())?;
        let path = self
            .policy
            .resolve_path(&resolved.host_path)
            .map_err(|error| error.to_string())?;
        // 规范化：解析符号链接后再做权限/认领校验，避免 ../ 或 symlink 绕过。
        let path = path.canonicalize().unwrap_or(path);
        let decision = if write {
            self.policy.assess_write(&path)
        } else {
            self.policy.assess_read(&path)
        };
        match decision {
            Decision::Allow => Ok(path),
            Decision::Ask(reason) | Decision::Deny(reason) => Err(reason),
        }
    }

    fn display_path(&self, path: &std::path::Path) -> String {
        self.path_map
            .resolve(path, Some(PathNamespace::Host))
            .map(|resolved| resolved.guest_path.display().to_string())
            .unwrap_or_else(|_| path.display().to_string())
    }

    fn truncate(&self, mut output: String) -> String {
        if output.len() <= self.max_output {
            return output;
        }
        let mut end = self.max_output;
        while !output.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        output.truncate(end);
        output.push_str("\n[output truncated]");
        output
    }
}

impl CoreTools {
    /// 内置工具清单（不含按会话/团队/记忆/MCP 动态追加的部分）。
    /// 同时作为工具质量层参数校验的 schema 来源（只构建一次，避免每次调用重建整张表）。
    fn builtin_specs() -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "read_file".into(),
                description: "Read a UTF-8 text file with stable line numbers. Files over 2 MiB are read in chunks: by default only the first 64 KiB is returned; pass offset (1-based line number) and limit to continue reading further chunks. Lines longer than 4096 chars are truncated. Use for log files, configs, and any large text file.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "offset": {"type": "integer", "minimum": 1},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 2000}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "write_file".into(),
                description: "Create or replace a UTF-8 text file inside the workspace.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "edit_file".into(),
                description: "Replace text fragments in a workspace file. Call read_file first and copy old_string byte-for-byte from the current content (exact newlines and indentation). For multiple replacements in one call, pass edits: [{old_string, new_string, replace_all?}]. Prefer apply_patch for whole-line changes.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                        "replace_all": {"type": "boolean"},
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "old_string": {"type": "string"},
                                    "new_string": {"type": "string"},
                                    "replace_all": {"type": "boolean"}
                                },
                                "required": ["old_string", "new_string"]
                            }
                        }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "glob_files".into(),
                description: "Find workspace files matching a glob pattern (supports *, **, ?). Example patterns: **/*.rs, src/**/*.ts, *.md. Returns relative paths.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string"},
                        "path": {"type": "string"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 2000}
                    },
                    "required": ["pattern"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "search".into(),
                description: "Search workspace text files with a regular expression.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "path": {"type": "string"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 1000}
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "shell".into(),
                description: "Run one shell command in the workspace under the active policy."
                    .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "environment": {"type": "string", "enum": shell_env_choices()},
                        "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 300000}
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "git_status".into(),
                description: "Show git working tree status (short + branch). Read-only.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "git_diff".into(),
                description: "Show git diff (optionally staged or for one path). Read-only.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "staged": {"type": "boolean"}
                    },
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "git_log".into(),
                description: "Show recent git log (--oneline). Read-only.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "n": {"type": "integer", "minimum": 1, "maximum": 100}
                    },
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "git_commit".into(),
                description: "git add -A && git commit -m. Requires user approval.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "message": {"type": "string"},
                        "add_all": {"type": "boolean"}
                    },
                    "required": ["message"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "git_branch".into(),
                description: "List branches, or create/checkout a branch. Write actions require approval.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["list", "create", "checkout", "switch"]},
                        "name": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "list_dir".into(),
                description: "List files and directories under a workspace path.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "depth": {"type": "integer", "minimum": 1, "maximum": 8},
                        "max_entries": {"type": "integer", "minimum": 1, "maximum": 2000}
                    },
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "grep_files".into(),
                description: "Search workspace text files with a regular expression.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "path": {"type": "string"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 1000}
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "local_shell".into(),
                description: "Run and manage a persistent local shell process. Use exec to start, write for stdin, wait for incremental output, and terminate to stop it. For dependency or tool downloads, start with exec and yield-time_ms 0, continue independent work, then use wait before the first dependent step.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": ["exec", "write", "wait", "terminate"]},
                        "command": {"type": "string"},
                        "environment": {"type": "string", "enum": shell_env_choices()},
                        "session_id": {"type": "string"},
                        "input": {"type": "string"},
                        "close_stdin": {"type": "boolean"},
                        "yield_time_ms": {"type": "integer", "minimum": 0, "maximum": 60000}
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "runtime_doctor".into(),
                description: "Report Host, Termux, and ProotLinux availability plus the active path mapping and SSH runtime directories.".into(),
                parameters: json!({"type": "object", "properties": {}, "additionalProperties": false}),
            },
            ToolSpec {
                name: "apply_patch".into(),
                description: "Atomically apply a Coomi patch containing add, update, move, and delete file operations.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {"patch": {"type": "string"}},
                    "required": ["patch"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "web_search".into(),
                description: "Search the web and return ranked result links with short snippets. Use the fetch tool to read the full content of a result page. If this tool reports unavailable, report the failure once and do not loop command-line searches to replace it; direct downloads and known-URL access via shell tools remain allowed.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 10}
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "fetch".into(),
                description: "Fetch a web page over HTTP(S) and return its readable text content. Use it to read the pages found by web_search, or to access any public web page. Only http/https URLs are allowed; JavaScript is not executed.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "max_length": {"type": "integer", "minimum": 1000, "maximum": 100000}
                    },
                    "required": ["url"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "ocr_image".into(),
                description: "Extract text from a local image via local tesseract OCR (default chi_sim+eng). Use for screenshots and scanned Chinese/English text.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Absolute or workspace-relative image path"},
                        "lang": {"type": "string", "description": "Tesseract language, default chi_sim+eng"}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "install_ocr_deps".into(),
                description: "Install tesseract-ocr + Chinese language packs in Proot via apt. Run once when ocr_image says tesseract not found.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "ssh_exec".into(),
                description: "Run a command on a remote host over SSH using the built-in pure-Rust client (no system openssh required). Prefer private-key auth from ~/.ssh (id_ed25519/id_rsa); you may also pass password or private_key_pem. Supports user@host and host:port. Requires user approval.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "host": {"type": "string", "description": "user@hostname, hostname, or hostname:port"},
                        "command": {"type": "string"},
                        "user": {"type": "string", "description": "SSH username if not embedded in host"},
                        "port": {"type": "integer", "minimum": 1, "maximum": 65535},
                        "private_key": {"type": "string", "description": "Path to private key (default: auto-detect ~/.ssh/id_ed25519 etc)"},
                        "private_key_pem": {"type": "string", "description": "Inline OpenSSH private key PEM text"},
                        "password": {"type": "string", "description": "Password auth if key auth fails"},
                        "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 300000}
                    },
                    "required": ["host", "command"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "view_image".into(),
                description: "Load a local PNG, JPEG, GIF, or WebP image for visual inspection.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "extract_video_frames".into(),
                description: "Extract key frames from a local video (mp4/webm/mov) for visual inspection. Use this when the user shares a video and the current model cannot accept video directly: strategy=fps samples uniformly (default), strategy=scene uses PySceneDetect if installed. Returns frame image paths; inspect them with view_image.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "strategy": {"type": "string", "enum": ["fps", "scene"]},
                        "max_frames": {"type": "integer", "minimum": 1, "maximum": 20}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "show_image".into(),
                description: "Display a local PNG, JPEG, GIF, or WebP image to the user in the interface (renders a large preview; the user can open it full-screen or save it). Use this when the user asks to see, show, or preview an image. Unlike view_image, this does not require the model to have vision capabilities.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "request_user_input".into(),
                description: "Ask the user one to five short questions in one batch and wait until the batch is submitted. Each question has three to seven suggested choices; the UI also provides Skip and a custom answer. The response contains both the selected option label (answer) and an optional free-text comment the user can add (reply/additional note).".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "questions": {
                            "type": "array", "minItems": 1, "maxItems": 5,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string"},
                                    "header": {"type": "string"},
                                    "question": {"type": "string"},
                                    "options": {
                                        "type": "array", "minItems": 3, "maxItems": 7,
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "label": {"type": "string"},
                                                "description": {"type": "string"},
                                                "allow_custom": {"type": "boolean", "default": false},
                                                "custom_prompt": {"type": "string"}
                                            },
                                            "required": ["label", "description"],
                                            "additionalProperties": false
                                        }
                                    }
                                },
                                "required": ["id", "header", "question", "options"],
                                "additionalProperties": false
                            }
                        },
                        "auto_resolution_ms": {"type": "integer", "minimum": 60000, "maximum": 240000}
                    },
                    "required": ["questions"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "ask_user".into(),
                description: "Ask the user one short question and wait for the answer. Use this when a single decision blocks progress. options are suggested answers (empty = free-form input); multi allows more than one selection; allow_custom lets the user type an answer that is not in options; timeout_ms caps the wait (omit it to wait indefinitely). The UI also offers Skip. Returns the selected answer(s) plus an optional comment.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "question": {"type": "string"},
                        "options": {
                            "type": "array",
                            "maxItems": 12,
                            "items": {"type": "string"}
                        },
                        "multi": {"type": "boolean", "default": false},
                        "allow_custom": {"type": "boolean", "default": true},
                        "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 3600000}
                    },
                    "required": ["question"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "request_file_import".into(),
                description: "Ask Android to let the user choose one or more phone files. The selected files are copied into the Agent-readable inbox and their local paths are returned. Do not ask the user to use shell file pickers.".into(),
                parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
            },
            ToolSpec {
                name: "request_file_export".into(),
                description: "Ask Android to export a local Agent file through the system document picker. Use this for APKs or other binary artifacts that the user needs on the phone.".into(),
                parameters: json!({"type":"object","properties":{"path":{"type":"string"},"suggested_name":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            },
            ToolSpec {
                name: "request_save_as".into(),
                description: "Ask the user to pick a destination for an existing local file through the native Save As dialog. The engine only sends the request event and never writes any file itself; the file must already exist. Only available when the allowSaveAsRequest capability is enabled.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "suggested_name": {"type": "string"}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "update_plan".into(),
                description: "Create or update the current task plan. At most one step may be in progress.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "explanation": {"type": "string"},
                        "steps": {
                            "type": "array", "minItems": 1,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "step": {"type": "string"},
                                    "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                                },
                                "required": ["step", "status"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["steps"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "create_loop".into(),
                description: "Create a persistent autonomous Loop objective when no active Loop exists.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "objective": {"type": "string"},
                        "token_budget": {"type": "integer", "minimum": 1}
                    },
                    "required": ["objective"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "get_loop".into(),
                description: "Read the current Loop objective, status, budget, and usage.".into(),
                parameters: json!({"type": "object", "properties": {}, "additionalProperties": false}),
            },
            ToolSpec {
                name: "update_loop".into(),
                description: "Update the persistent Loop objective or status. Blocking requires the same condition across three turns.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "status": {"type": "string", "enum": ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]},
                        "objective": {"type": "string"}
                    },
                    "required": ["status"],
                    "additionalProperties": false
                }),
            },
            // === 批 5：新增工具 ===
            ToolSpec {
                name: "context_search".into(),
                description: "Search this conversation's earlier messages (history) for relevant context: decisions, file paths, errors, or facts mentioned before compaction. Use it instead of guessing or re-asking the user.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Keywords or a phrase to find in earlier messages"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                        "role": {"type": "string", "enum": ["user", "assistant", "tool", "system"]}
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "file_search".into(),
                description: "Search workspace files by name or by content. Skips noise directories (.git, node_modules, target, dist, build, vendor) and returns at most max_results hits. mode=name matches file names, mode=content matches file contents, mode=auto tries the file name first.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Text to look for in file names or contents"},
                        "mode": {"type": "string", "enum": ["auto", "name", "content"]},
                        "path": {"type": "string", "description": "Directory to search, defaults to the working directory"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 200}
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            },
            ToolSpec {
                name: "web_fetch".into(),
                description: "Fetch a http(s) URL and return readable text. Size-capped, timed out, and reports non-200 responses as readable errors. Use for documentation, API responses, and pages found with web_search.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "max_length": {"type": "integer", "minimum": 1000, "maximum": 100000}
                    },
                    "required": ["url"],
                    "additionalProperties": false
                }),
            },
        ]
    }

    /// 内置工具的参数 schema 表（懒加载一次）。
    fn builtin_parameter_schemas() -> &'static HashMap<String, Value> {
        static SCHEMAS: std::sync::OnceLock<HashMap<String, Value>> = std::sync::OnceLock::new();
        SCHEMAS.get_or_init(|| {
            Self::builtin_specs()
                .into_iter()
                .map(|spec| (spec.name, spec.parameters))
                .collect()
        })
    }

    /// 带质量层的单次工具执行：并发闸 + 每工具超时 + 瞬时失败有界重试。
    /// quality 为 None 时退化为原来的直接调用。
    async fn call_with_quality(
        &self,
        canonical: &str,
        call: &ToolCall,
        approval: &dyn ApprovalHandler,
        quality: Option<&ToolQuality>,
    ) -> ToolResult {
        // 质量层被关掉（toolEnhance=false）时，以前这里是「直接 dispatch、没有任何超时」——
        // 任何一个卡住的工具都会让这一轮永远不返回：引擎进程还活着、CPU 为 0、端口还在监听，
        // 但所有请求都排队不响应（用户侧表现为「任务莫名停 + 引擎已断开 + 反复重启」）。
        // 所以**兜底超时必须无条件生效**：质量层在就用它的每工具预算，不在就用这里的硬上限。
        let Some(quality) = quality else {
            return match tokio::time::timeout(FALLBACK_TOOL_TIMEOUT, self.dispatch(call, approval)).await {
                Ok(result) => result,
                Err(_) => ToolResult::error(format!(
                    "工具 {} 执行超时（{} 秒）已中止（未启用工具增强层，使用兜底超时）。",
                    call.name,
                    FALLBACK_TOOL_TIMEOUT.as_secs()
                )),
            };
        };
        let mut attempt = 0_u32;
        loop {
            // 同一轮内并行工具调用的并发上限。
            let _permit = quality.acquire().await;
            let result = match quality.timeout_for(canonical) {
                Some(timeout) => {
                    match tokio::time::timeout(timeout, self.dispatch(call, approval)).await {
                        Ok(result) => result,
                        Err(_) => ToolResult::error(format!(
                            "工具 {canonical} 执行超时（{} 秒）已中止。可缩小请求范围或换用更精确的参数后重试。",
                            timeout.as_secs()
                        )),
                    }
                }
                None => self.dispatch(call, approval).await,
            };
            if !quality.should_retry(canonical, &result, attempt) {
                // 写操作成功即失效只读缓存，保证「先读后写」不会读到旧内容。
                if result.success && !quality.is_cacheable(canonical) {
                    quality.invalidate();
                }
                return result;
            }
            quality.note_retry();
            attempt = attempt.saturating_add(1);
            let delay = quality.backoff(attempt);
            eprintln!("[tool-quality] {canonical} 瞬时失败，第 {attempt} 次重试（{} ms 后）", delay.as_millis());
            tokio::time::sleep(delay).await;
        }
    }
}

#[async_trait]
impl ToolRuntime for CoreTools {
    fn specs(&self) -> Vec<ToolSpec> {
        let mut specs = Self::builtin_specs();
        // 能力开关：关掉的工具直接不进清单（模型看不到就不会调），
        // 参数 schema 仍留在 builtin_parameter_schemas 里，防止漏关时参数校验失效。
        if !self.ask_user {
            specs.retain(|spec| spec.name != "ask_user");
        }
        if !self.save_as_request {
            specs.retain(|spec| spec.name != "request_save_as");
        }
        if self.skills_directory.is_some() {
            specs.extend([
                ToolSpec {
                    name: "list_skills".into(),
                    description: "List installed Skills that can be loaded on demand.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "read_skill".into(),
                    description: "Load the full instructions for one installed Skill.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {"name": {"type": "string"}},
                        "required": ["name"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "list_mcp".into(),
                    description: "List configured and enabled MCP servers with their transport. Useful before calling their tools.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                },
            ]);
        }
        if self.config_home.is_some() {
            specs.extend([
                ToolSpec {
                    name: "configure_mcp".into(),
                    description: "Install a curated MCP server or create/repair one Coomi MCP server configuration. Use catalog_id for curated entries; otherwise provide name and config.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "catalog_id": {"type": "string", "enum": ["filesystem", "git", "memory", "playwright", "github"]},
                            "values": {
                                "type": "object",
                                "additionalProperties": {"type": "string"}
                            },
                            "name": {"type": "string"},
                            "config": {
                                "type": "object",
                                "description": "MCP server object containing transport and command/args or url",
                                "additionalProperties": true
                            }
                        },
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "install_skill".into(),
                    description: "Install a curated Coomi Skill by catalog_id, or install from a local directory or GitHub repository URL using source.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "catalog_id": {"type": "string", "enum": ["frontend-design", "webapp-testing", "code-review", "security-review", "react-nextjs", "api-design", "git-workflow", "technical-writing"]},
                            "source": {"type": "string"}
                        },
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "uninstall_skill".into(),
                    description: "Permanently uninstall a Skill by name: deletes its directory under the Coomi skills folder and removes the config/skills.json entry. Cannot be undone.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Installed Skill name, e.g. the name shown by list_skills"}
                        },
                        "required": ["name"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "uninstall_mcp".into(),
                    description: "Permanently uninstall an MCP server by name: removes its entry from config/mcp_servers.json. Cannot be undone.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Configured MCP server name"}
                        },
                        "required": ["name"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "list_workflows".into(),
                    description: "List all registered executable workflows by id.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "create_workflow".into(),
                    description: "Define and save a new workflow. Provide a full workflow JSON object with id, name, steps (each with id, action, depends_on).".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "steps": {"type": "array"},
                            "model_isolation": {"type": "boolean"}
                        },
                        "required": ["id", "name", "steps"],
                        "additionalProperties": true
                    }),
                },
                ToolSpec {
                    name: "get_workflow".into(),
                    description: "Read and pretty-print one workflow definition by id.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Workflow id"}
                        },
                        "required": ["id"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "save_workflow".into(),
                    description: "Overwrite/update an existing workflow definition. Provide the full workflow JSON object.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"},
                            "steps": {"type": "array"}
                        },
                        "required": ["id", "name", "steps"],
                        "additionalProperties": true
                    }),
                },
                ToolSpec {
                    name: "delete_workflow".into(),
                    description: "Delete a workflow definition and its registration by id.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Workflow id"}
                        },
                        "required": ["id"],
                        "additionalProperties": false
                    }),
                },
            ]);
        }
        if self.agent_scheduler.is_some() {
            specs.extend([
                ToolSpec {
                    name: "spawn_agent".into(),
                    description: format!(
                        "Spawn a background Coomi sub-agent with an optional fork of parent history. {}",
                        self.agent_scheduler
                            .as_ref()
                            .map(|scheduler| scheduler.sub_agent_summary())
                            .unwrap_or_default()
                    ),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "task": {"type": "string"},
                            "fork_turns": {"type": "string", "description": "none, all, or a positive integer"},
                            "sub_agent_id": {"type": "string", "description": "Optional ID from the configured global sub-agent list"}
                        },
                        "required": ["task"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "wait_agent".into(),
                    description: "Wait for selected background agents and return their latest status and output.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "ids": {"type": "array", "items": {"type": "string"}},
                            "timeout_ms": {"type": "integer", "minimum": 10, "maximum": 3600000}
                        },
                        "required": ["ids"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "close_agent".into(),
                    description: "Close a background agent, cancelling it if still running.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {"id": {"type": "string"}},
                        "required": ["id"],
                        "additionalProperties": false
                    }),
                },
                ToolSpec {
                    name: "message_agent".into(),
                    description: "Send a message to another collaborator by agent_id. The message is injected into that agent's ongoing turn so it can react and continue.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "agent_id": {"type": "string", "description": "The teammate's role id"},
                            "content": {"type": "string"},
                            "from": {"type": "string", "description": "Your role name (optional)"}
                        },
                        "required": ["agent_id", "content"],
                        "additionalProperties": false
                    }),
                },
            ]);
        }
        if self.team_files_query.is_some() {
            specs.push(ToolSpec {
                name: "team_files".into(),
                description: "Query the shared file activity log: which teammate created/downloaded/read/wrote which file. Use before starting work to avoid duplicating or clobbering a teammate's files.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "agent_id": {"type": "string", "description": "Optional: only show activity from this teammate"},
                        "path": {"type": "string", "description": "Optional: only show activity for this file path"},
                        "action": {"type": "string", "description": "Optional: read/write/edit/patch/download"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 200}
                    },
                    "additionalProperties": false
                }),
            });
        }
        if self.team_status_query.is_some() {
            specs.push(ToolSpec {
                name: "team_status".into(),
                description: "Peek at what a teammate (or the whole team) is currently doing: status, latest output, recent tool calls, and recently touched files. Pass agent_id to inspect one teammate; omit for a whole-team summary.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "agent_id": {"type": "string", "description": "Optional: the teammate to inspect; omit for all"}
                    },
                    "additionalProperties": false
                }),
            });
        }
        if self.team_inbox_query.is_some() {
            specs.push(ToolSpec {
                name: "team_inbox".into(),
                description: "Pull messages that other teammates have sent to you (the shared team inbox). Use to catch up on requests addressed to you before finishing your sub-task.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "mark_read": {"type": "boolean", "description": "Whether to mark returned messages as read (default true)"}
                    },
                    "additionalProperties": false
                }),
            });
        }
        // 计划项认领：协同角色始终可用（不依赖 inbox 配置）。
        if self.own_agent_id.is_some() {
            specs.push(ToolSpec {
                name: "claim_task".into(),
                description: "Claim ownership of a collaboration plan item so teammates do not duplicate work. Appends to .coomi/collab/claims.md. Always claim before implementing a non-trivial sub-task.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "task": {"type": "string", "description": "One-line description of the plan item you are claiming"}
                    },
                    "required": ["task"],
                    "additionalProperties": false
                }),
            });
            specs.push(ToolSpec {
                name: "list_claims".into(),
                description: "List plan items already claimed by teammates (from .coomi/collab/claims.md). Check before claiming to avoid duplicates.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            });
            specs.push(ToolSpec {
                name: "wait_for_file".into(),
                description: "Block until a shared workspace file exists and is non-empty (e.g. .coomi/collab/api-contract.md from a teammate). Returns error on timeout. Use before implementing dependent work.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 300000}
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            });
        }
        if let Some(runtime) = &self.mcp_runtime {
            specs.extend(runtime.specs());
        }
        if self.memory.is_some() {
            specs.extend(memory_specs());
        }
        // 别名去重：下面这几个名字与别的工具**执行路径完全相同**（见 call() 里的 `| ` 分支），
        // 同时发给模型只会让它多一个要考虑的选项 —— Claude Code 的经验是"加工具的门槛要很高"。
        // 执行端仍然接受旧名字，所以技能 / 插件 / 历史提示里的引用不会失效。
        const ALIAS_DUPLICATES: [&str; 3] = ["search", "fetch", "request_user_input"];
        specs.retain(|spec| !ALIAS_DUPLICATES.contains(&spec.name.as_str()));
        specs
    }

    async fn call(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let mut effective_call = call.clone();
        let mut additional_context = String::new();
        if let Some(hooks) = &self.hooks {
            let outcome = match hooks
                .run(
                    HookEvent::PreToolUse,
                    Some(&call.name),
                    json!({"tool_name": call.name, "arguments": call.arguments, "cwd": self.cwd}),
                )
                .await
            {
                Ok(outcome) => outcome,
                Err(error) => {
                    return ToolResult::error(format!("PreToolUse hook failed: {error:#}"));
                }
            };
            if !outcome.allow {
                return ToolResult::error(if outcome.reason.is_empty() {
                    "PreToolUse hook denied the call".into()
                } else {
                    outcome.reason
                });
            }
            if let Some(arguments) = outcome.arguments {
                if !arguments.is_object() {
                    return ToolResult::error("PreToolUse hook arguments must be a JSON object");
                }
                effective_call.arguments = arguments;
            }
            additional_context = outcome.additional_context;
        }

        let canonical = Self::canonical_tool_name(effective_call.name.as_str()).to_owned();
        let quality = self.quality.clone();
        // 工具质量层①：参数按 schema 校验，缺参/类型错给可读错误（不 panic、不 500）。
        if quality.is_some()
            && let Some(schema) = Self::builtin_parameter_schemas().get(&canonical)
            && let Err(message) =
                crate::quality::validate_arguments(&canonical, schema, &effective_call.arguments)
        {
            return ToolResult::error(message);
        }
        // 工具质量层⑥：只读结果 LRU 缓存（有 TTL，写操作成功后整体失效）。
        let cache_key = quality.as_ref().and_then(|quality| {
            quality
                .is_cacheable(&canonical)
                .then(|| quality.cache_key(&canonical, &effective_call.arguments, &self.cwd.display().to_string()))
        });
        let cache_hit = cache_key
            .as_ref()
            .and_then(|key| quality.as_ref().and_then(|quality| quality.cached(key)));
        let mut result = match cache_hit {
            Some(cached) => cached,
            None => {
                // 工具质量层②③④：并发上限 + 每工具超时 + 瞬时失败有界重试。
                let result = self
                    .call_with_quality(
                        &canonical,
                        &effective_call,
                        approval,
                        quality.as_deref(),
                    )
                    .await;
                if let (Some(quality), Some(key)) = (quality.as_ref(), cache_key.as_ref()) {
                    quality.store(key, &result);
                }
                result
            }
        };
        if let Some(hooks) = &self.hooks {
            let outcome = match hooks
                .run(
                    HookEvent::PostToolUse,
                    Some(&effective_call.name),
                    json!({
                        "tool_name": effective_call.name,
                        "arguments": effective_call.arguments,
                        "result": {"success": result.success, "output": result.output}
                    }),
                )
                .await
            {
                Ok(outcome) => outcome,
                Err(error) => {
                    return ToolResult::error(format!("PostToolUse hook failed: {error:#}"));
                }
            };
            if let Some(value) = outcome.result {
                if let Some(output) = value.as_str() {
                    result.output = output.to_owned();
                } else if let Some(output) = value.get("output").and_then(Value::as_str) {
                    result.output = output.to_owned();
                    if let Some(success) = value.get("success").and_then(Value::as_bool) {
                        result.success = success;
                    }
                }
            }
            if !outcome.additional_context.trim().is_empty() {
                if !additional_context.is_empty() {
                    additional_context.push_str("\n\n");
                }
                additional_context.push_str(&outcome.additional_context);
            }
        }
        if !additional_context.trim().is_empty() {
            result.additional_context = Some(additional_context);
        }
        // 工具质量层⑤：结果裁剪，超限写临时文件并返回路径。
        if let Some(quality) = quality.as_ref() {
            let output = std::mem::take(&mut result.output);
            result.output = quality.trim_output(&canonical, output);
        }
        result
    }

    async fn lifecycle(&self, event: &str, payload: Value) -> Result<Option<String>, String> {
        let Some(hooks) = &self.hooks else {
            return Ok(None);
        };
        let event = match event {
            "session_start" => HookEvent::SessionStart,
            "turn_start" => HookEvent::TurnStart,
            "turn_end" => HookEvent::TurnEnd,
            other => return Err(format!("unknown hook lifecycle event: {other}")),
        };
        let outcome = hooks
            .run(event, None, payload)
            .await
            .map_err(|error| format!("{error:#}"))?;
        if !outcome.allow {
            return Err(if outcome.reason.is_empty() {
                format!("{event:?} hook denied execution")
            } else {
                outcome.reason
            });
        }
        Ok((!outcome.additional_context.trim().is_empty()).then_some(outcome.additional_context))
    }
}

const fn default_memory_scope() -> MemoryScope {
    MemoryScope::Project
}

fn memory_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "memory_list".into(),
            description: "List persistent memories using local, project, then global precedence.".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ToolSpec {
            name: "memory_read".into(),
            description: "Read one persistent memory by name.".into(),
            parameters: json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}),
        },
        ToolSpec {
            name: "memory_search".into(),
            description: "Search persistent memories for relevant project or user context.".into(),
            parameters: json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"],"additionalProperties":false}),
        },
        ToolSpec {
            name: "memory_write".into(),
            description: "Create or update a durable memory. Prefer project scope unless the fact belongs in the repository or applies globally.".into(),
            parameters: json!({"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"type":{"type":"string","enum":["user","feedback","project","reference"]},"content":{"type":"string"},"scope":{"type":"string","enum":["local","project","global"]}},"required":["name","description","type","content"],"additionalProperties":false}),
        },
        ToolSpec {
            name: "memory_delete".into(),
            description: "Delete the highest-precedence persistent memory with this name.".into(),
            parameters: json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}),
        },
    ]
}

/// 会话历史里的角色名（context_search 展示用）。
fn role_name(role: coomi_engine::Role) -> &'static str {
    match role {
        coomi_engine::Role::User => "user",
        coomi_engine::Role::Assistant => "assistant",
        coomi_engine::Role::Tool => "tool",
        coomi_engine::Role::System => "system",
    }
}

/// 截取命中片段：以首个命中词为中心取一段可读文本。
fn history_snippet(content: &str, terms: &[String], width: usize) -> String {
    let lowered = content.to_lowercase();
    let position = terms
        .iter()
        .filter(|term| term.chars().count() >= 2)
        .filter_map(|term| lowered.find(term.as_str()))
        .min();
    let mut start = position.map_or(0, |position| position.saturating_sub(width / 3));
    while start > 0 && !content.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + width).min(content.len());
    while end < content.len() && !content.is_char_boundary(end) {
        end += 1;
    }
    let slice = content[start..end].replace(['\n', '\r'], " ");
    let slice = slice.split_whitespace().collect::<Vec<_>>().join(" ");
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < content.len() { "…" } else { "" };
    format!("{prefix}{slice}{suffix}")
}

/// 非 200 响应的可读错误（web_fetch / fetch 共用）。
fn http_status_message(url: &reqwest::Url, status: reqwest::StatusCode) -> String {
    let hint = match status.as_u16() {
        301 | 302 | 303 | 307 | 308 => "该地址需要重定向，请改用最终地址",
        400 => "服务器认为请求格式不合法",
        401 | 403 => "服务器拒绝访问（可能需要登录，或该站点禁止抓取）",
        404 => "页面不存在，请检查 URL 拼写或改用其它来源",
        408 => "服务器等待请求超时，可稍后重试",
        429 => "请求过于频繁被限流，请稍后重试",
        500..=599 => "服务器内部错误，可稍后重试或改用其它来源",
        _ => "请求未成功",
    };
    format!("抓取 {url} 失败：HTTP {} （{hint}）", status.as_u16())
}

fn string_arg<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// edit_file 的规范化匹配：把 `\r` 与行尾空白折叠后再找 needle，
/// 命中后返回原文件中对应的字节区间。找不到返回 None。
fn fuzzy_normalized_range(haystack: &str, needle: &str) -> Option<(usize, usize)> {
    // **必须按字符（不是字节）归一化**：多字节 UTF-8（中文 HTML 是常态）里，
    // 逐字节处理会把每个字节当成独立字符，map 记录的是字节下标，
    // 拿它去切 &str 就落在字符中间 → panic → 引擎崩溃（用户看到的就是
    // 「AI 一读 HTML 文件引擎就没了」）。这里用 chars() 保字符边界，
    // map 记录每个**字符的起始字节下标**，切出来的 from/to 永远合法。
    fn normalize(input: &str) -> (String, Vec<usize>) {
        let mut norm = String::with_capacity(input.len());
        let mut map = Vec::with_capacity(input.len());
        let mut byte_cursor = 0usize;
        for ch in input.chars() {
            if ch == '\r' {
                byte_cursor += ch.len_utf8();
                continue;
            }
            if ch == ' ' || ch == '\t' {
                let mut next = byte_cursor + ch.len_utf8();
                while let Some(c) = input[next..].chars().next() {
                    if c != ' ' && c != '\t' { break }
                    next += c.len_utf8();
                }
                if input[next..].chars().next() == Some('\n') {
                    byte_cursor = next;
                    continue;
                }
            }
            norm.push(ch);
            map.push(byte_cursor);
            byte_cursor += ch.len_utf8();
        }
        (norm, map)
    }
    let (norm_content, content_map) = normalize(haystack);
    let (norm_needle, _) = normalize(needle);
    if norm_needle.is_empty() {
        return None;
    }
    let found = norm_content.find(&norm_needle)?;
    let from = *content_map.get(found)?;
    let last = found + norm_needle.len() - 1;
    let to = content_map.get(last).map(|value| *value + 1)?;
    Some((from, to))
}

/// Convert a simple glob (`*`, `**`, `?`) into a regex for relative path matching.
fn glob_pattern_to_regex(pattern: &str) -> Result<Regex, String> {
    let mut out = String::from("(?i)^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // ** optionally crosses path separators
                    out.push_str(".*");
                    i += 2;
                    if i < chars.len() && chars[i] == '/' {
                        i += 1; // swallow slash after **
                    }
                } else {
                    out.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                out.push_str("[^/]");
                i += 1;
            }
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(chars[i]);
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out.push('$');
    Regex::new(&out).map_err(|error| format!("invalid glob pattern: {error}"))
}

fn string_namespace(value: &str) -> Option<PathNamespace> {
    if value == "/workspace"
        || value.starts_with("/workspace/")
        || value == "/home/coomi"
        || value.starts_with("/home/coomi/")
        || value == "/opt/coomi-dev"
        || value.starts_with("/opt/coomi-dev/")
        || value == "/tmp"
        || value.starts_with("/tmp/")
    {
        Some(PathNamespace::Guest)
    } else {
        None
    }
}

fn usize_arg(value: &Value, key: &str) -> Option<usize> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn u64_arg(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn validate_user_input_request(request: &coomi_engine::UserInputRequest) -> Result<(), String> {
    if !(1..=5).contains(&request.questions.len()) {
        return Err("request_user_input requires one to five questions".into());
    }
    if request
        .auto_resolution_ms
        .is_some_and(|value| !(60_000..=240_000).contains(&value))
    {
        return Err("auto_resolution_ms must be between 60000 and 240000".into());
    }
    let mut ids = std::collections::HashSet::new();
    for question in &request.questions {
        if question.id.trim().is_empty()
            || question.header.trim().is_empty()
            || question.question.trim().is_empty()
        {
            return Err("question id, header, and question must not be empty".into());
        }
        if !ids.insert(question.id.as_str()) {
            return Err(format!("duplicate question id: {}", question.id));
        }
        if !(3..=7).contains(&question.options.len()) {
            return Err(format!(
                "question `{}` requires three to seven options",
                question.id
            ));
        }
        if question
            .options
            .iter()
            .any(|option| option.label.trim().is_empty())
        {
            return Err(format!(
                "question `{}` has an empty option label",
                question.id
            ));
        }
    }
    Ok(())
}

fn decode_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&#x2F;", "/")
        .replace("&#x2f;", "/")
        .replace("&#58;", ":")
        .replace("&ldquo;", "\"")
        .replace("&rdquo;", "\"")
        .replace("&lsquo;", "'")
        .replace("&rsquo;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
        .replace("&middot;", "·")
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Maximum bytes read from any remote body (web_search / fetch) to avoid OOM on Android.
const MAX_BODY_BYTES: usize = 512 * 1024;

/// Read a response body capped at [`MAX_BODY_BYTES`], lossy-decoded to UTF-8.
async fn read_body_capped(mut response: reqwest::Response) -> Result<String, String> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = MAX_BODY_BYTES - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                if body.len() >= MAX_BODY_BYTES {
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => return Err(format!("response read failed: {error}")),
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn looks_like_html(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    body.trim_start().starts_with('<') && (lower.contains("<html") || lower.contains("<!doctype"))
}

/// SSRF guard: reject URLs that resolve to loopback, private, link-local, unspecified,
/// multicast or broadcast addresses (and DNS names resolving to them). Also covers the
/// cloud metadata address 169.254.169.254 via the link-local check.
async fn is_blocked_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip_is_blocked(&ip);
    }
    // Resolve the hostname; a failure to resolve is treated as unreachable/blocked.
    let port = url.port_or_known_default().unwrap_or(80);
    match tokio::net::lookup_host((host, port)).await {
        Ok(addresses) => addresses
            .map(|address| address.ip())
            .any(|ip| ip_is_blocked(&ip)),
        Err(_) => true,
    }
}

/// Extract the IPv4 address embedded in a NAT64 (`64:ff9b::/32`, RFC 6052) or 6to4
/// (`2002::/16`) IPv6 address, if any. Used to extend the SSRF guard to those
/// transition prefixes.
fn embedded_ipv4(v6: &std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let octets = v6.octets();
    // NAT64 family 64:ff9b::/32 (RFC 6052):
    //  - PL=96 (64:ff9b::/96): bytes 4..11 are zero, IPv4 is the last 32 bits.
    //  - PL=32..64 (u bits live in bytes 4..7): IPv4 is at bytes 8..11, tail is zero.
    if octets[..4] == [0x00, 0x64, 0xff, 0x9b] {
        if octets[4..12] == [0, 0, 0, 0, 0, 0, 0, 0] {
            return Some(std::net::Ipv4Addr::new(
                octets[12], octets[13], octets[14], octets[15],
            ));
        }
        if octets[12..16] == [0, 0, 0, 0] {
            return Some(std::net::Ipv4Addr::new(
                octets[8], octets[9], octets[10], octets[11],
            ));
        }
        return None;
    }
    // 6to4: 2002::/16, IPv4 at bytes 2..5.
    if octets[..2] == [0x20, 0x02] {
        return Some(std::net::Ipv4Addr::new(
            octets[2], octets[3], octets[4], octets[5],
        ));
    }
    None
}

fn ip_is_blocked(ip: &std::net::IpAddr) -> bool {
    // Reject IPv4-mapped IPv6 addresses (e.g. [::ffff:127.0.0.1]) by checking the
    // embedded IPv4 address, which is what a connection actually targets.
    if let std::net::IpAddr::V6(v6) = ip {
        if let Some(v4) = v6.to_ipv4_mapped() {
            return ip_is_blocked(&std::net::IpAddr::V4(v4));
        }
        // NAT64 / 6to4 transition prefixes embed an IPv4 address (e.g. carrier NAT64
        // on cellular networks); check that address as well.
        let octets = v6.octets();
        if octets[..4] == [0x00, 0x64, 0xff, 0x9b] {
            if let Some(v4) = embedded_ipv4(v6) {
                if ip_is_blocked(&std::net::IpAddr::V4(v4)) {
                    return true;
                }
            }
            // Fail-closed: non-standard NAT64 gateways may place the embedded IPv4 at
            // any of the RFC 6052 / other window positions. If *any* window decodes to
            // a loopback/private/link-local address, block it. 0.0.0.0 is deliberately
            // excluded here (it is common in the u-byte region of legitimate addresses).
            for window in [
                &octets[4..8],
                &octets[5..9],
                &octets[6..10],
                &octets[7..11],
                &octets[8..12],
                &octets[9..13],
                &octets[12..16],
            ] {
                let candidate = std::net::Ipv4Addr::new(window[0], window[1], window[2], window[3]);
                if candidate.is_loopback() || candidate.is_private() || candidate.is_link_local() {
                    return true;
                }
            }
        } else if let Some(v4) = embedded_ipv4(v6) {
            // 6to4 (2002::/16): fixed window, treat like the mapped case.
            return ip_is_blocked(&std::net::IpAddr::V4(v4));
        }
    }
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

fn html_to_text(body: &str) -> String {
    // NOTE: regex crate does not support backreferences (`\1`), so each tag kind is
    // matched with its own literal pair instead of one alternation with a backref.
    let tag_pairs = [
        r"(?is)<script\b[^>]*>.*?</script>",
        r"(?is)<style\b[^>]*>.*?</style>",
        r"(?is)<noscript\b[^>]*>.*?</noscript>",
        r"(?is)<svg\b[^>]*>.*?</svg>",
        r"(?is)<head\b[^>]*>.*?</head>",
    ];
    let tag_re = match Regex::new(r"<[^>]+>") {
        Ok(regex) => regex,
        Err(_) => return collapse_whitespace(&decode_html(body)),
    };
    let mut stripped = body.to_string();
    for pattern in tag_pairs {
        let Ok(block_re) = Regex::new(pattern) else {
            continue;
        };
        stripped = block_re.replace_all(&stripped, " ").into_owned();
    }
    let text = tag_re.replace_all(&stripped, " ");
    collapse_whitespace(&decode_html(&text))
}

/// Parse Bing's RSS search results (`format=rss`): title, link and a short snippet per item.
fn parse_bing_rss(body: &str, limit: usize) -> Vec<String> {
    let Ok(item_re) = Regex::new(r"(?is)<item>(.*?)</item>") else { return Vec::new(); };
    let Ok(title_re) = Regex::new(r"(?is)<title>(.*?)</title>") else { return Vec::new(); };
    let Ok(link_re) = Regex::new(r"(?is)<link>(.*?)</link>") else { return Vec::new(); };
    let Ok(desc_re) = Regex::new(r"(?is)<description>(.*?)</description>") else { return Vec::new(); };
    let Ok(cdata_re) = Regex::new(r"(?is)<!\[CDATA\[(.*?)\]\]>") else { return Vec::new(); };
    let Ok(tag_re) = Regex::new(r"<[^>]+>") else { return Vec::new(); };
    let mut results = Vec::new();
    for item in item_re.captures_iter(body).take(limit) {
        let block = &item[1];
        let title = title_re
            .captures(block)
            .map_or("", |m| m.get(1).map_or("", |v| v.as_str()));
        let link = link_re
            .captures(block)
            .map_or("", |m| m.get(1).map_or("", |v| v.as_str()));
        let description = desc_re
            .captures(block)
            .map_or("", |m| m.get(1).map_or("", |v| v.as_str()));
        let title = strip_cdata_and_tags(&tag_re, &cdata_re, title);
        let url = normalize_search_url(link);
        if !title.trim().is_empty() && !url.is_empty() {
            let mut line = format!("- {title}\n  {url}");
            let snippet = strip_cdata_and_tags(&tag_re, &cdata_re, description);
            let snippet = collapse_whitespace(&snippet);
            if !snippet.is_empty() {
                line.push_str("\n  ");
                line.push_str(&snippet.chars().take(280).collect::<String>());
            }
            results.push(line);
        }
    }
    results
}

fn strip_cdata_and_tags(tag_re: &Regex, cdata_re: &Regex, value: &str) -> String {
    let value = value.trim();
    let value = if let Some(captures) = cdata_re.captures(value) {
        captures.get(1).map_or("", |v| v.as_str())
    } else {
        value
    };
    let value = tag_re.replace_all(value, "");
    decode_html(&value).trim().to_string()
}

fn normalize_search_url(value: &str) -> String {
    let decoded = decode_html(value.trim());
    let absolute = if decoded.starts_with("//") {
        format!("https:{decoded}")
    } else if decoded.starts_with('/') {
        format!("https://duckduckgo.com{decoded}")
    } else {
        decoded
    };
    reqwest::Url::parse(&absolute)
        .ok()
        .and_then(|url| {
            if url
                .host_str()
                .is_some_and(|host| host.ends_with("duckduckgo.com"))
            {
                url.query_pairs()
                    .find(|(key, _)| key == "uddg")
                    .map(|(_, value)| value.into_owned())
            } else {
                None
            }
        })
        .unwrap_or(absolute)
}

fn web_search_unavailable(reason: impl AsRef<str>) -> ToolResult {
    ToolResult::error(format!(
        "web_search unavailable: {}. Do not retry this search with shell, curl, wget, or command-line browsing; report the cause once to the user.",
        reason.as_ref()
    ))
}

#[cfg(windows)]
fn platform_shell(command: &str) -> Command {
    let mut process = Command::new("powershell.exe");
    process.args(["-NoLogo", "-NoProfile", "-Command", command]);
    process
}

#[cfg(not(windows))]
fn platform_shell(command: &str) -> Command {
    let shell = std::env::var_os("COOMI_SHELL")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PREFIX")
                .map(PathBuf::from)
                .map(|prefix| prefix.join("bin").join("bash"))
        })
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/bash"));
    let mut process = Command::new(shell);
    process.args(["-lc", command]);
    process
}

#[cfg(test)]
mod tests {
    use super::*;
    use coomi_security::AccessMode;

    struct Deny;

    struct Approve;

    #[async_trait]
    impl ApprovalHandler for Deny {
        async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
            false
        }
    }

    #[async_trait]
    impl ApprovalHandler for Approve {
        async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
            true
        }
    }

    /// 记录提问请求并立即回答的假交互通道：验证 ask_user 真的走 ApprovalHandler::request_user_ask。
    struct AskRecorder {
        seen: std::sync::Mutex<Option<coomi_engine::UserAskRequest>>,
        answer: Option<coomi_engine::UserAskAnswer>,
    }

    #[async_trait]
    impl ApprovalHandler for AskRecorder {
        async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
            true
        }

        async fn request_user_ask(
            &self,
            request: &coomi_engine::UserAskRequest,
        ) -> Option<coomi_engine::UserAskAnswer> {
            *self
                .seen
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(request.clone());
            self.answer.clone()
        }
    }

    #[test]
    fn ask_user_and_save_as_follow_their_capability_switches() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        // 默认口径：askUser 开、allowSaveAsRequest 关。
        let default_specs = CoreTools::new(workspace.path().to_path_buf(), policy.clone()).specs();
        assert!(default_specs.iter().any(|spec| spec.name == "ask_user"));
        assert!(!default_specs.iter().any(|spec| spec.name == "request_save_as"));

        let flipped = CoreTools::new(workspace.path().to_path_buf(), policy)
            .with_ask_user(false)
            .with_save_as_request(true)
            .specs();
        assert!(flipped.iter().any(|spec| spec.name == "request_save_as"));
        assert!(!flipped.iter().any(|spec| spec.name == "ask_user"));
        // 参数 schema 始终在表里：能力开关只控制「模型看不看得见」。
        assert!(CoreTools::builtin_parameter_schemas().contains_key("ask_user"));
        assert!(CoreTools::builtin_parameter_schemas().contains_key("request_save_as"));
    }

    #[test]
    fn ask_user_is_not_swallowed_by_the_request_user_input_alias() {
        assert_eq!(CoreTools::canonical_tool_name("ask_user"), "ask_user");
        assert_eq!(
            CoreTools::canonical_tool_name("ask"),
            "request_user_input"
        );
    }

    #[tokio::test]
    async fn ask_user_round_trips_through_the_interaction_channel() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let approval = AskRecorder {
            seen: std::sync::Mutex::new(None),
            answer: Some(coomi_engine::UserAskAnswer {
                question: "继续吗？".into(),
                answers: vec!["继续".into()],
                comment: None,
                skipped: false,
            }),
        };
        let result = tools
            .call(
                &ToolCall {
                    id: "ask-1".into(),
                    name: "ask_user".into(),
                    arguments: json!({
                        "question": "继续吗？",
                        "options": ["继续", "停止"],
                        "timeout_ms": 5_000,
                    }),
                },
                &approval,
            )
            .await;
        assert!(result.success, "{}", result.output);
        assert!(result.output.contains("继续"), "{}", result.output);
        let seen = approval
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .expect("ask_user must reach the interaction channel");
        assert_eq!(seen.question, "继续吗？");
        assert_eq!(seen.options, vec!["继续".to_owned(), "停止".to_owned()]);
        assert_eq!(seen.timeout_ms, Some(5_000));
        assert!(seen.allow_custom, "allow_custom 默认 true");
    }

    #[tokio::test]
    async fn ask_user_rejects_an_empty_question_before_reaching_the_user() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let approval = AskRecorder {
            seen: std::sync::Mutex::new(None),
            answer: None,
        };
        let result = tools
            .call(
                &ToolCall {
                    id: "ask-2".into(),
                    name: "ask_user".into(),
                    arguments: json!({"question": "   "}),
                },
                &approval,
            )
            .await;
        assert!(!result.success);
        assert!(
            approval
                .seen
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none(),
            "空问题不该弹到用户面前"
        );
    }

    #[tokio::test]
    async fn request_save_as_only_sends_the_event_and_writes_nothing() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let target = workspace.path().join("artifact.txt");
        std::fs::write(&target, "payload").expect("write fixture");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy)
            .with_save_as_request(true);
        let approval = FileTransferRecorder::default();
        let result = tools
            .call(
                &ToolCall {
                    id: "save-1".into(),
                    name: "request_save_as".into(),
                    arguments: json!({"path": target.display().to_string()}),
                },
                &approval,
            )
            .await;
        assert!(result.success, "{}", result.output);
        let seen = approval
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .expect("request_save_as must emit a transfer request");
        assert_eq!(seen.operation, "export");
        assert_eq!(seen.intent.as_deref(), Some("save_as"));
        assert_eq!(seen.suggested_name.as_deref(), Some("artifact.txt"));
        // 引擎自己不写任何文件：源文件内容原样不动。
        assert_eq!(
            std::fs::read_to_string(&target).expect("read fixture"),
            "payload"
        );
    }

    /// 记录另存为/导入导出请求并立即回一条路径的假通道。
    #[derive(Default)]
    struct FileTransferRecorder {
        seen: std::sync::Mutex<Option<coomi_engine::FileTransferRequest>>,
    }

    #[async_trait]
    impl ApprovalHandler for FileTransferRecorder {
        async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool {
            true
        }

        async fn request_file_transfer(
            &self,
            request: &coomi_engine::FileTransferRequest,
        ) -> Option<Vec<String>> {
            *self
                .seen
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(request.clone());
            request.path.clone().map(|path| vec![path])
        }
    }

    #[tokio::test]
    async fn edits_files_inside_the_workspace() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let file = workspace.path().join("sample.txt");
        std::fs::write(&file, "before").expect("write fixture");
        let policy = SecurityPolicy::new(workspace.path(), AccessMode::WorkspaceWrite)
            .expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let result = tools
            .call(
                &ToolCall {
                    id: "1".into(),
                    name: "edit_file".into(),
                    arguments: json!({
                        "path": "sample.txt",
                        "old_string": "before",
                        "new_string": "after"
                    }),
                },
                &Deny,
            )
            .await;
        assert!(result.success);
        assert_eq!(std::fs::read_to_string(file).expect("read result"), "after");
    }

    #[tokio::test]
    async fn file_tools_translate_proot_workspace_paths() {
        let root = tempfile::tempdir().expect("runtime root");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let file = workspace.join("guest.txt");
        std::fs::write(&file, "guest path works").expect("write fixture");
        let policy =
            SecurityPolicy::new(&workspace, AccessMode::FullAccess).expect("security policy");
        let tools =
            CoreTools::new(workspace.clone(), policy).with_config_home(root.path().join("coomi"));
        let result = tools
            .call(
                &ToolCall {
                    id: "guest-path".into(),
                    name: "read_file".into(),
                    arguments: json!({"path": "/workspace/guest.txt"}),
                },
                &Deny,
            )
            .await;
        assert!(result.success, "{}", result.output);
        assert!(result.output.contains("guest path works"));
    }

    #[tokio::test]
    async fn rejects_unknown_tools() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let result = tools
            .call(
                &ToolCall {
                    id: "1".into(),
                    name: "missing".into(),
                    arguments: json!({}),
                },
                &Deny,
            )
            .await;
        assert!(!result.success);
    }

    #[test]
    fn truncates_tool_output_at_utf8_boundary() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let mut tools = CoreTools::new(workspace.path().to_path_buf(), policy);

        tools.max_output = 4;
        assert_eq!(tools.truncate("abc中文".into()), "abc\n[output truncated]");

        tools.max_output = 5;
        assert_eq!(tools.truncate("a😀b".into()), "a😀\n[output truncated]");
    }

    #[tokio::test]
    async fn read_file_chunks_large_files_by_offset() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        // 每行约 70 字节，共 60_000 行 ≈ 4.2 MB > 2 MiB 阈值
        let file = workspace.path().join("big.log");
        let mut content = String::new();
        for i in 1..=60_000 {
            content.push_str(&format!(
                "line-{i:>8}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n"
            ));
        }
        std::fs::write(&file, &content).expect("write fixture");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let call = |offset: Option<usize>| ToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: json!({
                "path": "big.log",
                "offset": offset,
                "limit": 5
            }),
        };

        // 默认（offset=1）：只读前 64 KiB，返回开头几行 + 分段提示
        let first = tools.call(&call(Some(1)), &Deny).await;
        assert!(first.success, "{}", first.output);
        assert!(first.output.contains("line-       1-"), "{}", first.output);
        assert!(first.output.contains("大文件共"), "{}", first.output);
        assert!(!first.output.contains("line-   30000-"), "{}", first.output);

        // offset 跳转到中部：能读到第 30_000 行附近（旧实现 offset 无法越过 2 MiB）
        let middle = tools.call(&call(Some(30_000)), &Deny).await;
        assert!(middle.success, "{}", middle.output);
        assert!(
            middle.output.contains("line-   30000-"),
            "{}",
            middle.output
        );
        assert!(middle.output.contains("offset=30005"), "{}", middle.output);

        // offset 恰好超出文件（第 60001 行不存在）：显示“已到末尾”
        let tail = tools.call(&call(Some(60_001)), &Deny).await;
        assert!(tail.success, "{}", tail.output);
        assert!(tail.output.contains("已到末尾"), "{}", tail.output);

        // offset 远超文件末尾：跳行中途遇 EOF，报错而不是静默返回空
        let beyond = tools.call(&call(Some(60_002)), &Deny).await;
        assert!(!beyond.success, "{}", beyond.output);
        assert!(beyond.output.contains("超出文件末尾"), "{}", beyond.output);
    }

    #[tokio::test]
    async fn read_file_truncates_overlong_single_lines() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        // 单行 200_000 字符（模拟压缩 JSON / 长日志行）
        let file = workspace.path().join("huge_line.txt");
        let long_line = "x".repeat(200_000);
        std::fs::write(&file, format!("head\n{long_line}\ntail\n")).expect("write fixture");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let result = tools
            .call(
                &ToolCall {
                    id: "1".into(),
                    name: "read_file".into(),
                    arguments: json!({"path": "huge_line.txt", "limit": 10}),
                },
                &Deny,
            )
            .await;
        assert!(result.success, "{}", result.output);
        assert!(
            result.output.contains("本行共 200000 字符，已截断"),
            "{}",
            result.output
        );
        assert!(result.output.contains("head"), "{}", result.output);
        assert!(result.output.contains("tail"), "{}", result.output);
    }

    #[tokio::test]
    async fn loads_installed_skills_on_demand() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let skills = tempfile::tempdir().expect("temporary skills");
        let skill = skills.path().join("review");
        std::fs::create_dir(&skill).expect("create Skill directory");
        std::fs::write(skill.join("SKILL.md"), "Review carefully.").expect("write Skill");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy)
            .with_skills_directory(skills.path().to_path_buf());
        let result = tools
            .call(
                &ToolCall {
                    id: "1".into(),
                    name: "read_skill".into(),
                    arguments: json!({"name": "review"}),
                },
                &Deny,
            )
            .await;
        assert_eq!(result, ToolResult::success("Review carefully."));
    }

    #[tokio::test]
    async fn view_image_returns_structured_image_content() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        std::fs::write(workspace.path().join("pixel.png"), [1, 2, 3, 4]).expect("image fixture");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let result = tools
            .call(
                &ToolCall {
                    id: "1".into(),
                    name: "view_image".into(),
                    arguments: json!({"path": "pixel.png"}),
                },
                &Deny,
            )
            .await;
        assert!(result.success);
        assert_eq!(result.images.len(), 1);
        assert_eq!(result.images[0].media_type, "image/png");
        assert_eq!(result.images[0].data, "AQIDBA==");
        assert!(!result.output.contains("base64"));
    }

    #[tokio::test]
    async fn agent_can_configure_curated_mcp_in_coomi_home() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let home = tempfile::tempdir().expect("temporary Coomi home");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy)
            .with_config_home(home.path().to_path_buf());
        let specs = tools.specs();
        assert!(specs.iter().any(|spec| spec.name == "configure_mcp"));
        assert!(specs.iter().any(|spec| spec.name == "install_skill"));

        let result = tools
            .call(
                &ToolCall {
                    id: "configure-memory".into(),
                    name: "configure_mcp".into(),
                    arguments: json!({"catalog_id": "memory"}),
                },
                &Approve,
            )
            .await;
        assert!(result.success, "{}", result.output);
        let config = std::fs::read_to_string(home.path().join("config/mcp_servers.json"))
            .expect("MCP configuration");
        assert!(config.contains("server-memory"));
    }

    #[test]
    fn html_to_text_strips_scripts_styles_and_markup() {
        let html = "<!doctype html><html><head><title>T</title></head><body>\
            <script>alert(1)</script><style>.x{}</style>\
            <p>Hello&nbsp;<b>world</b>!</p></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("world"));
        assert!(
            !text.contains("alert"),
            "script content must be stripped: {text}"
        );
        assert!(
            !text.contains("script"),
            "script tag must be stripped: {text}"
        );
        assert!(
            !text.contains("style"),
            "style tag must be stripped: {text}"
        );
        assert!(!text.contains("&nbsp;"), "entities must be decoded: {text}");
    }

    #[test]
    fn html_to_text_handles_script_with_angle_brackets() {
        let html = "<html><body>a<script>function f() { if (a < b) {} }</script>b</body></html>";
        let text = html_to_text(html);
        assert_eq!(text, "a b");
    }

    #[test]
    fn parse_bing_rss_extracts_items() {
        let rss = r#"<?xml version="1.0"?><rss><channel><item><title><![CDATA[Example &amp; Result]]></title><link>https://example.com/a?q=1</link><description><![CDATA[<p>First snippet</p>]]></description></item><item><title><![CDATA[Second]]></title><link>https://example.com/b</link><description><![CDATA[Second snippet]]></description></item></channel></rss>"#;
        let results = parse_bing_rss(rss, 10);
        assert_eq!(results.len(), 2);
        assert!(results[0].contains("Example & Result"));
        assert!(results[0].contains("https://example.com/a?q=1"));
        assert!(results[0].contains("First snippet"));
        assert!(results[1].contains("Second"));
    }

    #[test]
    fn ip_is_blocked_rejects_loopback_private_and_mapped_addresses() {
        let blocked = [
            "127.0.0.1",
            "::1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            // NAT64 (64:ff9b::/96, /48 and other RFC 6052 layouts) and 6to4 (2002::/16)
            // embed an IPv4 address.
            "64:ff9b::a00:1",
            "64:ff9b:0:0:7f00:1::",
            "64:ff9b:7f00:1:0:0:0:0",
            "64:ff9b:0:a00:1::",
            // PL=64 layout: IPv4 at bytes 9..12 (u byte at byte 8).
            "64:ff9b:0:0:7f:0:100::",
            "2002:7f00:1::",
            "2002:a00:1::",
        ];
        for value in blocked {
            let ip: std::net::IpAddr = value.parse().expect("valid IP");
            assert!(ip_is_blocked(&ip), "{value} must be blocked");
        }
        let allowed = [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            // Legitimate NAT64-mapped public address must not be over-blocked.
            "64:ff9b::808:808",
            "64:ff9b::8.8.8.8",
        ];
        for value in allowed {
            let ip: std::net::IpAddr = value.parse().expect("valid IP");
            assert!(!ip_is_blocked(&ip), "{value} must be allowed");
        }
    }

    #[test]
    fn new_batch5_tools_are_registered_with_aliases() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let specs = CoreTools::new(workspace.path().to_path_buf(), policy).specs();
        for name in ["context_search", "file_search", "web_fetch"] {
            assert!(
                specs.iter().any(|spec| spec.name == name),
                "{name} 必须在工具清单里"
            );
        }
        assert_eq!(CoreTools::canonical_tool_name("history_search"), "context_search");
        assert_eq!(CoreTools::canonical_tool_name("search_files"), "file_search");
        assert_eq!(CoreTools::canonical_tool_name("fetch_url"), "web_fetch");
        assert_eq!(CoreTools::canonical_tool_name("http_get"), "fetch");
    }

    #[tokio::test]
    async fn web_fetch_reports_readable_error_for_invalid_url() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);
        let result = tools
            .call(
                &ToolCall {
                    id: "fetch".into(),
                    name: "web_fetch".into(),
                    arguments: json!({"url": "not-a-url"}),
                },
                &Deny,
            )
            .await;
        assert!(!result.success);
        assert!(result.output.contains("invalid URL"), "{}", result.output);
    }

    #[tokio::test]
    async fn context_search_finds_history_and_reports_misses_readably() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let history = vec![
            coomi_engine::ChatMessage::user("我们决定把默认端口改成 8123"),
            coomi_engine::ChatMessage::assistant("好的，已记录。", Vec::new()),
            coomi_engine::ChatMessage::user("今天天气不错"),
        ];
        let tools =
            CoreTools::new(workspace.path().to_path_buf(), policy).with_conversation_history(history);

        let hit = tools
            .call(
                &ToolCall {
                    id: "ctx".into(),
                    name: "context_search".into(),
                    arguments: json!({"query": "默认端口"}),
                },
                &Deny,
            )
            .await;
        assert!(hit.success, "{}", hit.output);
        assert!(hit.output.contains("8123"), "{}", hit.output);
        assert!(hit.output.contains("会话历史"), "{}", hit.output);
        assert!(!hit.output.contains("天气"), "无关消息不应返回：{}", hit.output);

        let miss = tools
            .call(
                &ToolCall {
                    id: "ctx2".into(),
                    name: "context_search".into(),
                    arguments: json!({"query": "zzz-完全不存在的内容"}),
                },
                &Deny,
            )
            .await;
        assert!(miss.success, "未命中应是可读结果而不是错误");
        assert!(miss.output.contains("没有匹配"), "{}", miss.output);

        // 角色过滤
        let only_user = tools
            .call(
                &ToolCall {
                    id: "ctx3".into(),
                    name: "context_search".into(),
                    arguments: json!({"query": "记录", "role": "assistant"}),
                },
                &Deny,
            )
            .await;
        assert!(only_user.success);
        assert!(only_user.output.contains("assistant"), "{}", only_user.output);
    }

    #[tokio::test]
    async fn file_search_matches_names_and_contents_but_skips_noise_dirs() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        std::fs::create_dir_all(workspace.path().join("src")).expect("src dir");
        std::fs::create_dir_all(workspace.path().join("docs")).expect("docs dir");
        std::fs::create_dir_all(workspace.path().join("node_modules/pkg")).expect("node_modules");
        std::fs::create_dir_all(workspace.path().join("target/debug")).expect("target");
        std::fs::create_dir_all(workspace.path().join(".git")).expect(".git");
        std::fs::write(workspace.path().join("src/main.rs"), "fn needle_symbol() {}\n").expect("src");
        std::fs::write(workspace.path().join("docs/needle.md"), "# 说明\n").expect("docs");
        std::fs::write(
            workspace.path().join("node_modules/pkg/index.js"),
            "needle_symbol\n",
        )
        .expect("node_modules file");
        std::fs::write(workspace.path().join("target/debug/out.txt"), "needle_symbol\n")
            .expect("target file");
        std::fs::write(workspace.path().join(".git/config"), "needle_symbol\n").expect(".git file");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy);

        let content = tools
            .call(
                &ToolCall {
                    id: "fs1".into(),
                    name: "file_search".into(),
                    arguments: json!({"query": "needle_symbol", "mode": "content"}),
                },
                &Deny,
            )
            .await;
        assert!(content.success, "{}", content.output);
        assert!(content.output.contains("src/main.rs"), "{}", content.output);
        assert!(
            !content.output.contains("node_modules"),
            "必须跳过 node_modules：{}",
            content.output
        );
        assert!(
            !content.output.contains("target/debug"),
            "必须跳过 target：{}",
            content.output
        );
        assert!(
            !content.output.contains(".git/config"),
            "必须跳过 .git：{}",
            content.output
        );

        let by_name = tools
            .call(
                &ToolCall {
                    id: "fs2".into(),
                    name: "file_search".into(),
                    arguments: json!({"query": "needle.md", "mode": "name"}),
                },
                &Deny,
            )
            .await;
        assert!(by_name.success, "{}", by_name.output);
        assert!(by_name.output.contains("docs/needle.md"), "{}", by_name.output);

        let none = tools
            .call(
                &ToolCall {
                    id: "fs3".into(),
                    name: "file_search".into(),
                    arguments: json!({"query": "完全不存在的关键字"}),
                },
                &Deny,
            )
            .await;
        assert!(none.success, "{}", none.output);
        assert!(none.output.contains("没有找到"), "{}", none.output);
    }

    #[tokio::test]
    async fn tool_enhance_validates_arguments_and_caches_read_only_results() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        std::fs::write(workspace.path().join("a.txt"), "hello quality\n").expect("write fixture");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");

        // 关闭 toolEnhance：行为与改造前一致（沿用旧的缺参错误）
        let legacy = CoreTools::new(workspace.path().to_path_buf(), policy.clone());
        let missing = legacy
            .call(
                &ToolCall {
                    id: "l1".into(),
                    name: "read_file".into(),
                    arguments: json!({}),
                },
                &Deny,
            )
            .await;
        assert!(!missing.success);
        assert!(
            missing.output.contains("missing string argument: path"),
            "{}",
            missing.output
        );

        // 开启 toolEnhance：schema 校验给可读错误，且不会 panic
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy).with_tool_enhance(true);
        let wrong_type = tools
            .call(
                &ToolCall {
                    id: "q1".into(),
                    name: "read_file".into(),
                    arguments: json!({"path": 42}),
                },
                &Deny,
            )
            .await;
        assert!(!wrong_type.success);
        assert!(wrong_type.output.contains("未通过校验"), "{}", wrong_type.output);
        assert!(wrong_type.output.contains("path"), "{}", wrong_type.output);

        let invalid_mode = tools
            .call(
                &ToolCall {
                    id: "q2".into(),
                    name: "file_search".into(),
                    arguments: json!({"query": "x", "mode": "bogus"}),
                },
                &Deny,
            )
            .await;
        assert!(!invalid_mode.success);
        assert!(invalid_mode.output.contains("未通过校验"), "{}", invalid_mode.output);

        // 正常调用两次：第二次命中只读 LRU 缓存
        let call = ToolCall {
            id: "r1".into(),
            name: "read_file".into(),
            arguments: json!({"path": "a.txt"}),
        };
        let first = tools.call(&call, &Deny).await;
        assert!(first.success, "{}", first.output);
        assert!(first.output.contains("hello quality"));
        let second = tools.call(&call, &Deny).await;
        assert_eq!(second.output, first.output);
        let quality = tools.tool_quality().expect("quality enabled");
        let (hits, misses, _, _) = quality.stats();
        assert_eq!(hits, 1, "第二次读取必须命中缓存");
        assert_eq!(misses, 1);
    }

    #[tokio::test]
    async fn tool_enhance_trims_oversized_results_to_a_temp_file() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        std::fs::write(workspace.path().join("big.txt"), "line\n".repeat(20_000))
            .expect("write fixture");
        let policy =
            SecurityPolicy::new(workspace.path(), AccessMode::ReadOnly).expect("security policy");
        let spill = tempfile::tempdir().expect("spill dir");
        let tools = CoreTools::new(workspace.path().to_path_buf(), policy).with_tool_quality(
            ToolQualityConfig {
                max_output_bytes: 2_000,
                max_output_lines: 100,
                spill_directory: Some(spill.path().to_path_buf()),
                ..ToolQualityConfig::default()
            },
        );
        let result = tools
            .call(
                &ToolCall {
                    id: "big".into(),
                    name: "read_file".into(),
                    arguments: json!({"path": "big.txt", "limit": 20_000}),
                },
                &Deny,
            )
            .await;
        assert!(result.success, "{}", result.output);
        assert!(result.output.contains("完整输出已写入临时文件"), "{}", result.output);
        let spilled = std::fs::read_dir(spill.path())
            .expect("spill dir readable")
            .flatten()
            .count();
        assert_eq!(spilled, 1, "完整结果必须落盘");
    }
}

