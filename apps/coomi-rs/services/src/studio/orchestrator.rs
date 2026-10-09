use super::{Studio, StudioMember, StudioMessage, StudioStore, WorkItem, WorkItemStatus};
use anyhow::{Result, bail};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct StudioRoute { pub member_ids: Vec<String>, pub direct: bool }

/// Formatting around a mention is allowed; identifiers must match in full.
pub fn mentions_member(text: &str, name: &str) -> bool {
    if name.is_empty() { return false; }
    let text = text.replace('＠', "@");
    let marker = format!("@{name}");
    text.match_indices(&marker).any(|(start, matched)| {
        let before = text[..start].chars().next_back();
        let tail = &text[start + matched.len()..];
        let after = tail.chars().next();
        // Chinese prose commonly has no spaces around @成员名请检查.
        // Keep Latin identifier and email boundaries strict.
        let identifier = |c: char| {
            (c.is_alphanumeric() && !matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0x20000..=0x3134f))
                || matches!(c, '_' | '-')
        };
        let email_domain = tail.strip_prefix('.').is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()));
        !before.is_some_and(identifier) && !after.is_some_and(identifier) && !email_domain
    })
}

/// Use the same mention rules for user routing and member-to-member handoffs.
pub fn mentioned_members(members: &[StudioMember], text: &str, sender: Option<&str>) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let broadcast = ["全体", "所有人", "all", "everyone"]
        .iter().any(|name| mentions_member(&lower, name));
    members.iter().filter(|member| Some(member.id.as_str()) != sender)
        .filter(|member| broadcast || mentions_member(text, &member.id) || (
            mentions_member(text, &member.name) && !members.iter().any(|other| {
                other.name != member.name && other.name.starts_with(&member.name) && mentions_member(text, &other.name)
            })
        ))
        .map(|member| member.id.clone()).collect()
}

pub const STUDIO_MAX_WAVES: usize = 8;
const STUDIO_MAX_MEMBER_TURNS: usize = 3;

/// Deduplicate within a wave so several reviewers can wake the same author once.
/// Return limited members as well, so stopping a cycle is visible to the user.
pub fn take_studio_wave(pending: &mut Vec<String>, counts: &mut HashMap<String, usize>) -> (Vec<String>, Vec<String>) {
    let mut seen = HashSet::new();
    let mut wave = Vec::new();
    let mut limited = Vec::new();
    for id in pending.drain(..) {
        if !seen.insert(id.clone()) { continue; }
        let count = counts.entry(id.clone()).or_default();
        if *count >= STUDIO_MAX_MEMBER_TURNS { limited.push(id); }
        else { *count += 1; wave.push(id); }
    }
    (wave, limited)
}

pub const STUDIO_REPLY_STYLE: &str = "最终回复规范（适用于每一位成员，优先于角色中的排版要求）：你可以充分、深入地思考与调用工具，但最终回复必须是极简精炼的一段纯文本，只保留结论、关键成果和必要的协作交接；不得换段、列点、使用标题或 Markdown 格式，需要列举时用中文分号‘；’连接。需要其他成员接手时直接写 @成员名。不要输出思考过程、工具参数或重复进度。";

/// Keep final presentation plain and in one paragraph without truncating results.
pub fn compact_studio_reply(text: &str) -> String {
    text.lines().filter_map(|line| {
        let line = line.trim().trim_start_matches('#').trim();
        let line = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).or_else(|| line.strip_prefix("• ")).unwrap_or(line);
        let line = if let Some((number, rest)) = line.split_once(". ") {
            if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) { rest } else { line }
        } else { line };
        let line = line.replace("**", "").replace("__", "").replace('`', "");
        if line.is_empty() { None } else { Some(line) }
    }).collect::<Vec<_>>().join("；")
}

pub fn route_message(studio: &Studio, text: &str) -> Result<StudioRoute> {
    let mut ids = mentioned_members(&studio.members, text, None);
    ids.sort();
    ids.dedup();
    if ids.is_empty() { ids.push(studio.host_id.clone()); Ok(StudioRoute { member_ids: ids, direct: false }) }
    else { Ok(StudioRoute { member_ids: ids, direct: true }) }
}

pub fn create_work_item(studio: &Studio, assignee_id: &str, title: &str, description: &str) -> Result<WorkItem> {
    if !studio.members.iter().any(|m| m.id == assignee_id) { bail!("assignee does not exist") }
    let now=chrono::Utc::now().timestamp_millis();
    Ok(WorkItem{id:Uuid::new_v4().to_string(),title:title.into(),description:description.into(),assignee_id:assignee_id.into(),status:WorkItemStatus::Pending,depends_on:vec![],result:String::new(),created_at:now,updated_at:now})
}

pub fn record_user_message(store: &StudioStore, studio: &Studio, text: &str) -> Result<StudioRoute> {
    let route=route_message(studio,text)?;
    store.append_message(&studio.id,&StudioMessage::new("user".into(),"用户".into(),text.into(),route.member_ids.clone()))?;
    Ok(route)
}

#[cfg(test)] mod tests { use super::*; use crate::studio::{StudioMember,ToolPermission};
fn studio()->Studio { let members=vec!["host","coder"].into_iter().map(|id|StudioMember{id:id.into(),name:if id=="host"{"主持".into()}else{"程序员".into()},avatar:String::new(),provider_id:"p".into(),model:"m".into(),role:String::new(),system_prompt:String::new(),tool_permission:ToolPermission::default(),status:Default::default()}).collect(); Studio::new("s".into(),"/workspace".into(),members,"host".into()) }
#[test] fn routes_mentions_or_host(){let s=studio();assert_eq!(route_message(&s,"处理").unwrap().member_ids,vec!["host"]);assert_eq!(route_message(&s,"@程序员 修复").unwrap().member_ids,vec!["coder"]);}
#[test] fn chinese_handoffs_and_broadcasts_use_the_same_routing() {
    let s = studio();
    for text in ["请@程序员检查", "请＠程序员检查", "**@程序员**请返修"] {
        assert_eq!(route_message(&s, text).unwrap().member_ids, vec!["coder"]);
        assert_eq!(mentioned_members(&s.members, text, Some("host")), vec!["coder"]);
    }
    for text in ["@全体请复检", "＠所有人 请复检", "@ALL 请复检"] {
        assert_eq!(route_message(&s, text).unwrap().member_ids.len(), 2);
        assert_eq!(mentioned_members(&s.members, text, Some("host")), vec!["coder"]);
    }
    assert!(mentioned_members(&s.members, "@程序员检查", Some("coder")).is_empty());
    assert_eq!(route_message(&s, "@allison 检查").unwrap().member_ids, vec!["host"]);
}
#[test] fn prefixed_chinese_names_only_wake_the_named_member() {
    let mut s = studio();
    s.members[0].name = "程序员甲".into();
    assert_eq!(mentioned_members(&s.members, "@程序员甲请检查", None), vec!["host"]);
}
#[test] fn quality_review_handoffs_can_return_to_the_author_and_reviewer() {
    let mut counts = HashMap::new();
    for id in ["host", "coder", "reviewer", "coder", "reviewer", "host"] {
        let (wave, limited) = take_studio_wave(&mut vec![id.into(), id.into()], &mut counts);
        assert_eq!(wave, vec![id]);
        assert!(limited.is_empty());
    }
    assert!(STUDIO_MAX_WAVES >= 6);
}
#[test] fn broadcasts_include_every_member_and_cycles_report_the_limit() {
    let mut counts = HashMap::new();
    let ids = (0..12).map(|n| format!("member-{n}")).collect::<Vec<_>>();
    for _ in 0..STUDIO_MAX_MEMBER_TURNS {
        let (wave, limited) = take_studio_wave(&mut ids.clone(), &mut counts);
        assert_eq!(wave, ids);
        assert!(limited.is_empty());
    }
    let (wave, limited) = take_studio_wave(&mut ids.clone(), &mut counts);
    assert!(wave.is_empty());
    assert_eq!(limited, ids);
}
}


#[cfg(test)] mod formatting_tests {
    use super::*;
    #[test] fn bold_mentions_and_boundaries() {
        assert!(mentions_member("请 **@coder** 接手", "coder"));
        assert!(mentions_member("@AI reviewer；请检查", "AI reviewer"));
        assert!(!mentions_member("@Anna", "Ann"));
        assert!(!mentions_member("mail@coder.com", "coder"));
        assert!(!mentions_member("联系 @coder.com", "coder"));
        assert!(mentions_member("Please ask @coder.", "coder"));
    }
    #[test] fn concise_plain_reply_preserves_handoffs() {
        assert_eq!(compact_studio_reply("## 完成\n- **@coder** 接手\n\n1. 检查通过"), "完成；@coder 接手；检查通过");
        assert!(STUDIO_REPLY_STYLE.contains("每一位成员"));
    }
}
