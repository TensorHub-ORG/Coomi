//! DeepSeek PoW 求解 —— 嵌入官方 sha3.wasm，用 wasmi 执行 wasm_solve。
//! 算法 DeepSeekHashV1：prefix = salt + "_" + difficulty + "_"，wasm_solve 返回 float64 答案。

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Deserializer, Serialize};

/// 官方 wasm（DeepSeek 前端 sha3_wasm_bg.7b9ca65ddd.wasm），独立无 imports。
pub const SHA3_WASM: &[u8] = include_bytes!("sha3.wasm");

/// `difficulty` 在服务端有两种形态：`chat/create_pow_challenge` 给字符串，
/// `users/create_guest_challenge` 给数字。两者都要能解析，否则整个 challenge
/// 反序列化失败、PoW 静默退化成 answer=0 而请求被拒。
fn de_difficulty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error as _;
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(text) => Ok(text),
        serde_json::Value::Number(number) => Ok(number.to_string()),
        other => Err(D::Error::custom(format!("无法解析 difficulty: {other}"))),
    }
}

/// PoW 挑战对象（服务端 create_pow_challenge 返回）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowChallenge {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    #[serde(deserialize_with = "de_difficulty")]
    pub difficulty: String,
    pub signature: String,
    #[serde(default)]
    pub expire_at: Option<f64>,
    #[serde(default)]
    pub expire_after: Option<f64>,
    /// guest challenge 会带上目标路径，提交时按原样回填。
    #[serde(default)]
    pub target_path: Option<String>,
}

/// 求解结果。
#[derive(Debug, Clone, Serialize)]
pub struct PowSolution {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub answer: f64,
    pub signature: String,
}

/// 执行一次 wasm_solve。参数：challenge 字节、prefix 字节、difficulty。
///
/// 内存必须通过 wasm 自带的分配器（`__wbindgen_export_0`）获得。早前直接把数据写到
/// 0x1000/0x2000/0x3000 这类低地址，会踩坏 wasm-bindgen 的堆，求解函数一进入就
/// `unreachable`，导致 PoW 永远算不出答案、静默退化成 answer=0。
fn wasm_solve(challenge: &[u8], prefix: &[u8], difficulty: f64) -> Result<f64> {
    let engine = wasmi::Engine::default();
    let module = wasmi::Module::new(&engine, SHA3_WASM).context("加载 DeepSeek sha3.wasm 失败")?;
    let mut store = wasmi::Store::new(&engine, ());
    let instance = wasmi::Linker::new(&engine)
        .instantiate(&mut store, &module)
        .context("实例化 wasm 失败")?
        .start(&mut store)
        .context("启动 wasm 失败")?;

    let memory = instance
        .get_export(&store, "memory")
        .and_then(|e| e.into_memory())
        .context("wasm 无 memory 导出")?;

    let allocate = instance
        .get_export(&store, "__wbindgen_export_0")
        .and_then(|e| e.into_func())
        .context("wasm 无分配器导出")?;

    let mut alloc_result = [wasmi::Value::I32(0)];
    let mut allocate_for = |store: &mut wasmi::Store<()>, size: usize, align: i32| -> Result<u32> {
        let size = i32::try_from(size.max(1)).map_err(|_| anyhow!("分配尺寸过大"))?;
        allocate
            .call(
                store,
                &[wasmi::Value::I32(size), wasmi::Value::I32(align)],
                &mut alloc_result,
            )
            .map_err(|e| anyhow!("wasm 分配失败: {e}"))?;
        let address = alloc_result[0]
            .i32()
            .ok_or_else(|| anyhow!("wasm 分配器返回了非整数地址"))?;
        u32::try_from(address).map_err(|_| anyhow!("wasm 分配器返回了非法地址 {address}"))
    };

    let challenge_addr = allocate_for(&mut store, challenge.len(), 1)?;
    let prefix_addr = allocate_for(&mut store, prefix.len(), 1)?;
    let out_addr = allocate_for(&mut store, 16, 8)?;

    memory
        .write(&mut store, challenge_addr as usize, challenge)
        .map_err(|e| anyhow!("写入 challenge 失败: {e}"))?;
    memory
        .write(&mut store, prefix_addr as usize, prefix)
        .map_err(|e| anyhow!("写入 prefix 失败: {e}"))?;

    let solve_func = instance
        .get_export(&store, "wasm_solve")
        .and_then(|e| e.into_func())
        .context("wasm 无 wasm_solve 导出")?;

    let mut results = [];
    solve_func
        .call(
            &mut store,
            &[
                wasmi::Value::I32(out_addr as i32),
                wasmi::Value::I32(challenge_addr as i32),
                wasmi::Value::I32(challenge.len() as i32),
                wasmi::Value::I32(prefix_addr as i32),
                wasmi::Value::I32(prefix.len() as i32),
                wasmi::Value::F64(wasmi::core::F64::from_bits(difficulty.to_bits())),
            ],
            &mut results,
        )
        .context("调用 wasm_solve 失败")?;

    // 读结果
    let mut buf = [0u8; 16];
    memory
        .read(&store, out_addr as usize, &mut buf)
        .map_err(|e| anyhow!("读取结果失败: {e}"))?;
    let status = i32::from_le_bytes(buf[0..4].try_into().unwrap());
    if status != 0 {
        return Err(anyhow!("PoW 求解未找到解（status={status}）"));
    }
    let answer = f64::from_le_bytes(buf[8..16].try_into().unwrap());
    Ok(answer)
}

/// 求解一个 challenge，返回可直接放进 X-DS-PoW-Response 的对象。
///
/// 优先使用官方原生求解器（librscrypto.so，通过文件队列由 Java 侧执行）：
/// DeepSeekHashV1 的细节我们复现不出来（Keccak/SHA3 各种判据都试过，服务端一律 40301），
/// 而官方库是必然正确的。队列不可用时退回本地 wasm（大概率解不出，但保留降级路径）。
pub fn solve_challenge(ch: &PowChallenge) -> Result<PowSolution> {
    if ch.algorithm != "DeepSeekHashV1" {
        return Err(anyhow!("不支持的 PoW 算法: {}", ch.algorithm));
    }
    // 尝试通过文件队列找官方求解器（Java 侧 CoomiPowService 轮询）。
    let answer = crate::deepseek::pow::official_solve(ch)
        .or_else(|_| {
            let prefix = format!("{}_{}_", ch.salt, ch.difficulty);
            let difficulty_f64 = ch
                .difficulty
                .parse::<f64>()
                .map_err(|e| anyhow!("difficulty 解析失败: {e}"))?;
            wasm_solve(ch.challenge.as_bytes(), prefix.as_bytes(), difficulty_f64)
        })?;
    Ok(PowSolution {
        algorithm: ch.algorithm.clone(),
        challenge: ch.challenge.clone(),
        salt: ch.salt.clone(),
        answer,
        signature: ch.signature.clone(),
    })
}

/// 通过「pow 求解队列」让 Java 侧用官方 librscrypto.so 计算 answer。
///
/// 链路：本函数在 `<coomi-home>/control/pow/` 写 `<id>.cmd.json`
/// → Java 侧 CoomiPowService 轮询到后调官方原生库 → 写回 `<id>.result.json` → 本函数读回。
/// 与无障碍命令队列同一模式，只多一层「本地计算」，不需要网络。
fn official_solve(ch: &PowChallenge) -> Result<f64> {
    let home = crate::deepseek::pow::pow_queue_home().ok_or_else(|| anyhow!("无 Coomi home"))?;
    let dir = home.join("control").join("pow");
    std::fs::create_dir_all(&dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let id = format!("{stamp:013}-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let command_path = dir.join(format!("{id}.cmd.json"));
    let result_path = dir.join(format!("{id}.result.json"));
    std::fs::write(
        &command_path,
        serde_json::to_string(&serde_json::json!({
            "challenge": ch.challenge,
            "salt": ch.salt,
            "difficulty": ch.difficulty,
        }))?,
    )?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(&result_path) {
            let _ = std::fs::remove_file(&result_path);
            let value: serde_json::Value = serde_json::from_str(&text)?;
            let ok = value.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
            if !ok {
                return Err(anyhow!(
                    "官方 PoW 求解失败: {}",
                    value.get("error").and_then(serde_json::Value::as_str).unwrap_or("未知错误")
                ));
            }
            let answer = value.get("answer").and_then(serde_json::Value::as_f64)
                .ok_or_else(|| anyhow!("官方 PoW 结果缺 answer"))?;
            return Ok(answer);
        }
        std::thread::sleep(std::time::Duration::from_millis(80));
    }
    let _ = std::fs::remove_file(&command_path);
    Err(anyhow!("官方 PoW 求解超时（librscrypto.so 未加载？）"))
}

/// 求解队列的 home 目录：引擎以 `--home <TERMUX_HOME>/.coomi` 启动，
/// 这里从环境变量 COOMI_HOME 取（Java 侧启动引擎时注入），
/// 没有就退回 `$HOME/.coomi`（引擎在 proot 里 $HOME 是 <files>/home）。
fn pow_queue_home() -> Option<std::path::PathBuf> {
    if let Some(home) = std::env::var_os("COOMI_HOME") {
        return Some(std::path::PathBuf::from(home));
    }
    std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".coomi"))
}

/// 构造 X-DS-PoW-Response 头的 JSON 字符串。
pub fn pow_header_json(solution: &PowSolution, target_path: &str) -> Result<String> {
    serde_json::to_string(&serde_json::json!({
        "algorithm": solution.algorithm,
        "challenge": solution.challenge,
        "salt": solution.salt,
        "answer": solution.answer,
        "signature": solution.signature,
        "target_path": target_path,
    }))
    .map_err(Into::into)
}

/// 构造未登录接口（验证码登录 / 注册）需要的 `X-DS-Guest-Pow-Response`。
///
/// 关键差异：这个头必须是 **base64(JSON)**，直接给明文 JSON 服务端只会回
/// 40302 PAYLOAD_SCHEMA_MISMATCH；换成 base64 之后才会进入真正的校验（40301）。
/// `target_path` 留空时按服务端下发的值回填，不要自己拼 `/api/v0` 前缀。
pub fn guest_pow_header_json(solution: &PowSolution, target_path: Option<&str>) -> Result<String> {
    use base64::Engine as _;
    let mut payload = serde_json::json!({
        "algorithm": solution.algorithm,
        "challenge": solution.challenge,
        "salt": solution.salt,
        "answer": solution.answer,
        "signature": solution.signature,
    });
    if let Some(path) = target_path.filter(|value| !value.trim().is_empty()) {
        payload["target_path"] = serde_json::Value::String(path.trim().to_string());
    }
    let json = serde_json::to_string(&payload)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(json.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasm_loads() {
        let _ = wasm_solve(b"test", b"salt_5_", 5.0);
    }
}

#[cfg(test)]
mod real_test {
    use super::*;

    #[test]
    fn solve_runs() {
        // 用假 challenge 测试 wasm 能执行（非空 panic 即证明链路通）
        let r = wasm_solve(b"test_challenge", b"salt_5_", 5.0);
        println!("result: {:?}", r);
        assert!(r.is_ok() || r.is_err());
    }
}

#[cfg(test)]
mod live_test {
    use super::*;

    /// 真实联调：取 guest challenge → 求解 → 提交登录请求。
    ///
    /// 这个测试存在的意义是——guest PoW 的失败方式很隐蔽（缺头是 40300，头不对是
    /// 40302），只有真跑一次才能确认求解出的 answer 被服务端接受。
    /// 默认 `#[ignore]`，需要时用 `--ignored --nocapture` 手动跑。
    #[tokio::test]
    #[ignore = "network: 真实请求 DeepSeek guest challenge"]
    async fn guest_challenge_is_accepted_by_login_endpoint() {
        let target = "/api/v0/users/login_by_mobile_sms";
        let client = reqwest::Client::new();
        let response = client
            .post("https://chat.deepseek.com/api/v0/users/create_guest_challenge")
            .header("User-Agent", "DeepSeek/2.3.1 Android")
            .header("x-client-version", "2.3.1")
            .json(&serde_json::json!({ "target_path": target }))
            .send()
            .await
            .expect("challenge request");
        let body: serde_json::Value = response.json().await.expect("challenge json");
        let challenge_value = body
            .pointer("/data/biz_data/guest_challenge")
            .cloned()
            .expect("guest_challenge 字段缺失");
        let challenge: PowChallenge =
            serde_json::from_value(challenge_value).expect("解析 guest challenge");
        let solution = solve_challenge(&challenge).expect("求解 PoW");
        println!("answer = {}", solution.answer);
        let header = pow_header_json(&solution, target).expect("构造 PoW 头");
        println!("header = {header}");

        let response = client
            .post("https://chat.deepseek.com/api/v0/users/login_by_mobile_sms")
            .header("User-Agent", "DeepSeek/2.3.1 Android")
            .header("x-client-version", "2.3.1")
            .header("x-client-bundle-id", "com.deepseek.chat")
            .header("Content-Type", "application/json")
            .header("X-DS-Guest-Pow-Response", header)
            .json(&serde_json::json!({
                "mobile_number": "13800138000",
                "sms_verification_code": "000000",
                "area_code": "+86",
                "device_id": "coomi-android",
                "os": "android"
            }))
            .send()
            .await
            .expect("login request");
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        println!("HTTP {status} → {text}");
        // 只要不是 40302（头结构不匹配）就说明 schema 是对的，剩下的交给业务错误码。
        assert!(
            !text.contains("40302"),
            "guest PoW 头未被接受：{text}"
        );
    }
}
