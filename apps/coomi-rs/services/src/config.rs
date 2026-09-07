use anyhow::Context;
use anyhow::Result;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    OpenAiCompatible,
    OpenAiResponses,
    AnthropicMessages,
    GeminiNative,
    /// DeepSeek 账号登录（官方 chat.deepseek.com 私有协议，非 OpenAI 兼容）。
    DeepSeekAccount,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteCompactionMode {
    Legacy,
    #[default]
    V2,
}

impl ProviderKind {
    fn from_config(provider_type: &str, tool_protocol: Option<&str>) -> Result<Self> {
        let value = tool_protocol
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(provider_type)
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_");
        match value.as_str() {
            "generic" | "deepseek" | "openai" | "openai_compatible" | "chat_completions" => {
                Ok(Self::OpenAiCompatible)
            }
            "openai_responses" | "responses" => Ok(Self::OpenAiResponses),
            "anthropic" | "anthropic_messages" => Ok(Self::AnthropicMessages),
            "gemini" | "gemini_native" => Ok(Self::GeminiNative),
            "deepseek_account" | "deep_seek_account" | "deepseek_account_login" => {
                Ok(Self::DeepSeekAccount)
            }
            other => anyhow::bail!("unsupported provider protocol: {other}"),
        }
    }
}

#[derive(Clone)]
pub struct ProviderConfig {
    pub id: String,
    pub kind: ProviderKind,
    pub display: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub fast_model: Option<String>,
    /// 前端保存的模型列表（extra.models），用于 resolve 校验“已声明模型”。
    pub models: Vec<String>,
    /// 模型级上下文窗口覆盖；未命中时使用供应商默认值。
    pub model_context_windows: BTreeMap<String, u64>,
    /// 用户在提供商页面为各模型手动配置的图像理解能力。
    pub model_vision_support: BTreeMap<String, bool>,
    /// 用户为每个模型配置的采样参数与推理档位映射。
    pub model_parameters: BTreeMap<String, Value>,
    pub capabilities: coomi_engine::ModelCapabilities,
    pub remote_compaction_mode: RemoteCompactionMode,
}

impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderConfig")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("display", &self.display)
            .field("api_key", &"[redacted]")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("fast_model", &self.fast_model)
            .field("model_context_windows", &self.model_context_windows)
            .field("model_vision_support", &self.model_vision_support)
            .field("model_parameters", &self.model_parameters)
            .field("capabilities", &self.capabilities)
            .field("remote_compaction_mode", &self.remote_compaction_mode)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelChoice {
    pub selector: String,
    pub provider_id: String,
    pub provider_display: String,
    pub model: String,
    pub is_fast: bool,
}

#[derive(Debug)]
pub struct ProviderRegistry {
    active: String,
    providers: BTreeMap<String, ProviderConfig>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ProviderDocument {
    #[serde(default)]
    pub active: String,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderSettings>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ProviderSettings {
    #[serde(rename = "type", default = "default_provider_type")]
    pub provider_type: String,
    #[serde(default)]
    pub tool_protocol: Option<String>,
    #[serde(default)]
    pub display: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub fast_model: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub model_context_windows: BTreeMap<String, u64>,
    #[serde(default)]
    pub effective_context_window_percent: Option<u8>,
    #[serde(default)]
    pub auto_compact_token_limit: Option<u64>,
    #[serde(default)]
    pub auto_compact_scope: coomi_engine::AutoCompactScope,
    #[serde(default)]
    pub comp_hash: Option<String>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub supports_remote_compaction: Option<bool>,
    #[serde(default)]
    pub remote_compaction_mode: RemoteCompactionMode,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default = "default_true")]
    pub supports_native_tools: bool,
    #[serde(default)]
    pub supports_web_search: bool,
    #[serde(default)]
    pub supports_parallel_tool_calls: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn default_provider_type() -> String {
    "openai_compatible".into()
}

const fn default_true() -> bool {
    true
}

impl ProviderRegistry {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = ProviderDocument::load(path)?;
        let mut providers = BTreeMap::new();
        for (id, provider) in raw.providers {
            // 草稿 provider（模型未填）：跳过，不参与运行时加载；文件保留，
            // 等用户检索出模型补全后再加入。
            if provider.model.trim().is_empty() {
                continue;
            }
            if provider.base_url.trim().is_empty() {
                anyhow::bail!("provider `{id}` has no base_url");
            }
            let kind = ProviderKind::from_config(
                &provider.provider_type,
                provider.tool_protocol.as_deref(),
            )?;
            let display = if provider.display.trim().is_empty() {
                id.clone()
            } else {
                provider.display
            };
            let mut model_vision_support = provider
                .extra
                .get("capabilityOverrides")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(model, value)| {
                    value
                        .get("vision")
                        .and_then(Value::as_bool)
                        .map(|enabled| (model.clone(), enabled))
                })
                .collect::<BTreeMap<_, _>>();
            for model in provider
                .extra
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                model_vision_support
                    .entry(model.to_owned())
                    .or_insert(provider.supports_vision);
            }
            model_vision_support
                .entry(provider.model.clone())
                .or_insert(provider.supports_vision);
            let manual_vision = model_vision_support
                .get(&provider.model)
                .copied()
                .unwrap_or(provider.supports_vision);
            let mut capabilities = coomi_engine::ModelCapabilities {
                context_window: provider.context_window.unwrap_or(256_000),
                effective_context_window_percent: provider
                    .effective_context_window_percent
                    .unwrap_or(95)
                    .clamp(1, 100),
                auto_compact_token_limit: provider.auto_compact_token_limit,
                auto_compact_scope: provider.auto_compact_scope,
                comp_hash: provider.comp_hash,
                max_output_tokens: provider.max_output_tokens.unwrap_or(8_192),
                supports_remote_compaction: provider
                    .supports_remote_compaction
                    .unwrap_or(kind == ProviderKind::OpenAiResponses),
                supports_vision: manual_vision,
                supports_native_tools: provider.supports_native_tools,
                supports_web_search: provider.supports_web_search,
                supports_parallel_tool_calls: provider.supports_parallel_tool_calls,
            };
            if let Some(window) = provider.model_context_windows.get(&provider.model) {
                capabilities.context_window = *window;
            }
            providers.insert(
                id.clone(),
                ProviderConfig {
                    id,
                    kind,
                    display,
                    api_key: provider.api_key,
                    base_url: provider.base_url,
                    model: provider.model,
                    fast_model: provider.fast_model.filter(|value| !value.trim().is_empty()),
                    models: provider
                        .extra
                        .get("models")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                    model_context_windows: provider.model_context_windows,
                    model_vision_support,
                    model_parameters: provider
                        .extra
                        .get("modelParameters")
                        .and_then(Value::as_object)
                        .map(|parameters| {
                            parameters
                                .iter()
                                .map(|(model, value)| (model.clone(), value.clone()))
                                .collect()
                        })
                        .unwrap_or_default(),
                    capabilities,
                    remote_compaction_mode: provider.remote_compaction_mode,
                },
            );
        }
        if providers.is_empty() {
            anyhow::bail!("provider file contains no providers")
        }
        let active = if raw.active.is_empty() {
            providers
                .keys()
                .next()
                .cloned()
                .context("provider file contains no providers")?
        } else {
            raw.active
        };
        if !providers.contains_key(&active) {
            anyhow::bail!("active provider `{active}` does not exist")
        }
        Ok(Self { active, providers })
    }

    pub fn active_id(&self) -> &str {
        &self.active
    }

    pub fn choices(&self) -> Vec<ModelChoice> {
        let mut choices = Vec::new();
        for provider in self.providers.values() {
            choices.push(ModelChoice {
                selector: provider.id.clone(),
                provider_id: provider.id.clone(),
                provider_display: provider.display.clone(),
                model: provider.model.clone(),
                is_fast: false,
            });
            if let Some(fast_model) = &provider.fast_model
                && fast_model != &provider.model
            {
                choices.push(ModelChoice {
                    selector: format!("{}:{fast_model}", provider.id),
                    provider_id: provider.id.clone(),
                    provider_display: provider.display.clone(),
                    model: fast_model.clone(),
                    is_fast: true,
                });
            }
        }
        choices
    }

    pub fn resolve(&self, selector: Option<&str>) -> Result<ProviderConfig> {
        let selector = selector.unwrap_or(&self.active).trim();
        if let Some(provider) = self.find_provider(selector) {
            return Ok(provider.clone());
        }

        for choice in self.choices() {
            if choice.selector.eq_ignore_ascii_case(selector)
                || choice.model.eq_ignore_ascii_case(selector)
            {
                let mut provider = self
                    .providers
                    .get(&choice.provider_id)
                    .context("model choice references a missing provider")?
                    .clone();
                provider.model = choice.model;
                apply_model_context_window(&mut provider);
                return Ok(provider);
            }
        }

        if let Some((provider_id, model)) = selector.split_once(':')
            && let Some(provider) = self.find_provider(provider_id)
        {
            // declared = model / fast_model 字段，或前端保存的 models 列表（extra.models）
            let in_models = provider
                .models
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(model));
            let allowed = provider.model.eq_ignore_ascii_case(model)
                || provider
                    .fast_model
                    .as_deref()
                    .is_some_and(|candidate| candidate.eq_ignore_ascii_case(model))
                || in_models;
            if allowed || !model.trim().is_empty() {
                let mut provider = provider.clone();
                provider.model = model.to_string();
                apply_model_context_window(&mut provider);
                return Ok(provider);
            }
            anyhow::bail!(
                "model `{model}` is not declared for provider `{}`",
                provider.id
            )
        }

        anyhow::bail!("model selector `{selector}` is not present in providers.json")
    }

    fn find_provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.get(id).or_else(|| {
            self.providers
                .values()
                .find(|provider| provider.id.eq_ignore_ascii_case(id))
        })
    }
}

fn apply_model_context_window(provider: &mut ProviderConfig) {
    if let Some(window) = provider.model_context_windows.get(&provider.model) {
        provider.capabilities.context_window = *window;
    }
    if let Some(enabled) = provider.model_vision_support.get(&provider.model) {
        provider.capabilities.supports_vision = *enabled;
    }
}

impl ProviderDocument {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path)
            .with_context(|| format!("failed to read provider file {}", path.display()))?;
        serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid provider file {}", path.display()))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        self.validate()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("failed to save provider file {}", path.display()))
    }

    pub fn validate(&self) -> Result<()> {
        if !self.active.is_empty() {
            anyhow::ensure!(
                self.providers.contains_key(&self.active),
                "active provider `{}` does not exist",
                self.active
            );
        }
        for (id, provider) in &self.providers {
            anyhow::ensure!(!id.trim().is_empty(), "provider ID must not be empty");
            // 未激活的 provider 允许空模型/空 Base URL（草稿态：先保存配置，
            // 检索出模型后再补全并激活）。只有当前激活的 provider 必须完整可用。
            if !self.active.is_empty() && id == &self.active {
                anyhow::ensure!(
                    !provider.model.trim().is_empty(),
                    "active provider `{id}` has no model"
                );
                anyhow::ensure!(
                    !provider.base_url.trim().is_empty(),
                    "active provider `{id}` has no base_url"
                );
            }
            ProviderKind::from_config(&provider.provider_type, provider.tool_protocol.as_deref())?;
        }
        Ok(())
    }
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            provider_type: default_provider_type(),
            tool_protocol: Some("openai_compatible".into()),
            display: String::new(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            fast_model: None,
            context_window: None,
            model_context_windows: BTreeMap::new(),
            effective_context_window_percent: None,
            auto_compact_token_limit: None,
            auto_compact_scope: coomi_engine::AutoCompactScope::Total,
            comp_hash: None,
            max_output_tokens: None,
            supports_remote_compaction: None,
            remote_compaction_mode: RemoteCompactionMode::default(),
            supports_vision: false,
            supports_native_tools: true,
            supports_web_search: false,
            supports_parallel_tool_calls: false,
            extra: BTreeMap::new(),
        }
    }
}

/// DeepSeek 账号专用 Provider 配置构造函数。
/// 固定 base_url 为 `https://chat.deepseek.com`，协议 deepseek_account（私有协议），
/// 模型列表为 `["deepseek-chat", "deepseek-reasoner"]`，上下文窗口 128k。
pub fn deepseek_account_settings(api_key: &str, model: &str) -> ProviderSettings {
    let mut settings = ProviderSettings {
        provider_type: "deepseek_account".into(),
        tool_protocol: Some("deepseek_account".into()),
        display: "DeepSeek 账号".into(),
        api_key: api_key.to_string(),
        base_url: "https://chat.deepseek.com".into(),
        model: model.to_string(),
        fast_model: Some("deepseek-chat".into()),
        context_window: Some(128_000),
        ..Default::default()
    };
    // 显式声明模型列表，确保前端可展示 Chat/Reasoner 选择
    settings.extra.insert(
        "models".into(),
        serde_json::json!(["deepseek-chat", "deepseek-reasoner"]),
    );
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deepseek_account_provider_has_fixed_models() {
        let settings = deepseek_account_settings("test-token", "deepseek-chat");
        assert_eq!(settings.base_url, "https://chat.deepseek.com");
        assert_eq!(settings.model, "deepseek-chat");
        assert_eq!(settings.context_window, Some(128_000));
        assert_eq!(settings.provider_type, "deepseek_account");
        assert_eq!(
            settings.tool_protocol,
            Some("deepseek_account".to_string())
        );
        assert!(!settings.api_key.is_empty());
        let models = settings
            .extra
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert!(models.contains(&"deepseek-chat".to_string()));
        assert!(models.contains(&"deepseek-reasoner".to_string()));
        assert_eq!(
            ProviderKind::from_config(&settings.provider_type, settings.tool_protocol.as_deref())
                .expect("deepseek_account parses"),
            ProviderKind::DeepSeekAccount
        );
    }

    #[test]
    fn choices_only_include_models_declared_by_providers() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("providers.json");
        fs::write(
            &path,
            r#"{
                "active": "primary",
                "providers": {
                    "primary": {
                        "type": "generic",
                        "display": "Primary",
                        "api_key": "secret",
                        "base_url": "https://example.test/v1",
                        "model": "main-model",
                        "fast_model": "fast-model"
                    }
                }
            }"#,
        )
        .expect("write provider fixture");
        let registry = ProviderRegistry::load(&path).expect("provider registry");
        assert_eq!(registry.choices().len(), 2);
        assert_eq!(
            registry
                .resolve(Some("primary:fast-model"))
                .expect("fast model")
                .model,
            "fast-model"
        );
        assert!(registry.resolve(Some("invented-model")).is_err());
        assert_eq!(
            registry
                .resolve(Some("primary"))
                .expect("primary")
                .capabilities
                .effective_context_window(),
            243_200
        );
    }

    #[test]
    fn provider_document_allows_empty_or_unactivated_drafts() {
        let empty = ProviderDocument {
            active: String::new(),
            providers: BTreeMap::new(),
            extra: BTreeMap::new(),
        };
        empty
            .validate()
            .expect("empty document is valid for presets");

        let draft = ProviderDocument {
            active: String::new(),
            providers: BTreeMap::from([(
                String::from("openai"),
                ProviderSettings {
                    display: "OpenAI".into(),
                    base_url: "https://api.openai.com/v1".into(),
                    ..ProviderSettings::default()
                },
            )]),
            extra: BTreeMap::new(),
        };
        draft.validate().expect("unactivated draft is valid");
    }
}
