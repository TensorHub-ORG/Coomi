//! 镜像源设置与测速。
//!
//! - GET  /api/settings/mirrors —— 统一契约 {kinds:{github,npm,pip,docker},custom,updatedAt}：
//!   每类 = {active,effective,count,items:[{id,label,url,type,enabled,custom}]}；
//!   同时保留旧字段（mirrors / builtin / effective）与扁平清单（sources / items / active），
//!   旧形状把 mirrors 写成对象、前端整块读不到，扁平清单让只认数组的前端也能拿到源。
//! - PUT  /api/settings/mirrors —— **部分更新**（新增 / 删除 / 启停 / 排序 / 切 active），
//!   返回归一化后的完整 payload；支持 kinds、平铺四类、{"type":"npm",..}、{"mirrors":{..}}、
//!   {"mirrors":[...]}（整表回传）与 {"custom":[...]} 六种形状。
//! - POST /api/runtime/mirror-test {type,url} —— 单条镜像测速：
//!   GitHub 前缀发 Range 前 1KB、npm 打 /-/ping、pip 打索引根、docker 打 /v2/；
//!   3s 超时、两次取中位数，返回 {ok,ttfb_ms,status,error}。
//!
//! 这里只测速与存配置：真正把镜像以环境变量注入子进程的是 services 的 mirrors 模块，
//! 两条路径共用同一份生效规则（active 指向的条目且该条目 enabled）。

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::io::Read;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

use crate::web::ApiError;
use crate::web::AppState;
use coomi_services::MirrorEntry;
use coomi_services::MirrorKind;
use coomi_services::MirrorsSettings;
use coomi_services::OFFICIAL_ID;
use coomi_services::apply_github_prefix;
use coomi_services::builtin_mirrors;
use coomi_services::load_mirrors;
use coomi_services::merge_into_settings;
use coomi_services::normalize_mirrors;

/// 测速超时（单次）：连接 + 首字节。
const MIRROR_TEST_TIMEOUT: Duration = Duration::from_secs(3);
/// 测速次数：两次取中位数（一次抖动不决定结论）。
const MIRROR_TEST_ATTEMPTS: usize = 2;
/// GitHub 前缀的探测目标：就用装 winget 的那个脚本（真实存在、体积小）。
const GITHUB_PROBE_URL: &str =
    "https://github.com/asheroto/winget-install/releases/latest/download/winget-install.ps1";
/// Range 探测读取的字节数。
const RANGE_PROBE_BYTES: usize = 1024;

/// GET /api/settings/mirrors
pub(in crate::web) async fn mirrors_get(State(state): State<AppState>) -> Json<Value> {
    Json(mirror_payload(&state.home))
}

/// PUT /api/settings/mirrors —— 部分更新，返回归一化后的完整 payload。
///
/// 语义：只覆盖 body 里出现的类；items 按 id upsert（同 id 覆盖，新 id 追加），
/// remove: ["id"] 删自定义条目，order: ["id"] 排序，replace: true 表示「这份清单就是全部」
/// （前端整表回传时用它，缺的自定义条目会被删掉）——内置条目只能 enabled=false 停用。
/// 形状见 extract_patch 的文档。
pub(in crate::web) async fn mirrors_put(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let patch = extract_patch(&body)?;
    let current = load_mirrors(&state.home);
    let patched = apply_patch(&current, &patch);
    let settings = crate::web::read_settings(&state.home);
    crate::web::write_settings(&state.home, &merge_into_settings(&settings, &patched))?;
    Ok(Json(mirror_payload(&state.home)))
}

/// 一条镜像 → 线上形状 {id,label,url,type,enabled,custom}（另给 official / builtin 兼容键）。
fn item_payload(entry: &MirrorEntry, builtin_ids: &[String]) -> Value {
    let custom = !builtin_ids
        .iter()
        .any(|id| id.eq_ignore_ascii_case(&entry.id));
    json!({
        "id": entry.id,
        "label": entry.label,
        "url": entry.url,
        "type": entry.kind.as_str(),
        "enabled": entry.enabled,
        "custom": custom,
        "builtin": !custom,
        "official": entry.id.eq_ignore_ascii_case(OFFICIAL_ID),
    })
}

/// settings.json 的修改时间（RFC3339）；还没写过就用当前时间。
fn updated_at(home: &Path) -> String {
    std::fs::metadata(home.join("config").join("settings.json"))
        .and_then(|meta| meta.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now())
        .to_rfc3339()
}

/// 读取 settings.json → mirrors，输出统一契约 + 生效状态。
fn mirror_payload(home: &Path) -> Value {
    let mirrors = load_mirrors(home);
    let builtin = builtin_mirrors();
    let env = mirrors.env();

    let mut kinds = Map::new();
    let mut custom: Vec<Value> = Vec::new();
    let mut flat: Vec<Value> = Vec::new();
    let mut active_map = Map::new();
    let mut effective_map = Map::new();
    for kind in MirrorKind::ALL {
        let group = mirrors.group(kind);
        let builtin_ids = builtin
            .group(kind)
            .items
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        let items = group
            .items
            .iter()
            .map(|entry| item_payload(entry, &builtin_ids))
            .collect::<Vec<_>>();
        for item in &items {
            if item.get("custom").and_then(Value::as_bool).unwrap_or(false) {
                custom.push(item.clone());
            }
        }
        flat.extend(items.iter().cloned());
        let effective = mirrors.effective(kind).map(|entry| entry.id.clone());
        active_map.insert(kind.as_str().to_owned(), json!(group.active));
        effective_map.insert(
            kind.as_str().to_owned(),
            effective.clone().map(Value::String).unwrap_or(Value::Null),
        );
        kinds.insert(
            kind.as_str().to_owned(),
            json!({
                "active": group.active,
                "effective": effective,
                "count": items.len(),
                "items": items,
            }),
        );
    }
    let updated_at = updated_at(home);
    json!({
        // 统一契约：前端按 kinds / custom / updatedAt 渲染。
        "kinds": Value::Object(kinds),
        "custom": custom,
        "updatedAt": updated_at.clone(),
        "updated_at": updated_at,
        // 兼容旧字段：老前端与脚本读 mirrors（settings 原文）/ builtin / effective。
        "mirrors": mirrors.to_value(),
        "builtin": builtin.to_value(),
        "effective": {
            "active": Value::Object(active_map.clone()),
            "effective": Value::Object(effective_map),
            "github_prefix": mirrors.github_prefix(),
            "npm_registry": env.get("npm_config_registry"),
            "pip_index_url": env.get("PIP_INDEX_URL"),
            "docker_registry": mirrors.docker_registry(),
            // 启动 MCP / 安装任务时，这些键会原样注入子进程环境。
            "env": env,
        },
        "env_keys": ["npm_config_registry", "PIP_INDEX_URL", "UV_INDEX_URL"],
        "note": "只影响引擎拉起的子进程（MCP / 安装任务），不改用户的全局 npm/pip 配置；docker registry 镜像需自行写入 daemon.json。",
        // 兼容扁平清单：前端 parseSnapshot 认 mirrors / sources / items 三种数组键。
        "sources": flat.clone(),
        "items": flat,
        "active": Value::Object(active_map.clone()),
        "activeByKind": Value::Object(active_map),
    })
}

/// PUT body → 分类型的 patch（只改 body 里出现的类，别的类原样保留）。
///
/// 支持六种写法：
/// 1. 统一契约：{"kinds": {"npm": {"active":"...","items":[...],"remove":[...],"order":[...]}}}
/// 2. 平铺四类：{"github": {...}, "npm": {...}}（也接受包在 {"mirrors": {...}} 里）
/// 3. 单类：{"type": "npm", "active": "..."}（kind / kind 别名同样可）
/// 4. 整表回传：{"mirrors": [{id,label,url,type,enabled}, ...], "active": {"npm": "id"}}
///    —— 清单里没有的自定义条目会被删掉，顺序以数组为准（前端的上移/下移/删除就这么发）
/// 5. 追加自定义源：{"custom": [{type: "pip", ...}]}
/// 6. 裸数组：[{id,label,url,type,enabled}, ...]（等价于 4 但不带 active）
fn extract_patch(body: &Value) -> Result<Value, ApiError> {
    let mut patch: Map<String, Value> = Map::new();

    if let Some(items) = body.as_array() {
        snapshot_into(&mut patch, items, None)?;
        return finish_patch(patch);
    }
    let Some(object) = body.as_object() else {
        return Err(ApiError::bad_request(
            "mirrors 配置必须是一个 JSON 对象或条目数组",
        ));
    };

    // ① kinds：统一契约形状。
    if let Some(kinds) = object.get("kinds") {
        let kinds = kinds.as_object().ok_or_else(|| {
            ApiError::bad_request("kinds 必须是一个对象（github / npm / pip / docker）")
        })?;
        merge_kind_map(&mut patch, kinds, "kinds")?;
    }
    // ② mirrors：对象 = 按类 patch；数组 = 整份清单回传。
    match object.get("mirrors") {
        Some(Value::Array(items)) => {
            snapshot_into(&mut patch, items, active_map(object).as_ref())?;
        }
        Some(Value::Object(groups)) => merge_kind_map(&mut patch, groups, "mirrors")?,
        Some(_) => {
            return Err(ApiError::bad_request(
                "mirrors 必须是对象（按类 patch）或数组（整份清单）",
            ));
        }
        None => {}
    }
    // ③ 平铺四类：{"npm": {...}}。
    for kind in MirrorKind::ALL {
        if let Some(group) = object.get(kind.as_str()) {
            merge_group_patch(&mut patch, kind, group)?;
        }
    }
    // ④ 单类写法：{"type": "npm", "active": ...}。
    let single = object
        .get("type")
        .or_else(|| object.get("kind"))
        .and_then(Value::as_str)
        .and_then(MirrorKind::parse);
    if let Some(kind) = single {
        merge_group_patch(&mut patch, kind, body)?;
    }
    // ⑤ 自定义源：{"custom": [{type:"pip", ...}]}。
    if let Some(custom) = object.get("custom") {
        let items = custom
            .as_array()
            .ok_or_else(|| ApiError::bad_request("custom 必须是条目数组"))?;
        custom_into(&mut patch, items)?;
    }
    finish_patch(patch)
}

/// 空 patch 直接报错：与其「保存成功但什么都没改」，不如说清楚能传什么。
fn finish_patch(patch: Map<String, Value>) -> Result<Value, ApiError> {
    if patch.is_empty() {
        return Err(ApiError::bad_request(
            "body 里没有任何镜像分类：请给出 github / npm / pip / docker（或 kinds / mirrors / custom）",
        ));
    }
    Ok(Value::Object(patch))
}

/// 把 {github:{...}, npm:{...}} 这种「按类」对象合并进 patch。
fn merge_kind_map(
    patch: &mut Map<String, Value>,
    groups: &Map<String, Value>,
    origin: &str,
) -> Result<(), ApiError> {
    for (name, group) in groups {
        let kind = MirrorKind::parse(name).ok_or_else(|| {
            ApiError::bad_request(format!(
                "{origin}.{name} 不是镜像分类：只能是 github / npm / pip / docker"
            ))
        })?;
        merge_group_patch(patch, kind, group)?;
    }
    Ok(())
}

/// 合并一类的 patch：只认 active / items / remove / order / replace，
/// 其余键一律忽略（前端会把整条 item 原样带回来，多余键不该报错）。
fn merge_group_patch(
    patch: &mut Map<String, Value>,
    kind: MirrorKind,
    raw: &Value,
) -> Result<(), ApiError> {
    let group = raw.as_object().ok_or_else(|| {
        ApiError::bad_request(format!(
            "mirrors.{} 必须是一个对象（active / items / remove / order）",
            kind.as_str()
        ))
    })?;
    let slot = group_slot(patch, kind);
    for key in ["active", "items", "remove", "order", "replace"] {
        if let Some(value) = group.get(key) {
            slot.insert(key.to_owned(), value.clone());
        }
    }
    Ok(())
}

/// 整份清单 → 每类一个 {items, replace:true}：顺序以数组为准，缺的自定义条目删掉。
/// 条目按自己的 type / kind 归类；认不出类型的跳过（宁可不改，也不塞错类）。
fn snapshot_into(
    patch: &mut Map<String, Value>,
    items: &[Value],
    active: Option<&Map<String, Value>>,
) -> Result<(), ApiError> {
    for item in items {
        let kind = item
            .get("type")
            .or_else(|| item.get("kind"))
            .and_then(Value::as_str)
            .and_then(MirrorKind::parse);
        let Some(kind) = kind else {
            continue;
        };
        let slot = group_slot(patch, kind);
        slot.insert("replace".to_owned(), json!(true));
        let entry = slot
            .entry("items".to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(list) = entry.as_array_mut() {
            list.push(item.clone());
        }
    }
    if let Some(active) = active {
        for (name, value) in active {
            let Some(kind) = MirrorKind::parse(name) else {
                continue;
            };
            let id = value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default();
            group_slot(patch, kind).insert("active".to_owned(), json!(id));
        }
    }
    Ok(())
}

/// 追加入自定义源（meta 里带 type 的条目列表）。
fn custom_into(patch: &mut Map<String, Value>, items: &[Value]) -> Result<(), ApiError> {
    for item in items {
        match item
            .get("type")
            .or_else(|| item.get("kind"))
            .and_then(Value::as_str)
            .and_then(MirrorKind::parse)
        {
            Some(kind) => {
                let slot = group_slot(patch, kind);
                let entry = slot
                    .entry("items".to_owned())
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(list) = entry.as_array_mut() {
                    list.push(item.clone());
                }
            }
            None => {
                return Err(ApiError::bad_request(
                    "custom 里的每一条都要带 type：github / npm / pip / docker",
                ));
            }
        }
    }
    Ok(())
}

/// 活动指针对象：{"active": {...}} 或 {"activeByKind": {...}}。
fn active_map(object: &Map<String, Value>) -> Option<Map<String, Value>> {
    for key in ["active", "activeByKind", "active_by_kind", "current"] {
        if let Some(map) = object.get(key).and_then(Value::as_object) {
            return Some(map.clone());
        }
    }
    None
}

/// 取（或建）某一类的 patch 槽位。
fn group_slot(patch: &mut Map<String, Value>, kind: MirrorKind) -> &mut Map<String, Value> {
    let slot = patch
        .entry(kind.as_str().to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut()
        .expect("mirror group patch slot must be an object")
}

/// 把 patch 应用到当前配置：从「当前生效配置」起算（而不是从内置清单起算），
/// 这样自定义条目、enabled 开关与 active 指针都不会被下一次 PUT 抹掉。
///
/// 两种语义分得很清：
/// - 部分更新（默认）：items 是 upsert，追加到现有清单之后，已有顺序不动；
/// - 整表回传（replace:true）：清单就是权威内容与顺序，不在表里的自定义条目删掉
///   （内置条目由 services 保留，只能 enabled=false 停用）。
fn apply_patch(current: &MirrorsSettings, patch: &Value) -> MirrorsSettings {
    let stored = merge_into_settings(&json!({}), current);
    let mut combined = stored.get("mirrors").cloned().unwrap_or_else(|| json!({}));
    if let (Some(target), Some(source)) = (combined.as_object_mut(), patch.as_object()) {
        for (kind, group) in source {
            let Some(group) = group.as_object() else {
                continue;
            };
            let replace = group.get("replace").and_then(Value::as_bool).unwrap_or(false);
            let added = group.get("items").and_then(Value::as_array);
            let mut merged = target
                .get(kind)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match (replace, added) {
                // 整表：内容与顺序都以这次给的表为准。
                (true, Some(items)) => {
                    merged.insert("items".to_owned(), Value::Array(items.clone()));
                    merged.insert("replace".to_owned(), json!(true));
                }
                // 部分更新：现有清单在前，新增（或同 id 覆盖）的在后。
                (false, Some(items)) => {
                    let mut list = merged
                        .get("items")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    list.extend(items.iter().cloned());
                    merged.insert("items".to_owned(), Value::Array(list));
                }
                _ => {}
            }
            for key in ["active", "remove", "order"] {
                if let Some(value) = group.get(key) {
                    merged.insert(key.to_owned(), value.clone());
                }
            }
            target.insert(kind.clone(), Value::Object(merged));
        }
    }
    normalize_mirrors(&combined)
}

// ── 测速 ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub(in crate::web) struct MirrorTestRequest {
    /// github / npm / pip（pip-uv）/ docker；pip 与 uv 同源。
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    url: String,
    /// 可选：直接指定探测目标（默认按类型推导）。
    #[serde(default)]
    target: Option<String>,
}

/// 一次测速要打的地址与判定规则。
#[derive(Clone, Debug, PartialEq)]
struct ProbeTarget {
    url: String,
    /// 是否带 Range: bytes=0-1023（GitHub 前缀流量通常几十 MB，只取前 1KB）。
    range: bool,
    ok_statuses: &'static [u16],
}

/// POST /api/runtime/mirror-test {type,url}
pub(in crate::web) async fn mirror_test(
    Json(request): Json<MirrorTestRequest>,
) -> Result<Json<Value>, ApiError> {
    let kind = MirrorKind::parse(&request.kind)
        .ok_or_else(|| ApiError::bad_request("type 必须是 github / npm / pip / docker 之一"))?;
    let target = probe_target(kind, &request.url, request.target.as_deref())?;
    let result = tokio::task::spawn_blocking({
        let target = target.clone();
        move || run_probe(&target)
    })
    .await
    .map_err(|error| ApiError::internal(format!("mirror test task failed: {error}")))?;
    let error = result.error.clone();
    Ok(Json(json!({
        "ok": result.ok,
        "ttfb_ms": result.ttfb_ms,
        "status": result.status,
        "error": error,
        "type": kind.as_str(),
        "url": request.url.trim(),
        "target": target.url,
        "range": target.range,
        "bytes": result.bytes,
        "attempts": MIRROR_TEST_ATTEMPTS,
        "samples_ms": result.samples_ms,
        "timeout_ms": MIRROR_TEST_TIMEOUT.as_millis() as u64,
    })))
}

/// 按类型推导探测目标：GitHub 前缀拼脚本地址、npm 打 /-/ping、pip 打索引根、docker 打 /v2/。
fn probe_target(kind: MirrorKind, url: &str, target: Option<&str>) -> Result<ProbeTarget, ApiError> {
    let url = url.trim();
    if let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(ProbeTarget {
            url: target.to_owned(),
            range: matches!(kind, MirrorKind::Github),
            ok_statuses: ok_statuses(kind),
        });
    }
    if url.is_empty() {
        return Err(ApiError::bad_request("missing url"));
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(ApiError::bad_request("url 必须是 http(s) 地址"));
    }
    let trimmed = url.trim_end_matches('/');
    let probe = match kind {
        MirrorKind::Github => {
            // 官方条目（https://github.com）不加前缀：直连探测。
            let prefix = (!trimmed.eq_ignore_ascii_case("https://github.com")).then_some(trimmed);
            ProbeTarget {
                url: apply_github_prefix(prefix, GITHUB_PROBE_URL),
                range: true,
                ok_statuses: &[200, 206],
            }
        }
        MirrorKind::Npm => ProbeTarget {
            url: format!("{trimmed}/-/ping"),
            range: false,
            ok_statuses: &[200],
        },
        // pip / uv：索引根本身（simple 索引按目录语义解析，尾斜杠必须有）。
        MirrorKind::Pip => ProbeTarget {
            url: format!("{trimmed}/"),
            range: false,
            ok_statuses: &[200],
        },
        MirrorKind::Docker => ProbeTarget {
            url: format!("{trimmed}/v2/"),
            range: false,
            // registry 对未认证请求回 401 是正常的「服务活着」。
            ok_statuses: &[200, 401, 403],
        },
    };
    Ok(probe)
}

fn ok_statuses(kind: MirrorKind) -> &'static [u16] {
    match kind {
        MirrorKind::Github => &[200, 206],
        MirrorKind::Npm | MirrorKind::Pip => &[200],
        MirrorKind::Docker => &[200, 401, 403],
    }
}

/// 单次探测结果。
#[derive(Clone, Debug, Default)]
struct ProbeRun {
    ok: bool,
    ttfb_ms: Option<u64>,
    status: Option<u16>,
    error: Option<String>,
    bytes: usize,
    samples_ms: Vec<u64>,
}

/// 两次探测取中位数：两次都成功取均值（两次的中位数），一次成功用那一次。
fn run_probe(target: &ProbeTarget) -> ProbeRun {
    let client = match reqwest::blocking::Client::builder()
        .timeout(MIRROR_TEST_TIMEOUT)
        .user_agent("coomi-mirror-test")
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return ProbeRun {
                error: Some(format!("无法创建 HTTP 客户端：{error}")),
                ..ProbeRun::default()
            };
        }
    };
    let mut run = ProbeRun::default();
    for _ in 0..MIRROR_TEST_ATTEMPTS {
        let attempt = attempt(&client, target);
        if let Some(sample) = attempt.ttfb_ms.filter(|_| attempt.ok) {
            run.samples_ms.push(sample);
        }
        // 以最后一次的结果为准：失败信息要能覆盖前一次的失败原因。
        run.status = attempt.status;
        run.bytes = attempt.bytes;
        if !attempt.ok {
            run.error = attempt.error;
        }
    }
    if run.samples_ms.is_empty() {
        if run.error.is_none() {
            run.error = Some("镜像没有在超时时间内返回首字节".to_owned());
        }
        return run;
    }
    run.ttfb_ms = Some(median_ms(&run.samples_ms));
    run.ok = true;
    run.error = None;
    run
}

/// 一次 HTTP 探测：首字节耗时（ttfb）+ 状态码 + 读到的字节数。
fn attempt(client: &reqwest::blocking::Client, target: &ProbeTarget) -> ProbeRun {
    let mut request = client.get(&target.url);
    if target.range {
        request = request.header(reqwest::header::RANGE, format!("bytes=0-{}", RANGE_PROBE_BYTES - 1));
    }
    let started = Instant::now();
    let response = match request.send() {
        Ok(response) => response,
        Err(error) => {
            return ProbeRun {
                error: Some(describe_error(&error, target)),
                ..ProbeRun::default()
            };
        }
    };
    let ttfb = started.elapsed();
    let status = response.status().as_u16();
    let mut response = response;
    let mut buffer = [0u8; RANGE_PROBE_BYTES];
    let bytes = response.read(&mut buffer).unwrap_or_default();
    ProbeRun {
        ok: target.ok_statuses.contains(&status),
        ttfb_ms: Some(ttfb.as_millis().min(u128::from(u64::MAX)) as u64),
        status: Some(status),
        error: (!target.ok_statuses.contains(&status)).then(|| format!("HTTP {status}")),
        bytes,
        samples_ms: Vec::new(),
    }
}

/// 把 reqwest 的错误翻成用户能看懂的一句话（超时 / 连接失败 / TLS）。
fn describe_error(error: &reqwest::Error, target: &ProbeTarget) -> String {
    if error.is_timeout() {
        return format!(
            "{}s 内没有响应（超时）：{}",
            MIRROR_TEST_TIMEOUT.as_secs(),
            target.url
        );
    }
    if error.is_connect() {
        return format!("连接失败：{}（{}）", target.url, error);
    }
    format!("请求失败：{error}")
}

/// 中位数：奇数取中间值，偶数取中间两个的均值（两次测速即取平均）。
fn median_ms(samples: &[u64]) -> u64 {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    match sorted.len() {
        0 => 0,
        1 => sorted[0],
        len if len % 2 == 1 => sorted[len / 2],
        len => (sorted[len / 2 - 1] + sorted[len / 2]) / 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_targets_follow_the_documented_shapes() {
        let github = probe_target(MirrorKind::Github, "https://gh-proxy.com/", None).expect("github");
        assert!(github.range, "github prefix probe must use a Range request");
        assert_eq!(
            github.url,
            format!("https://gh-proxy.com/{GITHUB_PROBE_URL}")
        );
        // 官方条目不加前缀。
        let official = probe_target(MirrorKind::Github, "https://github.com", None).expect("github");
        assert_eq!(official.url, GITHUB_PROBE_URL);

        let npm = probe_target(MirrorKind::Npm, "https://registry.npmmirror.com", None).expect("npm");
        assert_eq!(npm.url, "https://registry.npmmirror.com/-/ping");
        assert!(!npm.range);

        let pip = probe_target(MirrorKind::Pip, "https://pypi.tuna.tsinghua.edu.cn/simple/", None)
            .expect("pip");
        assert_eq!(pip.url, "https://pypi.tuna.tsinghua.edu.cn/simple/");

        let docker = probe_target(MirrorKind::Docker, "https://hub-mirror.c.163.com", None)
            .expect("docker");
        assert_eq!(docker.url, "https://hub-mirror.c.163.com/v2/");
        assert!(docker.ok_statuses.contains(&401));
    }

    #[test]
    fn probe_target_rejects_bad_input_and_accepts_an_explicit_target() {
        assert!(probe_target(MirrorKind::Npm, "", None).is_err());
        assert!(probe_target(MirrorKind::Npm, "ftp://example.com", None).is_err());
        assert!(probe_target(MirrorKind::Npm, "   ", None).is_err());
        let explicit =
            probe_target(MirrorKind::Pip, "https://ignored", Some("https://x.example/simple")).expect("target");
        assert_eq!(explicit.url, "https://x.example/simple");
    }

    #[test]
    fn median_of_two_samples_is_their_average() {
        assert_eq!(median_ms(&[120, 126]), 123);
        assert_eq!(median_ms(&[300]), 300);
        assert_eq!(median_ms(&[30, 10, 20]), 20);
        assert_eq!(median_ms(&[]), 0);
    }

    #[test]
    fn extract_patch_accepts_three_shapes_and_rejects_junk() {
        let flat = extract_patch(&json!({"npm": {"active": "huawei"}})).expect("flat");
        assert_eq!(flat["npm"]["active"], json!("huawei"));
        let wrapped = extract_patch(&json!({"mirrors": {"pip": {"active": "official"}}})).expect("wrapped");
        assert_eq!(wrapped["pip"]["active"], json!("official"));
        let single = extract_patch(&json!({"type": "docker", "active": "netease"})).expect("single");
        assert_eq!(single["docker"]["active"], json!("netease"));
        assert!(extract_patch(&json!({"nothing": 1})).is_err());
        assert!(extract_patch(&json!({"npm": 3})).is_err());
    }

    #[test]
    fn patch_keeps_custom_entries_and_toggles_enabled() {
        let home = tempfile::tempdir().expect("temporary home");
        let mut current = load_mirrors(home.path());
        current.pip.items.push(coomi_services::MirrorEntry {
            id: "corp".to_owned(),
            label: "公司内网".to_owned(),
            url: "https://pypi.corp.example/simple/".to_owned(),
            kind: MirrorKind::Pip,
            enabled: true,
        });
        current.pip.active = "corp".to_owned();
        // 只切 active：自定义条目还在。
        let patched = apply_patch(&current, &json!({"pip": {"active": "aliyun"}}));
        assert_eq!(patched.pip.active, "aliyun");
        assert!(patched.pip.items.iter().any(|entry| entry.id == "corp"));
        assert_eq!(patched.pip.items.len(), current.pip.items.len());
        // 停用某条：active 指针保留，但不再生效。
        let patched = apply_patch(
            &patched,
            &json!({"pip": {"active": "corp", "items": [{"id": "corp", "enabled": false}]}}),
        );
        assert_eq!(patched.pip.active, "corp");
        assert!(patched.effective(MirrorKind::Pip).is_none());
        // remove 删掉自定义条目，active 回落内置默认。
        let patched = apply_patch(&patched, &json!({"pip": {"remove": ["corp"]}}));
        assert!(!patched.pip.items.iter().any(|entry| entry.id == "corp"));
        assert_eq!(patched.pip.active, "tsinghua");
        // 内置条目删不掉。
        let patched = apply_patch(&patched, &json!({"pip": {"remove": ["aliyun"]}}));
        assert!(patched.pip.items.iter().any(|entry| entry.id == "aliyun"));
    }

    /// 存一份配置到 settings.json（payload 读的就是它）。
    fn store(home: &Path, mirrors: &MirrorsSettings) {
        let settings = merge_into_settings(&json!({}), mirrors);
        crate::web::write_settings(home, &settings).expect("write settings");
    }

    /// 契约：GET 的 keys 一个都不能少——前端照着这个形状渲染，缺一个就整块空白。
    #[test]
    fn payload_exposes_the_unified_contract() {
        let home = tempfile::tempdir().expect("temporary home");
        let payload = mirror_payload(home.path());
        assert!(payload["kinds"].is_object(), "kinds 必须是对象");
        assert!(payload["custom"].is_array(), "custom 必须是数组");
        assert!(payload["updatedAt"].is_string(), "updatedAt 必须是时间字符串");
        assert!(payload["updated_at"].is_string(), "updated_at 兼容键也要有");
        for key in ["github", "npm", "pip", "docker"] {
            let group = &payload["kinds"][key];
            assert!(group.is_object(), "kinds.{key} 缺失");
            assert!(group["active"].is_string(), "kinds.{key}.active 缺失");
            assert!(
                group["effective"].is_null() || group["effective"].is_string(),
                "kinds.{key}.effective 形状不对"
            );
            assert!(group["count"].is_number(), "kinds.{key}.count 缺失");
            let items = group["items"].as_array().expect("kinds items array");
            assert!(!items.is_empty(), "kinds.{key}.items 不能为空");
            for item in items {
                for field in ["id", "label", "url", "type", "enabled", "custom"] {
                    assert!(
                        !item[field].is_null(),
                        "kinds.{key}.items[].{field} 缺失"
                    );
                }
                assert!(item["enabled"].is_boolean());
                assert!(item["custom"].is_boolean());
                assert_eq!(item["type"], json!(key), "条目 type 必须与所在类一致");
            }
        }
        // 旧字段仍在（兼容老前端 / 脚本）。
        assert!(payload["builtin"]["github"]["items"].is_array());
        assert!(payload["mirrors"]["github"]["items"].is_array());
        assert!(payload["effective"]["github_prefix"].is_string());
        assert_eq!(payload["env_keys"][0], json!("npm_config_registry"));
        // 扁平清单：老形状把 mirrors 写成对象，前端 Array.isArray 判定失败 → 一条源都读不到。
        let flat = payload["sources"].as_array().expect("sources array");
        assert!(flat.len() >= 19, "四类内置源都要在扁平清单里");
        assert_eq!(
            flat.len(),
            payload["items"].as_array().expect("items array").len()
        );
        assert!(flat.iter().any(|item| item["type"] == json!("docker")));
        assert_eq!(payload["active"]["github"], json!("gh-proxy"));
        assert_eq!(payload["activeByKind"]["pip"], json!("tsinghua"));
        assert!(
            payload["custom"].as_array().expect("custom array").is_empty(),
            "默认没有自定义源"
        );
    }

    /// 契约：自定义源同时出现在 custom 与所属类的 items 里，且带 custom:true。
    #[test]
    fn custom_entries_are_reported_in_custom_and_kinds() {
        let home = tempfile::tempdir().expect("temporary home");
        let mut mirrors = builtin_mirrors();
        mirrors.pip.items.push(MirrorEntry {
            id: "corp".to_owned(),
            label: "公司内网".to_owned(),
            url: "https://pypi.corp.example/simple/".to_owned(),
            kind: MirrorKind::Pip,
            enabled: true,
        });
        mirrors.pip.active = "corp".to_owned();
        store(home.path(), &mirrors);

        let payload = mirror_payload(home.path());
        let custom = payload["custom"].as_array().expect("custom array");
        assert_eq!(custom.len(), 1);
        assert_eq!(custom[0]["id"], json!("corp"));
        assert_eq!(custom[0]["type"], json!("pip"));
        assert_eq!(custom[0]["custom"], json!(true));
        assert_eq!(payload["kinds"]["pip"]["active"], json!("corp"));
        assert_eq!(payload["kinds"]["pip"]["effective"], json!("corp"));
        let builtin_item = payload["kinds"]["pip"]["items"]
            .as_array()
            .expect("pip items")
            .iter()
            .find(|item| item["id"] == json!("tsinghua"))
            .cloned()
            .expect("builtin item");
        assert_eq!(builtin_item["custom"], json!(false));
        assert_eq!(builtin_item["builtin"], json!(true));
    }

    /// PUT：部分更新只动 body 里出现的类与字段（别的类一个字节都不变）。
    #[test]
    fn put_partial_update_only_touches_what_was_sent() {
        let home = tempfile::tempdir().expect("temporary home");
        let current = load_mirrors(home.path());
        let patch = extract_patch(&json!({
            "kinds": {
                "npm": {"items": [{"id": "corp-npm", "label": "公司内网", "url": "https://npm.corp.example/"}]}
            }
        }))
        .expect("kinds patch");
        let next = apply_patch(&current, &patch);
        assert!(next.npm.items.iter().any(|entry| entry.id == "corp-npm"));
        // 没给的字段与没提的类都不许动。
        assert_eq!(next.npm.active, "npmmirror");
        assert_eq!(next.pip.active, current.pip.active);
        assert_eq!(next.pip.items, current.pip.items);
        assert_eq!(next.github.items, current.github.items);
        assert_eq!(next.docker.items, current.docker.items);

        store(home.path(), &next);
        let payload = mirror_payload(home.path());
        assert_eq!(payload["kinds"]["npm"]["count"], json!(6));
        assert_eq!(payload["active"]["npm"], json!("npmmirror"));
    }

    /// 排序必须活过 settings.json 的一次往返：PUT 响应就是重新读盘后的结果，
    /// 只断言内存里的顺序会漏掉「保存成功、刷新弹回原位」这类问题。
    #[test]
    fn put_order_survives_a_settings_round_trip() {
        let home = tempfile::tempdir().expect("temporary home");
        let current = load_mirrors(home.path());
        let first = extract_patch(&json!({"kinds": {"github": {"active": "ghfast"}}})).expect("first");
        let current = apply_patch(&current, &first);
        let patch = extract_patch(&json!({
            "kinds": {
                "npm": {
                    "items": [
                        {"id": "corp-npm", "label": "corp", "url": "https://npm.corp.example/"},
                        {"id": "huawei", "enabled": false}
                    ],
                    "order": ["corp-npm", "official"],
                    "active": "corp-npm"
                }
            }
        }))
        .expect("second");
        let next = apply_patch(&current, &patch);
        assert_eq!(next.npm.items[0].id, "corp-npm");
        // 存盘 → 重新读 → 顺序仍在，且自定义条目被标成 custom。
        store(home.path(), &next);
        let payload = mirror_payload(home.path());
        let ids = payload["kinds"]["npm"]["items"]
            .as_array()
            .expect("npm items")
            .iter()
            .map(|item| item["id"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(ids[0], "corp-npm", "读盘后顺序不能弹回原位");
        assert_eq!(ids[1], "official");
        assert_eq!(payload["kinds"]["npm"]["active"], json!("corp-npm"));
        assert_eq!(payload["custom"][0]["id"], json!("corp-npm"));
        // 只按 order 排序、不动 items 的写法同样有效。
        let current = load_mirrors(home.path());
        let patch = extract_patch(&json!({"kinds": {"npm": {"order": ["official", "corp-npm"]}}})).expect("order patch");
        let next = apply_patch(&current, &patch);
        store(home.path(), &next);
        let payload = mirror_payload(home.path());
        assert_eq!(payload["kinds"]["npm"]["items"][0]["id"], json!("official"));
        assert_eq!(payload["kinds"]["npm"]["items"][1]["id"], json!("corp-npm"));
    }

    /// PUT：部分更新里的排序（order）与删除（remove）都只作用在指定类上。
    #[test]
    fn put_partial_order_and_remove_reorder_the_kind() {
        let home = tempfile::tempdir().expect("temporary home");
        let current = load_mirrors(home.path());
        let patch = extract_patch(&json!({
            "kinds": {
                "npm": {
                    "items": [{"id": "corp", "label": "公司内网", "url": "https://npm.corp.example/"}],
                    "order": ["corp", "official"],
                }
            }
        }))
        .expect("order patch");
        let next = apply_patch(&current, &patch);
        assert_eq!(next.npm.items[0].id, "corp", "order 里先出现者排最前");
        assert_eq!(next.npm.items[1].id, "official");
        assert_eq!(next.npm.items.len(), current.npm.items.len() + 1);
        // 没列到的条目保持原相对顺序跟在后面（稳定排序）。
        assert_eq!(next.npm.items[2].id, "npmmirror");
        // 别的类不受排序影响。
        assert_eq!(next.pip.items, current.pip.items);
        assert_eq!(next.github.items, current.github.items);

        // remove 只删自定义条目，内置条目留在原地。
        let patch = extract_patch(&json!({"kinds": {"npm": {"remove": ["corp", "huawei"]}}})).expect("remove patch");
        let next = apply_patch(&next, &patch);
        assert!(!next.npm.items.iter().any(|entry| entry.id == "corp"));
        assert!(next.npm.items.iter().any(|entry| entry.id == "huawei"));
        assert_eq!(next.npm.items.len(), current.npm.items.len());
    }

    /// PUT：整表回传（前端上移/下移/删除发的形状）＝内容与顺序都以数组为准。
    #[test]
    fn put_snapshot_body_reorders_and_deletes() {
        let home = tempfile::tempdir().expect("temporary home");
        let mut current = load_mirrors(home.path());
        current.pip.items.push(MirrorEntry {
            id: "corp".to_owned(),
            label: "公司内网".to_owned(),
            url: "https://pypi.corp.example/simple/".to_owned(),
            kind: MirrorKind::Pip,
            enabled: true,
        });
        current.pip.active = "corp".to_owned();
        // 整份清单（顺序＝前端渲染顺序），故意不包含 corp：等于「删除 corp」。
        let patch = extract_patch(&json!({
            "mirrors": [
                {"id": "ustc", "label": "中科大", "url": "https://pypi.mirrors.ustc.edu.cn/simple/", "type": "pip", "enabled": true},
                {"id": "official", "label": "官方 PyPI", "url": "https://pypi.org/simple/", "type": "pip", "enabled": true},
                {"id": "tsinghua", "label": "清华 TUNA", "url": "https://pypi.tuna.tsinghua.edu.cn/simple/", "type": "pip", "enabled": false},
            ],
            "active": {"pip": "official"},
            "activeByKind": {"pip": "official"}
        }))
        .expect("snapshot patch");
        let next = apply_patch(&current, &patch);
        assert!(
            !next.pip.items.iter().any(|entry| entry.id == "corp"),
            "不在整表里的自定义条目要删掉"
        );
        assert_eq!(next.pip.active, "official");
        assert_eq!(next.pip.items[0].id, "ustc", "顺序以整表为准");
        assert_eq!(next.pip.items[1].id, "official");
        assert!(
            !next.pip.items.iter().find(|e| e.id == "tsinghua").expect("tsinghua").enabled,
            "停用开关要落盘"
        );
        // 没出现在整表里的类不动。
        assert_eq!(next.github.items, current.github.items);
        assert_eq!(next.docker.active, current.docker.active);
    }

    /// PUT：body 认不下时必须报错，而不是「保存成功但什么都没改」。
    #[test]
    fn put_rejects_bodies_it_cannot_understand() {
        assert!(extract_patch(&json!([])).is_err());
        assert!(extract_patch(&json!({"kinds": {"whatever": {}}})).is_err());
        assert!(extract_patch(&json!({"mirrors": 3})).is_err());
        assert!(extract_patch(&json!({"custom": [{"id": "x"}]})).is_err());
        assert!(extract_patch(&json!({"kinds": {"npm": 3}})).is_err());
        // 认得出类型的整表照收。
        assert!(
            extract_patch(&json!([{"id": "x", "url": "https://x.example/", "type": "npm"}]))
                .is_ok()
        );
    }

    /// 只切 active 的兼容写法（{"type":"npm","active":"huawei"}）仍然有效。
    #[test]
    fn single_kind_body_switches_active() {
        let home = tempfile::tempdir().expect("temporary home");
        let current = load_mirrors(home.path());
        let patch = extract_patch(&json!({"type": "npm", "active": "huawei"})).expect("single patch");
        let next = apply_patch(&current, &patch);
        assert_eq!(next.npm.active, "huawei");
        assert_eq!(next.pip.active, "tsinghua");
        assert_eq!(next.npm.items.len(), current.npm.items.len());
    }
}
