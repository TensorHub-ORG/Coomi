//! 群聊发言策略：V > θ 才发言。
//!
//! V = 信息增益 × 紧迫性 × 社交合适性 - 打扰成本
//!
//! 目标：让 AI 知道何时沉默，而不是每次都抢话。

use super::types::*;

/// 发言阈值（可调）。
pub const SPEECH_THRESHOLD: f64 = 0.3;

/// 群聊上下文（用于发言策略计算）。
pub struct GroupContext {
    /// 当前话题
    pub topic: String,
    /// 最近 N 条消息
    pub recent_messages: Vec<ChatMessage>,
    /// 是否闲聊时段
    pub is_casual: bool,
    /// 是否已有人回答了最近的问题
    pub others_answered: bool,
    /// 当前成员最近发言次数
    pub member_recent_speak_count: u32,
}

/// 计算是否应该发言。
pub fn should_speak(context: &GroupContext, member: &ChatMember) -> bool {
    let v = calculate_speech_value(context, member);
    v > SPEECH_THRESHOLD
}

/// 计算发言价值分。
pub fn calculate_speech_value(context: &GroupContext, member: &ChatMember) -> f64 {
    let info_gain = calculate_information_gain(context, member);
    let urgency = calculate_urgency(context);
    let social_fit = calculate_social_fitness(context, member);
    let disturbance_cost = calculate_disturbance_cost(context, member);

    info_gain * urgency * social_fit - disturbance_cost
}

/// 信息增益：成员的发言能带来多少新信息。
fn calculate_information_gain(context: &GroupContext, member: &ChatMember) -> f64 {
    let mut gain: f64 = 0.5; // 基础值

    // 如果成员有独特的人设/专业知识，信息增益更高
    if !member.persona.trim().is_empty() {
        gain += 0.15;
    }
    if !member.values.trim().is_empty() {
        gain += 0.1;
    }

    // 如果最近消息中该成员没有出现过，信息增益更高
    let recent_from_member = context
        .recent_messages
        .iter()
        .filter(|m| m.from == member.id)
        .count();
    if recent_from_member == 0 {
        gain += 0.2;
    } else if recent_from_member > 3 {
        gain -= 0.2; // 已经说了很多，边际效用递减
    }

    gain.clamp(0.0, 1.0)
}

/// 紧迫性：当前是否需要紧急发言。
fn calculate_urgency(context: &GroupContext) -> f64 {
    let mut urgency: f64 = 0.5;

    // 闲聊时段紧迫性低
    if context.is_casual {
        urgency -= 0.3;
    }

    // 最近有人提问（以问号结尾的消息）
    let has_question = context
        .recent_messages
        .iter()
        .rev()
        .take(3)
        .any(|m| m.content.contains('？') || m.content.contains('?'));
    if has_question {
        urgency += 0.2;
    }

    // 已有人回答了
    if context.others_answered {
        urgency -= 0.3;
    }

    urgency.clamp(0.0, 1.0)
}

/// 社交合适性：发言是否符合社交规范。
fn calculate_social_fitness(context: &GroupContext, member: &ChatMember) -> f64 {
    let mut fitness: f64 = 0.7;

    // 如果成员是被 @ 的，社交合适性高
    let last_msg = context.recent_messages.last();
    if let Some(msg) = last_msg {
        if msg.content.contains(&format!("@{}", member.name)) {
            fitness += 0.3;
        }
    }

    // 如果话题与成员人设相关，合适性更高
    if !context.topic.is_empty() && !member.persona.is_empty() {
        let topic_lower = context.topic.to_lowercase();
        let persona_lower = member.persona.to_lowercase();
        if topic_lower
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word.len() > 1 && persona_lower.contains(word))
        {
            fitness += 0.15;
        }
    }

    fitness.clamp(0.0, 1.0)
}

/// 打扰成本：发言可能造成的负面影响。
fn calculate_disturbance_cost(context: &GroupContext, member: &ChatMember) -> f64 {
    let mut cost: f64 = 0.0;

    // 闲聊时段打扰成本高
    if context.is_casual {
        cost += 0.3;
    }

    // 已有人回答了最近的问题
    if context.others_answered {
        cost += 0.5;
    }

    // 近期发言太多
    if context.member_recent_speak_count > 3 {
        cost += 0.2;
    }
    if context.member_recent_speak_count > 5 {
        cost += 0.3;
    }

    cost.clamp(0.0, 1.0)
}
