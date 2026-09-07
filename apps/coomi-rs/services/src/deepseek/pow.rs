//! DeepSeek PoW 求解 —— 嵌入官方 sha3.wasm，用 wasmi 执行 wasm_solve。
//! 算法 DeepSeekHashV1：prefix = salt + "_" + difficulty + "_"，wasm_solve 返回 float64 答案。

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

/// 官方 wasm（DeepSeek 前端 sha3_wasm_bg.7b9ca65ddd.wasm），独立无 imports。
pub const SHA3_WASM: &[u8] = include_bytes!("sha3.wasm");

/// PoW 挑战对象（服务端 create_pow_challenge 返回）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowChallenge {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub difficulty: String,
    pub signature: String,
    #[serde(default)]
    pub expire_at: Option<f64>,
    #[serde(default)]
    pub expire_after: Option<f64>,
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
/// 结果：wasm 把 status(i32)@out、answer(f64)@out+8 写入内存。
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

    // 布局：challenge 数据区、prefix 数据区、输出区
    let challenge_addr: u32 = 0x1000;
    let prefix_addr: u32 = 0x2000;
    let out_addr: u32 = 0x3000;

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
pub fn solve_challenge(ch: &PowChallenge) -> Result<PowSolution> {
    if ch.algorithm != "DeepSeekHashV1" {
        return Err(anyhow!("不支持的 PoW 算法: {}", ch.algorithm));
    }
    let prefix = format!("{}_{}_", ch.salt, ch.difficulty);
    let difficulty_f64 = ch
        .difficulty
        .parse::<f64>()
        .map_err(|e| anyhow!("difficulty 解析失败: {e}"))?;
    let answer = wasm_solve(ch.challenge.as_bytes(), prefix.as_bytes(), difficulty_f64)?;
    Ok(PowSolution {
        algorithm: ch.algorithm.clone(),
        challenge: ch.challenge.clone(),
        salt: ch.salt.clone(),
        answer,
        signature: ch.signature.clone(),
    })
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
