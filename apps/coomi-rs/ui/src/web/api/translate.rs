//! POST /api/catalog/translate —— 目录条目的批量中译。
//!
//! 入参 { ids: string[], target: "zh-CN" } → 返回 { id → {name, description} }。
//! 命中顺序：内置中文词表（catalogs/tools_zh.json，与前端共用同一份）→ 本地缓存
//! （{home}/catalog-translations.json，key = id|lang，LRU 上限 5000）→ 免费翻译 API
//! （MyMemory，失败退 LibreTranslate）→ 全部失败回退回原名/原描述。
//!
//! 安全约束：所有网络走 reqwest（现有依赖）+ 每次 5s 超时 + 文本长度上限；
//! 字符串只按 char 边界截断（绝不做字节切片，避开 UTF-8 边界 panic）；
//! 任何一步出错都只会让该条回退原名，绝不 panic。

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use futures_util::StreamExt;

use crate::web::ApiError;
use crate::web::AppState;

/// 每次网络翻译的独立超时（连接建好后的整个响应往返）。
const TRANSLATE_TIMEOUT: Duration = Duration::from_secs(5);
/// 单次请求允许的 id 数量上限（超出部分静默忽略）。
const MAX_IDS_PER_REQUEST: usize = 300;
/// 发给翻译 API 的单个文本长度上限（字符；truncate 按 char 边界，不做字节切片）。
const API_TEXT_CHARS: usize = 500;
/// 本地缓存 LRU 条目数上限（key = id|lang）。
const CACHE_LIMIT: usize = 5_000;
/// 免费翻译 API 的每日字符配额：用尽即停，不再发起翻译请求（剩余条目回原名）。
const DAILY_CHAR_QUOTA: usize = 10_000;
/// 并发翻译请求数上限（免费 API 需要克制，也别把单次请求拖到几分钟）。
const TRANSLATE_CONCURRENCY: usize = 4;

/// 本模块只支持一种目标语言；与内置词表、MyMemory langpair 保持一致。
const SUPPORTED_TARGET: &str = "zh-cn";

#[derive(Deserialize)]
struct TranslateRequest {
    ids: Vec<String>,
    target: String,
}

/// 一条正在等待 API 翻译的条目。
/// texts 里的每个元素是要翻译的原文；bool = true 表示它是 name（否则是 description）。
struct PendingItem {
    /// 在 results 里的下标（翻译完成后回填）。
    index: usize,
    /// 缓存键：id|lang。
    cache_key: String,
    texts: Vec<(String, bool)>,
    /// 回退用的原名/原描述。
    name: String,
    description: String,
}

/// 本地翻译缓存 + 当日配额。
struct TranslationCache {
    /// key(id|lang) → (name, description)。
    entries: HashMap<String, (String, String)>,
    /// LRU 访问顺序：队尾最新。
    order: VecDeque<String>,
    /// 配额记账日期（YYYY-MM-DD）。
    quota_date: String,
    quota_used: usize,
}

impl TranslationCache {
    fn empty() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            quota_date: String::new(),
            quota_used: 0,
        }
    }

    /// 读取 {home}/catalog-translations.json；文件缺失/损坏一律回空缓存（绝不 panic）。
    fn load(home: &Path) -> Self {
        let bytes = match std::fs::read(cache_path(home)) {
            Ok(bytes) => bytes,
            Err(_) => return Self::empty(),
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return Self::empty(),
        };
        let mut cache = Self::empty();
        if let Some(quota) = value.get("quota") {
            if let Some(date) = quota.get("date").and_then(Value::as_str) {
                cache.quota_date = date.to_owned();
            }
            cache.quota_used = quota
                .get("used_chars")
                .and_then(Value::as_u64)
                .map(|count| count as usize)
                .unwrap_or(0);
        }
        if let Some(order) = value.get("order").and_then(Value::as_array) {
            for key in order {
                if let Some(key) = key.as_str() {
                    cache.order.push_back(key.to_owned());
                }
            }
        }
        if let Some(entries) = value.get("entries").and_then(Value::as_object) {
            for (key, entry) in entries {
                let name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let description = entry
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                cache.entries.insert(key.clone(), (name, description));
            }
        }
        // LRU 上限兜底：超出部分按访问顺序从队头丢。
        while cache.order.len() > CACHE_LIMIT {
            if let Some(oldest) = cache.order.pop_front() {
                cache.entries.remove(&oldest);
            }
        }
        cache
    }

    /// 命中即视为最近使用：把键移到队尾。
    fn get(&mut self, key: &str) -> Option<(String, String)> {
        let value = self.entries.get(key).cloned()?;
        if let Some(position) = self.order.iter().position(|k| k == key)
            && let Some(moved) = self.order.remove(position)
        {
            self.order.push_back(moved);
        }
        Some(value)
    }

    fn insert(&mut self, key: String, name: String, description: String) {
        if let Some(existing) = self.entries.get_mut(&key) {
            *existing = (name, description);
            if let Some(position) = self.order.iter().position(|k| *k == key)
                && let Some(moved) = self.order.remove(position)
            {
                self.order.push_back(moved);
            }
            return;
        }
        while self.order.len() >= CACHE_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key.clone(), (name, description));
        self.order.push_back(key);
    }

    fn save(&self, home: &Path) {
        let mut entries = Map::new();
        for (key, (name, description)) in &self.entries {
            entries.insert(
                key.clone(),
                json!({ "name": name, "description": description }),
            );
        }
        let document = json!({
            "version": 1,
            "quota": { "date": self.quota_date, "used_chars": self.quota_used },
            "order": self.order.iter().collect::<Vec<_>>(),
            "entries": Value::Object(entries),
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&document) {
            let _ = std::fs::write(cache_path(home), bytes);
        }
    }
}

fn cache_path(home: &Path) -> PathBuf {
    home.join("catalog-translations.json")
}

/// 当日配额（并发翻译共享）。reserve 失败 = 配额用尽，调用方跳过该段文本。
#[derive(Clone, Default)]
struct QuotaState {
    used: usize,
}

impl QuotaState {
    fn reserve(&mut self, chars: usize) -> bool {
        let next = self.used.saturating_add(chars);
        if next > DAILY_CHAR_QUOTA {
            return false;
        }
        self.used = next;
        true
    }

    fn release(&mut self, chars: usize) {
        self.used = self.used.saturating_sub(chars);
    }
}

/// POST /api/catalog/translate
pub(in crate::web) async fn catalog_translate(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let request: TranslateRequest = serde_json::from_value(body)
        .map_err(|error| ApiError::bad_request(format!("请求体不合法：{error}")))?;
    let target = request.target.trim().to_ascii_lowercase();
    if target != SUPPORTED_TARGET {
        return Err(ApiError::bad_request(
            "target 目前只支持 zh-CN（词表与翻译 API 都只挂了这一对语言）",
        ));
    }
    // 去重（大小写不敏感）并限长。
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in request.ids {
        let id = raw.trim();
        if id.is_empty() {
            continue;
        }
        if seen.insert(id.to_ascii_lowercase()) {
            ids.push(id.to_owned());
        }
        if ids.len() >= MAX_IDS_PER_REQUEST {
            break;
        }
    }
    if ids.is_empty() {
        return Err(ApiError::bad_request("ids 不能为空"));
    }

    let dict = coomi_catalogs::builtin_translation()
        .map_err(|error| ApiError::internal(format!("内置词表不可用：{error}")))?;

    let mut cache = TranslationCache::load(&state.home);
    let today = today_local();
    if cache.quota_date != today {
        cache.quota_date = today.clone();
        cache.quota_used = 0;
    }

    let client = reqwest::Client::builder()
        .connect_timeout(TRANSLATE_TIMEOUT)
        .user_agent("coomi-translate")
        .build()
        .map_err(|error| ApiError::internal(format!("failed to build HTTP client: {error}")))?;
    let registry = registry_snapshot(&state);

    let mut results: Vec<(String, String)> = Vec::with_capacity(ids.len());
    let mut pending: Vec<PendingItem> = Vec::new();
    for id in &ids {
        let lower = id.to_ascii_lowercase();
        let cache_key = format!("{lower}|{target}");
        // 1) 内置词表（与前端同一份）。
        if let Some(entry) = dict.get(&lower) {
            results.push((entry.name.clone(), entry.description.clone()));
            continue;
        }
        // 2) 本地缓存。
        if let Some((name, description)) = cache.get(&cache_key) {
            results.push((name, description));
            continue;
        }
        // 3) 需要翻译：先解析原文（内置目录 / 远端 registry / 兜底取 id 本身）。
        let (name, description, description_is_zh) = resolve_source(id, &registry);
        let name_needed = !name.trim().is_empty() && !contains_cjk(&name);
        let description_needed =
            !description.trim().is_empty() && !description_is_zh && !contains_cjk(&description);
        if !name_needed && !description_needed {
            // 原文已经可用（中文或空），不需要调 API。
            results.push((name, description));
            continue;
        }
        let mut texts: Vec<(String, bool)> = Vec::new();
        if name_needed {
            texts.push((truncate_chars(&name, API_TEXT_CHARS), true));
        }
        if description_needed {
            texts.push((truncate_chars(&description, API_TEXT_CHARS), false));
        }
        let index = results.len();
        results.push((name.clone(), description.clone())); // 占位，成功后替换
        pending.push(PendingItem {
            index,
            cache_key,
            texts,
            name,
            description,
        });
    }

    if !pending.is_empty() {
        let quota = Arc::new(StdMutex::new(QuotaState { used: cache.quota_used }));
        let stopped = Arc::new(AtomicBool::new(false));
        let stream = futures_util::stream::iter(pending.into_iter().map(|item| {
            let client = client.clone();
            let quota = Arc::clone(&quota);
            let stopped = Arc::clone(&stopped);
            async move {
                let translations =
                    translate_batch(&client, &quota, &stopped, &item.texts).await;
                (item, translations)
            }
        }));
        let outcomes = stream
            .buffer_unordered(TRANSLATE_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let mut changed = false;
        for (item, translations) in outcomes {
            let Some(translations) = translations else { continue };
            let mut translated_name = item.name;
            let mut translated_description = item.description;
            for ((_raw, is_name), value) in item.texts.into_iter().zip(translations.into_iter()) {
                let value = value.trim().to_owned();
                if is_name {
                    translated_name = value;
                } else {
                    translated_description = value;
                }
            }
            // 原样回填；缓存里存翻译结果，下次直接命中。
            results[item.index] = (translated_name.clone(), translated_description.clone());
            cache.insert(item.cache_key, translated_name, translated_description);
            changed = true;
        }
        if changed {
            cache.quota_used = quota.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).used;
            cache.save(&state.home);
        }
    }

    let mut map = Map::new();
    for (id, (name, description)) in ids.into_iter().zip(results.into_iter()) {
        map.insert(id, json!({ "name": name, "description": description }));
    }
    Ok(Json(Value::Object(map)))
}

/// 并发批翻译：先整体预留配额，翻译失败或中途停用时释放并回退原文。
/// 返回 None = 本轮配额已尽（或无文本可翻），调用方保持原文。
async fn translate_batch(
    client: &reqwest::Client,
    quota: &StdMutex<QuotaState>,
    stopped: &AtomicBool,
    texts: &[(String, bool)],
) -> Option<Vec<String>> {
    if texts.is_empty() || stopped.load(Ordering::SeqCst) {
        return None;
    }
    let total: usize = texts.iter().map(|(text, _)| text.chars().count()).sum();
    let reserved = {
        let mut state = quota.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.reserve(total)
    };
    if !reserved {
        return None;
    }
    let mut out = Vec::with_capacity(texts.len());
    for (text, _) in texts {
        if stopped.load(Ordering::SeqCst) {
            quota
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .release(text.chars().count());
            out.push(text.clone());
            continue;
        }
        match translate_text(client, &stopped, text).await {
            Ok(translated) => out.push(translated),
            Err(()) => {
                // 失败不占配额：把预留的字符还回去。
                quota
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .release(text.chars().count());
                out.push(text.clone());
            }
        }
    }
    Some(out)
}

/// 翻译一段文本：MyMemory 优先，失败（或返回原样）退 LibreTranslate。
/// Err = 两个服务都失败，调用方回退原文。
async fn translate_text(
    client: &reqwest::Client,
    stopped: &AtomicBool,
    text: &str,
) -> Result<String, ()> {
    let query = truncate_chars(text, API_TEXT_CHARS);
    if query.is_empty() {
        return Ok(String::new());
    }
    // 1) MyMemory（免费匿名接口，无需密钥）。
    let url = format!(
        "https://api.mymemory.translated.net/get?q={}&langpair=en%7Czh-CN",
        percent_encode(&query)
    );
    let request = client.get(&url).timeout(TRANSLATE_TIMEOUT);
    if let Ok(response) = request.send().await
        && response.status().is_success()
        && let Ok(value) = response.json::<Value>().await
    {
        // 服务端每日匿名配额耗尽：本日其余翻译全部停发。
        if value.get("quotaFinished").and_then(Value::as_bool).unwrap_or(false) {
            stopped.store(true, Ordering::SeqCst);
        }
        if let Some(translated) = value
            .pointer("/responseData/translatedText")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| !same_text(value, &query))
        {
            return Ok(translated.to_owned());
        }
    }
    // 2) LibreTranslate 兜底（form 编码，q/source/target/format）。
    let form = [
        ("q", query.as_str()),
        ("source", "en"),
        ("target", "zh"),
        ("format", "text"),
    ];
    let request = client
        .post("https://libretranslate.com/translate")
        .form(&form)
        .timeout(TRANSLATE_TIMEOUT);
    if let Ok(response) = request.send().await
        && response.status().is_success()
        && let Ok(value) = response.json::<Value>().await
        && let Some(translated) = value
            .get("translatedText")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| !same_text(value, &query))
    {
        return Ok(translated.to_owned());
    }
    Err(())
}

/// 解析某 id 的原文（英文名/描述），返回 (name, description, description_is_zh)。
/// 内置 MCP 条目的描述本来就是中文（描述不需要翻）；远端 registry 条目按 id 匹配。
fn resolve_source(id: &str, registry: &Value) -> (String, String, bool) {
    if let Ok(catalog) = coomi_catalogs::builtin_mcp() {
        if let Some(entry) = catalog.entries.iter().find(|entry| entry.id.eq_ignore_ascii_case(id)) {
            return (entry.name.clone(), entry.description.clone(), true);
        }
    }
    if let Ok(catalog) = coomi_catalogs::builtin_skills() {
        if let Some(entry) = catalog.entries.iter().find(|entry| entry.id.eq_ignore_ascii_case(id)) {
            return (entry.name.clone(), entry.description.clone(), false);
        }
    }
    if let Some(registry) = registry.get("registry") {
        for section in ["skills", "mcps", "mcp"] {
            if let Some(list) = registry.get(section).and_then(Value::as_array) {
                for item in list {
                    let matches = item
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| value.eq_ignore_ascii_case(id));
                    if matches {
                        let name = item
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or(id)
                            .to_owned();
                        let description = item
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        return (name, description, false);
                    }
                }
            }
        }
    }
    // 完全未知的 id：把 id 本身当原名，不翻描述。
    (id.to_owned(), String::new(), false)
}

/// 远端市场数据快照：读 {home}/cache/registry.json（内存缓存是 registry 接口的私货，
/// 这里直接落盘读取同样一份；拿不到返回 Null，翻译只是少了一个原文来源）。
fn registry_snapshot(state: &AppState) -> Value {
    let path = state.home.join("cache").join("registry.json");
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 按字符边界截断（永远不碰字节切片）。
fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// 是否已含 CJK 字符（视为已中文化，无需再翻）。
fn contains_cjk(text: &str) -> bool {
    text.chars().any(|character| {
        ('\u{4e00}'..='\u{9fff}').contains(&character)
            || ('\u{3400}'..='\u{4dbf}').contains(&character)
    })
}

/// 宽松相等：去掉首尾空白后忽略大小写比较（MyMemory 偶尔原样回显输入）。
fn same_text(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

/// 极简 percent-encoding：只保留 unreserved 字符，其余按 UTF-8 字节 %XX 编码。
fn percent_encode(input: &str) -> String {
    let mut output = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, 45 | 95 | 46 | 126) {
            // 45=-(hyphen) 95=_(underscore) 46=.(dot) 126=~(tilde)：unreserved 的 ASCII 码。
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}
