use crate::EndpointResolver;
use crate::ProviderConfig;
use crate::ProviderKind;
use crate::ProviderProtocol;
use crate::RemoteCompactionMode;
use anyhow::Context;
use anyhow::Result;
use async_trait::async_trait;
use coomi_engine::ChatMessage;
use coomi_engine::CompactionRequest;
use coomi_engine::CompactionResponse;
use coomi_engine::InvalidToolCall;
use coomi_engine::ModelCapabilities;
use coomi_engine::ModelProvider;
use coomi_engine::ModelRequest;
use coomi_engine::ModelResponse;
use coomi_engine::ModelStreamObserver;
use coomi_engine::ProviderErrorKind;
use coomi_engine::ProviderRequestError;
use coomi_engine::Role;
use coomi_engine::TokenUsage;
use coomi_engine::ToolCall;
use coomi_engine::retained_user_history;
use futures_util::StreamExt;
use reqwest::Client;
use reqwest::RequestBuilder;
use reqwest::Response;
use reqwest::header::HeaderMap;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::error::Error as StdError;
use std::time::Duration;

pub struct HttpModelProvider {
    config: ProviderConfig,
    client: Client,
}

impl HttpModelProvider {
    pub fn new(config: ProviderConfig) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // A streamed completion has no fixed body length. A total timeout
            // would abort otherwise healthy generations after 180 seconds;
            // use a per-read timeout so every received chunk resets the clock.
            .read_timeout(Duration::from_secs(180))
            .build()
            .context("failed to build provider HTTP client")?;
        Ok(Self { config, client })
    }

    async fn openai_compatible(&self, request: ModelRequest) -> Result<ModelResponse> {
        if self.config.base_url.contains("chat.deepseek.com") {
            return self.deepseek_account(request, None).await;
        }
        let endpoint = endpoint(&self.config.base_url, "chat/completions");
        let mut body = json!({
            "model": request.model,
            "messages": openai_messages(
                &request.messages,
                self.config.capabilities.supports_vision,
            )?,
            "stream": false
        });
        if self.config.capabilities.supports_native_tools && !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.parameters
                            }
                        })
                    })
                    .collect(),
            );
            body["tool_choice"] = Value::String("auto".into());
            if self.config.capabilities.supports_parallel_tool_calls {
                body["parallel_tool_calls"] = Value::Bool(true);
            }
        }
        apply_model_parameters(
            &self.config,
            &mut body,
            request.reasoning_effort.as_deref(),
            Some(false),
        );
        let response = self
            .send_with_reasoning_fallback(
                &endpoint,
                &body,
                false,
                Some(responses_body_legacy(&body)),
            )
            .await?;
        let value = checked_json(response, "response_body").await?;
        let message = value
            .pointer("/choices/0/message")
            .context("provider response has no choices[0].message")?;
        let content = text_content(message.get("content"));
        let (tool_calls, invalid_tool_calls) = parse_openai_tool_calls(message.get("tool_calls"))?;
        Ok(ModelResponse {
            content,
            tool_calls,
            invalid_tool_calls,
            usage: openai_usage(value.get("usage")),
            streamed: false,
        })
    }

    async fn openai_compatible_stream(
        &self,
        request: ModelRequest,
        observer: &dyn ModelStreamObserver,
    ) -> Result<ModelResponse> {
        if self.config.base_url.contains("chat.deepseek.com") {
            return self.deepseek_account(request, Some(observer)).await;
        }
        let endpoint = endpoint(&self.config.base_url, "chat/completions");
        let mut body = json!({
            "model": request.model,
            "messages": openai_messages(
                &request.messages,
                self.config.capabilities.supports_vision,
            )?,
            "stream": true
        });
        if self.config.capabilities.supports_native_tools && !request.tools.is_empty() {
            body["tools"] = Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.parameters
                            }
                        })
                    })
                    .collect(),
            );
            body["tool_choice"] = Value::String("auto".into());
            if self.config.capabilities.supports_parallel_tool_calls {
                body["parallel_tool_calls"] = Value::Bool(true);
            }
        }
        apply_model_parameters(
            &self.config,
            &mut body,
            request.reasoning_effort.as_deref(),
            Some(false),
        );
        let response = self
            .send_with_reasoning_fallback(&endpoint, &body, true, None)
            .await?;
        let status = response.status();
        if !status.is_success() {
            return checked_json(response, "response_body")
                .await
                .map(|_| ModelResponse::default());
        }
        let mut state = ChatStreamState::default();
        read_sse(response, "response_stream", |value| {
            state.consume(&value, observer)
        })
        .await?;
        state.finish()
    }

    /// DeepSeek 账号端点不是 OpenAI 协议。这里把 Coomi 历史折叠成官方 prompt，
    /// 自动创建会话、计算 PoW，并读取官方 SSE；工具定义以文本协议附在 prompt 中，
    /// 模型仍可按 Coomi 的工具调用约定返回 JSON。
    async fn deepseek_account(
        &self,
        request: ModelRequest,
        observer: Option<&dyn ModelStreamObserver>,
    ) -> Result<ModelResponse> {
        use crate::deepseek::client::{chat_completion, create_session};

        if self.config.api_key.trim().is_empty() {
            anyhow::bail!("DeepSeek 账号尚未登录");
        }
        let mut prompt = String::new();
        for message in &request.messages {
            let role = match message.role {
                Role::System => "系统",
                Role::User => "用户",
                Role::Assistant => "助手",
                Role::Tool => "工具结果",
            };
            if !message.content.trim().is_empty() {
                prompt.push_str(role);
                prompt.push_str("：");
                prompt.push_str(&message.content);
                prompt.push_str("\n\n");
            }
        }
        if !request.tools.is_empty() {
            prompt.push_str("你可以调用以下工具。需要调用时，只输出一个 JSON 对象：{\"tool\":\"工具名\",\"arguments\":{...}}。工具清单：\n");
            for tool in &request.tools {
                prompt.push_str("- ");
                prompt.push_str(&tool.name);
                prompt.push_str(": ");
                prompt.push_str(&tool.description);
                prompt.push_str("\n");
            }
        }
        let session = create_session(&self.client, &self.config.api_key).await?;
        let thinking = request.model.contains("reasoner")
            || request.reasoning_effort.as_deref().is_some_and(|v| v != "low");
        let response = chat_completion(
            &self.client,
            &self.config.api_key,
            session.chat_session_id,
            &request.model,
            &prompt,
            thinking,
        )
        .await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("DeepSeek 对话失败 HTTP {status}: {body}");
        }
        let mut stream = response.bytes_stream();
        let mut pending = String::new();
        let mut content = String::new();
        let mut reasoning = String::new();
        while let Some(chunk) = stream.next().await {
            pending.push_str(&String::from_utf8_lossy(&chunk?));
            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_string();
                pending.drain(..=pos);
                let Some(data) = line.strip_prefix("data:") else { continue; };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" { continue; }
                let Ok(value) = serde_json::from_str::<Value>(data) else { continue; };
                let delta = value.get("text_delta")
                    .or_else(|| value.pointer("/choices/0/delta/content"))
                    .or_else(|| value.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !delta.is_empty() {
                    content.push_str(delta);
                    if let Some(obs) = observer { obs.on_text_delta(delta); }
                }
                let think = value.get("reasoning_delta")
                    .or_else(|| value.pointer("/choices/0/delta/reasoning_content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !think.is_empty() {
                    reasoning.push_str(think);
                    if let Some(obs) = observer { obs.on_reasoning_delta(think); }
                }
            }
        }
        if content.is_empty() {
            if !reasoning.is_empty() {
                return Ok(ModelResponse {
                    content: reasoning,
                    tool_calls: Vec::new(),
                    invalid_tool_calls: Vec::new(),
                    usage: TokenUsage::default(),
                    streamed: observer.is_some(),
                });
            }
            anyhow::bail!("DeepSeek 响应没有文本内容");
        }
        Ok(ModelResponse {
            content,
            tool_calls: Vec::new(),
            invalid_tool_calls: Vec::new(),
            usage: TokenUsage::default(),
            streamed: observer.is_some(),
        })
    }

    async fn openai_remote_compaction(
        &self,
        request: CompactionRequest,
    ) -> Result<CompactionResponse> {
        let endpoint = responses_compact_endpoint(&self.config.base_url);
        let body = json!({
            "model": request.model,
            "input": responses_input(&request.messages, self.config.capabilities.supports_vision, true)?,
            "instructions": request.system_prompt
        });
        let value = checked_json(
            send_request(
                self.authenticated(self.client.post(endpoint)).json(&body),
                "request_send",
            )
            .await?,
            "response_body",
        )
        .await?;
        let mut messages = Vec::new();
        for item in value
            .get("output")
            .and_then(Value::as_array)
            .context("compact response has no output array")?
        {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                let role = match item.get("role").and_then(Value::as_str) {
                    Some("assistant") => Role::Assistant,
                    Some("system" | "developer") => Role::System,
                    _ => Role::User,
                };
                let content = item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !content.is_empty() {
                    let mut message = match role {
                        Role::Assistant => ChatMessage::assistant(content, Vec::new()),
                        Role::System => ChatMessage::system(content),
                        Role::User | Role::Tool => ChatMessage::user(content),
                    };
                    message.provider_items.push(item.clone());
                    messages.push(message);
                }
            } else if matches!(
                item.get("type").and_then(Value::as_str),
                Some("compaction" | "context_compaction")
            ) {
                if item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .is_some()
                {
                    messages.push(ChatMessage::provider_item(item.clone()));
                } else if let Some(summary) = item
                    .get("summary")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
                {
                    messages.push(ChatMessage::summary(summary));
                }
            }
        }
        if messages.is_empty() {
            anyhow::bail!("compact response contained no reusable history")
        }
        Ok(CompactionResponse {
            messages,
            usage: responses_usage(value.get("usage")),
        })
    }

    async fn openai_remote_compaction_v2(
        &self,
        request: CompactionRequest,
    ) -> Result<CompactionResponse> {
        let endpoint = responses_endpoint(&self.config.base_url);
        let body = remote_compaction_v2_body(
            &request,
            self.config.capabilities.supports_web_search,
            self.config.capabilities.supports_parallel_tool_calls,
            self.config.capabilities.supports_vision,
        )?;
        let response = self
            .authenticated(self.client.post(endpoint))
            .json(&body)
            .send()
            .await
            .map_err(|error| transport_error("request_send", error))?;
        let status = response.status();
        if !status.is_success() {
            return checked_json(response, "response_body")
                .await
                .and_then(|_| anyhow::bail!("remote compaction returned no stream"));
        }
        let mut state = CompactionStreamState::default();
        read_sse(response, "compaction_stream", |value| state.consume(&value)).await?;
        let (item, usage) = state.finish()?;
        let mut messages = retained_user_history(&request.messages);
        messages.push(ChatMessage::provider_item(item));
        Ok(CompactionResponse { messages, usage })
    }

    async fn openai_responses(&self, request: ModelRequest) -> Result<ModelResponse> {
        let endpoint = responses_endpoint(&self.config.base_url);
        let mut body = json!({
            "model": request.model,
            "input": responses_input(&request.messages, self.config.capabilities.supports_vision, true)?,
            "stream": false
        });
        let request_tools = if self.config.capabilities.supports_native_tools {
            request.tools.as_slice()
        } else {
            &[]
        };
        let provider_tools =
            openai_responses_tools(request_tools, self.config.capabilities.supports_web_search);
        if !provider_tools.is_empty() {
            body["tools"] = Value::Array(provider_tools);
            body["tool_choice"] = Value::String("auto".into());
            if self.config.capabilities.supports_parallel_tool_calls {
                body["parallel_tool_calls"] = Value::Bool(true);
            }
        }
        apply_model_parameters(
            &self.config,
            &mut body,
            request.reasoning_effort.as_deref(),
            Some(true),
        );
        let response = self
            .send_with_reasoning_fallback(
                &endpoint,
                &body,
                false,
                Some(responses_body_legacy(&body)),
            )
            .await?;
        let value = checked_json(response, "response_body").await?;
        let mut content = String::new();
        let mut tool_calls = Vec::new();
        let mut invalid_tool_calls = Vec::new();
        for item in value
            .get("output")
            .and_then(Value::as_array)
            .context("responses payload has no output array")?
        {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    for part in item
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if matches!(
                            part.get("type").and_then(Value::as_str),
                            Some("output_text" | "text")
                        ) && let Some(text) = part.get("text").and_then(Value::as_str)
                        {
                            content.push_str(text);
                        }
                    }
                }
                Some("function_call") => match parse_function_call_item(item) {
                    Ok(call) => tool_calls.push(call),
                    Err(error) => invalid_tool_calls.push(invalid_tool_call(item, error)),
                },
                _ => {}
            }
        }
        Ok(ModelResponse {
            content,
            tool_calls,
            invalid_tool_calls,
            usage: responses_usage(value.get("usage")),
            streamed: false,
        })
    }

    async fn openai_responses_stream(
        &self,
        request: ModelRequest,
        observer: &dyn ModelStreamObserver,
    ) -> Result<ModelResponse> {
        let endpoint = responses_endpoint(&self.config.base_url);
        let mut body = json!({
            "model": request.model,
            "input": responses_input(&request.messages, self.config.capabilities.supports_vision, true)?,
            "stream": true
        });
        let request_tools = if self.config.capabilities.supports_native_tools {
            request.tools.as_slice()
        } else {
            &[]
        };
        let provider_tools =
            openai_responses_tools(request_tools, self.config.capabilities.supports_web_search);
        if !provider_tools.is_empty() {
            body["tools"] = Value::Array(provider_tools);
            body["tool_choice"] = Value::String("auto".into());
            if self.config.capabilities.supports_parallel_tool_calls {
                body["parallel_tool_calls"] = Value::Bool(true);
            }
        }
        apply_model_parameters(
            &self.config,
            &mut body,
            request.reasoning_effort.as_deref(),
            Some(true),
        );
        let response = self
            .send_with_reasoning_fallback(
                &endpoint,
                &body,
                true,
                Some(responses_body_legacy(&body)),
            )
            .await?;
        let status = response.status();
        if !status.is_success() {
            return checked_json(response, "response_body")
                .await
                .map(|_| ModelResponse::default());
        }
        let mut state = ResponsesStreamState::default();
        read_sse(response, "response_stream", |value| {
            state.consume(&value, observer)
        })
        .await?;
        state.finish()
    }

    async fn anthropic_messages(&self, request: ModelRequest) -> Result<ModelResponse> {
        let endpoint = endpoint(&self.config.base_url, "messages");
        let (system, messages) =
            anthropic_messages(&request.messages, self.config.capabilities.supports_vision)?;
        let mut body = json!({
            "model": request.model,
            "max_tokens": 8192,
            "messages": messages,
            "stream": false
        });
        if !system.is_empty() {
            body["system"] = Value::String(system);
        }
        let mut provider_tools = request
            .tools
            .iter()
            .filter(|_| self.config.capabilities.supports_native_tools)
            .filter(|tool| {
                !(self.config.capabilities.supports_web_search && tool.name == "web_search")
            })
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.parameters
                })
            })
            .collect::<Vec<_>>();
        if self.config.capabilities.supports_web_search {
            provider_tools.push(json!({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5
            }));
        }
        if !provider_tools.is_empty() {
            body["tools"] = Value::Array(provider_tools);
        }
        apply_model_parameters(
            &self.config,
            &mut body,
            request.reasoning_effort.as_deref(),
            None,
        );
        let mut builder = self
            .client
            .post(endpoint)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");
        if !self.config.api_key.is_empty() {
            builder = builder.header("x-api-key", &self.config.api_key);
        }
        let value = checked_json(
            send_request(builder.json(&body), "request_send").await?,
            "response_body",
        )
        .await?;
        let mut content = String::new();
        let mut tool_calls = Vec::new();
        let mut invalid_tool_calls = Vec::new();
        for block in value
            .get("content")
            .and_then(Value::as_array)
            .context("anthropic response has no content array")?
        {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        content.push_str(text);
                    }
                }
                Some("tool_use") => {
                    let parsed = (|| {
                        Ok::<_, anyhow::Error>(ToolCall {
                            id: required_string(block, "id")?.to_string(),
                            name: required_string(block, "name")?.to_string(),
                            arguments: parse_arguments(block.get("input").unwrap_or(&Value::Null))?,
                        })
                    })();
                    match parsed {
                        Ok(call) => tool_calls.push(call),
                        Err(error) => invalid_tool_calls.push(invalid_tool_call(block, error)),
                    }
                }
                _ => {}
            }
        }
        let usage = anthropic_usage(value.get("usage"));
        Ok(ModelResponse {
            content,
            tool_calls,
            invalid_tool_calls,
            usage,
            streamed: false,
        })
    }

    async fn gemini_native(&self, request: ModelRequest) -> Result<ModelResponse> {
        let base = self.config.base_url.trim_end_matches('/');
        let endpoint = if base.ends_with(":generateContent") {
            base.to_string()
        } else {
            format!("{base}/models/{}:generateContent", request.model)
        };
        let (system, contents) =
            gemini_messages(&request.messages, self.config.capabilities.supports_vision)?;
        let mut body = json!({"contents": contents});
        if !system.is_empty() {
            body["systemInstruction"] = json!({"parts": [{"text": system}]});
        }
        let function_declarations = request
            .tools
            .iter()
            .filter(|_| self.config.capabilities.supports_native_tools)
            .filter(|tool| {
                !(self.config.capabilities.supports_web_search && tool.name == "web_search")
            })
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters
                })
            })
            .collect::<Vec<_>>();
        let mut provider_tools = Vec::new();
        if !function_declarations.is_empty() {
            provider_tools.push(json!({"functionDeclarations": function_declarations}));
        }
        if self.config.capabilities.supports_web_search {
            provider_tools.push(json!({"google_search": {}}));
        }
        if !provider_tools.is_empty() {
            body["tools"] = Value::Array(provider_tools);
        }
        apply_model_parameters(
            &self.config,
            &mut body,
            request.reasoning_effort.as_deref(),
            None,
        );
        let mut builder = self
            .client
            .post(endpoint)
            .header("content-type", "application/json");
        if !self.config.api_key.is_empty() {
            builder = builder.header("x-goog-api-key", &self.config.api_key);
        }
        let value = checked_json(
            send_request(builder.json(&body), "request_send").await?,
            "response_body",
        )
        .await?;
        let parts = value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .context("gemini response has no candidate content")?;
        let mut content = String::new();
        let mut tool_calls = Vec::new();
        let mut invalid_tool_calls = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                content.push_str(text);
            }
            if let Some(call) = part.get("functionCall") {
                let id = format!("gemini-call-{index}");
                let parsed = (|| {
                    Ok::<_, anyhow::Error>(ToolCall {
                        id: id.clone(),
                        name: required_string(call, "name")?.to_string(),
                        arguments: parse_arguments(call.get("args").unwrap_or(&Value::Null))?,
                    })
                })();
                match parsed {
                    Ok(call) => tool_calls.push(call),
                    Err(error) => invalid_tool_calls.push(InvalidToolCall {
                        id,
                        name: call
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("provider_protocol_error")
                            .to_owned(),
                        reason: error.to_string(),
                    }),
                }
            }
        }
        let usage = value.get("usageMetadata");
        Ok(ModelResponse {
            content,
            tool_calls,
            invalid_tool_calls,
            usage: TokenUsage {
                input_tokens: nested_u64(usage, "promptTokenCount"),
                cached_input_tokens: nested_u64(usage, "cachedContentTokenCount"),
                cache_observed_input_tokens: if usage
                    .is_some_and(|value| value.get("cachedContentTokenCount").is_some())
                {
                    nested_u64(usage, "promptTokenCount")
                } else {
                    0
                },
                output_tokens: nested_u64(usage, "candidatesTokenCount"),
                cache_data_available: usage
                    .is_some_and(|value| value.get("cachedContentTokenCount").is_some()),
            },
            streamed: false,
        })
    }

    fn authenticated(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.config.api_key.is_empty() {
            builder
        } else {
            builder.bearer_auth(&self.config.api_key)
        }
    }

    /// 400 兜底：逐级剥离非标准参数后重试（reasoning → top_k → 并行工具 → 全部工具），
    /// 直到成功或全部失败。全部失败时返回首个响应的原始错误详情。
    async fn send_with_reasoning_fallback(
        &self,
        endpoint: &str,
        body: &Value,
        streaming: bool,
        extra_fallback: Option<Value>,
    ) -> Result<Response> {
        let request = || {
            let builder = self.authenticated(self.client.post(endpoint));
            if streaming {
                builder
                    .header(reqwest::header::ACCEPT, "text/event-stream")
                    .header(reqwest::header::CACHE_CONTROL, "no-cache")
            } else {
                builder
            }
        };
        let response = request()
            .json(body)
            .send()
            .await
            .map_err(|error| transport_error("request_send", error))?;
        if response.status().as_u16() != 400 {
            return Ok(response);
        }

        let first_status = response.status();
        let first_retry_after_ms = retry_after_ms(response.headers());
        let first_request_id = response_request_id(response.headers());
        let first_body = response
            .text()
            .await
            .map_err(|error| transport_error("response_body", error))?;

        // 阶梯：记录每次递减的 body，去重后依次尝试。
        let mut steps: Vec<Value> = Vec::new();
        let mut push_step = |value: Value, steps: &mut Vec<Value>| {
            if value != *body {
                steps.push(value);
            }
        };
        push_step(
            {
                let mut value = body.clone();
                remove_reasoning_fields(&mut value);
                value
            },
            &mut steps,
        );
        push_step(
            {
                let mut value = body.clone();
                remove_reasoning_fields(&mut value);
                remove_json_field(&mut value, "top_k");
                value
            },
            &mut steps,
        );
        push_step(
            {
                let mut value = body.clone();
                remove_reasoning_fields(&mut value);
                remove_json_field(&mut value, "top_k");
                remove_json_field(&mut value, "parallel_tool_calls");
                value
            },
            &mut steps,
        );
        push_step(
            {
                let mut value = body.clone();
                remove_reasoning_fields(&mut value);
                remove_json_field(&mut value, "top_k");
                remove_json_field(&mut value, "parallel_tool_calls");
                remove_optional_capability_fields(&mut value);
                value
            },
            &mut steps,
        );
        // #8：gpt-5 系模型拒绝 temperature，且该错误是持久 400——加入阶梯兜底。
        push_step(
            {
                let mut value = body.clone();
                remove_reasoning_fields(&mut value);
                remove_json_field(&mut value, "top_k");
                remove_json_field(&mut value, "parallel_tool_calls");
                remove_optional_capability_fields(&mut value);
                remove_json_field(&mut value, "temperature");
                value
            },
            &mut steps,
        );
        // 兼容阶梯末位：严格 serde 代理（agnes/OpenCode 等网关）拒绝 Responses
        // 全形状（type/id/input_text 等）时，退回旧简写形状重试。
        if let Some(legacy) = extra_fallback {
            push_step(legacy, &mut steps);
        }

        for fallback in &steps {
            let retry = request()
                .json(fallback)
                .send()
                .await
                .map_err(|error| transport_error("request_send", error))?;
            if retry.status().as_u16() != 400 {
                return Ok(retry);
            }
            // 读走 body 以便复用连接，仅保留首个错误详情。
            let _ = retry.text().await;
        }

        Err(ProviderRequestError {
            phase: "response_body",
            kind: ProviderErrorKind::Http,
            status: Some(first_status.as_u16()),
            retry_after_ms: first_retry_after_ms,
            request_id: first_request_id,
            retryable: false,
            detail: safe_http_error_detail(first_status.as_u16(), &first_body),
        }
        .into())
    }
}

fn apply_model_parameters(
    config: &ProviderConfig,
    body: &mut Value,
    effort: Option<&str>,
    standard_reasoning: Option<bool>,
) {
    let parameters = config.model_parameters.get(&config.model);
    if let Some(temperature) = parameters
        .and_then(|value| value.get("temperature"))
        .and_then(Value::as_f64)
        .filter(|value| (0.0..=2.0).contains(value))
    {
        match config.kind {
            ProviderKind::GeminiNative => {
                set_json_path(body, "generationConfig.temperature", json!(temperature));
            }
            _ => body["temperature"] = json!(temperature),
        }
    }
    if let Some(top_k) = parameters
        .and_then(|value| value.get("topK"))
        .and_then(Value::as_u64)
        .filter(|value| (1..=65_536).contains(value))
    {
        match config.kind {
            ProviderKind::GeminiNative => {
                set_json_path(body, "generationConfig.topK", json!(top_k));
            }
            _ => body["top_k"] = json!(top_k),
        }
    }

    let reasoning_field = parameters
        .and_then(|value| value.get("reasoningField"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let requested_effort = effort.filter(|value| *value != "auto");
    if let Some(field) = reasoning_field {
        remove_reasoning_fields(body);
        let mapped = requested_effort.and_then(|level| {
            parameters
                .and_then(|value| value.get("reasoningMapping"))
                .and_then(|mapping| mapping.get(level))
                .and_then(parameter_value)
        });
        if let Some(value) = mapped {
            set_json_path(body, field, value);
            if field.starts_with("thinking.") && field != "thinking.type" {
                set_json_path(body, "thinking.type", Value::String("enabled".into()));
            }
        }
    } else if let Some(responses_api) = standard_reasoning {
        apply_reasoning_effort(body, requested_effort, responses_api);
    }
}

fn parameter_value(value: &Value) -> Option<Value> {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                serde_json::from_str(trimmed)
                    .ok()
                    .or_else(|| Some(Value::String(trimmed.to_owned())))
            }
        }
        Value::Null => None,
        value => Some(value.clone()),
    }
}

fn set_json_path(target: &mut Value, path: &str, value: Value) {
    fn set_segments(target: &mut Value, segments: &[&str], value: Value) {
        let Some((head, tail)) = segments.split_first() else {
            return;
        };
        if !target.is_object() {
            *target = json!({});
        }
        let object = target.as_object_mut().expect("object created above");
        if tail.is_empty() {
            object.insert((*head).to_owned(), value);
            return;
        }
        let child = object.entry((*head).to_owned()).or_insert_with(|| json!({}));
        set_segments(child, tail, value);
    }

    let segments = path
        .split('.')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    set_segments(target, &segments, value);
}

fn apply_reasoning_effort(body: &mut Value, effort: Option<&str>, responses_api: bool) {
    let Some(effort) = effort.filter(|value| *value != "auto") else {
        return;
    };
    if responses_api {
        body["reasoning"] = json!({"effort": effort});
    } else {
        body["reasoning_effort"] = Value::String(effort.to_owned());
    }
}

fn has_reasoning_field(body: &Value) -> bool {
    body.get("reasoning_effort").is_some()
        || body.get("reasoning").is_some()
        || body.get("thinking").is_some()
        || body.get("enable_thinking").is_some()
        || body.pointer("/generationConfig/thinkingConfig").is_some()
}

fn remove_reasoning_fields(body: &mut Value) {
    if let Some(object) = body.as_object_mut() {
        object.remove("reasoning_effort");
        object.remove("reasoning");
        object.remove("thinking");
        object.remove("enable_thinking");
        if let Some(generation_config) = object
            .get_mut("generationConfig")
            .and_then(Value::as_object_mut)
        {
            generation_config.remove("thinkingConfig");
        }
    }
}

fn remove_json_field(body: &mut Value, key: &str) {
    if let Some(object) = body.as_object_mut() {
        object.remove(key);
    }
}

fn rejects_reasoning_field(body: &str) -> bool {
    let text = body.to_ascii_lowercase();
    let mentions_field = text.contains("reasoning_effort")
        || text.contains("reasoning.effort")
        || text.contains("reasoning")
        || text.contains("thinking")
        || text.contains("budget_tokens");
    let rejects_field = text.contains("unknown")
        || text.contains("unsupported")
        || text.contains("unrecognized")
        || text.contains("not allowed")
        || text.contains("extra field")
        || text.contains("invalid parameter");
    mentions_field && rejects_field
}

fn rejects_model_capability(body: &str) -> bool {
    let text = body.to_ascii_lowercase();
    text.contains("model_capability_not_supported")
        || (text.contains("capability")
            && (text.contains("not supported")
                || text.contains("unsupported")
                || text.contains("does not support")))
}

fn remove_optional_capability_fields(body: &mut Value) {
    if let Some(object) = body.as_object_mut() {
        for key in [
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "functions",
            "function_call",
        ] {
            object.remove(key);
        }
    }
}

fn has_optional_capability_fields(body: &Value) -> bool {
    [
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "functions",
        "function_call",
    ]
    .iter()
    .any(|key| body.get(*key).is_some())
}

fn openai_responses_tools(tools: &[coomi_engine::ToolSpec], native_web_search: bool) -> Vec<Value> {
    let mut output = tools
        .iter()
        .filter(|tool| !(native_web_search && tool.name == "web_search"))
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "strict": true
            })
        })
        .collect::<Vec<_>>();
    if native_web_search {
        output.push(json!({"type": "web_search"}));
    }
    output
}

#[async_trait]
impl ModelProvider for HttpModelProvider {
    fn provider_id(&self) -> &str {
        &self.config.id
    }

    fn model(&self) -> &str {
        &self.config.model
    }

    fn capabilities(&self) -> ModelCapabilities {
        self.config.capabilities.clone()
    }

    async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
        match self.config.kind {
            ProviderKind::OpenAiCompatible => self.openai_compatible(request).await,
            ProviderKind::OpenAiResponses => self.openai_responses(request).await,
            ProviderKind::AnthropicMessages => self.anthropic_messages(request).await,
            ProviderKind::GeminiNative => self.gemini_native(request).await,
            ProviderKind::DeepSeekAccount => self.deepseek_account(request, None).await,
        }
    }

    async fn complete_stream(
        &self,
        request: ModelRequest,
        observer: &dyn ModelStreamObserver,
    ) -> Result<ModelResponse> {
        match self.config.kind {
            ProviderKind::OpenAiCompatible => {
                self.openai_compatible_stream(request, observer).await
            }
            ProviderKind::OpenAiResponses => self.openai_responses_stream(request, observer).await,
            ProviderKind::AnthropicMessages | ProviderKind::GeminiNative => {
                self.complete(request).await
            }
            ProviderKind::DeepSeekAccount => {
                self.deepseek_account(request, Some(observer)).await
            }
        }
    }

    async fn compact(&self, request: CompactionRequest) -> Result<Option<CompactionResponse>> {
        if self.config.kind == ProviderKind::OpenAiResponses
            && self.config.capabilities.supports_remote_compaction
        {
            let response = match self.config.remote_compaction_mode {
                RemoteCompactionMode::Legacy => self.openai_remote_compaction(request).await,
                RemoteCompactionMode::V2 => self.openai_remote_compaction_v2(request).await,
            }?;
            return Ok(Some(response));
        }
        Ok(None)
    }
}

async fn send_request(builder: RequestBuilder, phase: &'static str) -> Result<Response> {
    builder
        .send()
        .await
        .map_err(|error| transport_error(phase, error))
}

fn transport_error(phase: &'static str, error: reqwest::Error) -> anyhow::Error {
    let is_builder = error.is_builder();
    let is_body = error.is_body();
    let is_redirect = error.is_redirect();
    let is_timeout = error.is_timeout();
    let is_connect = error.is_connect();
    let detail = transport_error_chain(error);
    let chain = detail.to_ascii_lowercase();
    let kind = if is_builder {
        ProviderErrorKind::RequestBuild
    } else if is_body {
        ProviderErrorKind::RequestBody
    } else if is_redirect {
        ProviderErrorKind::Redirect
    } else if is_timeout {
        ProviderErrorKind::Timeout
    } else if is_connect {
        if chain.contains("dns")
            || chain.contains("name resolution")
            || chain.contains("lookup address")
        {
            ProviderErrorKind::Dns
        } else if chain.contains("tls")
            || chain.contains("certificate")
            || chain.contains("handshake")
        {
            ProviderErrorKind::Tls
        } else if chain.contains("proxy") {
            ProviderErrorKind::Proxy
        } else {
            ProviderErrorKind::Connect
        }
    } else if chain.contains("i/o") || chain.contains("io error") {
        ProviderErrorKind::LocalIo
    } else {
        ProviderErrorKind::Request
    };
    let retryable = retryable_transport_kind(kind);
    ProviderRequestError {
        phase,
        kind,
        status: None,
        retry_after_ms: None,
        request_id: None,
        retryable,
        detail,
    }
    .into()
}

fn retryable_transport_kind(kind: ProviderErrorKind) -> bool {
    matches!(
        kind,
        ProviderErrorKind::Timeout
            | ProviderErrorKind::Connect
            | ProviderErrorKind::Dns
            | ProviderErrorKind::Request
            | ProviderErrorKind::Stream
    )
}

/// reqwest intentionally displays only a generic message for body decoder
/// failures. Preserve its source chain (without the request URL) so logs can
/// distinguish a timeout, peer reset, incomplete chunked body, or HTTP/2 error.
fn transport_error_chain(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && parts.last().is_none_or(|previous| previous != &text) {
            parts.push(text);
        }
        source = cause.source();
    }
    parts.join(": ")
}

async fn read_sse(
    response: Response,
    phase: &'static str,
    mut consume: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    let status = response.status();
    let version = response.version();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_owned();
    let transfer_encoding = response
        .headers()
        .get(reqwest::header::TRANSFER_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none")
        .to_owned();
    let content_encoding = response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("identity")
        .to_owned();
    let content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_owned();
    let request_id = response_request_id(response.headers());
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut bytes_received = 0_u64;
    let mut chunks_received = 0_u64;
    let mut saw_done = false;
    'stream: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            let kind = if error.is_timeout() {
                ProviderErrorKind::Timeout
            } else {
                ProviderErrorKind::Stream
            };
            let detail = format!(
                "{}; http_status={} http_version={:?} content_type={} transfer_encoding={} content_encoding={} content_length={} bytes_received={} chunks_received={} saw_done={}",
                transport_error_chain(error),
                status.as_u16(),
                version,
                content_type,
                transfer_encoding,
                content_encoding,
                content_length,
                bytes_received,
                chunks_received,
                saw_done,
            );
            anyhow::Error::new(ProviderRequestError {
                phase,
                kind,
                status: Some(status.as_u16()),
                retry_after_ms: None,
                request_id: request_id.clone(),
                retryable: retryable_transport_kind(kind),
                detail,
            })
        })?;
        chunks_received = chunks_received.saturating_add(1);
        bytes_received = bytes_received.saturating_add(chunk.len() as u64);
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            let line = String::from_utf8(line).map_err(|_| {
                anyhow::Error::new(ProviderRequestError {
                    phase,
                    kind: ProviderErrorKind::Decode,
                    status: None,
                    retry_after_ms: None,
                    request_id: request_id.clone(),
                    retryable: false,
                    detail: "provider stream was not UTF-8".into(),
                })
            })?;
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                saw_done = true;
                // The SSE protocol has an explicit terminator. Do not wait
                // for a proxy/provider to close the keep-alive connection.
                break 'stream;
            }
            let value = serde_json::from_str(data).map_err(|_| {
                anyhow::Error::new(ProviderRequestError {
                    phase,
                    kind: ProviderErrorKind::Decode,
                    status: None,
                    retry_after_ms: None,
                    request_id: request_id.clone(),
                    retryable: false,
                    detail: "provider stream contained invalid SSE JSON".into(),
                })
            })?;
            consume(value)?;
        }
    }
    if saw_done {
        return Ok(());
    }
    Ok(())
}

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct ChatStreamState {
    content: String,
    tools: BTreeMap<usize, PartialToolCall>,
    usage: TokenUsage,
}

impl ChatStreamState {
    fn consume(&mut self, value: &Value, observer: &dyn ModelStreamObserver) -> Result<()> {
        if value.get("usage").is_some_and(|usage| !usage.is_null()) {
            self.usage = openai_usage(value.get("usage"));
        }
        let Some(delta) = value.pointer("/choices/0/delta") else {
            return Ok(());
        };
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            observer.on_reasoning_delta(reasoning);
        }
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            self.content.push_str(content);
            observer.on_text_delta(content);
        }
        for item in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(self.tools.len());
            let target = self.tools.entry(index).or_default();
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                target.id.push_str(id);
            }
            if let Some(function) = item.get("function") {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    target.name.push_str(name);
                }
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    target.arguments.push_str(arguments);
                }
            }
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                // A few OpenAI-compatible gateways flatten function.name onto
                // the tool-call item while keeping arguments under function.
                target.name.push_str(name);
            }
            if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                target.arguments.push_str(arguments);
            }
        }
        // Legacy Chat Completions implementations may emit one tool call as
        // delta.function_call instead of delta.tool_calls[]. Preserve it as
        // index zero so the call can still be validated and executed.
        if let Some(function) = delta.get("function_call") {
            let target = self.tools.entry(0).or_default();
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                target.name.push_str(name);
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                target.arguments.push_str(arguments);
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<ModelResponse> {
        let tools = std::mem::take(&mut self.tools);
        let mut tool_calls = Vec::new();
        let mut invalid_tool_calls = Vec::new();
        for (index, call) in tools.into_values().enumerate() {
            let id = if call.id.is_empty() {
                format!("call-{index}")
            } else {
                call.id
            };
            if call.name.trim().is_empty() {
                invalid_tool_calls.push(InvalidToolCall {
                    id,
                    name: "provider_protocol_error".into(),
                    reason: format!(
                        "streamed tool call has no function name (arguments_bytes={})",
                        call.arguments.len()
                    ),
                });
                continue;
            }
            match parse_arguments(&Value::String(call.arguments)) {
                Ok(arguments) => tool_calls.push(ToolCall {
                    id,
                    name: call.name,
                    arguments,
                }),
                Err(error) => invalid_tool_calls.push(InvalidToolCall {
                    id,
                    name: call.name,
                    reason: error.to_string(),
                }),
            }
        }
        Ok(ModelResponse {
            content: self.content,
            tool_calls,
            invalid_tool_calls,
            usage: self.usage,
            streamed: true,
        })
    }
}

#[derive(Default)]
struct CompactionStreamState {
    item: Option<Value>,
    usage: TokenUsage,
}

impl CompactionStreamState {
    fn consume(&mut self, value: &Value) -> Result<()> {
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_item.added" | "response.output_item.done") => {
                if let Some(item) = value.get("item")
                    && matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("compaction" | "context_compaction")
                    )
                {
                    self.item = Some(item.clone());
                }
            }
            Some("response.completed") => {
                self.usage = responses_usage(value.pointer("/response/usage"));
            }
            Some("error" | "response.failed") => {
                return Err(stream_event_error("compaction_stream", value));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> Result<(Value, TokenUsage)> {
        let item = self
            .item
            .context("compaction stream contained no compaction output item")?;
        anyhow::ensure!(
            item.get("encrypted_content")
                .and_then(Value::as_str)
                .is_some(),
            "compaction output has no encrypted_content"
        );
        Ok((item, self.usage))
    }
}

#[derive(Default)]
struct ResponsesStreamState {
    content: String,
    tools: BTreeMap<String, PartialToolCall>,
    /// item_id（fc_…）→ call_id（call_…）别名：output_item.added 两个都带，
    /// 而 function_call_arguments.delta 只带 item_id——不归一会让同一工具调用
    /// 分裂成两条（call_id 条目有名无参、item_id 条目有参无名）。（#8）
    item_aliases: BTreeMap<String, String>,
    usage: TokenUsage,
}

impl ResponsesStreamState {
    fn consume(&mut self, value: &Value, observer: &dyn ModelStreamObserver) -> Result<()> {
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    self.content.push_str(delta);
                    observer.on_text_delta(delta);
                }
            }
            Some("response.reasoning_summary_text.delta" | "response.reasoning_text.delta") => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    observer.on_reasoning_delta(delta);
                }
            }
            Some("response.output_item.added" | "response.output_item.done") => {
                if let Some(item) = value.get("item")
                    && item.get("type").and_then(Value::as_str) == Some("function_call")
                {
                    let id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(item_id) = item.get("id").and_then(Value::as_str)
                        && item_id != id
                        && !id.is_empty()
                    {
                        self.item_aliases.insert(item_id.to_owned(), id.clone());
                    }
                    let target = self.tools.entry(id.clone()).or_default();
                    target.id = id;
                    if let Some(name) = item.get("name").and_then(Value::as_str) {
                        target.name = name.to_owned();
                    }
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        target.arguments = arguments.to_owned();
                    }
                }
            }
            Some("response.function_call_arguments.delta") => {
                let raw = value
                    .get("call_id")
                    .or_else(|| value.get("item_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let id = self.item_aliases.get(&raw).cloned().unwrap_or(raw);
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    self.tools.entry(id).or_default().arguments.push_str(delta);
                }
            }
            Some("response.completed") => {
                self.usage = responses_usage(value.pointer("/response/usage"));
            }
            Some("error" | "response.failed") => {
                return Err(stream_event_error("response_stream", value));
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(mut self) -> Result<ModelResponse> {
        let tools = std::mem::take(&mut self.tools);
        let mut tool_calls = Vec::new();
        let mut invalid_tool_calls = Vec::new();
        for (index, call) in tools.into_values().enumerate() {
            let id = if call.id.is_empty() {
                format!("call-{index}")
            } else {
                call.id
            };
            if call.name.trim().is_empty() {
                invalid_tool_calls.push(InvalidToolCall {
                    id,
                    name: "provider_protocol_error".into(),
                    reason: "streamed tool call has no function name".into(),
                });
                continue;
            }
            match parse_arguments(&Value::String(call.arguments)) {
                Ok(arguments) => tool_calls.push(ToolCall {
                    id,
                    name: call.name,
                    arguments,
                }),
                Err(error) => invalid_tool_calls.push(InvalidToolCall {
                    id,
                    name: call.name,
                    reason: error.to_string(),
                }),
            }
        }
        Ok(ModelResponse {
            content: self.content,
            tool_calls,
            invalid_tool_calls,
            usage: self.usage,
            streamed: true,
        })
    }
}

fn endpoint(base_url: &str, suffix: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with(suffix) {
        base_url.to_string()
    } else {
        format!("{base_url}/{suffix}")
    }
}

/// #8：Responses 端点统一走 EndpointResolver——base_url 不带版本段时自动补
/// `v1`（如 https://api.openai.com → /v1/responses），与能力探测路径一致。
/// 之前的 endpoint() 直接拼 `/responses`，造成"检测通过、对话 404"。
fn responses_endpoint(base_url: &str) -> String {
    EndpointResolver::new(base_url, ProviderProtocol::OpenAiResponses).inference("")
}

/// 兼容降级：把 Responses 全形状请求体退回旧简写形状
/// （message 去 type/id、content 压回字符串；function_call(_output) 去 id）。
/// 供严格 serde 代理（agnes/OpenCode 等网关）400 时作为最后阶梯重试。
fn responses_body_legacy(body: &Value) -> Value {
    let mut legacy = body.clone();
    if let Some(items) = legacy.get_mut("input").and_then(Value::as_array_mut) {
        let simplified: Vec<Value> = items
            .iter()
            .map(|item| {
                let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "message" => {
                        let role = item.get("role").cloned().unwrap_or_else(|| json!("user"));
                        let text = item
                            .pointer("/content/0/text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        json!({ "role": role, "content": text })
                    }
                    "function_call" | "function_call_output" => {
                        let mut object = item.clone();
                        if let Some(map) = object.as_object_mut() {
                            map.remove("id");
                        }
                        object
                    }
                    _ => item.clone(),
                }
            })
            .collect();
        legacy["input"] = Value::Array(simplified);
    }
    legacy
}

fn responses_compact_endpoint(base_url: &str) -> String {
    format!("{}/compact", responses_endpoint(base_url))
}

async fn checked_json(response: Response, phase: &'static str) -> Result<Value> {
    let status = response.status();
    let retry_after_ms = retry_after_ms(response.headers());
    let request_id = response_request_id(response.headers());
    let body = response
        .text()
        .await
        .map_err(|error| transport_error(phase, error))?;
    if !status.is_success() {
        return Err(ProviderRequestError {
            phase,
            kind: ProviderErrorKind::Http,
            status: Some(status.as_u16()),
            retry_after_ms,
            request_id,
            retryable: matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504),
            detail: safe_http_error_detail(status.as_u16(), &body),
        }
        .into());
    }
    serde_json::from_str(&body).map_err(|_| {
        ProviderRequestError {
            phase,
            kind: ProviderErrorKind::Decode,
            status: Some(status.as_u16()),
            retry_after_ms: None,
            request_id,
            retryable: false,
            detail: "provider returned invalid JSON".into(),
        }
        .into()
    })
}

fn retry_after_ms(headers: &HeaderMap) -> Option<u64> {
    let value = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1_000));
    }
    let target = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let delay = target.timestamp_millis() - chrono::Utc::now().timestamp_millis();
    u64::try_from(delay.max(0)).ok()
}

fn response_request_id(headers: &HeaderMap) -> Option<String> {
    ["x-request-id", "request-id", "x-trace-id"]
        .iter()
        .find_map(|name| headers.get(*name))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .map(ToOwned::to_owned)
}

fn safe_http_error_detail(status: u16, body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let summary = if ["image_url", "input_image", "inline_data", "media_type"]
        .iter()
        .any(|needle| lower.contains(needle))
        || lower.contains("vision is not supported")
        || lower.contains("image input is not supported")
        || lower.contains("multimodal")
        || lower.contains("expected `text`")
    {
        "provider rejected image input (image_url)"
    } else if lower.contains("context_window_exceeded")
        || lower.contains("context length")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
    {
        "provider context_window_exceeded"
    } else if status == 429
        || lower.contains("rate limit")
        || lower.contains("tpm")
        || lower.contains("quota")
    {
        "provider rate or token limit was exceeded"
    } else if matches!(status, 401 | 403) {
        "provider authentication or authorization failed"
    } else if status == 404 {
        "provider endpoint was not found; verify the Base URL and protocol"
    } else if status >= 500 {
        "provider service is temporarily unavailable"
    } else {
        "provider rejected the request"
    };
    let code = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .pointer("/error/code")
            .or_else(|| value.pointer("/error/type"))
            .or_else(|| value.get("code"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 80
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            })
            .map(ToOwned::to_owned)
    });
    // 报错细化（批次八收尾）：保留上游 error.message 原文（脱敏后）——它才是
    // 判断欠费/限流/参数错误的真实依据，只有短码用户没法归因。
    let upstream_message = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .pointer("/error/message")
            .or_else(|| value.pointer("/message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(redact_upstream_message)
    });
    match (code, upstream_message) {
        (Some(code), Some(message)) => format!("{summary} (code={code}) {message}"),
        (Some(code), None) => format!("{summary} (code={code})"),
        (None, Some(message)) => format!("{summary}: {message}"),
        (None, None) => summary.to_owned(),
    }
}

/// 上游错误消息脱敏：截断到 400 字符；sk- 开头的密钥、含 token=/key= 的参数
/// 整词替换为占位符，其余保留（用户需要看到欠费/限流的真实描述）。
fn redact_upstream_message(message: &str) -> String {
    let truncated: String = message.chars().take(400).collect();
    let mut output = String::with_capacity(truncated.len());
    for (index, word) in truncated
        .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';' | '"' | '(' | ')'))
        .enumerate()
    {
        if index > 0 {
            output.push(' ');
        }
        let lower = word.to_ascii_lowercase();
        if (lower.starts_with("sk-") && word.len() > 6)
            || lower.contains("token=")
            || lower.contains("key=")
            || lower.contains("apikey=")
        {
            output.push_str("[已脱敏]");
        } else {
            output.push_str(word);
        }
    }
    output
}

fn stream_event_error(phase: &'static str, value: &Value) -> anyhow::Error {
    let message = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/response/error/message"))
        .and_then(Value::as_str)
        .unwrap_or("provider stream failed");
    let lower = message.to_ascii_lowercase();
    let retryable = lower.contains("rate limit")
        || lower.contains("tpm")
        || lower.contains("quota")
        || lower.contains("temporarily unavailable")
        || lower.contains("internal server error")
        || lower.contains("overloaded")
        || lower.contains("service unavailable");
    let status = if lower.contains("rate limit") || lower.contains("tpm") || lower.contains("quota")
    {
        429
    } else if retryable {
        503
    } else {
        400
    };
    ProviderRequestError {
        phase,
        kind: ProviderErrorKind::Stream,
        status: None,
        retry_after_ms: None,
        request_id: None,
        retryable,
        detail: safe_http_error_detail(status, &value.to_string()),
    }
    .into()
}

fn openai_messages(messages: &[ChatMessage], supports_vision: bool) -> Result<Vec<Value>> {
    let mut output = Vec::new();
    for message in messages {
        if !message.provider_items.is_empty() {
            continue;
        }
        let value = match message.role {
            Role::System => json!({"role": "system", "content": message.content}),
            Role::User => json!({"role": "user", "content": message.content}),
            Role::Assistant => {
                let mut value = json!({
                    "role": "assistant",
                    "content": if message.content.is_empty() { Value::Null } else { Value::String(message.content.clone()) }
                });
                if !message.tool_calls.is_empty() {
                    value["tool_calls"] = Value::Array(
                        message
                            .tool_calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "id": call.id,
                                    "type": "function",
                                    "function": {
                                        "name": call.name,
                                        "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into())
                                    }
                                })
                            })
                            .collect(),
                    );
                }
                value
            }
            Role::Tool => {
                // tool 消息的 content 在 OpenAI 兼容端点只接受字符串，图片
                // 不能放进 tool 消息（上游会忽略或报错）。图片以独立的 user
                // 消息紧跟在 tool 消息之后发送：
                //   {"role":"user","content":[{"type":"text",...},
                //    {"type":"image_url","image_url":{"url":"data:...;base64,..."}}]}
                output.push(json!({
                    "role": "tool",
                    "tool_call_id": message.tool_call_id.as_deref().context("tool message has no call id")?,
                    "content": message.content
                }));
                if supports_vision && !message.images.is_empty() {
                    let mut content = vec![json!({"type": "text", "text": message.content})];
                    content.extend(message.images.iter().map(|image| {
                        json!({
                            "type": "image_url",
                            "image_url": {"url": image.data_url()}
                        })
                    }));
                    output.push(json!({"role": "user", "content": content}));
                }
                continue;
            }
        };
        output.push(value);
    }
    Ok(output)
}

fn responses_input(messages: &[ChatMessage], supports_vision: bool, strict: bool) -> Result<Vec<Value>> {
    let mut input = Vec::new();
    for message in messages {
        if !message.provider_items.is_empty() {
            input.extend(message.provider_items.iter().cloned());
            continue;
        }
        match message.role {
            Role::System | Role::User => {
                if strict {
                    input.push(json!({
                        "type": "message",
                        "role": role_name(message.role),
                        "content": [{ "type": "input_text", "text": message.content }]
                    }));
                } else {
                    input.push(json!({
                        "role": role_name(message.role),
                        "content": message.content
                    }));
                }
            },
            Role::Assistant => {
                if !message.content.is_empty() {
                    if strict {
                        input.push(json!({
                            "type": "message",
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": message.content }]
                        }));
                    } else {
                        input.push(json!({"role": "assistant", "content": message.content}));
                    }
                }
                for call in &message.tool_calls {
                    let mut call_item = json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": serde_json::to_string(&call.arguments)?
                    });
                    if strict {
                        call_item["id"] = json!(call.id);
                    }
                    input.push(call_item);
                }
            }
            Role::Tool => {
                let output = if message.images.is_empty() || !supports_vision {
                    Value::String(message.content.clone())
                } else {
                    // #8：Responses API 的 function_call_output 内容项类型是
                    // output_text/output_image（input_* 只用于 user 消息），
                    // 用错会被 400 拒绝。
                    let mut items = vec![json!({
                        "type": "output_text",
                        "text": message.content
                    })];
                    items.extend(message.images.iter().map(|image| {
                        json!({
                            "type": "output_image",
                            "image_url": image.data_url()
                        })
                    }));
                    Value::Array(items)
                };
                let mut output_item = json!({
                    "type": "function_call_output",
                    "call_id": message.tool_call_id.as_deref().context("tool message has no call id")?,
                    "output": output
                });
                if strict {
                    output_item["id"] = json!(message.tool_call_id.as_deref().context("tool message has no call id")?);
                }
                input.push(output_item);
            }
        }
    }
    Ok(input)
}

fn remote_compaction_v2_body(
    request: &CompactionRequest,
    supports_web_search: bool,
    parallel_tool_calls: bool,
    supports_vision: bool,
) -> Result<Value> {
    let mut input = responses_input(&request.messages, supports_vision, true)?;
    input.push(json!({"type": "compaction_trigger"}));
    let mut body = json!({
        "model": request.model,
        "input": input,
        "instructions": request.system_prompt,
        "stream": true,
        "parallel_tool_calls": parallel_tool_calls
    });
    let tools = openai_responses_tools(&request.tools, supports_web_search);
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    Ok(body)
}

fn anthropic_messages(
    messages: &[ChatMessage],
    supports_vision: bool,
) -> Result<(String, Vec<Value>)> {
    let mut system = Vec::new();
    let mut output = Vec::new();
    for message in messages {
        if !message.provider_items.is_empty() {
            continue;
        }
        match message.role {
            Role::System => system.push(message.content.clone()),
            Role::User => output.push(json!({"role": "user", "content": message.content})),
            Role::Assistant => {
                let mut blocks = Vec::new();
                if !message.content.is_empty() {
                    blocks.push(json!({"type": "text", "text": message.content}));
                }
                for call in &message.tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments
                    }));
                }
                output.push(json!({"role": "assistant", "content": blocks}));
            }
            Role::Tool => {
                let content = if message.images.is_empty() || !supports_vision {
                    Value::String(message.content.clone())
                } else {
                    let mut blocks = vec![json!({"type": "text", "text": message.content})];
                    blocks.extend(message.images.iter().map(|image| {
                        json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image.media_type,
                                "data": image.data
                            }
                        })
                    }));
                    Value::Array(blocks)
                };
                output.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id.as_deref().context("tool message has no call id")?,
                        "content": content
                    }]
                }));
            }
        }
    }
    Ok((system.join("\n\n"), output))
}

fn gemini_messages(
    messages: &[ChatMessage],
    supports_vision: bool,
) -> Result<(String, Vec<Value>)> {
    let mut system = Vec::new();
    let mut output = Vec::new();
    let mut call_names = Map::new();
    for message in messages {
        if !message.provider_items.is_empty() {
            continue;
        }
        match message.role {
            Role::System => system.push(message.content.clone()),
            Role::User => output.push(json!({
                "role": "user",
                "parts": [{"text": message.content}]
            })),
            Role::Assistant => {
                let mut parts = Vec::new();
                if !message.content.is_empty() {
                    parts.push(json!({"text": message.content}));
                }
                for call in &message.tool_calls {
                    call_names.insert(call.id.clone(), Value::String(call.name.clone()));
                    parts.push(json!({
                        "functionCall": {"name": call.name, "args": call.arguments}
                    }));
                }
                output.push(json!({"role": "model", "parts": parts}));
            }
            Role::Tool => {
                let call_id = message
                    .tool_call_id
                    .as_deref()
                    .context("tool message has no call id")?;
                let name = call_names
                    .get(call_id)
                    .and_then(Value::as_str)
                    .context("gemini tool result has no matching call")?;
                let mut parts = vec![json!({
                    "functionResponse": {
                        "name": name,
                        "response": {"output": message.content}
                    }
                })];
                if supports_vision {
                    parts.extend(message.images.iter().map(|image| {
                        json!({
                            "inlineData": {
                                "mimeType": image.media_type,
                                "data": image.data
                            }
                        })
                    }));
                }
                output.push(json!({"role": "user", "parts": parts}));
            }
        }
    }
    Ok((system.join("\n\n"), output))
}

fn parse_openai_tool_calls(value: Option<&Value>) -> Result<(Vec<ToolCall>, Vec<InvalidToolCall>)> {
    let mut valid = Vec::new();
    let mut invalid = Vec::new();
    for call in value.and_then(Value::as_array).into_iter().flatten() {
        let parsed = (|| {
            let function = call
                .get("function")
                .context("tool call has no function object")?;
            let arguments = function
                .get("arguments")
                .context("tool call has no arguments")?;
            Ok::<_, anyhow::Error>(ToolCall {
                id: required_string(call, "id")?.to_string(),
                name: required_string(function, "name")?.to_string(),
                arguments: parse_arguments(arguments)?,
            })
        })();
        match parsed {
            Ok(call) => valid.push(call),
            Err(error) => invalid.push(invalid_tool_call(call, error)),
        }
    }
    Ok((valid, invalid))
}

fn invalid_tool_call(value: &Value, error: anyhow::Error) -> InvalidToolCall {
    let function = value.get("function").unwrap_or(value);
    InvalidToolCall {
        id: value
            .get("call_id")
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("invalid-tool-call")
            .to_owned(),
        name: function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("provider_protocol_error")
            .to_owned(),
        reason: error.to_string(),
    }
}

fn parse_function_call_item(item: &Value) -> Result<ToolCall> {
    Ok(ToolCall {
        id: item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .context("function call item has no call_id")?
            .to_string(),
        name: required_string(item, "name")?.to_string(),
        arguments: parse_arguments(
            item.get("arguments")
                .context("function call item has no arguments")?,
        )?,
    })
}

fn parse_arguments(value: &Value) -> Result<Value> {
    let parsed = match value {
        Value::String(value) => parse_argument_text(value)?,
        value => value.clone(),
    };
    if !parsed.is_object() {
        anyhow::bail!("tool arguments must be a JSON object")
    }
    Ok(parsed)
}

fn parse_argument_text(input: &str) -> Result<Value> {
    let trimmed = input.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }
    if let Some(fenced) = strip_json_fence(trimmed)
        && let Ok(value) = serde_json::from_str(fenced)
    {
        return Ok(value);
    }
    if let Some(object) = extract_json_object(trimmed)
        && let Ok(value) = serde_json::from_str(object)
    {
        return Ok(value);
    }
    anyhow::bail!("tool arguments are not valid JSON")
}

fn strip_json_fence(input: &str) -> Option<&str> {
    let body = input.strip_prefix("```")?;
    let newline = body.find('\n')?;
    let language = body[..newline].trim();
    if !language.is_empty() && !language.eq_ignore_ascii_case("json") {
        return None;
    }
    body[newline + 1..].strip_suffix("```").map(str::trim)
}

fn extract_json_object(input: &str) -> Option<&str> {
    let bytes = input.as_bytes();
    let mut start = None;
    let mut candidate = None;
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes.iter().copied().enumerate() {
        if depth == 0 {
            if byte != b'{' {
                continue;
            }
            start = Some(offset);
            depth = 1;
            in_string = false;
            escaped = false;
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let object_start = start?;
                    let value = input.get(object_start..=offset)?;
                    if serde_json::from_str::<Map<String, Value>>(value).is_ok() {
                        if candidate.is_some() {
                            return None;
                        }
                        candidate = Some(value);
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }
    candidate
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("missing string field `{key}`"))
}

fn text_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn openai_usage(value: Option<&Value>) -> TokenUsage {
    let cache_available = value
        .and_then(|usage| usage.pointer("/prompt_tokens_details/cached_tokens"))
        .is_some();
    TokenUsage {
        input_tokens: nested_u64(value, "prompt_tokens"),
        cached_input_tokens: value
            .and_then(|usage| usage.pointer("/prompt_tokens_details/cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_observed_input_tokens: if cache_available {
            nested_u64(value, "prompt_tokens")
        } else {
            0
        },
        output_tokens: nested_u64(value, "completion_tokens"),
        cache_data_available: cache_available,
    }
}

fn anthropic_usage(value: Option<&Value>) -> TokenUsage {
    let uncached_input = nested_u64(value, "input_tokens");
    let cache_read_input = nested_u64(value, "cache_read_input_tokens");
    let cache_creation_input = nested_u64(value, "cache_creation_input_tokens");
    let cache_available = value.is_some_and(|usage| {
        usage.get("cache_read_input_tokens").is_some()
            || usage.get("cache_creation_input_tokens").is_some()
    });
    // Anthropic reports uncached, cache-read, and cache-creation input in
    // separate fields. The actual request input is their sum.
    let observed_input = uncached_input
        .saturating_add(cache_read_input)
        .saturating_add(cache_creation_input);
    TokenUsage {
        input_tokens: observed_input,
        cached_input_tokens: cache_read_input,
        cache_observed_input_tokens: if cache_available { observed_input } else { 0 },
        output_tokens: nested_u64(value, "output_tokens"),
        cache_data_available: cache_available,
    }
}

fn responses_usage(value: Option<&Value>) -> TokenUsage {
    let cache_available = value
        .and_then(|usage| usage.pointer("/input_tokens_details/cached_tokens"))
        .is_some();
    TokenUsage {
        input_tokens: nested_u64(value, "input_tokens"),
        cached_input_tokens: value
            .and_then(|usage| usage.pointer("/input_tokens_details/cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_observed_input_tokens: if cache_available {
            nested_u64(value, "input_tokens")
        } else {
            0
        },
        output_tokens: nested_u64(value, "output_tokens"),
        cache_data_available: cache_available,
    }
}

fn nested_u64(value: Option<&Value>, key: &str) -> u64 {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct IgnoreStream;

    impl ModelStreamObserver for IgnoreStream {
        fn on_text_delta(&self, _delta: &str) {}

        fn on_reasoning_delta(&self, _delta: &str) {}
    }

    #[test]
    fn rejects_non_object_tool_arguments() {
        assert!(parse_arguments(&Value::String("[]".into())).is_err());
    }

    #[test]
    fn normalizes_safe_wrappers_around_tool_arguments() {
        assert_eq!(
            parse_arguments(&Value::String(
                "```json\n{\"path\":\"README.md\"}\n```".into()
            ))
            .expect("JSON fence"),
            json!({"path": "README.md"})
        );
        assert_eq!(
            parse_arguments(&Value::String(
                "I will use these arguments: {\"path\":\"README.md\"}.".into()
            ))
            .expect("one embedded object"),
            json!({"path": "README.md"})
        );
    }

    #[test]
    fn does_not_guess_or_choose_ambiguous_tool_arguments() {
        for input in [
            "{\"path\":\"README.md\"",
            "{'path':'README.md'}",
            "prefix [1, 2] suffix",
            "first {\"a\":1} then {\"b\":2}",
        ] {
            assert!(
                parse_arguments(&Value::String(input.into())).is_err(),
                "unexpectedly accepted {input}"
            );
        }
    }

    #[test]
    fn streamed_invalid_tool_arguments_are_reported_not_executed() {
        let mut state = ChatStreamState::default();
        state
            .consume(
                &json!({
                    "choices": [{"delta": {"tool_calls": [{
                        "index": 0,
                        "id": "call-1",
                        "function": {"name": "read_file", "arguments": "{\"path\":"}
                    }]}}]
                }),
                &IgnoreStream,
            )
            .expect("consume stream delta");
        let response = state.finish().expect("finish stream");
        assert!(response.tool_calls.is_empty());
        assert_eq!(response.invalid_tool_calls.len(), 1);
        assert_eq!(response.invalid_tool_calls[0].name, "read_file");
    }

    #[test]
    fn streamed_tool_calls_accept_flattened_and_legacy_function_shapes() {
        let mut flattened = ChatStreamState::default();
        flattened
            .consume(
                &json!({
                    "choices": [{"delta": {"tool_calls": [{
                        "index": 0,
                        "id": "call-flat",
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}"
                    }]}}]
                }),
                &IgnoreStream,
            )
            .expect("consume flattened tool delta");
        let response = flattened.finish().expect("finish flattened stream");
        assert_eq!(response.tool_calls[0].name, "read_file");

        let mut legacy = ChatStreamState::default();
        legacy
            .consume(
                &json!({
                    "choices": [{"delta": {"function_call": {
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}"
                    }}}]
                }),
                &IgnoreStream,
            )
            .expect("consume legacy function delta");
        let response = legacy.finish().expect("finish legacy stream");
        assert_eq!(response.tool_calls[0].name, "read_file");
    }

    #[test]
    fn streamed_tool_call_without_name_is_protocol_error() {
        let mut state = ChatStreamState::default();
        state
            .consume(
                &json!({
                    "choices": [{"delta": {"tool_calls": [{
                        "index": 0,
                        "id": "call-missing-name",
                        "function": {"arguments": "{}"}
                    }]}}]
                }),
                &IgnoreStream,
            )
            .expect("consume malformed tool delta");
        let response = state.finish().expect("finish malformed stream");
        assert!(response.tool_calls.is_empty());
        assert_eq!(response.invalid_tool_calls[0].name, "provider_protocol_error");
        assert!(response.invalid_tool_calls[0]
            .reason
            .contains("arguments_bytes=2"));
    }

    #[test]
    fn retry_after_and_request_id_headers_are_strictly_parsed() {
        let mut headers = HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "12".parse().expect("header"));
        headers.insert("x-request-id", "req_abc-123.4".parse().expect("header"));
        assert_eq!(retry_after_ms(&headers), Some(12_000));
        assert_eq!(
            response_request_id(&headers).as_deref(),
            Some("req_abc-123.4")
        );

        headers.insert("x-request-id", "unsafe request id".parse().expect("header"));
        assert_eq!(response_request_id(&headers), None);
    }

    #[test]
    fn request_send_failures_are_retryable() {
        for kind in [
            ProviderErrorKind::Timeout,
            ProviderErrorKind::Connect,
            ProviderErrorKind::Dns,
            ProviderErrorKind::Request,
        ] {
            assert!(retryable_transport_kind(kind), "{kind:?} should retry");
        }
        assert!(!retryable_transport_kind(ProviderErrorKind::RequestBuild));
        assert!(!retryable_transport_kind(ProviderErrorKind::RequestBody));
    }

    #[test]
    fn http_error_detail_keeps_diagnostics_without_echoing_secrets() {
        let body = r#"{"error":{"code":"rate_limit_exceeded","message":"TPM exhausted for key sk-secret and https://host.test?token=secret"}}"#;
        let detail = safe_http_error_detail(429, body);
        assert!(detail.contains("rate or token limit"));
        assert!(detail.contains("rate_limit_exceeded"));
        assert!(!detail.contains("sk-secret"));
        assert!(!detail.contains("token=secret"));
    }

    #[test]
    fn stream_error_events_are_classified_and_sanitized() {
        let error = stream_event_error(
            "response_stream",
            &json!({"error": {"message": "TPM exhausted for key sk-secret"}}),
        );
        let structured = error
            .downcast_ref::<ProviderRequestError>()
            .expect("structured provider error");
        assert!(structured.retryable);
        assert!(structured.detail.contains("rate or token limit"));
        assert!(!structured.detail.contains("sk-secret"));

        let error = stream_event_error(
            "response_stream",
            &json!({"error": {"message": "invalid image_url content"}}),
        );
        let structured = error
            .downcast_ref::<ProviderRequestError>()
            .expect("structured provider error");
        assert!(!structured.retryable);
        assert!(structured.detail.contains("image_url"));
    }

    #[test]
    fn reasoning_fields_are_mapped_and_removed_for_fallback() {
        let mut chat = json!({"model": "m"});
        apply_reasoning_effort(&mut chat, Some("high"), false);
        assert_eq!(chat["reasoning_effort"], "high");
        remove_reasoning_fields(&mut chat);
        assert!(!has_reasoning_field(&chat));

        let mut responses = json!({"model": "m"});
        apply_reasoning_effort(&mut responses, Some("xhigh"), true);
        assert_eq!(responses["reasoning"], json!({"effort": "xhigh"}));
        assert!(rejects_reasoning_field(
            r#"{"error":{"message":"Unknown field reasoning.effort"}}"#
        ));

        let mut automatic = json!({"model": "m"});
        apply_reasoning_effort(&mut automatic, Some("auto"), false);
        assert!(!has_reasoning_field(&automatic));
    }

    #[test]
    fn capability_fallback_is_detected_and_removes_optional_tools() {
        assert!(rejects_model_capability(
            r#"{"error":{"code":"MODEL_CAPABILITY_NOT_SUPPORTED"}}"#
        ));
        let mut body = json!({
            "model": "m",
            "tools": [{"type": "function"}],
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "messages": []
        });
        remove_optional_capability_fields(&mut body);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert!(body.get("parallel_tool_calls").is_none());
        assert!(body.get("messages").is_some());
    }

    #[test]
    fn anthropic_cache_usage_uses_total_observed_input() {
        let value = json!({
            "input_tokens": 10_000,
            "cache_read_input_tokens": 90_000,
            "cache_creation_input_tokens": 2_000,
            "output_tokens": 500
        });
        let usage = anthropic_usage(Some(&value));
        assert_eq!(usage.input_tokens, 102_000);
        assert_eq!(usage.cached_input_tokens, 90_000);
        assert_eq!(usage.cache_observed_input_tokens, 102_000);
        assert!(usage.cache_data_available);
        assert!(usage.cached_input_tokens <= usage.cache_observed_input_tokens);
    }

    #[test]
    fn preserves_openai_tool_history() {
        let messages = vec![ChatMessage::assistant(
            "",
            vec![ToolCall {
                id: "call-1".into(),
                name: "read_file".into(),
                arguments: json!({"path": "README.md"}),
            }],
        )];
        let rendered = openai_messages(&messages, true).expect("render messages");
        assert_eq!(
            rendered[0].pointer("/tool_calls/0/function/name"),
            Some(&Value::String("read_file".into()))
        );
    }

    #[test]
    fn joins_endpoint_without_duplicate_suffix() {
        assert_eq!(
            endpoint("https://example.test/v1", "responses"),
            "https://example.test/v1/responses"
        );
        assert_eq!(
            endpoint("https://example.test/v1/responses", "responses"),
            "https://example.test/v1/responses"
        );
    }

    #[test]
    fn native_web_search_replaces_the_local_function_for_responses() {
        let tools = vec![
            coomi_engine::ToolSpec {
                name: "web_search".into(),
                description: "fallback".into(),
                parameters: json!({"type": "object"}),
            },
            coomi_engine::ToolSpec {
                name: "read_file".into(),
                description: "read".into(),
                parameters: json!({"type": "object"}),
            },
        ];
        let output = openai_responses_tools(&tools, true);
        assert_eq!(
            output
                .iter()
                .filter(|tool| tool.get("type").and_then(Value::as_str) == Some("web_search"))
                .count(),
            1
        );
        assert!(!output.iter().any(|tool| {
            tool.get("type").and_then(Value::as_str) == Some("function")
                && tool.get("name").and_then(Value::as_str) == Some("web_search")
        }));
    }

    #[test]
    fn responses_history_replays_opaque_compaction_items() {
        let item = json!({
            "id": "cmp_1",
            "type": "compaction",
            "encrypted_content": "opaque"
        });
        let input = responses_input(&[ChatMessage::provider_item(item.clone())], true, true)
            .expect("responses input");
        assert_eq!(input, vec![item]);
        assert!(
            openai_messages(
                &[ChatMessage::provider_item(json!({
                    "type": "compaction",
                    "encrypted_content": "opaque"
                }))],
                true,
            )
            .expect("chat messages")
            .is_empty()
        );
    }

    #[test]
    fn compaction_stream_preserves_encrypted_output_and_usage() {
        let mut state = CompactionStreamState::default();
        state
            .consume(&json!({
                "type": "response.output_item.done",
                "item": {
                    "id": "cmp_1",
                    "type": "compaction",
                    "encrypted_content": "opaque"
                }
            }))
            .expect("compaction item");
        state
            .consume(&json!({
                "type": "response.completed",
                "response": {"usage": {"input_tokens": 42, "output_tokens": 3}}
            }))
            .expect("usage");
        let (item, usage) = state.finish().expect("finished stream");
        assert_eq!(item["encrypted_content"], "opaque");
        assert_eq!(usage.input_tokens, 42);
        assert_eq!(usage.output_tokens, 3);
    }

    #[test]
    fn renders_structured_image_tool_outputs_for_each_provider() {
        let call = ToolCall {
            id: "call-1".into(),
            name: "view_image".into(),
            arguments: json!({"path": "image.png"}),
        };
        let mut output = ChatMessage::tool("call-1", "success: image loaded");
        output.images.push(coomi_engine::ImageContent {
            media_type: "image/png".into(),
            data: "BASE64".into(),
        });
        let history = vec![ChatMessage::assistant("", vec![call]), output];

        let responses = responses_input(&history, true, true).expect("Responses history");
        assert_eq!(responses[1]["output"][1]["type"], "output_image");
        assert_eq!(
            responses[1]["output"][1]["image_url"],
            "data:image/png;base64,BASE64"
        );

        let chat = openai_messages(&history, true).expect("Chat history");
        // tool 消息 content 保持纯字符串；图片以独立的 user 消息跟随其后
        assert_eq!(chat[1]["role"], "tool");
        assert_eq!(chat[1]["content"], "success: image loaded");
        assert_eq!(chat[2]["role"], "user");
        assert_eq!(chat[2]["content"][0]["type"], "text");
        assert_eq!(chat[2]["content"][1]["type"], "image_url");
        assert_eq!(
            chat[2]["content"][1]["image_url"]["url"],
            "data:image/png;base64,BASE64"
        );

        let (_, anthropic) = anthropic_messages(&history, true).expect("Anthropic history");
        assert_eq!(
            anthropic[1]["content"][0]["content"][1]["source"]["media_type"],
            "image/png"
        );

        let (_, gemini) = gemini_messages(&history, true).expect("Gemini history");
        assert_eq!(gemini[1]["parts"][1]["inlineData"]["mimeType"], "image/png");
    }

    #[test]
    fn strips_images_when_provider_lacks_vision() {
        // 不支持视觉的 provider：图片 part 必须被过滤，只保留纯文本工具输出，
        // 否则历史中的图片消息会反复触发 400（unknown variant `image_url`）。
        let call = ToolCall {
            id: "call-1".into(),
            name: "view_image".into(),
            arguments: json!({"path": "image.png"}),
        };
        let mut output = ChatMessage::tool("call-1", "success: image loaded");
        output.images.push(coomi_engine::ImageContent {
            media_type: "image/png".into(),
            data: "BASE64".into(),
        });
        let history = vec![ChatMessage::assistant("", vec![call]), output];

        let responses = responses_input(&history, false, true).expect("Responses history");
        assert_eq!(responses[1]["output"], "success: image loaded");

        let chat = openai_messages(&history, false).expect("Chat history");
        assert_eq!(chat[1]["content"], "success: image loaded");

        let (_, anthropic) = anthropic_messages(&history, false).expect("Anthropic history");
        assert_eq!(
            anthropic[1]["content"][0]["content"],
            "success: image loaded"
        );

        let (_, gemini) = gemini_messages(&history, false).expect("Gemini history");
        assert_eq!(
            gemini[1]["parts"]
                .as_array()
                .expect("Gemini assistant parts")
                .len(),
            1
        );
        assert!(gemini[1]["parts"][0]["inlineData"].is_null());
    }

    #[test]
    fn remote_compaction_v2_appends_one_trigger() {
        let body = remote_compaction_v2_body(
            &CompactionRequest {
                model: "test-model".into(),
                messages: vec![ChatMessage::user("checkpoint")],
                system_prompt: "instructions".into(),
                tools: vec![coomi_engine::ToolSpec {
                    name: "read_file".into(),
                    description: "Read a file".into(),
                    parameters: json!({"type": "object"}),
                }],
            },
            false,
            true,
            true,
        )
        .expect("compaction body");
        let input = body["input"].as_array().expect("input array");
        assert_eq!(
            input
                .iter()
                .filter(|item| item["type"] == "compaction_trigger")
                .count(),
            1
        );
        assert_eq!(input.last(), Some(&json!({"type": "compaction_trigger"})));
        assert_eq!(body["parallel_tool_calls"], true);
        assert_eq!(body["tools"][0]["name"], "read_file");
    }
}
