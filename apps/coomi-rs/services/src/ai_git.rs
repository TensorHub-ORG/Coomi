//! Git 面板 AI 能力：提交信息生成 / 变更总结 / 代码 review / 冲突解决建议 / README 生成。
//!
//! 所有模型调用统一经过私有 [`AiGit::chat_once`]；模型不可用（未配置/无令牌）
//! 或调用失败时，一律返回启发式降级文本（`Ok`），绝不因 AI 失败而让上层 API 报错。
//!
//! 注册方式（由调用方统一处理，本文件不修改 `lib.rs`）：
//! ```text
//! pub mod ai_git;
//! ```

use crate::config::{ProviderConfig, ProviderKind};
use crate::git_engine::{FileEntry, GitEngine, ProjectInfo};
use anyhow::{Context, Result, anyhow};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// 单次补全输入的最大字符数，防止超长 diff 撑爆上下文。
const DIFF_LIMIT_CHARS: usize = 60_000;
/// 冲突文件内容送入模型的最大字符数。
const CONFLICT_LIMIT_CHARS: usize = 80_000;

const SYSTEM_COMMIT: &str = "你是一名资深的 Git 提交信息撰写专家。根据用户提供的暂存区 diff，生成一条符合 Conventional Commits 规范的提交信息：首行格式为 type(scope): subject（type 可选 feat/fix/refactor/docs/style/test/chore/perf/build/ci，scope 按需），随后用 2-4 条以 \"-\" 开头的简短 bullet 说明关键变更。只输出提交信息本身，不要输出解释、代码围栏或额外标题。";

const SYSTEM_SUMMARY: &str = "你是一名资深代码变更分析师。根据用户提供的 git diff，用中文总结 3-6 条变更要点，每条一行、以 \"-\" 开头，聚焦对外行为与关键实现变化。不要复述 diff 原文，不要输出代码围栏。";

const SYSTEM_REVIEW: &str = "你是一名资深代码审查专家。根据用户提供的 git diff，输出中文审查结果，格式为：\n## 问题\n- [级别：高/中/低] 问题描述（文件:行号，如适用）\n## 建议\n- 具体改进建议\n只写有依据的问题，避免空泛套话，不要输出代码围栏。";

const SYSTEM_FIX: &str = "你是一名资深代码修复专家。根据用户提供的 git diff，识别其中的问题并输出修复建议，格式为 JSON 数组（只输出数组本身，不要输出解释、代码围栏或 Markdown）。数组每项为一个对象，字段如下：path（问题所在文件的路径，必填）、severity（严重级别，取值为 高/中/低）、summary（中文问题描述与修复思路）、patch（针对该文件的 unified diff 补丁，可直接用 git apply 应用；无法给出可靠补丁时省略该字段）、line（问题所在行号，可选）。";

const SYSTEM_CONFLICT: &str = "你是一名 Git 合并冲突解决专家。根据用户提供的冲突文件内容，逐块给出解决建议：保留哪一侧、如何合并或改写，并给出最终建议代码。用中文输出，按冲突块编号组织，不要输出代码围栏。";

const SYSTEM_README: &str = "你是一名开源项目文档专家。根据用户提供的项目类型与顶层文件清单，生成一份中文 README 草稿，必须包含：项目名、项目简介、快速开始、功能列表。使用 Markdown 格式，结构清晰。";

const SYSTEM_PR: &str = "你是一名资深开源项目维护者与代码变更分析师。根据用户提供的 base..head 分支差异（diff），生成一份中文 PR（Pull Request）描述，格式为 Markdown：首行为标题（以 # 开头，概括本次变更），随后依次为「## 变更摘要」「## 主要文件」「## 测试建议」三节。变更摘要用 2-5 条 bullet 概括对外行为与关键实现变化；主要文件列出改动最相关的文件路径（每条一个 bullet）；测试建议给出 2-4 条可执行的验证步骤。只输出 PR 描述本身，不要输出解释、代码围栏或额外标题。";

const SYSTEM_AB: &str = "你是一名资深架构评审专家与 A/B 实验分析员。用户提供了两个实现方案（分支/提交）相对共同基线（merge-base）的差异，以及两方案之间的合并差异。请用中文输出对比报告，结构为：\n## 方案差异\n- 各自的核心实现思路与关键改动\n## 影响文件\n- 受影响的主要文件及两方案在其中的差异点\n## 实现取舍\n- 从复杂度、可维护性、性能、风险等维度对比两方案的取舍\n## 推荐结论\n- 明确推荐哪个方案、理由与落地建议\n只写有依据的分析，不要复述 diff 原文，不要输出代码围栏。";

const SYSTEM_ADVERSARIAL: &str = "你是一名极其挑剔的资深代码审查专家，擅长找出常规审查容易遗漏的盲点。根据用户提供的 git diff，以「挑剔的资深审查者」身份专门排查：边界条件与极端输入、错误处理缺失、安全隐患、并发与性能问题、兼容性（平台/版本/数据格式）风险。用中文 Markdown 输出，结构为：\n## 盲点\n- 常规审查容易忽略的问题（文件:行号，如适用）\n## 风险\n- 可能引发故障或安全事故的风险点\n## 建议\n- 具体可执行的改进建议\n只写有依据的问题，避免空泛套话，不要输出代码围栏。";

const SYSTEM_RCA: &str = "你是一名资深变更根因分析专家。根据用户提供的单个提交的提交信息与变更 diff，用中文输出根因分析报告，结构为：\n## 变更动机\n- 该变更试图解决什么问题\n## 触发背景\n- 结合提交信息推断变更发生的背景（如缺陷修复、需求迭代、技术债清理）\n## 对外影响\n- 变更对外部行为、接口、性能的影响范围\n## 是否引入风险\n- 分析该变更可能引入的新风险与回归面\n只写有依据的分析，不要复述 diff 原文，不要输出代码围栏。";

/// 单个审查问题：结构化问题清单，`patch` 为可直接 `git apply` 的补丁（可选）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewIssue {
    /// 问题所在文件路径。
    pub path: String,
    /// 严重级别：高 / 中 / 低。
    pub severity: String,
    /// 中文问题描述与修复思路。
    pub summary: String,
    /// 针对该文件的 unified diff 补丁（模型给出时才有）。
    pub patch: Option<String>,
    /// 问题所在行号（1-based，模型给出时才有）。
    pub line: Option<usize>,
}

/// 模型调用协议模式：决定 `chat_once` 走哪一套 API。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AiMode {
    /// OpenAI 兼容 `POST {base}/chat/completions`（OpenAiCompatible / OpenAiResponses）。
    OpenAiCompatible,
    /// Anthropic Messages API（`POST {base}/v1/messages`）。
    Anthropic,
    /// Gemini Native（`POST {base}/models/{model}:streamGenerateContent`）。
    Gemini,
}

/// Git 面板 AI 助手的独立模型配置（不依赖全局 Provider 配置）。
///
/// 保存在 `{home}/config/git-ai.json`，由前端「AI 模型设置」读写；
/// 启用且配置完整时，`AiGit` 优先使用本配置，不再读取全局 Provider。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct GitAiConfig {
    /// 是否启用独立配置。
    #[serde(default)]
    pub enabled: bool,
    /// 协议：`openai_compatible`（默认）/ `anthropic` / `gemini`。
    #[serde(default = "default_git_ai_kind")]
    pub kind: String,
    /// API 入口地址，如 `https://api.deepseek.com/v1`。
    /// 序列化输出 snake_case（与前端接口一致）；兼容早期 camelCase 文件。
    #[serde(default, alias = "baseUrl")]
    pub base_url: String,
    /// API Key（标准协议令牌）。
    #[serde(default, alias = "apiKey")]
    pub api_key: String,
    /// 模型名，如 `deepseek-chat`。
    #[serde(default)]
    pub model: String,
}

fn default_git_ai_kind() -> String {
    "openai_compatible".to_owned()
}

impl GitAiConfig {
    /// 读取配置文件；文件不存在或损坏时返回默认值（永不报错）。
    pub fn load(path: &Path) -> Self {
        match std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(config) => config,
            None => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("create git-ai config dir {}", parent.display())
            })?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("failed to save git-ai config {}", path.display()))
    }

    /// 是否可用：启用且 base_url / api_key / model 均非空。
    pub fn is_usable(&self) -> bool {
        self.enabled
            && !self.base_url.trim().is_empty()
            && !self.api_key.trim().is_empty()
            && !self.model.trim().is_empty()
    }
}

/// Git 面板 AI 助手：包装模型客户端，为 Git 场景提供模型能力与降级路径。
pub struct AiGit {
    http: Client,
    /// 访问令牌（API Key）。
    token: String,
    /// 模型名，如 "deepseek-chat"。
    model: String,
    /// 当前协议模式。
    mode: AiMode,
    /// 标准协议（OpenAI 兼容 / Anthropic / Gemini）的 base_url。
    base_url: String,
}

impl AiGit {
    /// 未配置的空助手（模型不可用，所有能力走降级路径）。
    pub fn new() -> Self {
        Self::with_token("", "deepseek-chat")
    }

    /// 以令牌与模型名构造助手。
    pub fn with_token(token: impl Into<String>, model: impl Into<String>) -> Self {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // SSE 长流：每次收到 chunk 都会重置读超时。
            .read_timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            http,
            token: token.into(),
            model: model.into(),
            mode: AiMode::OpenAiCompatible,
            base_url: String::new(),
        }
    }

    /// 以标准协议（OpenAI 兼容 / Anthropic / Gemini）构造助手。
    fn with_provider(
        token: impl Into<String>,
        model: impl Into<String>,
        mode: AiMode,
        base_url: &str,
    ) -> Self {
        let mut ai = Self::with_token(token, model);
        ai.mode = mode;
        ai.base_url = base_url.trim().trim_end_matches('/').to_owned();
        ai
    }

    /// 从 Provider 配置构造。所有「base_url + api_key 均非空」的 provider 都可用：
    /// OpenAI 兼容、Anthropic、Gemini 走各自标准协议。
    /// 无有效配置时返回不可用助手（所有能力走降级路径，绝不报错）。
    pub fn from_provider(config: &ProviderConfig) -> Self {
        if config.base_url.trim().is_empty() || config.api_key.trim().is_empty() {
            return Self::new();
        }
        let mode = match config.kind {
            ProviderKind::AnthropicMessages => AiMode::Anthropic,
            ProviderKind::GeminiNative => AiMode::Gemini,
            // OpenAiCompatible / OpenAiResponses 统一走 chat/completions。
            _ => AiMode::OpenAiCompatible,
        };
        Self::with_provider(
            config.api_key.clone(),
            config.model.clone(),
            mode,
            &config.base_url,
        )
    }

    /// 模型是否可用：要求令牌与 base_url 均非空。
    pub fn available(&self) -> bool {
        !self.token.trim().is_empty() && !self.base_url.trim().is_empty()
    }

    /// 从 Git AI 独立配置构造（不依赖全局 Provider）。协议按 `kind` 路由：
    /// - `anthropic` → Anthropic Messages API；
    /// - `gemini` → Gemini Native 流式接口；
    /// - 其余 → OpenAI 兼容 `chat/completions`。
    /// 配置不可用时返回不可用助手（所有能力走降级路径，绝不报错）。
    pub fn from_git_config(config: &GitAiConfig) -> Self {
        let mode = match config.kind.as_str() {
            "anthropic" => AiMode::Anthropic,
            "gemini" => AiMode::Gemini,
            _ => AiMode::OpenAiCompatible,
        };
        Self::with_provider(
            config.api_key.clone(),
            config.model.clone(),
            mode,
            &config.base_url,
        )
    }

    /// 连通性测试：让模型回复一句话，验证 base_url / api_key / model 是否可用。
    pub async fn ping(&self) -> Result<String> {
        self.chat_once("你是连通性测试助手。", "请只回复两个字：正常", 16)
            .await
    }

    /// 发起一次补全（按协议模式分流）。失败返回 `Err`，由调用方负责降级。
    async fn chat_once(&self, system: &str, user: &str, max_tokens: usize) -> Result<String> {
        if !self.available() {
            return Err(anyhow!("AI 模型未配置或未登录"));
        }
        match self.mode {
            AiMode::OpenAiCompatible => self.chat_once_openai(system, user, max_tokens).await,
            AiMode::Anthropic => self.chat_once_anthropic(system, user, max_tokens).await,
            AiMode::Gemini => self.chat_once_gemini(system, user, max_tokens).await,
        }
    }

    /// OpenAI 兼容：`POST {base}/chat/completions`（stream=true，Bearer 认证），
    /// SSE 逐行解析 `choices[0].delta.content`。base_url 已含 `/chat/completions` 时直接使用。
    async fn chat_once_openai(
        &self,
        system: &str,
        user: &str,
        max_tokens: usize,
    ) -> Result<String> {
        let base = self.base_url.trim().trim_end_matches('/');
        let endpoint = if base.ends_with("/chat/completions") {
            base.to_owned()
        } else {
            format!("{base}/chat/completions")
        };
        let response = self
            .http
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", self.token.trim()))
            .json(&serde_json::json!({
                "model": self.model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user },
                ],
                "stream": true,
                "max_tokens": max_tokens,
            }))
            .send()
            .await
            .context("AI 聊天请求失败")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("AI 对话失败 HTTP {status}: {body}"));
        }
        let mut content = String::new();
        let mut pending = String::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("读取 AI SSE 流失败")?;
            pending.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_string();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    if let Some(delta) = value
                        .pointer("/choices/0/delta/content")
                        .and_then(Value::as_str)
                    {
                        content.push_str(delta);
                    }
                }
            }
        }
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(anyhow!("AI 响应没有文本内容"));
        }
        Ok(content)
    }

    /// Anthropic Messages API：`POST {base}/v1/messages`（x-api-key + anthropic-version，
    /// stream=true），SSE 解析 `content_block_delta.text_delta`。
    async fn chat_once_anthropic(
        &self,
        system: &str,
        user: &str,
        max_tokens: usize,
    ) -> Result<String> {
        let base = self.base_url.trim().trim_end_matches('/');
        let endpoint = if base.ends_with("/v1/messages") {
            base.to_owned()
        } else {
            format!("{base}/v1/messages")
        };
        let response = self
            .http
            .post(&endpoint)
            .header("x-api-key", self.token.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&serde_json::json!({
                "model": self.model,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
                "max_tokens": max_tokens,
                "stream": true,
            }))
            .send()
            .await
            .context("Anthropic 聊天请求失败")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Anthropic 对话失败 HTTP {status}: {body}"));
        }
        let mut content = String::new();
        let mut pending = String::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("读取 Anthropic SSE 流失败")?;
            pending.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_string();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    if value.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                        if let Some(delta) = value.pointer("/delta/text").and_then(Value::as_str) {
                            content.push_str(delta);
                        }
                    }
                }
            }
        }
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(anyhow!("Anthropic 响应没有文本内容"));
        }
        Ok(content)
    }

    /// Gemini Native：`POST {base}/models/{model}:streamGenerateContent?alt=sse&key=API_KEY`，
    /// SSE 解析 `candidates[0].content.parts[].text`。
    async fn chat_once_gemini(
        &self,
        system: &str,
        user: &str,
        max_tokens: usize,
    ) -> Result<String> {
        let base = self.base_url.trim().trim_end_matches('/');
        let endpoint = format!(
            "{base}/models/{}:streamGenerateContent?alt=sse&key={}",
            self.model,
            self.token.trim()
        );
        let response = self
            .http
            .post(&endpoint)
            .json(&serde_json::json!({
                "system_instruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": user }] }],
                "generationConfig": { "maxOutputTokens": max_tokens },
            }))
            .send()
            .await
            .context("Gemini 聊天请求失败")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Gemini 对话失败 HTTP {status}: {body}"));
        }
        let mut content = String::new();
        let mut pending = String::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("读取 Gemini SSE 流失败")?;
            pending.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_string();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    if let Some(parts) = value
                        .pointer("/candidates/0/content/parts")
                        .and_then(Value::as_array)
                    {
                        for part in parts {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                content.push_str(text);
                            }
                        }
                    }
                }
            }
        }
        let content = content.trim().to_string();
        if content.is_empty() {
            return Err(anyhow!("Gemini 响应没有文本内容"));
        }
        Ok(content)
    }

    // -- 提交信息 ----------------------------------------------------------

    /// 基于暂存区 diff 生成 Conventional Commit 提交信息。
    /// 模型不可用或无暂存改动时，降级为「由改动文件推断」的启发式提交信息。
    pub async fn suggest_commit_message(
        &self,
        engine: &GitEngine,
        context: Option<&str>,
    ) -> Result<String> {
        let diff = match engine.diff_for_ai(None, true).await {
            Ok(diff) => diff,
            Err(_) => return Ok(self.fallback_commit_message(engine).await),
        };
        if diff.trim().is_empty() {
            return Ok(self.fallback_commit_message(engine).await);
        }
        if !self.available() {
            return Ok(self.fallback_commit_message(engine).await);
        }
        let mut user = format!("暂存区 diff：\n{}", limit_text(&diff, DIFF_LIMIT_CHARS));
        if let Some(context) = context.map(str::trim).filter(|c| !c.is_empty()) {
            user.push_str(&format!("\n\n额外上下文：{context}"));
        }
        user.push_str("\n\n请生成提交信息。");
        match self.chat_once(SYSTEM_COMMIT, &user, 300).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(self.fallback_commit_message(engine).await),
        }
    }

    /// 降级路径：无模型时由暂存区改动文件推断提交信息（独立函数，便于测试）。
    async fn fallback_commit_message(&self, engine: &GitEngine) -> String {
        let stat = engine
            .diff(None, true, 5)
            .await
            .map(|info| info.stat)
            .unwrap_or_default();
        let staged = engine.status().await.unwrap_or_default().staged;
        heuristic_commit_message(&staged, &stat)
    }

    // -- 变更总结 ----------------------------------------------------------

    /// 总结变更要点：`since` 为某 commit hash 时总结 since..HEAD，否则总结工作区未提交改动。
    /// 模型不可用时降级为 diff --stat 摘要文本。
    pub async fn summarize_changes(
        &self,
        engine: &GitEngine,
        since: Option<&str>,
    ) -> Result<String> {
        let since = since.map(str::trim).filter(|s| !s.is_empty());
        let (diff, stat, range_desc) = if let Some(rev) = since {
            match self.diff_range(engine, rev, "HEAD").await {
                Ok(d) if !d.trim().is_empty() => (d, String::new(), format!("提交 {rev} 至 HEAD 的变更")),
                Ok(_) => return Ok("所选提交范围内没有代码变更。".to_string()),
                Err(e) => return Ok(format!("无法获取 {rev}..HEAD 的差异：{e}")),
            }
        } else {
            match self.unstaged_changes(engine).await {
                Ok((diff, stat)) if !diff.trim().is_empty() => {
                    (diff, stat, "工作区未提交的变更".to_string())
                }
                Ok(_) => return Ok("当前没有未提交的改动。".to_string()),
                Err(e) => return Ok(format!("无法获取工作区差异：{e}")),
            }
        };
        if !self.available() {
            return Ok(fallback_summary(&stat, &diff));
        }
        let user = format!(
            "变更范围：{range_desc}\n\n差异内容：\n{}",
            limit_text(&diff, DIFF_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_SUMMARY, &user, 500).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback_summary(&stat, &diff)),
        }
    }

    // -- 代码 review -------------------------------------------------------

    /// 对指定文件（或全部未提交改动）的 diff 做代码审查，输出「问题/建议/级别」列表。
    /// 模型不可用时降级为 diff stat + 提示。
    pub async fn code_review(&self, engine: &GitEngine, path: Option<&str>) -> Result<String> {
        let diff = match engine.diff_for_ai(path, false).await {
            Ok(diff) => diff,
            Err(e) => return Ok(format!("无法获取待审查的差异：{e}")),
        };
        if diff.trim().is_empty() {
            return Ok(match path {
                Some(p) => format!("文件 {p} 没有未提交的改动，无需审查。"),
                None => "当前没有可审查的未提交改动。".to_string(),
            });
        }
        if !self.available() {
            return Ok(fallback_review(&diff));
        }
        let target = path.unwrap_or("全部未提交改动");
        let user = format!(
            "审查范围：{target}\n\ndiff 内容：\n{}",
            limit_text(&diff, DIFF_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_REVIEW, &user, 1000).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback_review(&diff)),
        }
    }

    // -- AI 一键修复 -------------------------------------------------------

    /// 审查 diff 并返回结构化问题清单（每项可带可应用补丁），作为
    /// 「发现 → 解决」之间的桥：问题可直接交给 [`GitEngine::apply_patch`] 应用。
    /// 空 diff、模型不可用或模型输出解析失败时一律降级为空数组（不报错）。
    pub async fn suggest_fixes(
        &self,
        engine: &GitEngine,
        path: Option<&str>,
    ) -> Result<Vec<ReviewIssue>> {
        let diff = match engine.diff_for_ai(path, false).await {
            Ok(diff) => diff,
            Err(_) => return Ok(Vec::new()),
        };
        if diff.trim().is_empty() {
            return Ok(Vec::new());
        }
        if !self.available() {
            return Ok(Vec::new());
        }
        let target = path.unwrap_or("全部未提交改动");
        let user = format!(
            "修复范围：{target}\n\ndiff 内容：\n{}\n\n请输出修复建议 JSON 数组。",
            limit_text(&diff, DIFF_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_FIX, &user, 2000).await {
            Ok(text) => Ok(parse_review_issues(&text)),
            Err(_) => Ok(Vec::new()),
        }
    }

    // -- 冲突解决 ----------------------------------------------------------

    /// 读取工作区冲突文件（含 <<<<<<< ======= >>>>>>> 标记），提取冲突块并给出合并建议。
    /// 无冲突标记返回提示；模型不可用时按块列出 ours/theirs 两侧摘要。
    pub async fn resolve_conflict(&self, engine: &GitEngine, path: &str) -> Result<String> {
        let path = path.trim();
        if path.is_empty() {
            return Ok("未指定冲突文件路径。".to_string());
        }
        let file_path = engine.workspace().join(path);
        let content = match std::fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(e) => return Ok(format!("无法读取文件 {path}：{e}")),
        };
        let blocks = parse_conflict_blocks(&content);
        if blocks.is_empty() {
            return Ok(format!(
                "文件 {path} 不包含冲突标记（<<<<<<< / ======= / >>>>>>>），无需解决。"
            ));
        }
        if !self.available() {
            return Ok(fallback_conflict(path, &blocks));
        }
        let user = format!(
            "冲突文件路径：{path}\n\n文件内容（含冲突标记，共 {} 处冲突）如下：\n\n{}\n\n请逐块给出合并建议：保留哪一侧、如何合并、最终建议代码。用中文输出。",
            blocks.len(),
            limit_text(&content, CONFLICT_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_CONFLICT, &user, 1200).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback_conflict(path, &blocks)),
        }
    }

    // -- README 生成 -------------------------------------------------------

    /// 基于项目类型 + workspace 顶层条目清单生成中文 README 草稿。
    /// 模型不可用时输出 Markdown 模板。
    pub async fn generate_readme(&self, engine: &GitEngine) -> Result<String> {
        let info = engine
            .project_info()
            .await
            .unwrap_or(ProjectInfo {
                detected: Vec::new(),
                gitignore: None,
            });
        let workspace = engine.workspace();
        let project_name = workspace
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "My Project".to_string());
        let entries = top_level_entries(workspace);
        if !self.available() {
            return Ok(readme_template(&project_name, &info.detected, &entries));
        }
        let detected = if info.detected.is_empty() {
            "未识别".to_string()
        } else {
            info.detected.join(" / ")
        };
        let entry_list = if entries.is_empty() {
            "（空目录）".to_string()
        } else {
            entries
                .iter()
                .map(|entry| format!("- {entry}"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let user = format!(
            "项目名（目录名）：{project_name}\n项目类型：{detected}\n顶层条目：\n{entry_list}\n\n请生成中文 README 草稿（包含项目名、项目简介、快速开始、功能列表，Markdown）。"
        );
        match self.chat_once(SYSTEM_README, &user, 1500).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(readme_template(&project_name, &info.detected, &entries)),
        }
    }

    // -- PR 描述 ----------------------------------------------------------

    /// 基于 base..head 分支差异生成 PR 标题+正文（中文 Markdown，含变更摘要 /
    /// 主要文件 / 测试建议）。空 base/head 返回错误；模型不可用或差异为空时降级
    /// 为由 git log base..head 提交 subject 拼成的模板（一律 Ok，不报错）。
    pub async fn generate_pr_description(
        &self,
        engine: &GitEngine,
        base: &str,
        head: &str,
    ) -> Result<String> {
        let base = base.trim();
        let head = head.trim();
        if base.is_empty() || head.is_empty() {
            anyhow::bail!("base and head branch names are required");
        }
        let subjects = self.pr_commit_subjects(engine, base, head).await;
        let diff = match self.diff_range(engine, base, head).await {
            Ok(diff) => diff,
            // diff 获取失败（如分支不存在）也走降级模板，不向调用方报错。
            Err(_) => return Ok(fallback_pr_description(base, head, &subjects)),
        };
        if diff.trim().is_empty() {
            return Ok(fallback_pr_description(base, head, &subjects));
        }
        if !self.available() {
            return Ok(fallback_pr_description(base, head, &subjects));
        }
        let user = format!(
            "变更范围：{base}..{head}\n\n差异内容：\n{}",
            limit_text(&diff, DIFF_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_PR, &user, 900).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback_pr_description(base, head, &subjects)),
        }
    }

    // -- A/B 实验模式（P2-5） ---------------------------------------------

    /// 对比两个分支/提交引用的实现方案，生成中文 A/B 实验对比报告
    /// （方案差异 / 影响文件 / 实现取舍 / 推荐结论）。
    ///
    /// 实现：以 `merge-base a b` 为共同基线，分别取两分支相对基线的 diff，
    /// 再取 a 与 b 的合并 diff 一并交给模型。空引用校验失败返回 Err；
    /// diff 获取失败、模型不可用或调用失败时一律降级为「两分支提交历史 +
    /// 合并 diff stat」拼成的对比摘要（Ok，不报错）。
    pub async fn compare_implementations(
        &self,
        engine: &GitEngine,
        branch_a: &str,
        branch_b: &str,
    ) -> Result<String> {
        let branch_a = branch_a.trim();
        let branch_b = branch_b.trim();
        if branch_a.is_empty() || branch_b.is_empty() {
            anyhow::bail!("branch_a and branch_b are required");
        }
        let fallback = || async {
            self.fallback_compare(engine, branch_a, branch_b).await
        };
        // 共同基线失败（分支不存在 / 无共同祖先）→ 降级。
        let base = match engine.merge_base(branch_a, branch_b).await {
            Ok(base) if !base.trim().is_empty() => base.trim().to_owned(),
            _ => return Ok(fallback().await),
        };
        let diff_a = match self.diff_range(engine, &base, branch_a).await {
            Ok(diff) => diff,
            Err(_) => return Ok(fallback().await),
        };
        let diff_b = match self.diff_range(engine, &base, branch_b).await {
            Ok(diff) => diff,
            Err(_) => return Ok(fallback().await),
        };
        let diff_ab = match self.diff_range(engine, branch_a, branch_b).await {
            Ok(diff) => diff,
            Err(_) => return Ok(fallback().await),
        };
        if diff_a.trim().is_empty() && diff_b.trim().is_empty() && diff_ab.trim().is_empty() {
            return Ok(format!(
                "分支 {branch_a} 与 {branch_b} 没有代码差异（可能指向相同提交或实现一致）。"
            ));
        }
        if !self.available() {
            return Ok(fallback().await);
        }
        let user = format!(
            "共同基线（merge-base）：{base}\n\n分支 {branch_a} 相对基线的差异：\n{}\n\n分支 {branch_b} 相对基线的差异：\n{}\n\n分支 {branch_a} 与 {branch_b} 的合并差异：\n{}\n\n请生成 A/B 实验对比报告。",
            limit_text(&diff_a, DIFF_LIMIT_CHARS / 3),
            limit_text(&diff_b, DIFF_LIMIT_CHARS / 3),
            limit_text(&diff_ab, DIFF_LIMIT_CHARS / 3),
        );
        match self.chat_once(SYSTEM_AB, &user, 1200).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback().await),
        }
    }

    /// A/B 对比降级：收集两分支提交历史与合并 diff stat 后拼成摘要。
    async fn fallback_compare(
        &self,
        engine: &GitEngine,
        branch_a: &str,
        branch_b: &str,
    ) -> String {
        let subjects_a = self.branch_commit_subjects(engine, branch_a).await;
        let subjects_b = self.branch_commit_subjects(engine, branch_b).await;
        let (code, stdout, _stderr) = engine
            .run_output(&["diff", "--stat", "--no-ext-diff", branch_a, branch_b], &[])
            .await
            .unwrap_or((1, String::new(), String::new()));
        let stat = if code == 0 { stdout } else { String::new() };
        fallback_compare_text(branch_a, &subjects_a, branch_b, &subjects_b, &stat)
    }

    /// 取某分支/引用最近 20 条提交 subject（降级模板用；命令失败返回空列表）。
    async fn branch_commit_subjects(&self, engine: &GitEngine, rev: &str) -> Vec<String> {
        let (code, stdout, _stderr) = engine
            .run_output(&["log", "-n", "20", "--pretty=format:%s", rev], &[])
            .await
            .unwrap_or((1, String::new(), String::new()));
        if code != 0 {
            return Vec::new();
        }
        stdout.lines().map(str::to_owned).collect()
    }

    // -- 对抗式评审（P2-6） -----------------------------------------------

    /// 以「挑剔的资深审查者」身份对指定文件（或全部未提交改动）做对抗式评审，
    /// 专门排查常规审查容易遗漏的盲点（边界条件 / 错误处理缺失 / 安全问题 /
    /// 并发与性能 / 兼容性），输出中文 Markdown（## 盲点 / ## 风险 / ## 建议）。
    /// 输入与 code_review 相同（工作区未提交 diff）；空 diff 提示与 code_review
    /// 一致；模型不可用时降级为变更文件清单 + 建议启用模型（Ok，不报错）。
    pub async fn adversarial_review(
        &self,
        engine: &GitEngine,
        path: Option<&str>,
    ) -> Result<String> {
        let diff = match engine.diff_for_ai(path, false).await {
            Ok(diff) => diff,
            Err(e) => return Ok(format!("无法获取待审查的差异：{e}")),
        };
        if diff.trim().is_empty() {
            return Ok(match path {
                Some(p) => format!("文件 {p} 没有未提交的改动，无需审查。"),
                None => "当前没有可审查的未提交改动。".to_string(),
            });
        }
        if !self.available() {
            return Ok(fallback_adversarial(&diff));
        }
        let target = path.unwrap_or("全部未提交改动");
        let user = format!(
            "审查范围：{target}\n\ndiff 内容：\n{}\n\n请以挑剔的资深审查者身份进行对抗式评审。",
            limit_text(&diff, DIFF_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_ADVERSARIAL, &user, 1200).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback_adversarial(&diff)),
        }
    }

    // -- 变更根因分析（P2-7） ---------------------------------------------

    /// 对单个提交做根因分析（变更动机 / 触发背景 / 对外影响 / 是否引入风险）。
    /// commit 缺省取 HEAD；输入为该提交的提交信息（subject）与相对父提交的 diff。
    /// commit 不存在或获取失败时返回明确中文提示（Ok，不报错）；模型不可用时
    /// 降级为「提交信息 + diff 统计」模板。
    pub async fn root_cause(
        &self,
        engine: &GitEngine,
        commit: Option<&str>,
    ) -> Result<String> {
        let commit = commit
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .unwrap_or("HEAD");
        let (subject, diff) = match engine.show_commit(commit).await {
            Ok(pair) => pair,
            Err(_) => {
                return Ok(format!(
                    "无法获取提交 {commit} 的信息：该提交可能不存在，请检查提交哈希或分支引用。"
                ));
            }
        };
        // 空提交 / 根提交等没有 diff 头的情况给出明确提示（git show 仅输出提交信息）。
        if !diff.lines().any(|line| line.starts_with("diff --git ")) {
            return Ok(format!("提交 {commit}（{subject}）没有可分析的代码差异（可能为空提交或根提交）。"));
        }
        if !self.available() {
            return Ok(fallback_root_cause(commit, &subject, &diff));
        }
        let user = format!(
            "提交：{commit}\n提交信息：{subject}\n\n变更 diff：\n{}\n\n请生成根因分析报告。",
            limit_text(&diff, DIFF_LIMIT_CHARS)
        );
        match self.chat_once(SYSTEM_RCA, &user, 1200).await {
            Ok(text) => Ok(clean_model_output(&text)),
            Err(_) => Ok(fallback_root_cause(commit, &subject, &diff)),
        }
    }

    /// 取 base..head 的提交 subject 列表（降级模板用；命令失败返回空列表）。
    async fn pr_commit_subjects(&self, engine: &GitEngine, base: &str, head: &str) -> Vec<String> {
        // 注意：`git log A..B` 的范围必须作为单个参数传入（A B 两个参数是并集语义）。
        let range = format!("{base}..{head}");
        let (code, stdout, _stderr) = engine
            .run_output(&["log", "--pretty=format:%s", range.as_str()], &[])
            .await
            .unwrap_or((1, String::new(), String::new()));
        if code != 0 {
            return Vec::new();
        }
        stdout.lines().map(str::to_owned).collect()
    }

    // -- 工具 --------------------------------------------------------------

    /// 工作区 + 暂存区相对 HEAD 的全部未提交改动（diff 与 stat）。
    async fn unstaged_changes(&self, engine: &GitEngine) -> Result<(String, String)> {
        let wd = engine.diff(None, false, 5).await?;
        let idx = engine.diff(None, true, 5).await?;
        let mut diff = String::new();
        if !wd.diff.trim().is_empty() {
            diff.push_str(&wd.diff);
        }
        if !idx.diff.trim().is_empty() {
            diff.push_str(&idx.diff);
        }
        let stat = format!("{}\n{}", wd.stat.trim(), idx.stat.trim());
        Ok((diff, stat.trim().to_string()))
    }

    /// 取两个提交/引用之间的完整 diff（参数化执行，不经 shell；
    /// 复用 GitEngine 的 PRoot Linux 路由，Android 宿主无 git 时也在 guest 内可用）。
    async fn diff_range(&self, engine: &GitEngine, from: &str, to: &str) -> Result<String> {
        let (code, stdout, stderr) = engine
            .run_output(
                &["diff", "--no-ext-diff", "--no-color", "--unified=5", from, to],
                &[],
            )
            .await?;
        if code != 0 {
            return Err(anyhow!(
                "git diff {from}..{to} 失败：{}",
                stderr.trim()
            ));
        }
        Ok(stdout)
    }
}

impl Default for AiGit {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 降级路径（模型不可用时的启发式结果，全部为独立纯函数，便于单元测试）
// ---------------------------------------------------------------------------

/// 由暂存区改动文件推断提交信息（如 `feat: update <首文件名>` + diff stat 行）。
fn heuristic_commit_message(entries: &[FileEntry], stat: &str) -> String {
    if entries.is_empty() {
        return "暂存区为空：请先 git add 需要提交的改动，再生成提交信息。".to_string();
    }
    let all_added = entries
        .iter()
        .all(|entry| entry.status.starts_with('A') || entry.status == "??");
    let all_removed = entries.iter().all(|entry| entry.status.starts_with('D'));
    let verb = if all_added {
        "add"
    } else if all_removed {
        "remove"
    } else {
        "update"
    };
    let first = &entries[0].path;
    let mut out = format!("feat: {verb} {first}\n\n");
    if !stat.trim().is_empty() {
        out.push_str(stat.trim());
        out.push('\n');
    }
    out.push_str(&format!(
        "\n变更文件（{}）：{}",
        entries.len(),
        entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    out.push_str("\n\n（由改动文件推断生成；模型不可用或暂存区为空时使用）");
    out
}

/// 变更总结降级：diff --stat 摘要 + 变更文件列表。
fn fallback_summary(stat: &str, diff: &str) -> String {
    let mut out = String::from("（模型不可用，以下为变更摘要降级结果）\n");
    let stat = stat.trim();
    if !stat.is_empty() {
        out.push_str(stat);
        out.push('\n');
    }
    let files = diff_file_names(diff);
    if !files.is_empty() {
        out.push_str(&format!("\n变更文件（{}）：\n", files.len()));
        for file in &files {
            out.push_str(&format!("- {file}\n"));
        }
    }
    if stat.is_empty() && files.is_empty() {
        out.push_str("未检测到变更内容。");
    }
    out
}

/// 从 unified diff 文本中提取变更文件（处理 rename 的 a/x -> b/y 形式）。
fn diff_file_names(diff: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in diff.lines() {
        let Some(rest) = line.strip_prefix("diff --git ") else {
            continue;
        };
        let mut parts = rest.split_whitespace();
        let a_raw = parts.next().unwrap_or("");
        let b_raw = parts.next().unwrap_or("");
        let a = a_raw.strip_prefix("a/").unwrap_or(a_raw).to_string();
        let b = b_raw.strip_prefix("b/").unwrap_or(b_raw).to_string();
        if a.is_empty() && b.is_empty() {
            continue;
        }
        let name = if a == b { a } else { format!("{a} -> {b}") };
        if !files.iter().any(|existing| *existing == name) {
            files.push(name);
        }
    }
    files
}

/// 代码 review 降级：diff stat + 变更文件清单 + 提示。
fn fallback_review(diff: &str) -> String {
    let files = diff_file_names(diff);
    let mut out = String::from(
        "（模型不可用，已降级为 diff 摘要，无法生成逐条代码审查）\n\n",
    );
    if files.is_empty() {
        out.push_str("未检测到变更文件。");
    } else {
        out.push_str(&format!("变更文件（{}）：\n", files.len()));
        for file in &files {
            out.push_str(&format!("- {file}\n"));
        }
        out.push_str("\n建议：待模型可用后重新执行代码审查，或手动检查上述文件的改动。");
    }
    out
}

/// 文件中的一个冲突块。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictBlock {
    /// 冲突标记 <<<<<<< 所在行号（1-based）。
    pub start_line: usize,
    /// 当前分支（ours）一侧内容（不含标记行）。
    pub ours: Vec<String>,
    /// 传入分支（theirs）一侧内容（不含标记行）。
    pub theirs: Vec<String>,
}

/// 解析文件中的冲突块（<<<<<<< ... ======= ... >>>>>>>）。
fn parse_conflict_blocks(content: &str) -> Vec<ConflictBlock> {
    let mut blocks = Vec::new();
    let mut ours: Vec<String> = Vec::new();
    let mut theirs: Vec<String> = Vec::new();
    let mut state: Option<usize> = None;
    let mut in_ours = true;
    for (idx, raw) in content.lines().enumerate() {
        let line_no = idx + 1;
        let line = raw.trim_end_matches('\r');
        if let Some(start) = state {
            if line.starts_with("=======") {
                in_ours = false;
                continue;
            }
            if line.starts_with(">>>>>>>") {
                blocks.push(ConflictBlock {
                    start_line: start,
                    ours: std::mem::take(&mut ours),
                    theirs: std::mem::take(&mut theirs),
                });
                state = None;
                continue;
            }
            if in_ours {
                ours.push(line.to_string());
            } else {
                theirs.push(line.to_string());
            }
        } else if line.starts_with("<<<<<<<") {
            state = Some(line_no);
            in_ours = true;
            ours.clear();
            theirs.clear();
        }
    }
    blocks
}

/// 冲突解决降级：按块列出 ours/theirs 两侧摘要。
fn fallback_conflict(path: &str, blocks: &[ConflictBlock]) -> String {
    let mut out = format!(
        "（模型不可用，以下为冲突两侧摘要，请手动合并）\n\n文件 {path} 共 {} 处冲突：\n\n",
        blocks.len()
    );
    for (idx, block) in blocks.iter().enumerate() {
        out.push_str(&format!(
            "冲突块 {}（约第 {} 行起）：\n",
            idx + 1,
            block.start_line
        ));
        out.push_str("  [当前分支 ours]\n");
        for line in summarize_lines(&block.ours, 12) {
            out.push_str(&format!("    {line}\n"));
        }
        out.push_str("  [传入分支 theirs]\n");
        for line in summarize_lines(&block.theirs, 12) {
            out.push_str(&format!("    {line}\n"));
        }
        out.push('\n');
    }
    out.push_str(
        "解决步骤：1) 编辑文件保留所需内容并删除冲突标记；2) git add 该文件；3) 完成合并提交。",
    );
    out
}

/// 截断多行内容供摘要展示；空行跳过，超出部分标注省略行数。
fn summarize_lines(lines: &[String], max: usize) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines.iter().take(max) {
        let line = line.trim();
        if !line.is_empty() {
            out.push(line.to_string());
        }
    }
    if lines.len() > max {
        out.push(format!("……（其余 {} 行省略）", lines.len() - max));
    }
    out
}

/// 工作区顶层条目清单（最多 30 项，跳过隐藏目录与常见构建产物目录）。
fn top_level_entries(workspace: &Path) -> Vec<String> {
    let mut entries = Vec::new();
    let Ok(rd) = std::fs::read_dir(workspace) else {
        return entries;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if matches!(
            name.as_str(),
            "node_modules" | "target" | "dist" | "build" | "venv" | "out" | "bin" | "obj"
        ) {
            continue;
        }
        entries.push(name);
        if entries.len() >= 30 {
            break;
        }
    }
    entries.sort();
    entries
}

/// README 生成降级：Markdown 模板（项目名/简介/快速开始/功能列表）。
fn readme_template(project_name: &str, detected: &[String], entries: &[String]) -> String {
    let mut out = format!("# {project_name}\n\n");
    if !detected.is_empty() {
        out.push_str(&format!("> 技术栈：{}\n\n", detected.join(" / ")));
    }
    out.push_str("## 项目简介\n\n（待补充：项目定位与核心价值）\n\n");
    out.push_str("## 快速开始\n\n```bash\n# 安装依赖\n# 运行项目\n```\n\n");
    out.push_str("## 功能列表\n\n");
    if entries.is_empty() {
        out.push_str("- （待补充）\n");
    } else {
        for entry in entries.iter().take(12) {
            out.push_str(&format!("- 模块/目录：`{entry}`\n"));
        }
        if entries.len() > 12 {
            out.push_str(&format!("- ……等共 {} 项\n", entries.len()));
        }
    }
    out.push_str("\n> 本 README 由 Coomi 生成（模型不可用时的模板草稿），请补充实际内容。\n");
    out
}

/// PR 描述降级模板：由 base..head 的提交 subject 拼成标题+正文
/// （模型不可用 / diff 为空 / 无法读取 diff 时使用；纯函数便于测试）。
fn fallback_pr_description(base: &str, head: &str, subjects: &[String]) -> String {
    let mut out = format!(
        "# {head} → {base} 变更\n\n（模型不可用，以下为提交摘要降级模板）\n\n## 变更摘要\n"
    );
    if subjects.is_empty() {
        out.push_str("- （无提交记录或无法读取提交历史）\n");
    } else {
        for subject in subjects {
            out.push_str(&format!("- {subject}\n"));
        }
    }
    out.push_str("\n## 主要文件\n（模型不可用时无法自动列出，请按实际改动补充）\n\n## 测试建议\n（请按实际改动补充测试计划）\n");
    out
}

/// A/B 实验对比降级模板：两分支提交历史 + 合并 diff stat（纯函数便于测试）。
fn fallback_compare_text(
    branch_a: &str,
    subjects_a: &[String],
    branch_b: &str,
    subjects_b: &[String],
    stat: &str,
) -> String {
    let mut out = format!(
        "（模型不可用，以下为 A/B 实验对比的降级摘要）\n\n## 方案差异\n- 分支 {branch_a} 最近提交：\n{}\n- 分支 {branch_b} 最近提交：\n{}\n\n## 影响文件\n",
        subjects_list(subjects_a),
        subjects_list(subjects_b),
    );
    let stat = stat.trim();
    if stat.is_empty() {
        out.push_str("（无法获取两分支合并差异的统计信息）\n");
    } else {
        out.push_str(&format!("两分支合并差异统计：\n{stat}\n"));
    }
    out.push_str("\n建议：待模型可用后重新生成对比报告，或手动 diff 两个分支核对实现差异。");
    out
}

/// 提交 subject 列表渲染（空列表给占位提示）。
fn subjects_list(subjects: &[String]) -> String {
    if subjects.is_empty() {
        "- （无提交记录或无法读取）".to_string()
    } else {
        subjects
            .iter()
            .map(|subject| format!("- {subject}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// 对抗式评审降级：变更文件清单 + 建议启用模型（纯函数便于测试）。
fn fallback_adversarial(diff: &str) -> String {
    let files = diff_file_names(diff);
    let mut out = String::from(
        "（模型不可用，已降级为 diff 摘要，无法进行对抗式盲点审查）\n\n",
    );
    if files.is_empty() {
        out.push_str("未检测到变更文件。");
    } else {
        out.push_str(&format!("变更文件（{}）：\n", files.len()));
        for file in &files {
            out.push_str(&format!("- {file}\n"));
        }
        out.push_str("\n建议：待模型可用后重新执行对抗式评审，或手动从边界条件、错误处理、安全、并发与兼容性角度检查上述文件。");
    }
    out
}

/// 根因分析降级模板：提交信息 + 由 diff 推导的变更统计（纯函数便于测试）。
fn fallback_root_cause(commit: &str, subject: &str, diff: &str) -> String {
    let mut out = format!(
        "（模型不可用，以下为变更根因分析的降级摘要）\n\n提交：{commit}\n提交信息：{subject}\n\n变更统计：\n{}\n",
        diff_stat_text(diff),
    );
    let files = diff_file_names(diff);
    if !files.is_empty() {
        out.push_str(&format!("\n变更文件（{}）：\n", files.len()));
        for file in &files {
            out.push_str(&format!("- {file}\n"));
        }
    }
    out.push_str("\n建议：待模型可用后重新执行根因分析，或结合提交信息与上述文件手工推断变更动机与风险。");
    out
}

/// 从 unified diff 推导变更统计：文件数 / 新增 / 删除行数。
fn diff_stat_text(diff: &str) -> String {
    let files = diff_file_names(diff);
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for line in diff.lines() {
        // 跳过 +++ / --- 文件头行，只统计真实变更行。
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if let Some(rest) = line.strip_prefix('+') {
            if !rest.is_empty() {
                additions += 1;
            }
        } else if let Some(rest) = line.strip_prefix('-') {
            if !rest.is_empty() {
                deletions += 1;
            }
        }
    }
    format!(
        "{} 个文件变更，{} 行新增，{} 行删除",
        files.len(),
        additions,
        deletions
    )
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/// 按字符数截断长文本，保留结尾截断标记。
fn limit_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars).collect();
    truncated.push_str("\n... [内容过长，已截断]");
    truncated
}

/// 清理模型输出：去掉首尾代码围栏与多余空白。
fn clean_model_output(text: &str) -> String {
    let mut out = text.trim().to_string();
    if out.starts_with("```") {
        if let Some(end) = out.find('\n') {
            out = out[end + 1..].to_string();
        } else {
            out = out.trim_start_matches('`').trim().to_string();
        }
    }
    if out.ends_with("```") {
        if let Some(start) = out.rfind("```") {
            out.truncate(start);
        }
    }
    out.trim().to_string()
}

/// 从模型输出中稳健解析问题 JSON 数组：先剥离代码围栏，再截取首个 `[` 到
/// 最后一个 `]` 之间的 JSON（兼容前后解释文本）。整体解析失败降级为空数组；
/// 单项字段缺失/类型不符时跳过该项，尽量保留其余可用问题。
fn parse_review_issues(text: &str) -> Vec<ReviewIssue> {
    let cleaned = clean_model_output(text);
    let Some(json_part) = extract_json_array(&cleaned) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(json_part) else {
        return Vec::new();
    };
    let Some(array) = value.as_array() else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    for item in array {
        let Some(path) = item.get("path").and_then(Value::as_str) else {
            continue;
        };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        issues.push(ReviewIssue {
            path: path.to_owned(),
            severity: item
                .get("severity")
                .and_then(Value::as_str)
                .unwrap_or("中")
                .to_owned(),
            summary: item
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            patch: item
                .get("patch")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|patch| !patch.is_empty())
                .map(str::to_owned),
            line: item
                .get("line")
                .and_then(|value| value.as_u64().or_else(|| value.as_f64().map(|f| f as u64)))
                .filter(|line| *line > 0)
                .map(|line| line as usize),
        });
    }
    issues
}

/// 截取文本中第一个 JSON 数组（首个 `[` 到最后一个 `]`），兼容代码围栏与
/// 前后解释文本；找不到返回 None。
fn extract_json_array(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(&text[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RemoteCompactionMode;
    use std::collections::BTreeMap;

    const CONFLICT_SAMPLE: &str = "\
line before
<<<<<<< HEAD
ours line 1
ours line 2
=======
theirs line 1
>>>>>>> feature-branch
line after
";

    #[test]
    fn parse_conflict_blocks_extracts_sides() {
        let blocks = parse_conflict_blocks(CONFLICT_SAMPLE);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 2);
        assert_eq!(blocks[0].ours, vec!["ours line 1", "ours line 2"]);
        assert_eq!(blocks[0].theirs, vec!["theirs line 1"]);
    }

    #[test]
    fn parse_conflict_blocks_without_markers_is_empty() {
        assert!(parse_conflict_blocks("no conflict here\nplain text\n").is_empty());
        assert!(parse_conflict_blocks("").is_empty());
    }

    #[test]
    fn fallback_conflict_lists_both_sides() {
        let blocks = parse_conflict_blocks(CONFLICT_SAMPLE);
        let text = fallback_conflict("src/main.rs", &blocks);
        assert!(text.contains("src/main.rs"));
        assert!(text.contains("冲突块 1"));
        assert!(text.contains("ours line 1"));
        assert!(text.contains("theirs line 1"));
        assert!(text.contains("git add"));
    }

    #[test]
    fn heuristic_commit_message_empty_is_nonempty_hint() {
        let msg = heuristic_commit_message(&[], "");
        assert!(!msg.trim().is_empty());
        assert!(msg.contains("暂存区为空"));
    }

    #[test]
    fn heuristic_commit_message_uses_first_file_and_stat() {
        let entries = vec![
            FileEntry {
                path: "src/main.rs".to_string(),
                status: "M.".to_string(),
                old_path: None,
            },
            FileEntry {
                path: "src/lib.rs".to_string(),
                status: "A.".to_string(),
                old_path: None,
            },
        ];
        let msg = heuristic_commit_message(&entries, " src/main.rs | 2 +-\n 2 files changed");
        assert!(msg.contains("feat: update src/main.rs"));
        assert!(msg.contains("src/lib.rs"));
        assert!(msg.contains("2 files changed"));
    }

    #[test]
    fn diff_file_names_parses_git_headers() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\ndiff --git a/old.rs b/new.rs\n";
        let names = diff_file_names(diff);
        assert!(names.contains(&"src/a.rs".to_string()));
        assert!(names.contains(&"old.rs -> new.rs".to_string()));
    }

    #[test]
    fn fallback_summary_contains_stat_and_files() {
        let text = fallback_summary(
            " 1 file changed, 2 insertions(+), 1 deletion(-)",
            "diff --git a/a.rs b/a.rs\n",
        );
        assert!(text.contains("1 file changed"));
        assert!(text.contains("a.rs"));
    }

    #[test]
    fn clean_model_output_strips_code_fences() {
        assert_eq!(
            clean_model_output("```markdown\n# Hello\n\nbody\n```"),
            "# Hello\n\nbody"
        );
        assert_eq!(clean_model_output("plain"), "plain");
    }

    fn provider_config(kind: ProviderKind, base_url: &str, api_key: &str) -> ProviderConfig {
        ProviderConfig {
            id: "test".to_string(),
            kind,
            display: "Test".to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
            model: "test-model".to_string(),
            fast_model: None,
            models: Vec::new(),
            model_context_windows: BTreeMap::new(),
            model_vision_support: BTreeMap::new(),
            model_parameters: BTreeMap::new(),
            capabilities: Default::default(),
            remote_compaction_mode: RemoteCompactionMode::V2,
        }
    }

    /// 回归：任何已配置的标准协议 provider（OpenAI 兼容 / Anthropic / Gemini）
    /// 都必须可用，不能静默降级（表现为「调用不到 AI 模型」）。
    #[test]
    fn from_provider_accepts_any_configured_provider() {
        // OpenAI 兼容（如 DeepSeek 开放平台 api.deepseek.com）：必须可用。
        let openai = AiGit::from_provider(&provider_config(
            ProviderKind::OpenAiCompatible,
            "https://api.deepseek.com/v1",
            "sk-test",
        ));
        assert!(openai.available(), "OpenAI 兼容 provider 必须可用");
        // Anthropic / Gemini 同样可用。
        assert!(
            AiGit::from_provider(&provider_config(
                ProviderKind::AnthropicMessages,
                "https://api.anthropic.com",
                "sk-ant-test",
            ))
            .available()
        );
        assert!(
            AiGit::from_provider(&provider_config(
                ProviderKind::GeminiNative,
                "https://generativelanguage.googleapis.com",
                "gemini-key",
            ))
            .available()
        );
        // 有 base_url 但无 api_key → 不可用（降级）。
        assert!(
            !AiGit::from_provider(&provider_config(
                ProviderKind::OpenAiCompatible,
                "https://api.deepseek.com/v1",
                "",
            ))
            .available()
        );
        // 无任何配置 → 不可用。
        assert!(!AiGit::new().available());
    }

    #[test]
    fn parse_review_issues_extracts_json_array_with_fences_and_noise() {
        let text = "好的，以下是修复建议：\n```json\n[\n  {\"path\": \"src/main.rs\", \"severity\": \"高\", \"summary\": \"空指针风险\", \"patch\": \"--- a/src/main.rs\\n+++ b/src/main.rs\\n@@ -1 +1 @@\\n-x\\n+y\\n\", \"line\": 10},\n  {\"path\": \"src/lib.rs\", \"severity\": \"中\", \"summary\": \"重复代码\"}\n]\n```\n如有疑问欢迎追问。";
        let issues = parse_review_issues(text);
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].path, "src/main.rs");
        assert_eq!(issues[0].severity, "高");
        assert_eq!(issues[0].line, Some(10));
        assert!(issues[0].patch.is_some());
        assert_eq!(issues[1].path, "src/lib.rs");
        assert!(issues[1].patch.is_none());
        assert_eq!(issues[1].line, None);
    }

    #[test]
    fn parse_review_issues_skips_malformed_items_and_falls_back_to_empty() {
        // 单项缺 path / path 类型不符 → 跳过；整体无法解析 → 空数组。
        let text = r#"[{"severity": "高"}, {"path": 123, "summary": "x"}, {"path": "ok.rs", "summary": "ok"}]"#;
        let issues = parse_review_issues(text);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, "ok.rs");
        assert!(parse_review_issues("模型不可用或输出无法解析").is_empty());
        assert!(parse_review_issues("").is_empty());
        assert!(parse_review_issues("{\"not\": \"an array\"}").is_empty());
    }

    #[tokio::test]
    async fn suggest_fixes_without_model_returns_empty_vec() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        std::fs::write(root.join("a.txt"), "hello\n")?;
        let engine = GitEngine::new(dir.path().join("home"), root);
        let ai = AiGit::new();
        assert!(!ai.available());
        // 有 diff 但模型不可用 → 空数组（降级，不报错）
        let issues = ai.suggest_fixes(&engine, None).await?;
        assert!(issues.is_empty());
        // 空 diff → 空数组
        let issues = ai.suggest_fixes(&engine, Some("a.txt")).await?;
        assert!(issues.is_empty());
        Ok(())
    }

    #[test]
    fn readme_template_contains_required_sections() {
        let text = readme_template(
            "demo",
            &["Rust (Cargo)".to_string()],
            &["src".to_string(), "Cargo.toml".to_string()],
        );
        assert!(text.contains("# demo"));
        assert!(text.contains("## 项目简介"));
        assert!(text.contains("## 快速开始"));
        assert!(text.contains("## 功能列表"));
        assert!(text.contains("Cargo.toml"));
        assert!(text.contains("Rust (Cargo)"));
    }

    #[test]
    fn available_reflects_token_and_base_url() {
        let ai = AiGit::new();
        assert!(!ai.available());
        // 有 token + base_url → 可用（标准协议）。
        let ai = AiGit::with_provider(
            "sk-test-token",
            "deepseek-chat",
            AiMode::OpenAiCompatible,
            "https://api.deepseek.com/v1",
        );
        assert!(ai.available());
        // 只有 token、没有 base_url → 不可用（无法确定端点）。
        let ai = AiGit::with_token("sk-test-token", "deepseek-chat");
        assert!(!ai.available());
        // 空白 token → 不可用。
        let ai = AiGit::with_provider(
            "   ",
            "deepseek-chat",
            AiMode::OpenAiCompatible,
            "https://api.deepseek.com/v1",
        );
        assert!(!ai.available());
    }

    #[tokio::test]
    async fn suggest_commit_message_without_staged_changes_returns_nonempty() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        let engine = GitEngine::new(dir.path().join("home"), root);
        let ai = AiGit::new();
        assert!(!ai.available());
        let msg = ai.suggest_commit_message(&engine, None).await?;
        assert!(!msg.trim().is_empty());
        // 无暂存改动时给出提示而不是报错
        assert!(msg.contains("暂存区为空"));
        Ok(())
    }

    #[tokio::test]
    async fn generate_readme_without_model_returns_template() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        std::fs::write(root.join("Cargo.toml"), "[package]\n")?;
        let engine = GitEngine::new(dir.path().join("home"), root);
        let ai = AiGit::new();
        let readme = ai.generate_readme(&engine).await?;
        assert!(readme.contains("## 项目简介"));
        assert!(readme.contains("## 快速开始"));
        assert!(readme.contains("## 功能列表"));
        assert!(readme.contains("Cargo.toml"));
        assert!(readme.contains("Rust (Cargo)"));
        Ok(())
    }

    #[test]
    fn fallback_pr_description_includes_sections_and_subjects() {
        let text = fallback_pr_description(
            "main",
            "feature",
            &["feat: x".to_string(), "fix: y".to_string()],
        );
        assert!(text.contains("# feature → main 变更"));
        assert!(text.contains("## 变更摘要"));
        assert!(text.contains("## 主要文件"));
        assert!(text.contains("## 测试建议"));
        assert!(text.contains("- feat: x"));
        assert!(text.contains("- fix: y"));

        let empty = fallback_pr_description("main", "feature", &[]);
        assert!(empty.contains("（无提交记录或无法读取提交历史）"));
    }

    #[tokio::test]
    async fn generate_pr_description_without_model_falls_back() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        std::fs::write(root.join("a.txt"), "hello\n")?;
        let engine = GitEngine::new(dir.path().join("home"), root);
        engine.stage(&["a.txt".into()], false).await?;
        let hash = engine.commit("feat: add a.txt").await?;
        let ai = AiGit::new();
        assert!(!ai.available());
        // 有 diff 但模型不可用 → 降级模板（Ok），包含提交 subject 与必需章节。
        let text = ai.generate_pr_description(&engine, "HEAD~1", &hash).await?;
        assert!(text.contains("feat: add a.txt"));
        assert!(text.contains("## 变更摘要"));
        assert!(text.contains("## 主要文件"));
        assert!(text.contains("## 测试建议"));
        // diff 为空（base == head）→ 降级模板，不报错。
        let text = ai
            .generate_pr_description(&engine, &hash, &hash)
            .await?;
        assert!(text.contains("## 变更摘要"));
        // 空 base/head → 校验错误。
        assert!(ai.generate_pr_description(&engine, "", &hash).await.is_err());
        assert!(ai
            .generate_pr_description(&engine, "HEAD~1", "  ")
            .await
            .is_err());
        Ok(())
    }

    #[test]
    fn new_prompt_constants_are_nonempty() {
        assert!(!SYSTEM_AB.is_empty());
        assert!(SYSTEM_AB.contains("## 方案差异"));
        assert!(SYSTEM_AB.contains("## 推荐结论"));
        assert!(!SYSTEM_ADVERSARIAL.is_empty());
        assert!(SYSTEM_ADVERSARIAL.contains("## 盲点"));
        assert!(SYSTEM_ADVERSARIAL.contains("## 风险"));
        assert!(SYSTEM_ADVERSARIAL.contains("## 建议"));
        assert!(!SYSTEM_RCA.is_empty());
        assert!(SYSTEM_RCA.contains("## 变更动机"));
        assert!(SYSTEM_RCA.contains("## 触发背景"));
        assert!(SYSTEM_RCA.contains("## 是否引入风险"));
    }

    #[test]
    fn fallback_compare_text_includes_branches_and_stat() {
        let subjects_a = vec!["feat: impl a".to_string()];
        let subjects_b = vec!["feat: impl b".to_string()];
        let text = fallback_compare_text(
            "feature-a",
            &subjects_a,
            "feature-b",
            &subjects_b,
            " a.txt | 2 +-",
        );
        assert!(text.contains("feature-a"));
        assert!(text.contains("feature-b"));
        assert!(text.contains("feat: impl a"));
        assert!(text.contains("feat: impl b"));
        assert!(text.contains("a.txt | 2 +-"));

        let empty = fallback_compare_text("a", &[], "b", &[], "");
        assert!(empty.contains("无提交记录"));
        assert!(empty.contains("无法获取两分支合并差异"));
    }

    #[test]
    fn fallback_adversarial_lists_files() {
        let text = fallback_adversarial("diff --git a/src/a.rs b/src/a.rs\n");
        assert!(text.contains("src/a.rs"));
        assert!(text.contains("模型不可用"));
        assert!(fallback_adversarial("").contains("未检测到变更文件"));
    }

    #[test]
    fn fallback_root_cause_contains_subject_and_stat() {
        let diff = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";
        let text = fallback_root_cause("abc123", "fix: change value", diff);
        assert!(text.contains("abc123"));
        assert!(text.contains("fix: change value"));
        assert!(text.contains("1 个文件变更"));
        assert!(text.contains("a.txt"));
        assert!(text.contains("模型不可用"));
    }

    #[test]
    fn diff_stat_text_counts_lines() {
        assert_eq!(
            diff_stat_text(
                "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-one\n+two\n+x\n"
            ),
            "1 个文件变更，2 行新增，1 行删除"
        );
        assert_eq!(diff_stat_text(""), "0 个文件变更，0 行新增，0 行删除");
    }

    #[tokio::test]
    async fn compare_implementations_without_model_returns_fallback() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        let engine = GitEngine::new(dir.path().join("home"), root.clone());
        // 基线提交。
        std::fs::write(root.join("a.txt"), "v1\n")?;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("base: add a.txt").await?;
        // 分支 A：基于基线的实现。
        engine.create_branch("feature-a").await?;
        std::fs::write(root.join("a.txt"), "va\n")?;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("feat: impl a").await?;
        // 分支 B：基于基线的另一套实现。
        engine.checkout("main").await?;
        engine.create_branch("feature-b").await?;
        std::fs::write(root.join("a.txt"), "vb\n")?;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("feat: impl b").await?;

        let ai = AiGit::new();
        assert!(!ai.available());
        // 模型不可用 → 降级摘要（Ok），包含两分支提交历史与合并 stat。
        let text = ai
            .compare_implementations(&engine, "feature-a", "feature-b")
            .await?;
        assert!(!text.trim().is_empty());
        assert!(text.contains("feature-a"));
        assert!(text.contains("feature-b"));
        assert!(text.contains("feat: impl a"));
        assert!(text.contains("feat: impl b"));
        assert!(text.contains("a.txt"));
        assert!(text.contains("模型不可用"));
        Ok(())
    }

    #[tokio::test]
    async fn compare_implementations_rejects_empty_refs() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        let engine = GitEngine::new(dir.path().join("home"), root);
        let ai = AiGit::new();
        assert!(ai
            .compare_implementations(&engine, "", "main")
            .await
            .is_err());
        assert!(ai
            .compare_implementations(&engine, "main", "  ")
            .await
            .is_err());
        Ok(())
    }

    #[tokio::test]
    async fn adversarial_review_without_model_returns_fallback() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        std::fs::write(root.join("a.txt"), "hello\n")?;
        let engine = GitEngine::new(dir.path().join("home"), root.clone());
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("feat: add a.txt").await?;
        let ai = AiGit::new();
        assert!(!ai.available());
        // 空 diff → 与 code_review 一致的提示。
        let text = ai.adversarial_review(&engine, Some("a.txt")).await?;
        assert!(text.contains("没有未提交的改动"));
        // 未提交改动 → 模型不可用降级：列出变更文件并提示启用模型。
        std::fs::write(root.join("a.txt"), "changed\n")?;
        let text = ai.adversarial_review(&engine, None).await?;
        assert!(!text.trim().is_empty());
        assert!(text.contains("a.txt"));
        assert!(text.contains("模型不可用"));
        Ok(())
    }

    #[tokio::test]
    async fn root_cause_without_model_returns_fallback() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        let engine = GitEngine::new(dir.path().join("home"), root.clone());
        std::fs::write(root.join("a.txt"), "one\n")?;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("feat: add a.txt").await?;
        std::fs::write(root.join("a.txt"), "two\n")?;
        engine.stage(&["a.txt".into()], false).await?;
        let hash = engine.commit("fix: change value").await?;

        let ai = AiGit::new();
        assert!(!ai.available());
        // 指定提交 → 降级摘要包含提交信息、统计与文件。
        let text = ai.root_cause(&engine, Some(&hash)).await?;
        assert!(!text.trim().is_empty());
        assert!(text.contains("fix: change value"));
        assert!(text.contains("a.txt"));
        assert!(text.contains("模型不可用"));
        // commit 缺省 → 取 HEAD。
        let text = ai.root_cause(&engine, None).await?;
        assert!(text.contains("fix: change value"));
        // commit 不存在 → 明确中文提示，Ok 不报错。
        let text = ai
            .root_cause(&engine, Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"))
            .await?;
        assert!(text.contains("无法获取提交"));
        assert!(text.contains("不存在"));
        Ok(())
    }

    #[tokio::test]
    async fn summarize_changes_without_model_is_nonempty() -> Result<()> {
        let dir = tempfile::tempdir().context("创建临时目录失败")?;
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root)?;
        init_repo(&root).await?;
        std::fs::write(root.join("a.txt"), "hello\n")?;
        let engine = GitEngine::new(dir.path().join("home"), root);
        engine.stage(&["a.txt".into()], false).await?;
        let ai = AiGit::new();
        let summary = ai.summarize_changes(&engine, None).await?;
        assert!(!summary.trim().is_empty());
        assert!(summary.contains("a.txt"));
        Ok(())
    }

    async fn init_repo(dir: &Path) -> Result<()> {
        let output = tokio::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(dir)
            .output()
            .await
            .context("git init 失败")?;
        assert!(output.status.success(), "git init 失败");
        for (key, value) in [("user.name", "Test"), ("user.email", "test@local")] {
            let output = tokio::process::Command::new("git")
                .args(["config", key, value])
                .current_dir(dir)
                .output()
                .await
                .context("git config 失败")?;
            assert!(output.status.success(), "git config {key} 失败");
        }
        let output = tokio::process::Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init", "-q"])
            .current_dir(dir)
            .output()
            .await
            .context("初始提交失败")?;
        assert!(output.status.success(), "初始提交失败");
        Ok(())
    }
}
