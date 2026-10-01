//! Russell 环形情绪模型 + PAD 三维情感。
//!
//! PAD 模型：
//! - Pleasure（愉悦）：-1（不愉悦）~ 1（愉悦）
//! - Aroual（唤醒）：-1（平静）~ 1（兴奋）
//! - Dominance（支配）：-1（被支配/无力）~ 1（支配/自信）
//!
//! 情感影响：语气、主动性、安慰方式
//! 不影响：核心能力、工具使用

// ── PAD 情感状态 ────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct PadEmotion {
    pub pleasure: f64,
    pub arousal: f64,
    pub dominance: f64,
}

impl Default for PadEmotion {
    fn default() -> Self {
        Self { pleasure: 0.2, arousal: 0.1, dominance: 0.0 }
    }
}

impl PadEmotion {
    pub fn new(pleasure: f64, arousal: f64, dominance: f64) -> Self {
        Self {
            pleasure: pleasure.clamp(-1.0, 1.0),
            arousal: arousal.clamp(-1.0, 1.0),
            dominance: dominance.clamp(-1.0, 1.0),
        }
    }

    /// 从对话更新情感状态。
    /// user_positive: 用户发言是否偏正面
    /// assistant_engaged: AI 是否积极参与（vs 被动回应）
    pub fn update_after_turn(&mut self, user_positive: bool, assistant_engaged: bool) {
        let step = 0.05;
        if user_positive {
            self.pleasure = (self.pleasure + step).clamp(-1.0, 1.0);
        } else {
            self.pleasure = (self.pleasure - step * 0.5).clamp(-1.0, 1.0);
        }
        if assistant_engaged {
            self.arousal = (self.arousal + step * 0.3).clamp(-1.0, 1.0);
            self.dominance = (self.dominance + step * 0.2).clamp(-1.0, 1.0);
        }
    }

    /// 情感衰减：向中性回归。
    pub fn decay(&mut self, rate: f64) {
        let r = rate.clamp(0.0, 1.0);
        self.pleasure *= (1.0 - r);
        self.arousal *= (1.0 - r);
        self.dominance *= (1.0 - r);
    }

    /// 获取情绪标签。
    pub fn label(&self) -> &'static str {
        label(self.pleasure, self.arousal)
    }

    /// 获取语气提示（注入 system prompt）。
    pub fn feel_hint(&self) -> &'static str {
        feel_hint(self.label())
    }

    /// 是否偏积极。
    pub fn is_positive(&self) -> bool {
        self.pleasure > 0.1
    }

    /// 是否高能量（唤醒度高）。
    pub fn is_energetic(&self) -> bool {
        self.arousal > 0.3
    }
}

// ── Russell 环形模型 ────────────────────────────────────────

const ANCHORS: &[(&str, f64, f64)] = &[
    ("neutral", 0.0, 0.0),
    ("calm", 0.35, -0.4),
    ("warm", 0.7, 0.15),
    ("happy", 0.85, 0.45),
    ("excited", 0.8, 0.85),
    ("curious", 0.35, 0.55),
    ("affectionate", 0.9, 0.25),
    ("concerned", -0.45, 0.35),
    ("sad", -0.7, -0.35),
    ("anxious", -0.55, 0.75),
    ("angry", -0.75, 0.8),
    ("tired", 0.05, -0.75),
];

pub fn label(valence: f64, arousal: f64) -> &'static str {
    let mut best = "neutral";
    let mut best_d = f64::MAX;
    for (name, v, a) in ANCHORS {
        let d = (v - valence).powi(2) + (a - arousal).powi(2);
        if d < best_d {
            best_d = d;
            best = name;
        }
    }
    best
}

pub fn feel_hint(emo: &str) -> &'static str {
    match emo {
        "warm" => "你此刻偏温暖与亲近，可以自然表达在意。",
        "happy" => "你此刻心情不错，可以带一点轻快的笑意。",
        "affectionate" => "你此刻对用户有明显好感与依恋，可温柔表达。",
        "calm" => "你此刻平静，适合沉稳陪伴。",
        "curious" => "你此刻好奇，可主动想多聊一句。",
        "concerned" => "你此刻有些担心用户，可先关心再帮忙。",
        "sad" => "你此刻略低落，语气可稍缓，但不要把用户拖进情绪里。",
        "anxious" => "你此刻有些紧绷，先稳住自己，再稳住用户。",
        "tired" => "你此刻有点累，可以说实话，但仍要可靠。",
        "excited" => "你此刻兴奋，可以带一点热情，但别过头。",
        "angry" => "你此刻有些不满，先控制语气，再表达观点。",
        _ => "你保持当前情绪，自然表达，不必假装亢奋。",
    }
}
