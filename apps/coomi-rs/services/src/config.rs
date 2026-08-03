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
            if provider.model.trim().is_empty() {
                anyhow::bail!("provider `{id}` has no model");
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
                    capabilities: coomi_engine::ModelCapabilities {
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
                        supports_vision: provider.supports_vision,
                        supports_native_tools: provider.supports_native_tools,
                        supports_web_search: provider.supports_web_search,
                        supports_parallel_tool_calls: provider.supports_parallel_tool_calls,
                    },
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
                return Ok(provider);
            }
        }

        if let Some((provider_id, model)) = selector.split_once(':')
            && let Some(provider) = self.find_provider(provider_id)
        {
            // declared = model / fast_model 字段，或前端保存的 models 列表（extra.models）
            let in_models = provider.models.iter().any(|candidate| candidate.eq_ignore_ascii_case(model));
            let allowed = provider.model.eq_ignore_ascii_case(model)
                || provider
                    .fast_model
                    .as_deref()
                    .is_some_and(|candidate| candidate.eq_ignore_ascii_case(model))
                || in_models;
            if allowed {
                let mut provider = provider.clone();
                provider.model = model.to_string();
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
        anyhow::ensure!(
            !self.providers.is_empty(),
            "at least one provider is required"
        );
        anyhow::ensure!(
            self.providers.contains_key(&self.active),
            "active provider `{}` does not exist",
            self.active
        );
        for (id, provider) in &self.providers {
            anyhow::ensure!(!id.trim().is_empty(), "provider ID must not be empty");
            anyhow::ensure!(
                !provider.model.trim().is_empty(),
                "provider `{id}` has no model"
            );
            anyhow::ensure!(
                !provider.base_url.trim().is_empty(),
                "provider `{id}` has no base_url"
            );
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
