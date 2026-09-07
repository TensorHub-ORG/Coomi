use super::{Studio, StudioMessage, WorkItem};
use anyhow::{Context, Result, bail};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Clone)]
pub struct StudioStore { root: PathBuf }

impl StudioStore {
    pub fn new(root: impl Into<PathBuf>) -> Self { Self { root: root.into() } }
    fn dir(&self, id: &str) -> PathBuf { self.root.join(id) }
    fn studio_path(&self, id: &str) -> PathBuf { self.dir(id).join("studio.json") }
    fn work_path(&self, id: &str) -> PathBuf { self.dir(id).join("work-items.json") }
    fn messages_path(&self, id: &str) -> PathBuf { self.dir(id).join("messages.jsonl") }

    pub fn list(&self) -> Result<Vec<Studio>> {
        if !self.root.exists() { return Ok(Vec::new()) }
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let path = entry?.path().join("studio.json");
            if path.is_file() { if let Ok(v) = read_json(&path) { out.push(v) } }
        }
        out.sort_by_key(|s: &Studio| std::cmp::Reverse(s.updated_at));
        Ok(out)
    }

    pub fn load(&self, id: &str) -> Result<Studio> { read_json(&self.studio_path(id)) }

    pub fn save(&self, mut studio: Studio) -> Result<Studio> {
        validate(&studio)?;
        studio.updated_at = chrono::Utc::now().timestamp_millis();
        let dir = self.dir(&studio.id); fs::create_dir_all(&dir)?;
        write_json_atomic(&self.studio_path(&studio.id), &studio)?;
        if !self.work_path(&studio.id).exists() { write_json_atomic(&self.work_path(&studio.id), &Vec::<WorkItem>::new())?; }
        Ok(studio)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let dir = self.dir(id); if dir.exists() { fs::remove_dir_all(dir)?; } Ok(())
    }

    pub fn messages(&self, id: &str) -> Result<Vec<StudioMessage>> {
        let path = self.messages_path(id); if !path.exists() { return Ok(Vec::new()) }
        Ok(fs::read_to_string(path)?.lines().filter_map(|line| serde_json::from_str(line).ok()).collect())
    }

    pub fn append_message(&self, id: &str, message: &StudioMessage) -> Result<()> {
        fs::create_dir_all(self.dir(id))?;
        let mut file = fs::OpenOptions::new().create(true).append(true).open(self.messages_path(id))?;
        serde_json::to_writer(&mut file, message)?; file.write_all(b"\n")?; file.sync_data()?; Ok(())
    }

    pub fn work_items(&self, id: &str) -> Result<Vec<WorkItem>> {
        let path = self.work_path(id); if !path.exists() { return Ok(Vec::new()) } read_json(&path)
    }

    pub fn save_work_items(&self, id: &str, items: &[WorkItem]) -> Result<()> {
        fs::create_dir_all(self.dir(id))?; write_json_atomic(&self.work_path(id), items)
    }
}

fn validate(studio: &Studio) -> Result<()> {
    if studio.name.trim().is_empty() { bail!("studio name is required") }
    if studio.members.len() < 2 || studio.members.len() > 12 { bail!("studio must contain 2 to 12 members") }
    if !studio.members.iter().any(|m| m.id == studio.host_id) { bail!("host member does not exist") }
    let workspace = Path::new(&studio.shared_dir);
    if !workspace.is_absolute() { bail!("workspace must be absolute") }
    let mut ids = std::collections::HashSet::new();
    if studio.members.iter().any(|m| m.name.trim().is_empty() || !ids.insert(&m.id)) { bail!("member names and ids must be unique and non-empty") }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("read {}", path.display()))?)
        .with_context(|| format!("parse {}", path.display()))
}
fn write_json_atomic<T: serde::Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("tmp"); fs::write(&tmp, serde_json::to_vec_pretty(value)?)?; fs::rename(tmp, path)?; Ok(())
}

#[cfg(test)]
mod tests {
    use super::*; use crate::studio::{StudioMember, ToolPermission};
    #[test] fn studio_store_round_trip() {
        let dir=tempfile::tempdir().unwrap(); let store=StudioStore::new(dir.path());
        let member=StudioMember{id:"host".into(),name:"主持".into(),avatar:String::new(),provider_id:"p".into(),model:"m".into(),role:String::new(),system_prompt:String::new(),tool_permission:ToolPermission::default(),status:Default::default()};
        let member2=StudioMember{id:"helper".into(),name:"协作".into(),avatar:String::new(),provider_id:"p".into(),model:"m".into(),role:String::new(),system_prompt:String::new(),tool_permission:ToolPermission::default(),status:Default::default()};
        // 工作目录必须是绝对路径：用临时目录拼出跨平台（Windows/Unix）均成立的绝对路径。
        let workspace = dir.path().join("workspace");
        let studio=Studio::new("项目".into(),workspace.display().to_string(),vec![member, member2],"host".into());
        let saved=store.save(studio).unwrap(); assert_eq!(store.load(&saved.id).unwrap().name,"项目");
        let msg=StudioMessage::new("user".into(),"用户".into(),"开始".into(),vec![]); store.append_message(&saved.id,&msg).unwrap(); assert_eq!(store.messages(&saved.id).unwrap().len(),1);
    }
}

