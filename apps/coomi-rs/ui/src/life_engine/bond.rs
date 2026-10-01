//! 多因子羁绊：warmth + reciprocity + history → bond(0~1)。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BondState {
    pub warmth: f32,
    pub reciprocity: f32,
    pub history: f32,
}

impl BondState {
    /// 综合羁绊值 0~1。
    pub fn total(&self) -> f32 {
        (self.warmth * 0.4 + self.reciprocity * 0.35 + self.history * 0.25).clamp(0.0, 1.0)
    }

    /// 一轮对话后更新：正面互动提升 warmth，有问有答提升 reciprocity。
    pub fn update_after_turn(&mut self, user_positive: bool, assistant_engaged: bool) {
        if user_positive {
            self.warmth = (self.warmth + 0.02).min(1.0);
        }
        if assistant_engaged {
            self.reciprocity = (self.reciprocity + 0.015).min(1.0);
        }
        // history 随轮次缓慢增长
        self.history = (self.history + 0.005).min(1.0);
    }
}
