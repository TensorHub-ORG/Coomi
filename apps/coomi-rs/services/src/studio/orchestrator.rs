use super::{Studio, StudioMessage, StudioStore, WorkItem, WorkItemStatus};
use anyhow::{Result, bail};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct StudioRoute { pub member_ids: Vec<String>, pub direct: bool }

/// Formatting around a mention is allowed; identifiers must match in full.
pub fn mentions_member(text: &str, name: &str) -> bool {
    if name.is_empty() { return false; }
    let marker = format!("@{name}");
    text.match_indices(&marker).any(|(start, matched)| {
        let before = text[..start].chars().next_back();
        let after = text[start + matched.len()..].chars().next();
        let identifier = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
        !before.is_some_and(identifier) && !after.is_some_and(identifier)
    })
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
    let broadcast = ["@全体", "@所有人", "@all", "@everyone"]
        .iter()
        .any(|marker| text.to_ascii_lowercase().contains(&marker.to_ascii_lowercase()));
    if broadcast {
        return Ok(StudioRoute {
            member_ids: studio.members.iter().map(|member| member.id.clone()).collect(),
            direct: true,
        });
    }
    let mut ids = Vec::new();
    for member in &studio.members {
        if mentions_member(text, &member.name) || mentions_member(text, &member.id) { ids.push(member.id.clone()); }
    }
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
}


#[cfg(test)] mod formatting_tests {
    use super::*;
    #[test] fn bold_mentions_and_boundaries() {
        assert!(mentions_member("请 **@coder** 接手", "coder"));
        assert!(mentions_member("@AI reviewer；请检查", "AI reviewer"));
        assert!(!mentions_member("@Anna", "Ann"));
        assert!(!mentions_member("mail@coder.com", "coder"));
    }
    #[test] fn concise_plain_reply_preserves_handoffs() {
        assert_eq!(compact_studio_reply("## 完成\n- **@coder** 接手\n\n1. 检查通过"), "完成；@coder 接手；检查通过");
        assert!(STUDIO_REPLY_STYLE.contains("每一位成员"));
    }
}
