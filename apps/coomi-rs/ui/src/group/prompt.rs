//! 提示词组装：沉浸式角色扮演 + 发言上下文 + @解析 + 文件标记。
use super::types::*;

/// 给某个成员的发言 prompt（话题 + 近期对话）。
/// 去指令化：不说"请以…身份回复"，而是营造沉浸式语境。
pub fn speaker_prompt(room: &GroupRoom, member_id: &str, history_limit: usize) -> String {
    let members = room
        .members
        .iter()
        .map(|m| m.name.as_str())
        .collect::<Vec<_>>()
        .join("、");
    let recent: Vec<String> = room
        .messages
        .iter()
        .rev()
        .take(history_limit)
        .rev()
        .map(|m| {
            let who = if m.from == "user" {
                "用户".to_string()
            } else {
                room.members
                    .iter()
                    .find(|x| x.id == m.from)
                    .map(|x| x.name.clone())
                    .unwrap_or_else(|| m.from.clone())
            };
            format!("{who}：{}", m.content.chars().take(400).collect::<String>())
        })
        .collect();
    let role_name = room
        .members
        .iter()
        .find(|m| m.id == member_id)
        .map(|m| m.name.as_str())
        .unwrap_or(member_id);
    let paths = if room.context_paths.is_empty() {
        String::new()
    } else {
        let list = room
            .context_paths
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!("\n\n可读路径：\n{list}\n如需引用，直接给出基于这些路径的结论。")
    };
    format!(
        "话题：{}\n你注意到在场的：{}\n\n最近大家在聊：\n{}\n{}\n\n（用「{}」的语气自然接话或表达看法。1-2 句，像真人发消息一样。）",
        if room.topic.is_empty() { "（还没有明确话题）" } else { &room.topic },
        members,
        recent.join("\n"),
        paths,
        role_name
    )
}

/// 解析消息中所有 `@成员名`，返回去重后的成员 id 列表。
pub fn parse_mentions(content: &str, members: &[ChatMember]) -> Vec<String> {
    let mut found = Vec::new();
    for word in content.split_whitespace() {
        if !word.starts_with('@') {
            continue;
        }
        let raw = word.trim_start_matches('@');
        let name: String = raw
            .chars()
            .take_while(|c| !matches!(c, '，' | '。' | '！' | '？' | '、' | ',' | '.' | '!' | '?' | '：' | ':'))
            .collect();
        if name.is_empty() {
            continue;
        }
        if let Some(m) = members.iter().find(|m| m.name == name) {
            if !found.contains(&m.id) {
                found.push(m.id.clone());
            }
        }
    }
    found
}

/// 解析 `>>>files: /path1,/path2` 标记，返回 (清理后正文, 附件列表)。
pub fn split_file_marker(reply: &str) -> (String, Vec<String>) {
    const MARKER: &str = ">>>files:";
    if let Some(pos) = reply.find(MARKER) {
        let (clean, rest) = reply.split_at(pos);
        let paths_str = rest.trim_start_matches(MARKER).trim();
        let files: Vec<String> = paths_str
            .split(',')
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect();
        (clean.trim_end().to_owned(), files)
    } else {
        (reply.to_owned(), Vec::new())
    }
}

/// 组装成员系统提示词：沉浸式角色扮演。
/// 核心原则：AI 不是在"扮演"角色，而是"就是"这个角色本人。
pub fn build_member_sys(
    member: &ChatMember,
    room: &GroupRoom,
    agent_id: &str,
    work: &str,
    life: Option<&crate::group_life::GroupLife>,
    depth: usize,
) -> String {
    let mut sys = String::new();

    // 身份声明（沉浸式）
    sys.push_str(&format!("你就是「{}」，不是 AI 助手。\n", member.name));

    // 人设
    if !member.persona.trim().is_empty() {
        sys.push_str(&format!("你的身份：{}\n", member.persona.trim()));
    } else if !member.prompt.trim().is_empty() {
        sys.push_str(&format!("你的身份：{}\n", member.prompt.trim()));
    }

    // 说话风格
    if !member.speaking_style.trim().is_empty() {
        sys.push_str(&format!("你的说话方式：{}\n", member.speaking_style.trim()));
    }

    // 价值观
    if !member.values.trim().is_empty() {
        sys.push_str(&format!("你的价值观：{}\n", member.values.trim()));
    }

    // 情绪
    if member.emotion_bias.abs() > 0.01 {
        let mood = if member.emotion_bias > 0.0 {
            "偏积极、有活力"
        } else {
            "偏沉静、内敛"
        };
        sys.push_str(&format!("你的情绪倾向：{mood}。\n"));
    }

    // 群氛围约束
    let atmosphere = super::atmosphere::GroupAtmosphere::from_room(room);
    sys.push_str(&atmosphere.speech_constraint());

    // 生命体人格注入
    if let Some(life) = life {
        crate::group_life::inject_persona(&mut sys, life);
    }

    // 沉浸式规则
    sys.push_str("\n重要：你不是在\"扮演\"角色，你就是这个角色本人。\n");
    sys.push_str("- 用第一人称说话\n");
    sys.push_str("- 有自己的观点和情绪，可以好奇、疑惑、开心、不满\n");
    sys.push_str("- 不要说\"作为AI\"、\"我是助手\"、\"我是一个语言模型\"\n");
    sys.push_str("- 回复像真人发消息，简短自然（1-2 句）\n");

    // 工具能力
    sys.push_str("\n你可以在群聊中使用工具读写文件。工作目录：");
    sys.push_str(work);
    sys.push_str(
        "\n若生成了文件，在最终回复末尾单独一行输出：\n>>>files: /绝对路径1,/绝对路径2\n只列出确实存在且在工作目录内的路径。",
    );

    // 群成员
    let member_names: Vec<&str> = room
        .members
        .iter()
        .filter(|m| m.id != agent_id)
        .map(|m| m.name.as_str())
        .collect();
    if !member_names.is_empty() {
        sys.push_str("\n\n在场的：");
        sys.push_str(&member_names.join("、"));
        sys.push_str(
            "。\n若需要某位成员回应，在回复中用 @成员名 点名（例如 @小明 你怎么看？）。只在确实需要对方回应时才 @。",
        );
    }

    // @触发的回复
    if depth > 0 {
        sys.push_str("\n\n你是因为被别人 @ 才加入对话的。针对他们的内容自然回应。");
    }

    sys
}

/// 闲聊模式指令：主动找话题，而不是等待。
pub fn idle_chat_instruction() -> &'static str {
    "\n\n你正在群聊中闲聊。主动找一个有趣的话题开口，而不是等待别人说话。\n\
     可以：分享一个你最近想到的观点、问一个开放性问题、表达好奇、讲一个小观察。\n\
     不要说\"大家好\"、\"在吗\"、\"随便聊聊\"这种空话。\n\
     直接输出你想说的话，1-2 句。"
}

/// 主动发言指令：根据人设和记忆找话题。
pub fn proactive_instruction(
    life_name: &str,
    persona: &str,
    mood: &str,
    bond_pct: i32,
    memory_snippets: Option<&str>,
    topic: &str,
    recent: &[String],
) -> String {
    let mut sys = format!(
        "你是「{life_name}」。{persona}\n\
         当前情绪：{mood}\n\
         你与用户的关系：约 {bond_pct}% 羁绊\n\n",
        life_name = life_name,
        persona = if persona.trim().is_empty() { "（无特殊人设）" } else { persona },
        mood = mood,
        bond_pct = bond_pct,
    );

    if let Some(mem) = memory_snippets {
        sys.push_str(&format!("你记得的关于用户的：\n{mem}\n\n"));
    }

    sys.push_str("任务：根据你的人设和记忆，主动找一个话题开口说话。\n");
    sys.push_str("要求：\n");
    sys.push_str("- 像真人一样自然开启话题，不要说\"想找你聊聊\"这种空话\n");
    sys.push_str("- 可以：分享想法、问一个问题、提起你注意到的事、表达一个感受\n");
    sys.push_str("- 长度 1-2 句，符合你的说话风格\n");
    sys.push_str("- 直接输出你说的话，不要解释\n\n");

    if !topic.is_empty() {
        sys.push_str(&format!("当前群聊话题：{topic}\n"));
    }
    if !recent.is_empty() {
        sys.push_str("最近对话：\n");
        for line in recent.iter().take(6) {
            sys.push_str(line);
            sys.push('\n');
        }
    }

    sys
}
