mod agents;
mod patch;
mod processes;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use coomi_catalogs::CatalogInstaller;
use coomi_engine::ApprovalHandler;
use coomi_engine::FileTransferRequest;
use coomi_engine::LoopState;
use coomi_engine::LoopStatus;
use coomi_engine::PlanState;
use coomi_engine::ToolCall;
use coomi_engine::ToolResult;
use coomi_engine::ToolRuntime;
use coomi_engine::ToolSpec;
use coomi_security::Decision;
use coomi_security::HookEvent;
use coomi_security::HookRunner;
use coomi_security::SecurityPolicy;
use coomi_services::AutoConfigIntent;
use coomi_services::McpRuntime;
use coomi_services::MemoryManager;
use coomi_services::MemoryScope;
use coomi_services::MemoryType;
use coomi_services::apply_auto_config;
use coomi_telemetry::Telemetry;
use ignore::WalkBuilder;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tokio::process::Command;

pub use crate::agents::AgentScheduler;
use crate::agents::snapshots_json;
pub use crate::processes::{ProcessManager, terminate_all_managed};

const DEFAULT_MAX_OUTPUT: usize = 48_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

pub struct CoreTools {
    cwd: PathBuf,
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
}

impl CoreTools {
    pub fn new(cwd: PathBuf, policy: SecurityPolicy) -> Self {
        Self {
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
        }
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

    pub fn with_skills_directory(mut self, directory: PathBuf) -> Self {
        self.skills_directory = Some(directory);
        self
    }

    pub fn with_config_home(mut self, home: PathBuf) -> Self {
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

    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }

    async fn dispatch(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        match Self::canonical_tool_name(call.name.as_str()) {
            "read_file" => self.read_file(&call.arguments).await,
            "write_file" => self.write_file(&call.arguments).await,
            "edit_file" => self.edit_file(&call.arguments).await,
            "list_dir" => self.list_dir(&call.arguments),
            "grep_files" | "search" => self.search(&call.arguments).await,
            "local_shell" => self.local_shell(call, approval).await,
            "shell" => self.shell(call, approval).await,
            "apply_patch" => self.apply_patch(call, approval).await,
            "web_search" => self.web_search(&call.arguments).await,
            "fetch" => self.fetch_url(&call.arguments).await,
            "view_image" => self.view_image(&call.arguments).await,
            "show_image" => self.show_image(&call.arguments).await,
            "request_user_input" => self.request_user_input(&call.arguments, approval).await,
            "request_file_import" => self.request_file_transfer(call, approval, "import").await,
            "request_file_export" => self.request_file_transfer(call, approval, "export").await,
            "update_plan" => self.update_plan(&call.arguments),
            "create_loop" => self.create_loop(&call.arguments),
            "get_loop" => self.get_loop(),
            "update_loop" => self.update_loop(&call.arguments),
            "spawn_agent" => self.spawn_agent(&call.arguments).await,
            "wait_agent" => self.wait_agent(&call.arguments).await,
            "close_agent" => self.close_agent(&call.arguments).await,
            "list_skills" => self.list_skills(),
            "read_skill" => self.read_skill(&call.arguments).await,
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
        match scheduler
            .spawn(task.to_owned(), &self.parent_history, fork_turns)
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
                let display = entry.path().strip_prefix(&self.cwd).unwrap_or(entry.path());
                let suffix = if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                    "/"
                } else {
                    ""
                };
                format!("{}{suffix}", display.display())
            })
            .collect::<Vec<_>>();
        entries.sort();
        if entries.is_empty() {
            ToolResult::success("directory is empty")
        } else {
            ToolResult::success(self.truncate(entries.join("\n")))
        }
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
        }
        self.processes.execute(&self.cwd, &call.arguments).await
    }

    async fn apply_patch(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult {
        let Some(patch_text) = string_arg(&call.arguments, "patch") else {
            return ToolResult::error("missing string argument: patch");
        };
        if self.policy.mode() != coomi_security::AccessMode::FullAccess
            && !approval
                .approve(call, "apply_patch will modify files")
                .await
        {
            return ToolResult::error("patch was not approved");
        }
        match patch::apply_patch(&self.policy, patch_text) {
            Ok(output) => ToolResult::success(output),
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
        let tag_re = Regex::new(r"<[^>]+>").expect("valid HTML tag regex");
        let mut results = Vec::new();
        let bing_re = Regex::new(
            r#"(?is)<li[^>]+class=['\"][^'\"]*b_algo[^'\"]*['\"][^>]*>.*?<h2[^>]*>\s*<a[^>]+href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>"#,
        )
        .expect("valid Bing result regex");
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
            let result_re = Regex::new(
                r#"(?is)<a[^>]+(?:class=['\"][^'\"]*(?:result__a|result-link)[^'\"]*['\"][^>]*href=['\"]([^'\"]+)['\"]|href=['\"]([^'\"]+)['\"][^>]*class=['\"][^'\"]*(?:result__a|result-link)[^'\"]*['\"])[^>]*>(.*?)</a>"#,
            )
            .expect("valid search result regex");
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
            return ToolResult::error(format!("HTTP {}", response.status()));
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

    async fn request_file_transfer(
        &self,
        call: &ToolCall,
        approval: &dyn ApprovalHandler,
        operation: &str,
    ) -> ToolResult {
        let path = string_arg(&call.arguments, "path").map(ToOwned::to_owned);
        let suggested_name = string_arg(&call.arguments, "suggested_name").map(ToOwned::to_owned);
        let request = FileTransferRequest {
            request_id: format!("file-{}", uuid::Uuid::new_v4()),
            operation: operation.to_owned(),
            path,
            suggested_name,
            multiple: operation == "import",
        };
        match approval.request_file_transfer(&request).await {
            Some(paths) if !paths.is_empty() => ToolResult::success(
                serde_json::json!({"operation": operation, "paths": paths}).to_string(),
            ),
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
        *self.plan.lock().expect("plan lock") = Some(plan.clone());
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
        let mut current = self.loop_state.lock().expect("loop lock");
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
        let current = self.loop_state.lock().expect("loop lock");
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
        let mut current = self.loop_state.lock().expect("loop lock");
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
            "run" | "run_shell" | "bash" | "sh" | "terminal" | "command" | "exec" => "shell",
            "web" | "web_search" => "web_search",
            "http" | "http_get" | "browse" | "get_url" => "fetch",
            "image_view" | "open_image" => "view_image",
            "image" | "display_image" => "show_image",
            "ask" | "ask_user" => "request_user_input",
            "import_file" => "request_file_import",
            "export_file" => "request_file_export",
            "plan" => "update_plan",
            "loop" | "create_loop" => "create_loop",
            "list_mcp_servers" | "mcp_list" | "get_mcp" | "list_servers" => "list_mcp",
            "list_skills" | "skills" => "list_skills",
            "skill" => "read_skill",
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
        if let Some(parent) = path.parent()
            && let Err(error) = tokio::fs::create_dir_all(parent).await
        {
            return ToolResult::error(format!(
                "failed to create directory {}: {error}",
                parent.display()
            ));
        }
        match tokio::fs::write(&path, content).await {
            Ok(()) => ToolResult::success(format!(
                "wrote {} bytes to {}",
                content.len(),
                path.display()
            )),
            Err(error) => ToolResult::error(format!("failed to write {}: {error}", path.display())),
        }
    }

    async fn edit_file(&self, arguments: &Value) -> ToolResult {
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
        let content = match tokio::fs::read_to_string(&path).await {
            Ok(content) => content,
            Err(error) => {
                return ToolResult::error(format!("failed to read {}: {error}", path.display()));
            }
        };
        let matches = content.matches(old_string).count();
        if matches == 0 {
            return ToolResult::error("old_string was not found");
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
        match tokio::fs::write(&path, updated).await {
            Ok(()) => ToolResult::success(format!("edited {}", path.display())),
            Err(error) => ToolResult::error(format!("failed to edit {}: {error}", path.display())),
        }
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
                    let display = entry.path().strip_prefix(&self.cwd).unwrap_or(entry.path());
                    output.push(format!("{}:{}:{line}", display.display(), line_index + 1));
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

        let timeout_ms = u64_arg(&call.arguments, "timeout_ms")
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, 300_000);
        let mut process = platform_shell(command);
        process
            .current_dir(&self.cwd)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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

    fn checked_path(&self, value: &str, write: bool) -> Result<PathBuf, String> {
        let path = self
            .policy
            .resolve_path(value)
            .map_err(|error| error.to_string())?;
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

    fn truncate(&self, mut output: String) -> String {
        if output.len() <= self.max_output {
            return output;
        }
        // 修复（原 2.0.0 崩溃根因）：String::truncate 要求 new_len 是 UTF-8 字符边界，
        // 多字节输出（中文等）超长时按字节切会触发 is_char_boundary 断言失败 panic
        // （本机 coomi.log 反复出现的 tools\src\lib.rs:1557 panic）。
        // floor_char_boundary 返回 ≤ max_output 的最大字符边界（Rust 1.73+ 稳定，rust-version=1.85 可用）。
        output.truncate(output.floor_char_boundary(self.max_output));
        output.push_str("\n[output truncated]");
        output
    }
}

#[async_trait]
impl ToolRuntime for CoreTools {
    fn specs(&self) -> Vec<ToolSpec> {
        let mut specs = vec![
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
                description: "Replace an exact text fragment in a workspace file.".into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                        "replace_all": {"type": "boolean"}
                    },
                    "required": ["path", "old_string", "new_string"],
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
                        "timeout_ms": {"type": "integer", "minimum": 1000, "maximum": 300000}
                    },
                    "required": ["command"],
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
                description: "Ask the user one to five short questions in one batch and wait until the batch is submitted. Each question has three to seven suggested choices; the UI also provides Skip and a custom answer.".into(),
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
                                                "description": {"type": "string"}
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
        ];
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
                            "catalog_id": {"type": "string", "enum": ["filesystem", "git", "fetch", "memory", "playwright", "github"]},
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
            ]);
        }
        if self.agent_scheduler.is_some() {
            specs.extend([
                ToolSpec {
                    name: "spawn_agent".into(),
                    description: "Spawn a background Coomi sub-agent with an optional fork of parent history.".into(),
                    parameters: json!({
                        "type": "object",
                        "properties": {
                            "task": {"type": "string"},
                            "fork_turns": {"type": "string", "description": "none, all, or a positive integer"}
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
            ]);
        }
        if let Some(runtime) = &self.mcp_runtime {
            specs.extend(runtime.specs());
        }
        if self.memory.is_some() {
            specs.extend(memory_specs());
        }
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

        let mut result = self.dispatch(&effective_call, approval).await;
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

fn string_arg<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
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
    let tag_re = Regex::new(r"<[^>]+>").expect("valid HTML tag regex");
    let mut stripped = body.to_string();
    for pattern in tag_pairs {
        let block_re = Regex::new(pattern).expect("valid block regex");
        stripped = block_re.replace_all(&stripped, " ").into_owned();
    }
    let text = tag_re.replace_all(&stripped, " ");
    collapse_whitespace(&decode_html(&text))
}

/// Parse Bing's RSS search results (`format=rss`): title, link and a short snippet per item.
fn parse_bing_rss(body: &str, limit: usize) -> Vec<String> {
    let item_re = Regex::new(r"(?is)<item>(.*?)</item>").expect("valid RSS item regex");
    let title_re = Regex::new(r"(?is)<title>(.*?)</title>").expect("valid RSS title regex");
    let link_re = Regex::new(r"(?is)<link>(.*?)</link>").expect("valid RSS link regex");
    let desc_re =
        Regex::new(r"(?is)<description>(.*?)</description>").expect("valid RSS description regex");
    let cdata_re = Regex::new(r"(?is)<!\[CDATA\[(.*?)\]\]>").expect("valid CDATA regex");
    let tag_re = Regex::new(r"<[^>]+>").expect("valid HTML tag regex");
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
}
