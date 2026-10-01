//! PSI 状态更新：情绪漂移、需求稳态、羁绊、mood mirroring、做梦。

use serde_json::{json, Value};

use crate::life_engine::emotion;

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

fn clamp_v(x: f64) -> f64 {
    x.clamp(-1.0, 1.0)
}

const NEGATIVE_HINTS: &[&str] = &[
    "error", "failed", "wrong", "problem", "crash", "broken", "bug",
    "错误", "失败", "坏了", "问题", "崩", "难受", "难过", "生气",
];
const POSITIVE_HINTS: &[&str] = &[
    "thanks", "thank", "good", "great", "love", "nice", "beautiful",
    "谢谢", "喜欢", "开心", "棒", "好",
];
const QUESTION_HINTS: &[&str] = &["?", "how", "why", "what", "吗", "呢", "什么", "为什么", "怎么"];

fn contains_any(lower: &str, hints: &[&str]) -> bool {
    hints.iter().any(|h| lower.contains(h))
}

pub fn update(state: &mut Value, user_text: &str, assistant_text: &str) {
    let lower = user_text.to_lowercase();

    // 需求稳态：漂向 0.5
    if let Some(needs) = state["needs"].as_object_mut() {
        for (_, v) in needs.iter_mut() {
            let cur = v.as_f64().unwrap_or(0.5);
            *v = json!((cur * 0.97 + 0.5 * 0.03).round4());
        }
    }

    // 情绪：回归中性 + 正/负刺激
    let mut valence = state["valence"].as_f64().unwrap_or(0.0) * 0.92;
    let mut arousal = state["arousal"].as_f64().unwrap_or(0.0) * 0.92;

    if contains_any(&lower, POSITIVE_HINTS) {
        valence = clamp_v(valence + 0.3);
        arousal = clamp_v(arousal + 0.1);
        if let Some(needs) = state["needs"].as_object_mut() {
            let r = needs.get("relatedness").and_then(|v| v.as_f64()).unwrap_or(0.5);
            needs["relatedness"] = json!(clamp01(r + 0.08).round4());
        }
    }
    if contains_any(&lower, NEGATIVE_HINTS) {
        valence = clamp_v(valence - 0.3);
        arousal = clamp_v(arousal + 0.2);
        if let Some(needs) = state["needs"].as_object_mut() {
            let c = needs.get("certainty").and_then(|v| v.as_f64()).unwrap_or(0.5);
            needs["certainty"] = json!(clamp01(c - 0.08).round4());
        }
    }
    if contains_any(&lower, QUESTION_HINTS) || user_text.chars().count() > 400 {
        arousal = clamp_v(arousal + 0.12);
        if let Some(needs) = state["needs"].as_object_mut() {
            let g = needs.get("growth").and_then(|v| v.as_f64()).unwrap_or(0.5);
            needs["growth"] = json!(clamp01(g + 0.05).round4());
        }
    }
    if !assistant_text.is_empty() {
        if let Some(needs) = state["needs"].as_object_mut() {
            let c = needs.get("competence").and_then(|v| v.as_f64()).unwrap_or(0.5);
            needs["competence"] = json!(clamp01(c + 0.02).round4());
        }
    }

    // Mood mirroring
    let user_v = if contains_any(&lower, POSITIVE_HINTS) {
        0.15
    } else if contains_any(&lower, NEGATIVE_HINTS) {
        -0.2
    } else {
        0.0
    };
    let mirror_v = state["mood_mirror"]["valence"].as_f64().unwrap_or(0.0) * 0.8 + user_v * 0.2;
    let mirror_a = state["mood_mirror"]["arousal"].as_f64().unwrap_or(0.0) * 0.85;
    state["mood_mirror"] = json!({
        "valence": mirror_v.round4(),
        "arousal": mirror_a.round4(),
        "updated_at_ms": now_ms(),
    });
    valence = clamp_v(valence * 0.85 + mirror_v * 0.15);

    state["valence"] = json!(valence.round4());
    state["arousal"] = json!(arousal.round4());
    state["emotion"] = json!(emotion::label(valence, arousal));
    state["attention"] = json!("user");

    // 羁绊多因子
    let mut warmth = state["bond_factors"]["warmth"].as_f64().unwrap_or(0.0);
    let mut reciprocity = state["bond_factors"]["reciprocity"].as_f64().unwrap_or(0.0);
    let mut history = state["bond_factors"]["history"].as_f64().unwrap_or(0.0);
    if contains_any(&lower, POSITIVE_HINTS) {
        warmth = clamp01(warmth + 0.01);
    }
    history = clamp01((history + 0.001).min(1.0));
    if !assistant_text.is_empty() && !user_text.is_empty() {
        reciprocity = clamp01(reciprocity * 0.95 + 0.05);
    }
    state["bond_factors"] = json!({
        "warmth": warmth.round4(),
        "reciprocity": reciprocity.round4(),
        "history": history.round4(),
    });
    let bond = 0.4 * warmth + 0.3 * reciprocity + 0.3 * history;
    state["bond"] = json!(clamp01(bond).round4());

    let turns = state["turn_count"].as_u64().unwrap_or(0) + 1;
    state["turn_count"] = json!(turns);

    // 做梦：每 16 轮
    if turns % 16 == 0 {
        let emo = state["emotion"].as_str().unwrap_or("neutral").to_owned();
        let bond_v = state["bond"].as_f64().unwrap_or(0.0);
        let entry = format!("t={turns} emotion={emo} bond={bond_v:.2}");
        if let Some(log) = state["dream"]["log"].as_array_mut() {
            log.push(json!(entry));
            if log.len() > 40 {
                let skip = log.len() - 40;
                log.drain(..skip);
            }
        } else {
            state["dream"] = json!({"last_at_ms": now_ms(), "log": [entry]});
        }
        state["dream"]["last_at_ms"] = json!(now_ms());
    }
}

trait Round4 {
    fn round4(self) -> f64;
}
impl Round4 for f64 {
    fn round4(self) -> f64 {
        (self * 10000.0).round() / 10000.0
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
