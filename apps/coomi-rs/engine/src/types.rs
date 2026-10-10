use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// context_window 的来源：压缩判定「取小了」的根因定位与前端展示都靠它。
/// 优先级（高 → 低）：Probe（上游 /models 探测到的真实窗口）→ Config
/// （providers.json 的 contextWindow / modelContextWindows 已知值）→ Default（兜底默认值）。
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextWindowSource {
    /// 上游探测得到的真实窗口（providers.json 标记 context_window_source = "probe"）。
    Probe,
    /// providers.json 里配置/已知的窗口值。
    Config,
    /// 没有任何可用配置时的兜底默认窗口。
    #[default]
    Default,
}

impl ContextWindowSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Config => "config",
            Self::Default => "default",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ModelCapabilities {
    #[serde(default = "default_context_window")]
    pub context_window: u64,
    /// context_window 的来源（probe / config / default）。压缩判定与前端提示都用它解释
    /// 「窗口从哪来」；旧会话/旧配置反序列化时回落到 default。
    #[serde(default)]
    pub context_window_source: ContextWindowSource,
    #[serde(default = "default_effective_context_window_percent")]
    pub effective_context_window_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compact_token_limit: Option<u64>,
    #[serde(default)]
    pub auto_compact_scope: AutoCompactScope,
    /// 自动压缩阈值比例（窗口百分比，50~95，默认 85）。
    #[serde(default = "default_auto_compact_percent")]
    pub auto_compact_percent: u8,
    /// 自动压缩绝对下限（token）：用量不到这个数一律不自动压缩；0 = 不启用下限。
    #[serde(default = "default_auto_compact_floor_tokens")]
    pub auto_compact_floor_tokens: u64,
    /// 压缩保留区（token）：压缩阈值不得超过「有效窗口 − 保留区」，给压缩本身留出余量。
    #[serde(default = "default_auto_compact_retain_tokens")]
    pub auto_compact_retain_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comp_hash: Option<String>,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u64,
    #[serde(default)]
    pub supports_remote_compaction: bool,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_native_tools: bool,
    #[serde(default)]
    pub supports_web_search: bool,
    #[serde(default)]
    pub supports_parallel_tool_calls: bool,
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self {
            context_window: default_context_window(),
            context_window_source: ContextWindowSource::Default,
            effective_context_window_percent: default_effective_context_window_percent(),
            auto_compact_token_limit: None,
            auto_compact_scope: AutoCompactScope::Total,
            auto_compact_percent: default_auto_compact_percent(),
            auto_compact_floor_tokens: default_auto_compact_floor_tokens(),
            auto_compact_retain_tokens: default_auto_compact_retain_tokens(),
            comp_hash: None,
            max_output_tokens: default_max_output_tokens(),
            supports_remote_compaction: false,
            supports_vision: false,
            supports_native_tools: true,
            supports_web_search: false,
            supports_parallel_tool_calls: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoCompactScope {
    #[default]
    Total,
    BodyAfterPrefix,
}

/// 触发一次上下文压缩的原因：写入压缩历史（CompactionRecord.reason），
/// 也随 AgentEvent::CompactionCompleted 推给前端做「为什么压缩」的解释。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    /// 用量达到窗口维度阈值：min(窗口 × auto_compact_percent, 有效窗口 − 保留区)，
    /// 且该阈值不低于绝对下限。旧记录里的 token_limit / context_window 也归到这里。
    #[serde(alias = "token_limit", alias = "context_window")]
    Percent,
    /// 绝对下限（auto_compact_floor_tokens）是实际触发点：下限高于窗口维度阈值，
    /// 用量先到下限才压。
    Floor,
    /// 系统提示 / 工具定义指纹（comp_hash）变化，缓存前缀失效。
    #[serde(alias = "comp_hash")]
    Cache,
    /// 消息条数达到 auto_compact_message_limit（且用量已超过窗口 50%）。
    #[serde(alias = "message_limit")]
    Messages,
    /// provider 直接报「上下文超限」，走强制压缩兜底（不受自动压缩开关影响）。
    ProviderError,
    /// 用户手动压缩（/compact 或强制压缩）。
    Manual,
}

impl CompactionReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Percent => "percent",
            Self::Floor => "floor",
            Self::Cache => "cache",
            Self::Messages => "messages",
            Self::ProviderError => "provider_error",
            Self::Manual => "manual",
        }
    }
}

impl ModelCapabilities {
    pub fn effective_context_window(&self) -> u64 {
        self.context_window
            .saturating_mul(u64::from(self.effective_context_window_percent))
            / 100
    }

    /// 窗口比例阈值：窗口 × auto_compact_percent（比例非法时夹到 50~95）。
    pub fn auto_compact_percent_limit(&self) -> u64 {
        let percent = u64::from(
            self.auto_compact_percent
                .clamp(MIN_AUTO_COMPACT_PERCENT, MAX_AUTO_COMPACT_PERCENT),
        );
        self.context_window.saturating_mul(percent) / 100
    }

    /// 保留区上限：有效窗口 − 保留区。至少留 1，避免窗口比保留区还小时阈值归零、
    /// 变成「每轮都压」。
    pub fn auto_compact_retain_limit(&self) -> u64 {
        self.effective_context_window()
            .saturating_sub(self.auto_compact_retain_tokens)
            .max(1)
    }

    /// 自动压缩的窗口维度阈值：min(窗口 × 比例, 有效窗口 − 保留区)，
    /// 再被 provider 显式配置的 auto_compact_token_limit 压低，且不超过有效窗口。
    pub fn auto_compact_window_limit(&self) -> u64 {
        let derived = self
            .auto_compact_percent_limit()
            .min(self.auto_compact_retain_limit());
        self.auto_compact_token_limit
            .map_or(derived, |limit| limit.min(derived))
            .min(self.effective_context_window())
    }

    /// 实际触发点（前端展示「到多少 token 才会自动压缩」）：
    /// 窗口维度阈值与绝对下限取较大者，但不超过窗口本身（超过窗口必然要压）。
    pub fn auto_compact_trigger_limit(&self) -> u64 {
        self.auto_compact_window_limit()
            .max(self.auto_compact_floor_tokens)
            .min(self.context_window.max(1))
    }

    /// 用量占窗口的百分比（0~100）。
    pub fn used_percent(&self, used_tokens: u64) -> u8 {
        let window = self.context_window.max(1);
        u8::try_from(
            used_tokens
                .saturating_mul(100)
                .saturating_div(window)
                .min(100),
        )
        .unwrap_or(100)
    }
}

/// 自动压缩比例的下限/上限（百分比）。
pub const MIN_AUTO_COMPACT_PERCENT: u8 = 50;
pub const MAX_AUTO_COMPACT_PERCENT: u8 = 95;
/// 默认按窗口 85% 触发（256k 窗口约 21.8 万 token）。
pub const DEFAULT_AUTO_COMPACT_PERCENT: u8 = 85;
/// 默认绝对下限 10 万 token：窗口再小也不在 10 万 token 以前自动压缩。
pub const DEFAULT_AUTO_COMPACT_FLOOR_TOKENS: u64 = 100_000;
/// 默认保留区 3.2 万 token：压缩前至少给窗口留这么多余量。
pub const DEFAULT_AUTO_COMPACT_RETAIN_TOKENS: u64 = 32_000;

const fn default_context_window() -> u64 {
    256_000
}

const fn default_auto_compact_percent() -> u8 {
    DEFAULT_AUTO_COMPACT_PERCENT
}

const fn default_auto_compact_floor_tokens() -> u64 {
    DEFAULT_AUTO_COMPACT_FLOOR_TOKENS
}

const fn default_auto_compact_retain_tokens() -> u64 {
    DEFAULT_AUTO_COMPACT_RETAIN_TOKENS
}

const fn default_effective_context_window_percent() -> u8 {
    95
}

const fn default_max_output_tokens() -> u64 {
    8_192
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// 结构化附件：用户随一条消息附带的文件/目录。
/// UI 侧按 name/kind/ext 渲染卡片；模型侧由引擎把完整路径内联进请求文本
/// （模型必须能按路径真的读到文件），会话里存的仍是用户原始文本。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Attachment {
    #[serde(default)]
    pub name: String,
    /// 绝对路径（Windows 上是 \\?\ 之外的普通盘符路径）。模型按它读文件。
    #[serde(default)]
    pub path: String,
    /// 小写扩展名，不含点；目录为空串。
    #[serde(default)]
    pub ext: String,
    #[serde(default)]
    pub size: u64,
    /// file / directory / image / video / audio / archive / code / text。
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

impl Attachment {
    /// 由磁盘路径补全元数据（前端只传 path 时也能得到完整的结构化附件）。
    pub fn from_path(path: &Path) -> Self {
        let metadata = std::fs::metadata(path).ok();
        let is_directory = metadata.as_ref().is_some_and(std::fs::Metadata::is_dir);
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path.display().to_string());
        let ext = if is_directory {
            String::new()
        } else {
            path.extension()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default()
        };
        Self {
            name,
            path: path.display().to_string(),
            ext: ext.clone(),
            size: metadata.as_ref().map(std::fs::Metadata::len).unwrap_or(0),
            kind: if is_directory {
                "directory".to_owned()
            } else {
                attachment_kind(&ext).to_owned()
            },
            mime: None,
        }
    }

    /// 模型侧渲染成一行（路径必须完整，模型要照着读）。
    pub fn model_line(&self) -> String {
        let kind = if self.kind.is_empty() {
            "file"
        } else {
            self.kind.as_str()
        };
        let mut line = format!(
            "- {}（{}，{}，{} bytes）",
            if self.name.is_empty() {
                self.path.as_str()
            } else {
                self.name.as_str()
            },
            kind,
            if self.ext.is_empty() {
                "无扩展名".to_owned()
            } else {
                format!("ext={}", self.ext)
            },
            self.size
        );
        line.push_str(&format!("\n  path: {}", self.path));
        if let Some(mime) = &self.mime
            && !mime.is_empty()
        {
            line.push_str(&format!("\n  mime: {mime}"));
        }
        line
    }
}

/// 扩展名 → 类别标签（只影响展示与模型提示词里的分类，不做内容嗅探）。
pub fn attachment_kind(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" => "image",
        "mp4" | "mov" | "mkv" | "avi" | "webm" => "video",
        "mp3" | "wav" | "flac" | "m4a" | "ogg" => "audio",
        "zip" | "7z" | "rar" | "tar" | "gz" | "xz" | "bz2" => "archive",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "java" | "kt" | "go" | "c" | "cc" | "cpp"
        | "h" | "hpp" | "cs" | "rb" | "php" | "swift" | "sh" | "ps1" | "bat" | "cmd" | "toml"
        | "json" | "yaml" | "yml" | "xml" | "sql" | "css" | "html" | "vue" => "code",
        "txt" | "md" | "log" | "csv" | "tsv" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt"
        | "pptx" => "text",
        _ => "file",
    }
}

/// 结构化引用：用户引用的一段历史消息（UI 显示引用卡片，模型侧内联原文）。
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Quote {
    /// 被引用消息的 id（旧前端可能不带）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default)]
    pub text: String,
    /// 引用时间：ISO 字符串或毫秒时间戳都接受，统一按字符串保存。
    #[serde(
        default,
        deserialize_with = "deserialize_flexible_text",
        skip_serializing_if = "String::is_empty"
    )]
    pub at: String,
}

impl Quote {
    pub fn model_line(&self) -> String {
        let mut line = format!("- {}", self.text.trim().replace('\n', " "));
        match (
            self.message_id.as_deref().filter(|id| !id.is_empty()),
            self.at.is_empty(),
        ) {
            (Some(id), false) => line.push_str(&format!("（引用消息 {id}，时间 {}）", self.at)),
            (Some(id), true) => line.push_str(&format!("（引用消息 {id}）")),
            (None, false) => line.push_str(&format!("（引用时间 {}）", self.at)),
            (None, true) => {}
        }
        line
    }
}

/// 时间戳字段的宽松反序列化：字符串原样、数字转十进制字符串、null/缺失为空串。
fn deserialize_flexible_text<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(text)) => text,
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ChatMessage {
    /// 稳定消息 id：供前端精确定位单条消息做编辑/删除/重新回答。
    /// 旧会话无 id 时惰性生成（serde default 兼容），会话加载时补齐。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub role: Role,
    pub content: String,
    /// 模型思考（reasoning / reasoning_content）文本：流式产出，随本轮
    /// assistant 消息一起持久化。旧会话没有该字段（serde default 兼容），
    /// 一轮结束后前端回读历史时也不再丢失思考框。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reasoning: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub compaction_summary: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub internal: bool,
    /// 引擎注入的**非用户输入**标记（机器可读）：目前只有 "goal"（目标复述）。
    /// 前端据此不把它当成用户消息渲染，改成一条轻量系统行。
    /// 之前只有 internal 这一个布尔（且前端忽略了它），于是每 6 轮注入一次的目标复述
    /// 会以一个「用户气泡」的样子突然出现在对话里 —— 看起来像用户自己发了一条控制台指令。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder: Option<String>,
    /// 数字生命体主动消息（气泡/开场问候）：由生命体队列直接写入，不来自模型。
    #[serde(default, skip_serializing_if = "is_false")]
    pub life_proactive: bool,
    /// 消息级置顶：置顶消息在上下文压缩时优先逐字保留（总量另设上限）。
    /// 用户可手动置顶，引擎也会把「里程碑轮次」自动置顶。
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    /// 流式草稿：模型还在生成时周期性落盘的部分回复。正常结束会被正式消息
    /// 覆盖；进程被杀/崩溃时它以「生成中断」的形式留在会话里，不丢已生成内容。
    #[serde(default, skip_serializing_if = "is_false")]
    pub draft: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_items: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageContent>,
    /// 结构化附件（serde default：旧会话没有该字段也能加载）。
    /// 会话里存的是结构，UI 只渲染卡片；发给模型时由引擎内联成路径文本。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// 结构化引用（同上：旧会话向后兼容）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quotes: Vec<Quote>,
    /// **本轮易变上下文的尾巴**（记忆召回 / 技能路由正文 / 目标栈 / MCP 清单）——
    /// 只在这个字段里存，UI 与历史展示仍然只读 content（用户原文）。
    ///
    /// 为什么必须随消息持久化，而不是发送时临时拼接：前缀缓存按 token 前缀匹配，
    /// 这一轮拼上去的尾巴在下一轮就是历史的一部分；如果历史里存的是「干净原文」，
    /// 下一轮重建出来的 token 序列就会在这里分叉 —— 实测缓存只能吃到 system+tools
    /// 那一段（约 16k tokens），命中率卡在 77% 上不去。存下来之后历史即所发，
    /// 前缀逐字节一致，稳态命中率才可能到 95%+。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub request_context: String,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(Role::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(Role::User, content)
    }

    pub fn assistant(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        let mut tool_calls = tool_calls;
        for call in &mut tool_calls {
            sanitize_json_encoded_data(&mut call.arguments);
        }
        Self {
            id: new_message_id(),
            role: Role::Assistant,
            content: sanitize_long_encoded_data(&content.into()),
            reasoning: String::new(),
            tool_calls,
            tool_call_id: None,
            compaction_summary: false,
            internal: false,
            reminder: None,
            life_proactive: false,
            pinned: false,
            draft: false,
            provider_items: Vec::new(),
            images: Vec::new(),
            attachments: Vec::new(),
            quotes: Vec::new(),
            request_context: String::new(),
        }
    }

    /// 流式草稿消息：id 由调用方在整轮流式期间复用（草稿落盘时原地覆盖同一条），
    /// 因此这里只负责造一条空的 assistant 消息。
    pub fn assistant_draft(content: impl Into<String>) -> Self {
        let mut message = Self::assistant(content, Vec::new());
        message.draft = true;
        message
    }

    pub fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: new_message_id(),
            role: Role::Tool,
            content: sanitize_long_encoded_data(&content.into()),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            tool_call_id: Some(call_id.into()),
            compaction_summary: false,
            internal: false,
            reminder: None,
            life_proactive: false,
            pinned: false,
            draft: false,
            provider_items: Vec::new(),
            images: Vec::new(),
            attachments: Vec::new(),
            quotes: Vec::new(),
            request_context: String::new(),
        }
    }

    fn plain(role: Role, content: impl Into<String>) -> Self {
        Self {
            id: new_message_id(),
            role,
            content: sanitize_long_encoded_data(&content.into()),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            compaction_summary: false,
            internal: false,
            reminder: None,
            life_proactive: false,
            pinned: false,
            draft: false,
            provider_items: Vec::new(),
            images: Vec::new(),
            attachments: Vec::new(),
            quotes: Vec::new(),
            request_context: String::new(),
        }
    }

    /// 链式写入本轮上下文尾巴（只影响发出去的请求，UI 仍只显示用户原文）。
    #[must_use]
    pub fn with_request_context(mut self, context: impl Into<String>) -> Self {
        self.request_context = context.into();
        self
    }

    pub fn internal_user(content: impl Into<String>) -> Self {
        let mut message = Self::user(content);
        message.internal = true;
        message
    }

    /// 带**机器可读种类**的内部消息（引擎注入：目标复述 / 上下文尾巴 …）。
    /// 前端按 `reminder` 决定怎么渲染，不再去猜正文前缀。
    pub fn internal_reminder(content: impl Into<String>, kind: &str) -> Self {
        let mut message = Self::internal_user(content);
        message.reminder = Some(kind.to_owned());
        message
    }

    /// 链式写入结构化附件（会话落盘保留结构，模型侧由引擎内联路径）。
    #[must_use]
    pub fn with_attachments(mut self, attachments: Vec<Attachment>) -> Self {
        self.attachments = attachments;
        self
    }

    /// 链式写入结构化引用。
    #[must_use]
    pub fn with_quotes(mut self, quotes: Vec<Quote>) -> Self {
        self.quotes = quotes;
        self
    }

    /// 是否带结构化上下文（附件/引用）。
    pub fn has_structured_context(&self) -> bool {
        !self.attachments.is_empty() || !self.quotes.is_empty()
    }

    /// 给模型看的正文：用户原文 + 附件路径清单 + 引用原文。
    ///
    /// 只用在「组装请求」这一步：会话里存的 content 始终是用户原文，
    /// UI 因此不会显示拼接出来的清单文本。
    pub fn model_content(&self) -> String {
        if !self.has_structured_context() {
            return self.content.clone();
        }
        let mut text = self.content.clone();
        if !self.attachments.is_empty() {
            text.push_str(
                "\n\n[附件] 用户随这条消息附带了以下文件/目录，路径真实存在，需要时请直接用文件工具按 path 读取内容，不要凭空猜测：",
            );
            for attachment in &self.attachments {
                text.push('\n');
                text.push_str(&attachment.model_line());
            }
        }
        if !self.quotes.is_empty() {
            text.push_str("\n\n[引用] 用户引用了以下历史消息片段，回答时请结合这些上下文：");
            for quote in &self.quotes {
                text.push('\n');
                text.push_str(&quote.model_line());
            }
        }
        text
    }

    /// 链式置顶：`ChatMessage::user("...").pin()`。
    /// 置顶消息在压缩保留（retained_user_history / trim_history_to_fit）里优先保留。
    #[must_use]
    pub fn pin(mut self) -> Self {
        self.pinned = true;
        self
    }

    /// 链式写入思考文本：流式结束后由引擎把本轮 reasoning 附到正式回复上。
    /// 与 content 一样过一遍长编码清洗，避免把 base64 塞进会话文件。
    #[must_use]
    pub fn with_reasoning(mut self, reasoning: impl Into<String>) -> Self {
        self.reasoning = sanitize_long_encoded_data(&reasoning.into());
        self
    }

    pub fn summary(content: impl Into<String>) -> Self {
        let mut message = Self::user(content);
        message.compaction_summary = true;
        message
    }

    pub fn provider_item(item: Value) -> Self {
        let mut message = Self::assistant(String::new(), Vec::new());
        message.compaction_summary = true;
        let mut item = item;
        sanitize_json_encoded_data(&mut item);
        message.provider_items.push(item);
        message
    }
}

/// 生成一条稳定的消息 id（UUID v4 字符串）。
fn new_message_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Replace very long inline encodings before they enter model context or persistence.
/// Structured `ImageContent` is intentionally excluded and remains available to vision calls.
pub fn sanitize_long_encoded_data(input: &str) -> String {
    const MIN_ENCODED_CHARS: usize = 4_096;
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len().min(64 * 1024));
    let mut cursor = 0;
    let mut index = 0;
    while index < bytes.len() {
        if !is_base64_body_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_base64_body_byte(bytes[index]) {
            index += 1;
        }
        let mut padding = 0;
        while index < bytes.len() && bytes[index] == b'=' && padding < 2 {
            index += 1;
            padding += 1;
        }
        let encoded = &input[start..index];
        if encoded.len() < MIN_ENCODED_CHARS {
            continue;
        }
        let is_hex = encoded.len() % 2 == 0 && encoded.bytes().all(|byte| byte.is_ascii_hexdigit());
        let is_base64 =
            encoded.len() % 4 == 0 && encoded.bytes().filter(|byte| *byte == b'=').count() <= 2;
        if !is_hex && !is_base64 {
            continue;
        }
        output.push_str(&input[cursor..start]);
        let kind = if is_hex { "hex" } else { "base64" };
        output.push_str(&format!(
            "[encoded_data omitted type={kind} chars={} md5={:x}]",
            encoded.len(),
            md5::compute(encoded.as_bytes())
        ));
        cursor = index;
    }
    if cursor == 0 {
        return input.to_owned();
    }
    output.push_str(&input[cursor..]);
    output
}

fn is_base64_body_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')
}

pub fn sanitize_json_encoded_data(value: &mut Value) {
    match value {
        Value::String(text) => *text = sanitize_long_encoded_data(text),
        Value::Array(values) => values.iter_mut().for_each(sanitize_json_encoded_data),
        Value::Object(values) => values.values_mut().for_each(sanitize_json_encoded_data),
        _ => {}
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

impl ToolCall {
    pub fn resource_key(&self) -> Option<String> {
        [
            "path",
            "file",
            "directory",
            "cwd",
            "session_id",
            "id",
            "name",
        ]
        .iter()
        .find_map(|key| self.arguments.get(*key).and_then(Value::as_str))
        .map(|value| value.replace('\\', "/").to_ascii_lowercase())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct InvalidToolCall {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolConcurrency {
    ReadOnly,
    Mutating,
    Destructive,
    Interactive,
}

impl ToolSpec {
    /// Conservative scheduling metadata for built-ins. Unknown/MCP tools stay serial
    /// until they explicitly gain a trusted classification.
    pub fn concurrency(&self) -> ToolConcurrency {
        match self.name.as_str() {
            "read_file" | "list_dir" | "search" | "grep_files" | "glob_files" | "web_search"
            | "fetch" | "view_image" | "show_image" | "list_skills" | "read_skill"
            | "memory_list" | "memory_read" | "memory_search" | "list_mcp" | "get_loop"
            | "wait_agent" | "git_status" | "git_diff" | "git_log" => {
                ToolConcurrency::ReadOnly
            }
            "uninstall_mcp" | "uninstall_skill" | "memory_delete" | "close_agent" => {
                ToolConcurrency::Destructive
            }
            "request_user_input" | "request_file_import" | "request_file_export"
            | "ask_user" | "request_save_as" => ToolConcurrency::Interactive,
            _ => ToolConcurrency::Mutating,
        }
    }

    pub fn background_capable(&self) -> bool {
        matches!(self.name.as_str(), "shell" | "local_shell" | "wait_agent")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ImageContent {
    pub media_type: String,
    pub data: String,
}

impl ImageContent {
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.data)
    }
}

#[derive(Clone, Debug)]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CompactionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub system_prompt: String,
    pub tools: Vec<ToolSpec>,
}

#[derive(Clone, Debug)]
pub struct CompactionResponse {
    pub messages: Vec<ChatMessage>,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub cache_observed_input_tokens: u64,
    /// **写缓存**的输入量（Anthropic 的 cache_creation_input_tokens；OpenAI 系为 0）。
    /// 它按 1.25× 计费、也不是命中，必须与 cached_input_tokens 分开统计 ——
    /// 混进命中率会让「首次写缓存」那一轮看起来像缓存失败。
    #[serde(default)]
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_data_available: bool,
}

impl TokenUsage {
    pub fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.cache_observed_input_tokens = self
            .cache_observed_input_tokens
            .saturating_add(other.cache_observed_input_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_data_available |= other.cache_data_available;
    }

    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }

    pub fn saturating_sub(&self, previous: &Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(previous.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(previous.cached_input_tokens),
            cache_observed_input_tokens: self
                .cache_observed_input_tokens
                .saturating_sub(previous.cache_observed_input_tokens),
            cache_write_tokens: self
                .cache_write_tokens
                .saturating_sub(previous.cache_write_tokens),
            output_tokens: self.output_tokens.saturating_sub(previous.output_tokens),
            cache_data_available: self.cache_data_available,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ModelResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// Tool calls that were rejected before execution because their arguments
    /// could not be normalized to a JSON object.
    pub invalid_tool_calls: Vec<InvalidToolCall>,
    pub usage: TokenUsage,
    pub streamed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderErrorKind {
    Http,
    Timeout,
    Connect,
    Dns,
    Tls,
    Proxy,
    Redirect,
    RequestBuild,
    RequestBody,
    LocalIo,
    Request,
    Stream,
    Decode,
}

#[derive(Debug)]
pub struct ProviderRequestError {
    pub phase: &'static str,
    pub kind: ProviderErrorKind,
    pub status: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub request_id: Option<String>,
    pub retryable: bool,
    pub detail: String,
}

impl std::fmt::Display for ProviderRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "provider error [phase={} kind={:?} retryable={}",
            self.phase, self.kind, self.retryable
        )?;
        if let Some(status) = self.status {
            write!(formatter, " status={status}")?;
        }
        if let Some(retry_after_ms) = self.retry_after_ms {
            write!(formatter, " retry_after_ms={retry_after_ms}")?;
        }
        if let Some(request_id) = &self.request_id {
            write!(formatter, " request_id={request_id}")?;
        }
        write!(formatter, "]: {}", self.detail)
    }
}

impl std::error::Error for ProviderRequestError {}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    pub plan: Option<PlanState>,
    pub loop_state: Option<LoopState>,
    pub additional_context: Option<String>,
    pub images: Vec<ImageContent>,
    /// 本次调用真正落盘的文件（宿主绝对路径）。
    /// 由写文件类工具自己声明，一轮结束时汇总成 turn_end 的 `artifacts`；
    /// 只读工具一律留空。声明了也要过真实文件校验（见 `crate::artifacts`）。
    pub artifacts: Vec<String>,
}

impl ToolResult {
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            success: true,
            output: output.into(),
            plan: None,
            loop_state: None,
            additional_context: None,
            images: Vec::new(),
            artifacts: Vec::new(),
        }
    }

    pub fn error(output: impl Into<String>) -> Self {
        Self {
            success: false,
            output: output.into(),
            plan: None,
            loop_state: None,
            additional_context: None,
            images: Vec::new(),
            artifacts: Vec::new(),
        }
    }

    /// 声明本次调用落盘的文件（宿主绝对路径）。
    #[must_use]
    pub fn with_artifact(mut self, path: impl Into<String>) -> Self {
        let path = path.into();
        if !path.trim().is_empty() && !self.artifacts.contains(&path) {
            self.artifacts.push(path);
        }
        self
    }

    /// 批量声明落盘文件（顺序保留，重复自动去重）。
    #[must_use]
    pub fn with_artifacts(mut self, paths: impl IntoIterator<Item = String>) -> Self {
        for path in paths {
            self = self.with_artifact(path);
        }
        self
    }

    pub fn with_plan(mut self, plan: PlanState) -> Self {
        self.plan = Some(plan);
        self
    }

    pub fn with_loop(mut self, loop_state: LoopState) -> Self {
        self.loop_state = Some(loop_state);
        self
    }

    pub fn with_additional_context(mut self, context: impl Into<String>) -> Self {
        self.additional_context = Some(context.into());
        self
    }

    pub fn with_image(mut self, media_type: impl Into<String>, data: impl Into<String>) -> Self {
        self.images.push(ImageContent {
            media_type: media_type.into(),
            data: data.into(),
        });
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanStep {
    pub step: String,
    pub status: PlanStepStatus,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanState {
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
}

impl PlanState {
    pub fn validate(&self) -> Result<(), String> {
        if self.steps.is_empty() {
            return Err("plan must contain at least one step".into());
        }
        if self
            .steps
            .iter()
            .filter(|step| step.status == PlanStepStatus::InProgress)
            .count()
            > 1
        {
            return Err("at most one plan step may be in progress".into());
        }
        if self.steps.iter().any(|step| step.step.trim().is_empty()) {
            return Err("plan steps must not be empty".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LoopState {
    pub objective: String,
    pub status: LoopStatus,
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub tokens_used: u64,
    #[serde(default)]
    pub time_used_seconds: u64,
    #[serde(default)]
    pub blocked_streak: u8,
    #[serde(default)]
    pub turns_completed: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
    /// 是否允许用户选择此选项后追加自定义回答（回答 = 选中的选项标签）。
    /// 默认 false，仅最后一个选项或显式指定的选项可以开启。
    #[serde(default)]
    pub allow_custom: bool,
    /// 自定义回答的提示文本。allow_custom 为 true 时显示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<UserInputOption>,
    /// 用户补充说明的占位文本。默认 "补充说明（可选）"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_prompt: Option<String>,
    /// 是否允许用户提交补充说明。默认 true。
    #[serde(default)]
    pub allow_comment: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UserInputRequest {
    pub questions: Vec<UserInputQuestion>,
    pub auto_resolution_ms: Option<u64>,
}

/// 用户输入响应：每个问题返回选中的选项标签 + 可选的补充说明。
///
/// `answer` = 选中的选项 label（回答问题）
/// `comment` = 用户的补充说明（可选，回复/补充）
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct UserInputAnswer {
    /// 选中的选项标签（回答问题）
    pub answer: String,
    /// 用户补充说明（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

pub type UserInputResponse = BTreeMap<String, UserInputAnswer>;

/// ask_user 工具的一次提问：单问题、可选候选答案、可选多选/自定义、可选超时。
///
/// 与 `UserInputRequest` 的关系：两者共用同一条人机交互通道
/// （前端事件 `user_question_request` + 命令 `answer_question`），
/// `UserAskRequest` 是给「模型只问一句话」这个场景用的轻量形态：
///  - `options` 为空 = 纯自由输入（前端仍提供自定义输入框）；
///  - `allow_custom` 缺省 true = 允许用户不选候选、自己写答案；
///  - `timeout_ms` 缺省 None = 一直等用户回答（由能力开关 askUser 决定工具是否可见）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct UserAskRequest {
    pub question: String,
    /// 候选答案（纯文本，按顺序展示）；空数组表示不给候选。
    pub options: Vec<String>,
    /// 是否允许多选。
    pub multi: bool,
    /// 是否允许自定义答案。
    pub allow_custom: bool,
    /// 等待用户回答的毫秒数；None = 一直等。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Default for UserAskRequest {
    fn default() -> Self {
        Self {
            question: String::new(),
            options: Vec::new(),
            multi: false,
            allow_custom: true,
            timeout_ms: None,
        }
    }
}

impl UserAskRequest {
    /// 候选答案条数上限：提问卡是「一句话 + 几个按钮」，不是表单。
    pub const MAX_OPTIONS: usize = 12;

    /// 校验：空问题、超限候选、非法超时都返回可读错误。
    pub fn validate(&self) -> Result<(), String> {
        if self.question.trim().is_empty() {
            return Err("ask_user requires a non-empty question".into());
        }
        if self.options.len() > Self::MAX_OPTIONS {
            return Err(format!(
                "ask_user accepts at most {} options",
                Self::MAX_OPTIONS
            ));
        }
        if self
            .timeout_ms
            .is_some_and(|value| !(1_000..=3_600_000).contains(&value))
        {
            return Err("timeout_ms must be between 1000 and 3600000".into());
        }
        Ok(())
    }
}

/// ask_user 的回答：选中的候选（多选时为多条）+ 可选补充说明。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct UserAskAnswer {
    /// 原样回带问题，便于模型把答案与问题对上。
    pub question: String,
    /// 用户给出的答案；跳过/取消时为空数组。
    pub answers: Vec<String>,
    /// 用户补充说明（可选）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// 用户是否跳过了这个问题（没给任何答案）。
    #[serde(default)]
    pub skipped: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow 可编排多步骤执行（作为 Coomi 拓展能力，落点在 .coomi/workflows/<id>/）
// ─────────────────────────────────────────────────────────────────────────────

/// 单个步骤可绑定的执行能力（混合声明式）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum StepAction {
    /// 一次独立的模型调用，使用本步骤自己的 prompt（可配置是否隔离上下文）。
    Model {
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// 是否使用隔离的子会话上下文；缺省跟随 workflow 的 model_isolation 设置。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        isolate: Option<bool>,
    },
    /// 直接调用一个具体工具（不经过模型推理）。
    Tool {
        tool: String,
        #[serde(default)]
        arguments: serde_json::Value,
    },
    /// 在工作目录执行一条 shell 命令。
    Script {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_s: Option<u64>,
    },
    /// 嵌套执行一个已注册的子 workflow（组合复用）。
    SubWorkflow {
        #[serde(default)]
        workflow: String,
    },
}

/// 步骤的完成状态。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepState {
    Pending,
    Waiting,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl Default for WorkflowStepState {
    fn default() -> Self {
        Self::Pending
    }
}

/// 一个可编排的步骤。`depends_on` 是其前置步骤 id，构成 DAG 边。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkflowStep {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub action: StepAction,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub retry: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_s: Option<u64>,
    #[serde(default)]
    pub state: WorkflowStepState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub attempts: u32,
}

impl WorkflowStep {
    pub fn new(id: impl Into<String>, name: impl Into<String>, action: StepAction) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            action,
            depends_on: Vec::new(),
            retry: 0,
            timeout_s: None,
            state: WorkflowStepState::Pending,
            result: None,
            attempts: 0,
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    pub fn depends_on(mut self, ids: &[&str]) -> Self {
        self.depends_on = ids.iter().map(|s| (*s).to_string()).collect();
        self
    }

    pub fn with_retry(mut self, retry: u32) -> Self {
        self.retry = retry;
        self
    }
}

/// workflow 整体状态。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl Default for WorkflowStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// workflow 的来源（用于区分内置/用户/模型生成）。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowOrigin {
    Model,
    User,
    Imported,
    Builtin,
}

impl Default for WorkflowOrigin {
    fn default() -> Self {
        Self::User
    }
}

impl WorkflowOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::User => "user",
            Self::Imported => "imported",
            Self::Builtin => "builtin",
        }
    }
}

/// 工作流的定时调度配置（cron 表达式，引擎 scheduler 每分钟检查匹配）。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkflowSchedule {
    /// 是否启用定时触发；关闭后仅支持手动运行。
    #[serde(default)]
    pub enabled: bool,
    /// cron 表达式（如 `0 8 * * *`）；None 或空串表示未配置定时。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
}

impl WorkflowSchedule {
    pub fn is_active(&self) -> bool {
        self.enabled
            && self
                .cron
                .as_deref()
                .map(|c| !c.trim().is_empty())
                .unwrap_or(false)
    }
}

/// 一个可编排工作流的完整定义（定义文件落点为 .coomi/workflows/<id>/workflow.json）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps: Vec<WorkflowStep>,
    #[serde(default)]
    pub status: WorkflowStatus,
    #[serde(default)]
    pub origin: WorkflowOrigin,
    /// Model 类型步骤默认是否隔离上下文。
    #[serde(default)]
    pub model_isolation: bool,
    /// 定时调度配置（P1：scheduler 定时触发；缺省关闭）。
    #[serde(default)]
    pub schedule: WorkflowSchedule,
    /// workflow 定义运行时的临时变量（步骤之间传递数据的通道）。
    #[serde(default)]
    pub variables: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl WorkflowState {
    pub fn new(id: impl Into<String>, name: impl Into<String>, steps: Vec<WorkflowStep>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            steps,
            status: WorkflowStatus::Pending,
            origin: WorkflowOrigin::User,
            model_isolation: false,
            variables: BTreeMap::new(),
            schedule: WorkflowSchedule::default(),
            created_at: None,
            updated_at: None,
        }
    }

    /// 校验依赖图：无自环、无未知依赖、无重复 id、每个依赖最终可执行。
    /// 返回给定步骤的拓扑可执行顺序（DAG，允许多个无依赖的根并行）。
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("workflow id must not be empty".into());
        }
        if self.steps.is_empty() {
            return Err("workflow must contain at least one step".into());
        }
        let mut seen = std::collections::HashSet::new();
        for step in &self.steps {
            if step.id.trim().is_empty() {
                return Err("step id must not be empty".into());
            }
            if !seen.insert(step.id.as_str()) {
                return Err(format!("duplicate step id `{}`", step.id));
            }
        }
        for step in &self.steps {
            for dep in &step.depends_on {
                if dep == &step.id {
                    return Err(format!("step `{}` depends on itself", step.id));
                }
                if !seen.contains(dep.as_str()) {
                    return Err(format!(
                        "step `{}` depends on unknown step `{}`",
                        step.id, dep
                    ));
                }
            }
        }
        self.topological_order()?;
        Ok(())
    }

    /// 返回一个拓扑顺序。若存在循环或未知依赖则报错。
    pub fn topological_order(&self) -> Result<Vec<String>, String> {
        let mut indegree: BTreeMap<String, usize> = BTreeMap::new();
        let mut dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for step in &self.steps {
            indegree.entry(step.id.clone()).or_insert(0);
            dependents.entry(step.id.clone()).or_default();
        }
        for step in &self.steps {
            for dep in &step.depends_on {
                // indegree 是「步骤自身有多少条入边」= depends_on 数量。
                if let Some(deg) = indegree.get_mut(&step.id) {
                    *deg += 1;
                }
                // dependents 是「被依赖者的后继」= 依赖它的步骤。
                if let Some(children) = dependents.get_mut(dep) {
                    children.push(step.id.clone());
                }
            }
        }
        // Kahn's algorithm
        let mut queue: Vec<String> = indegree
            .iter()
            .filter(|(_, deg)| **deg == 0)
            .map(|(id, _)| id.clone())
            .collect();
        queue.sort();
        let mut order: Vec<String> = Vec::new();
        let mut temp = queue;
        while let Some(node) = temp.first().cloned() {
            temp.remove(0);
            order.push(node.clone());
            if let Some(children) = dependents.get(&node) {
                for child in children {
                    if let Some(deg) = indegree.get_mut(child) {
                        *deg = deg.saturating_sub(1);
                        if *deg == 0 {
                            temp.push(child.clone());
                        }
                    }
                }
            }
            temp.sort();
            temp.dedup();
        }
        if order.len() != self.steps.len() {
            return Err("workflow dependency graph contains a cycle".into());
        }
        Ok(order)
    }

    /// 返回当前"可执行"的步骤 id：所有依赖已 succeeded 自身仍 Pending。
    pub fn ready_steps(&self) -> Vec<String> {
        let state_of = |id: &str| self.steps.iter().find(|s| s.id == id).map(|s| s.state);
        let mut ready = Vec::new();
        for step in &self.steps {
            if step.state != WorkflowStepState::Pending {
                continue;
            }
            let all_deps_ok = step
                .depends_on
                .iter()
                .all(|dep| state_of(dep) == Some(WorkflowStepState::Succeeded));
            if all_deps_ok {
                ready.push(step.id.clone());
            }
        }
        ready
    }

    /// 所有步骤是否都到达终态。
    pub fn is_terminal(&self) -> bool {
        self.steps.iter().all(|s| {
            matches!(
                s.state,
                WorkflowStepState::Succeeded
                    | WorkflowStepState::Failed
                    | WorkflowStepState::Skipped
                    | WorkflowStepState::Cancelled
            )
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileTransferRequest {
    pub request_id: String,
    pub operation: String,
    pub path: Option<String>,
    pub suggested_name: Option<String>,
    pub multiple: bool,
    /// 请求语义（可选）：`save_as` = 模型调 request_save_as 触发的「另存为」，
    /// 与既有的 `request_file_export` 共用同一个 `file_transfer_request` 事件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgentEvent {
    ModelStarted {
        provider: String,
        model: String,
        round: usize,
    },
    ConnectionRetry {
        attempt: u8,
        max_attempts: u8,
        delay_ms: u64,
        message: String,
    },
    /// Discard partial stream output before retrying the same model request.
    StreamReset,
    Text(String),
    TextDelta(String),
    ReasoningDelta(String),
    ContextUpdated(ContextStatus),
    /// Usage reported by one completed model request. This is emitted after
    /// every tool-loop model call so observers can refresh live statistics.
    ModelUsage {
        total: TokenUsage,
        request: TokenUsage,
    },
    CompactionStarted {
        automatic: bool,
    },
    CompactionCompleted {
        automatic: bool,
        before_tokens: u64,
        after_tokens: u64,
        /// 本次压缩的触发原因（percent / floor / messages / cache /
        /// provider_error / manual）。
        reason: CompactionReason,
        /// 压缩前的用量占窗口比例（0~100）：前端展示「用了多少才压」。
        used_percent: u8,
        /// 判定时使用的上下文窗口（token）。
        window: u64,
    },
    PlanUpdated(PlanState),
    LoopUpdated(LoopState),
    QueuedInputAccepted(Vec<String>),
    /// 运行中插话已在当前轮的安全点并入上下文（step 说明是哪个安全点：
    /// model_call / tool_round / stream_interrupt / before_final_answer）。
    InterjectionApplied {
        id: String,
        step: String,
        text: String,
    },
    /// 插话被拒（内容为空等）：id 与中文原因回给前端。
    InterjectionRejected {
        id: String,
        reason: String,
    },
    ToolStarted(ToolCall),
    ToolFinished {
        call: ToolCall,
        result: ToolResult,
    },
    TurnCompleted {
        total: TokenUsage,
        turn: TokenUsage,
    },
}

pub trait AgentObserver: Send + Sync {
    fn on_event(&self, event: &AgentEvent);
}

#[async_trait]
pub trait TurnControl: Send + Sync {
    /// Wait at a resumable boundary. Implementations must not report a running
    /// model request or tool subprocess as paused before this method is reached.
    async fn safe_point(&self) -> Result<()>;
}

pub struct NoopObserver;

impl AgentObserver for NoopObserver {
    fn on_event(&self, _event: &AgentEvent) {}
}

#[async_trait]
pub trait ApprovalHandler: Send + Sync {
    async fn approve(&self, call: &ToolCall, reason: &str) -> bool;

    async fn request_user_input(&self, _request: &UserInputRequest) -> Option<UserInputResponse> {
        None
    }

    /// ask_user 的单问题提问。缺省实现返回 None（该运行环境不支持交互提问）。
    /// 实现方必须复用 `user_question_request` 事件与 `answer_question` 命令，
    /// 不要另开一条交互通道。
    async fn request_user_ask(&self, _request: &UserAskRequest) -> Option<UserAskAnswer> {
        None
    }

    async fn request_file_transfer(&self, _request: &FileTransferRequest) -> Option<Vec<String>> {
        None
    }
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn provider_id(&self) -> &str;
    fn model(&self) -> &str;
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities::default()
    }
    async fn complete(&self, request: ModelRequest) -> Result<ModelResponse>;

    async fn complete_stream(
        &self,
        request: ModelRequest,
        _observer: &dyn ModelStreamObserver,
    ) -> Result<ModelResponse> {
        self.complete(request).await
    }

    async fn compact(&self, _request: CompactionRequest) -> Result<Option<CompactionResponse>> {
        Ok(None)
    }
}

pub trait ModelStreamObserver: Send + Sync {
    fn on_text_delta(&self, delta: &str);
    fn on_reasoning_delta(&self, delta: &str);
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextStatus {
    pub used_tokens: u64,
    pub context_window: u64,
    /// 当前 context_window 的来源（probe / config / default）：
    /// 前端据此解释「窗口是不是取了兜底默认值」。
    #[serde(default)]
    pub context_window_source: ContextWindowSource,
    pub effective_context_window: u64,
    pub auto_compact_token_limit: u64,
    pub remaining_tokens: u64,
    pub used_percent: u8,
    pub remaining_percent: u8,
    pub auto_compact_scope_tokens: u64,
    pub compaction_count: u64,
}

#[async_trait]
pub trait ToolRuntime: Send + Sync {
    fn specs(&self) -> Vec<ToolSpec>;
    async fn call(&self, call: &ToolCall, approval: &dyn ApprovalHandler) -> ToolResult;

    async fn lifecycle(&self, _event: &str, _payload: Value) -> Result<Option<String>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::sanitize_long_encoded_data;

    #[test]
    fn removes_one_megabyte_base64_without_retaining_payload() {
        let payload = "QUJD".repeat(256 * 1024);
        let sanitized = sanitize_long_encoded_data(&format!("data:image/png;base64,{payload}"));
        assert!(sanitized.contains("encoded_data omitted type=base64"));
        assert!(sanitized.contains("chars=1048576"));
        assert!(!sanitized.contains(&payload[..4096]));
        assert!(sanitized.len() < 256);
    }

    #[test]
    fn keeps_hashes_and_regular_jwts() {
        let hash = "0123456789abcdef".repeat(4);
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
        let input = format!("hash={hash} jwt={jwt}");
        assert_eq!(sanitize_long_encoded_data(&input), input);
    }
}

#[cfg(test)]
mod workflow_tests {
    use super::{StepAction, WorkflowState, WorkflowStep, WorkflowStepState};

    fn model_step(id: &str, name: &str, deps: &[&str]) -> WorkflowStep {
        WorkflowStep::new(
            id,
            name,
            StepAction::Model {
                prompt: "hi".into(),
                model: None,
                isolate: None,
            },
        )
        .depends_on(deps)
    }

    fn linear_workflow() -> WorkflowState {
        WorkflowState::new(
            "wf-1",
            "linear",
            vec![
                model_step("a", "A", &[]),
                model_step("b", "B", &["a"]),
                model_step("c", "C", &["b"]),
            ],
        )
    }

    #[test]
    fn topological_order_is_respected() {
        let wf = linear_workflow();
        wf.validate().expect("valid");
        assert_eq!(wf.topological_order().unwrap(), vec!["a", "b", "c"]);
    }

    #[test]
    fn parallel_branches_are_detected() {
        let wf = WorkflowState::new(
            "wf-2",
            "parallel",
            vec![
                model_step("root", "root", &[]),
                model_step("left", "L", &["root"]),
                model_step("right", "R", &["root"]),
                model_step("join", "join", &["left", "right"]),
            ],
        );
        wf.validate().expect("valid");
        // root 先，然后 left/right 可并行（顺序不定但都在 join 前）
        let order = wf.topological_order().unwrap();
        assert_eq!(order[0], "root");
        assert_eq!(order[3], "join");
        assert!(order.contains(&"left".to_string()));
        assert!(order.contains(&"right".to_string()));
    }

    #[test]
    fn cycle_is_rejected() {
        let wf = WorkflowState::new(
            "wf-3",
            "cycle",
            vec![model_step("a", "A", &["b"]), model_step("b", "B", &["a"])],
        );
        assert!(wf.validate().is_err());
    }

    #[test]
    fn unknown_dependency_is_rejected() {
        let wf = WorkflowState::new("wf-4", "bad-dep", vec![model_step("a", "A", &["missing"])]);
        assert!(wf.validate().is_err());
    }

    #[test]
    fn self_dependency_is_rejected() {
        let wf = WorkflowState::new("wf-5", "self-dep", vec![model_step("a", "A", &["a"])]);
        assert!(wf.validate().is_err());
    }

    #[test]
    fn duplicate_step_id_is_rejected() {
        let wf = WorkflowState::new(
            "wf-6",
            "dup",
            vec![model_step("a", "A", &[]), model_step("a", "A2", &[])],
        );
        assert!(wf.validate().is_err());
    }

    #[test]
    fn empty_steps_are_rejected() {
        let wf = WorkflowState::new("wf-7", "empty", vec![]);
        assert!(wf.validate().is_err());
    }

    #[test]
    fn ready_steps_only_include_unblocked_pending() {
        let mut wf = linear_workflow();
        // 初始只有根 a 就绪
        assert_eq!(wf.ready_steps(), vec!["a"]);
        // 标记 a 成功，b 就绪
        wf.steps[0].state = WorkflowStepState::Succeeded;
        assert_eq!(wf.ready_steps(), vec!["b"]);
        // a 仍 pending 时 b 不因 c 就绪
        wf.steps[1].state = WorkflowStepState::Pending;
        wf.steps[0].state = WorkflowStepState::Pending;
        assert_eq!(wf.ready_steps(), vec!["a"]);
    }

    #[test]
    fn is_terminal_when_all_finished() {
        let mut wf = linear_workflow();
        for step in &mut wf.steps {
            step.state = WorkflowStepState::Succeeded;
        }
        assert!(wf.is_terminal());
        wf.steps[0].state = WorkflowStepState::Running;
        assert!(!wf.is_terminal());
    }

    #[test]
    fn validate_accepts_diamond() {
        let wf = WorkflowState::new(
            "wf-8",
            "diamond",
            vec![
                model_step("a", "A", &[]),
                model_step("b", "B", &["a"]),
                model_step("c", "C", &["a"]),
                model_step("d", "D", &["b", "c"]),
            ],
        );
        wf.validate().expect("diamond valid");
    }

    #[test]
    fn model_step_defaults_to_pending() {
        let step = model_step("s", "S", &[]);
        assert_eq!(step.state, WorkflowStepState::Pending);
        assert_eq!(step.attempts, 0);
        assert!(step.result.is_none());
    }
}
