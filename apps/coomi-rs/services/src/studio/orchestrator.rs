use super::{Studio, StudioMessage, StudioStore, WorkItem, WorkItemStatus};
use anyhow::{Result, bail};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct StudioRoute { pub member_ids: Vec<String>, pub direct: bool }

pub fn route_message(studio: &Studio, text: &str) -> Result<StudioRoute> {
    let mut ids = Vec::new();
    for member in &studio.members {
        if text.contains(&format!("@{}", member.name)) || text.contains(&format!("@{}", member.id)) { ids.push(member.id.clone()); }
    }
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

