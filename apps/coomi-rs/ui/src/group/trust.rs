//! 多 Agent 信任评估：综合历史可靠性、预测准确度、协作一致性等维度。
//!
//! 信任函数：
//! T_ij(t) = ω₁·H + ω₂·P + ω₃·C + ω₄·S - ω₅·A + ω₆·E
//!
//! 其中：
//! - H: 历史可靠性
//! - P: 预测准确度
//! - C: 协作一致性
//! - S: 安全行为
//! - A: 对抗异常（负向）
//! - E: 加密合规

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 信任权重
const WEIGHTS: [f64; 6] = [0.25, 0.20, 0.20, 0.15, 0.10, 0.10];

/// 信任历史记录
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustHistory {
    /// i → j 的信任记录
    pub pairs: HashMap<String, TrustRecord>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    /// 历史可靠性：完成任务的比例
    pub historical_reliability: f64,
    /// 预测准确度：承诺 vs 实际
    pub prediction_accuracy: f64,
    /// 协作一致性：协同工作时的一致性
    pub collaboration_consistency: f64,
    /// 安全行为：是否遵守安全规则
    pub security_behavior: f64,
    /// 对抗异常：异常行为次数（负向）
    pub adversarial_anomaly: f64,
    /// 加密合规：数据加密使用情况
    pub encryption_compliance: f64,
    /// 最后更新时间
    pub last_updated_ms: u64,
}

impl TrustRecord {
    /// 计算综合信任分 0..1
    pub fn score(&self) -> f64 {
        let raw = WEIGHTS[0] * self.historical_reliability
            + WEIGHTS[1] * self.prediction_accuracy
            + WEIGHTS[2] * self.collaboration_consistency
            + WEIGHTS[3] * self.security_behavior
            - WEIGHTS[4] * self.adversarial_anomaly
            + WEIGHTS[5] * self.encryption_compliance;
        raw.clamp(0.0, 1.0)
    }
}

impl TrustHistory {
    /// 获取 i 对 j 的信任分。
    pub fn get_trust(&self, i: &str, j: &str) -> f64 {
        let key = pair_key(i, j);
        self.pairs.get(&key).map(|r| r.score()).unwrap_or(0.5)
    }

    /// 更新 i 对 j 的信任记录。
    pub fn update(&mut self, i: &str, j: &str, update: TrustUpdate) {
        let key = pair_key(i, j);
        let record = self.pairs.entry(key).or_default();
        if let Some(v) = update.historical_reliability {
            record.historical_reliability = v.clamp(0.0, 1.0);
        }
        if let Some(v) = update.prediction_accuracy {
            record.prediction_accuracy = v.clamp(0.0, 1.0);
        }
        if let Some(v) = update.collaboration_consistency {
            record.collaboration_consistency = v.clamp(0.0, 1.0);
        }
        if let Some(v) = update.security_behavior {
            record.security_behavior = v.clamp(0.0, 1.0);
        }
        if let Some(v) = update.adversarial_anomaly {
            record.adversarial_anomaly = v.clamp(0.0, 1.0);
        }
        if let Some(v) = update.encryption_compliance {
            record.encryption_compliance = v.clamp(0.0, 1.0);
        }
        record.last_updated_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
    }

    /// 记录一次任务完成（成功/失败）。
    pub fn record_task(&mut self, i: &str, j: &str, success: bool) {
        let key = pair_key(i, j);
        let record = self.pairs.entry(key).or_default();
        let old = record.historical_reliability;
        // 简单移动平均
        let alpha = 0.1;
        let new_val = if success { 1.0 } else { 0.0 };
        record.historical_reliability = old * (1.0 - alpha) + new_val * alpha;
        record.last_updated_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
    }
}

/// 信任更新参数
#[derive(Clone, Debug, Default)]
pub struct TrustUpdate {
    pub historical_reliability: Option<f64>,
    pub prediction_accuracy: Option<f64>,
    pub collaboration_consistency: Option<f64>,
    pub security_behavior: Option<f64>,
    pub adversarial_anomaly: Option<f64>,
    pub encryption_compliance: Option<f64>,
}

fn pair_key(i: &str, j: &str) -> String {
    format!("{i}->{j}")
}

// ── 信任分 → 权限门控档位（批 6） ──────────────────────────────
//
// 权限系统复用同一套「信任」语义：信任越低，权限收得越紧。
// 三档与权限模式的映射在 web 层完成（web::PermissionMode 是 web 私有类型）：
//   readonly → 一律询问（且 SecurityPolicy 只读）
//   normal   → 完全沿用用户当前的 permissionMode / 审批行为（默认档）
//   full     → 一律放行
/// 低于该信任分视为「只读」。
pub const TRUST_READONLY_BELOW: f64 = 0.4;
/// 达到该信任分视为「完全放行」。
pub const TRUST_FULL_AT_OR_ABOVE: f64 = 0.85;

/// 信任档位：权限门控的三档粗粒度化。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrustTier {
    ReadOnly,
    Normal,
    Full,
}

impl TrustTier {
    /// 由 0..1 的信任分（见 `TrustRecord::score` / `TrustHistory::get_trust`）推出档位。
    pub fn from_score(score: f64) -> Self {
        if score.is_nan() || score < TRUST_READONLY_BELOW {
            Self::ReadOnly
        } else if score >= TRUST_FULL_AT_OR_ABOVE {
            Self::Full
        } else {
            Self::Normal
        }
    }

    /// 由某对 agent 的信任记录推出档位（用户视角），与 `weighted_vote` 用同一视角。
    pub fn from_history(history: &TrustHistory, agent_id: &str) -> Self {
        Self::from_score(history.get_trust("user", agent_id))
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readonly",
            Self::Normal => "normal",
            Self::Full => "full",
        }
    }

    /// 解析持久化/HTTP 传入的档位；未知值返回 None（调用方给可读错误）。
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "readonly" | "read_only" | "read-only" | "readonly_mode" => Some(Self::ReadOnly),
            "normal" | "default" => Some(Self::Normal),
            "full" | "allow_all" | "allow-all" | "unrestricted" => Some(Self::Full),
            _ => None,
        }
    }
}


// ── 共识决策 ────────────────────────────────────────────────

/// 加权投票：信任高的 Agent 权重更大。
pub fn weighted_vote(
    votes: &[(String, bool)], // (agent_id, vote)
    trust: &TrustHistory,
) -> bool {
    if votes.is_empty() {
        return false;
    }
    let mut yes_weight = 0.0;
    let mut no_weight = 0.0;
    for (agent_id, vote) in votes {
        let w = trust.get_trust("user", agent_id); // 以用户视角评估
        if *vote {
            yes_weight += w;
        } else {
            no_weight += w;
        }
    }
    yes_weight > no_weight
}
