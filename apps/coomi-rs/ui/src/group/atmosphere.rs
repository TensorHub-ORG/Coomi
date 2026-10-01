//! 群情感氛围：感知群内整体情绪，约束 AI 情感表达。
//!
//! 规则：
//! - 群体兴奋时不过度附和
//! - 群体低落时不过度活跃
//! - 情感表达符合群规范，不能像正常对话那样亲密

use super::types::*;

/// 群情感氛围。
#[derive(Clone, Debug)]
pub struct GroupAtmosphere {
    /// 群体情绪 -1..1（负=低落，正=兴奋）
    pub overall_mood: f64,
    /// 群体能量 0..1
    pub energy_level: f64,
    /// 话题参与度 0..1
    pub topic_engagement: f64,
    /// 是否闲聊氛围
    pub is_casual: bool,
}

impl Default for GroupAtmosphere {
    fn default() -> Self {
        Self {
            overall_mood: 0.0,
            energy_level: 0.5,
            topic_engagement: 0.5,
            is_casual: false,
        }
    }
}

impl GroupAtmosphere {
    /// 从房间消息计算群氛围。
    pub fn from_room(room: &GroupRoom) -> Self {
        if room.messages.is_empty() {
            return Self::default();
        }

        let recent: Vec<_> = room.messages.iter().rev().take(20).rev().collect();
        let n = recent.len() as f64;

        // 计算群体情绪（基于消息长度和内容关键词）
        let mut mood_sum = 0.0;
        let mut energy_sum = 0.0;
        for msg in &recent {
            let content = msg.content.to_lowercase();
            // 简单情绪分析
            let positive = ["好", "棒", "赞", "开心", "哈哈", "喜欢", "不错", "厉害"];
            let negative = ["差", "烂", "烦", "难过", "讨厌", "不好", "垃圾", "生气"];
            let pos_count = positive.iter().filter(|w| content.contains(**w)).count() as f64;
            let neg_count = negative.iter().filter(|w| content.contains(**w)).count() as f64;
            mood_sum += (pos_count - neg_count).clamp(-2.0, 2.0) * 0.25;

            // 能量基于消息长度
            energy_sum += (msg.content.len() as f64 / 100.0).min(1.0);
        }

        let overall_mood = (mood_sum / n).clamp(-1.0, 1.0);
        let energy_level = (energy_sum / n).clamp(0.0, 1.0);

        // 话题参与度：最近有多少不同成员发言
        let unique_speakers: std::collections::HashSet<_> =
            recent.iter().map(|m| m.from.as_str()).collect();
        let topic_engagement = (unique_speakers.len() as f64 / room.members.len().max(1) as f64)
            .clamp(0.0, 1.0);

        // 是否闲聊：话题为空且消息短
        let avg_len: f64 = recent.iter().map(|m| m.content.len() as f64).sum::<f64>() / n;
        let is_casual = room.topic.is_empty() && avg_len < 50.0;

        Self {
            overall_mood,
            energy_level,
            topic_engagement,
            is_casual,
        }
    }

    /// 获取情感表达约束提示（注入 system prompt）。
    pub fn speech_constraint(&self) -> String {
        let mut hint = String::from("当前群氛围：");

        if self.overall_mood > 0.3 {
            hint.push_str("群里气氛活跃兴奋。");
            hint.push_str("你可以适当参与，但不要过度附和或抢话。");
        } else if self.overall_mood < -0.3 {
            hint.push_str("群里气氛有些低落。");
            hint.push_str("你可以适当表达关心，但不要过度活跃或强行乐观。");
        } else {
            hint.push_str("群里气氛平稳。");
            hint.push_str("保持自然参与即可。");
        }

        if self.is_casual {
            hint.push_str("\n当前是闲聊氛围，回复可以轻松一些，但不要说空话。");
        }

        if self.energy_level > 0.7 {
            hint.push_str("\n群里能量较高，可以适当简短，不必每条都回。");
        }

        hint
    }

    /// 判断是否应该让 AI 主动发言（结合氛围）。
    pub fn should_initiate(&self) -> bool {
        // 高能量 + 有话题参与度时，可以主动
        self.energy_level > 0.3 && self.topic_engagement > 0.2
    }
}
