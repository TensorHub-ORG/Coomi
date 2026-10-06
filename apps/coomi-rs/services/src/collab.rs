use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabRole {
    pub id: String,
    pub name: String,
    #[serde(default)] pub model_selector: String,
    #[serde(default)] pub prompt: String,
    #[serde(default)] pub color: String,
    #[serde(default)] pub icon: String,
    #[serde(default)] pub visibility: String,
    #[serde(default)] pub allowed_paths: Vec<String>,
    #[serde(default)] pub forbidden_paths: Vec<String>,
    #[serde(default)] pub role_type: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabAgent {
    pub id: String,
    pub role_id: String,
    pub name: String,
    pub status: String,
    #[serde(default)] pub output: String,
    #[serde(default)] pub reasoning: String,
    #[serde(default)] pub current_message: String,
    #[serde(default)] pub activities: Vec<CollabActivity>,
    #[serde(default)] pub started_at_ms: Option<i64>,
    #[serde(default)] pub finished_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabActivity {
    pub id: String,
    pub kind: String,
    #[serde(default)] pub content: String,
    #[serde(default)] pub tool_name: String,
    #[serde(default)] pub arguments: serde_json::Value,
    #[serde(default)] pub tool_status: String,
    pub ts_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub content: String,
    pub ts_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabEvent {
    pub seq: u64,
    pub event_type: String,
    pub detail: serde_json::Value,
    pub ts_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabArtifact {
    pub id: String,
    pub path: String,
    pub name: String,
    #[serde(default)] pub kind: String,
    #[serde(default)] pub action: String,
    #[serde(default)] pub agent_id: String,
    #[serde(default)] pub size: u64,
    pub modified_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabTask {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub session_id: String,
    pub cwd: String,
    #[serde(default)] pub attachments: Vec<String>,
    pub mode: String,
    pub status: String,
    #[serde(default)] pub roles: Vec<CollabRole>,
    #[serde(default)] pub agents: Vec<CollabAgent>,
    #[serde(default)] pub messages: Vec<CollabMessage>,
    #[serde(default)] pub events: Vec<CollabEvent>,
    #[serde(default)] pub artifacts: Vec<CollabArtifact>,
    #[serde(default)] pub summary: String,
    #[serde(default)] pub retry_count: u32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)] pub started_at_ms: Option<i64>,
    #[serde(default)] pub finished_at_ms: Option<i64>,
}
impl CollabTask {
    pub fn new(title:String, objective:String, session_id:String, cwd:String, mode:String, roles:Vec<CollabRole>)->Self{
        let now=chrono::Utc::now().timestamp_millis();
        let agents=roles.iter().map(|r|CollabAgent{id:r.id.clone(),role_id:r.id.clone(),name:r.name.clone(),status:"waiting".into(),output:String::new(),reasoning:String::new(),current_message:String::new(),activities:vec![],started_at_ms:None,finished_at_ms:None}).collect();
        Self{id:Uuid::new_v4().to_string(),title,objective,session_id,cwd,attachments:vec![],mode,status:"draft".into(),roles,agents,messages:vec![],events:vec![],artifacts:vec![],summary:String::new(),retry_count:0,created_at_ms:now,updated_at_ms:now,started_at_ms:None,finished_at_ms:None}
    }
    pub fn push_event(&mut self,event_type:impl Into<String>,detail:serde_json::Value){
        let seq=self.events.last().map(|e|e.seq+1).unwrap_or(1); self.events.push(CollabEvent{seq,event_type:event_type.into(),detail,ts_ms:chrono::Utc::now().timestamp_millis()});
        if self.events.len()>1000{let n=self.events.len()-1000;self.events.drain(..n);}
        self.updated_at_ms=chrono::Utc::now().timestamp_millis();
    }
}

#[derive(Clone)]
pub struct CollabStore{root:PathBuf}
impl CollabStore{
    pub fn new(home:impl AsRef<Path>)->Self{Self{root:home.as_ref().join("collab").join("tasks")}}
    fn path(&self,id:&str)->PathBuf{self.root.join(format!("{id}.json"))}
    pub fn list(&self)->Result<Vec<CollabTask>>{if !self.root.exists(){return Ok(vec![])}let mut v=fs::read_dir(&self.root)?.filter_map(|e|{let p=e.ok()?.path();if p.extension().and_then(|v|v.to_str())!=Some("json"){return None}serde_json::from_slice::<CollabTask>(&fs::read(p).ok()?).ok()}).collect::<Vec<_>>();v.sort_by_key(|t|std::cmp::Reverse(t.updated_at_ms));Ok(v)}
    pub fn load(&self,id:&str)->Result<CollabTask>{serde_json::from_slice(&fs::read(self.path(id)).with_context(||format!("read collab task {id}"))?).with_context(||format!("parse collab task {id}"))}
    pub fn save(&self,mut task:CollabTask)->Result<CollabTask>{validate(&task)?;task.updated_at_ms=chrono::Utc::now().timestamp_millis();fs::create_dir_all(&self.root)?;let p=self.path(&task.id);let tmp=p.with_extension("tmp");fs::write(&tmp,serde_json::to_vec_pretty(&task)?)?;fs::rename(tmp,p)?;Ok(task)}
    pub fn delete(&self,id:&str)->Result<()>{let p=self.path(id);if p.exists(){fs::remove_file(p)?;}Ok(())}
}
fn validate(t:&CollabTask)->Result<()>{if t.objective.trim().is_empty(){bail!("collab objective is required")}if t.roles.is_empty()||t.roles.len()>30{bail!("collab roles must contain 1 to 30 entries")}if !matches!(t.mode.as_str(),"parallel"|"coordinated"|"orchestrated"){bail!("invalid collab mode")}Ok(())}
