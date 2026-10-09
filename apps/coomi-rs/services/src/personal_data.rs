use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};
use uuid::Uuid;

static NOTES_LOCK: Mutex<()> = Mutex::new(());

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("missing parent")?)?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings { pub tavily_api_key: String }

pub fn load_search_settings(home: &Path) -> Result<SearchSettings> {
    match fs::read(home.join("search-settings.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SearchSettings::default()),
        Err(e) => Err(e.into()),
    }
}
pub fn save_search_settings(home: &Path, key: &str) -> Result<()> {
    let key = key.trim();
    if key.len() > 512 || key.chars().any(char::is_control) { bail!("invalid Tavily API key"); }
    atomic_write(&home.join("search-settings.json"), &serde_json::to_vec(&SearchSettings { tavily_api_key: key.into() })?)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalNote {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub revision: u64,
}

fn note_id(id: &str) -> Result<Uuid> { Ok(Uuid::parse_str(id).context("invalid note id")?) }
fn index(home: &Path) -> Result<Vec<PersonalNote>> {
    match fs::read(home.join("notes/index.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).context("notes index is unreadable; original retained")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}
pub fn list_personal_notes(home: &Path) -> Result<Vec<PersonalNote>> {
    let _lock = NOTES_LOCK.lock().map_err(|_| anyhow::anyhow!("notes lock unavailable"))?;
    let mut notes = index(home)?;
    notes.sort_by(|a,b| b.updated_at.cmp(&a.updated_at));
    Ok(notes)
}
pub fn read_personal_note(home: &Path, id: &str) -> Result<(PersonalNote, String)> {
    let _lock = NOTES_LOCK.lock().map_err(|_| anyhow::anyhow!("notes lock unavailable"))?;
    let id = note_id(id)?.to_string();
    let note = index(home)?.into_iter().find(|n| n.id == id).context("note not found")?;
    let content = fs::read_to_string(home.join("notes").join(format!("{id}.txt")))?;
    Ok((note, content))
}
pub fn save_personal_note(home: &Path, id: &str, title: &str, content: &str, revision: u64) -> Result<PersonalNote> {
    let _lock = NOTES_LOCK.lock().map_err(|_| anyhow::anyhow!("notes lock unavailable"))?;
    let id = note_id(id)?.to_string();
    let title = title.trim();
    if title.is_empty() || title.chars().count()>80 || title.chars().any(char::is_control) { bail!("note title must contain 1–80 characters"); }
    if content.len()>1024*1024 { bail!("note exceeds 1 MiB"); }
    let mut notes = index(home)?;
    let previous = notes.iter().find(|n| n.id == id);
    if previous.map_or(0, |n| n.revision) != revision { bail!("note changed; reopen before saving"); }
    if previous.is_none() && notes.len()>=500 { bail!("at most 500 notes allowed"); }
    let note = PersonalNote { id: id.clone(), title: title.into(), updated_at: chrono::Utc::now().to_rfc3339(), revision: revision+1 };
    let path=home.join("notes").join(format!("{id}.txt"));
    let old = match fs::read(&path) { Ok(bytes)=>Some(bytes), Err(e) if e.kind()==std::io::ErrorKind::NotFound=>None, Err(e)=>return Err(e.into()) };
    atomic_write(&path,content.as_bytes())?;
    notes.retain(|n| n.id != id); notes.push(note.clone());
    if let Err(e)=atomic_write(&home.join("notes/index.json"),&serde_json::to_vec(&notes)?) {
        if let Some(bytes)=old { atomic_write(&path,&bytes)?; } else { let _=fs::remove_file(&path); }
        return Err(e);
    }
    Ok(note)
}
pub fn delete_personal_note(home: &Path, id: &str, revision: u64) -> Result<()> {
    let _lock = NOTES_LOCK.lock().map_err(|_| anyhow::anyhow!("notes lock unavailable"))?;
    let id=note_id(id)?.to_string();
    let mut notes=index(home)?;
    let note=notes.iter().find(|n| n.id==id).context("note not found")?;
    if note.revision!=revision { bail!("note changed; refresh before deleting"); }
    notes.retain(|n| n.id!=id);
    atomic_write(&home.join("notes/index.json"),&serde_json::to_vec(&notes)?)?;
    let _=fs::remove_file(home.join("notes").join(format!("{id}.txt")));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notes_keep_txt_and_detect_stale_edits() {
        let dir=tempfile::tempdir().unwrap(); let home=dir.path(); let id=Uuid::new_v4().to_string();
        let first=save_personal_note(home,&id,"备忘","first",0).unwrap();
        assert_eq!(fs::read_to_string(home.join(format!("notes/{id}.txt"))).unwrap(),"first");
        assert!(save_personal_note(home,&id,"stale","lost",0).is_err());
        let next=save_personal_note(home,&id,"备忘","second",first.revision).unwrap();
        assert_eq!(read_personal_note(home,&id).unwrap().1,"second");
        assert!(delete_personal_note(home,&id,first.revision).is_err());
        assert!(read_personal_note(home,"../index").is_err());
        delete_personal_note(home,&id,next.revision).unwrap(); assert!(list_personal_notes(home).unwrap().is_empty());
    }
    #[test]
    fn search_key_persists_and_can_be_cleared() {
        let dir=tempfile::tempdir().unwrap();
        assert!(load_search_settings(dir.path()).unwrap().tavily_api_key.is_empty());
        save_search_settings(dir.path()," tvly-example ").unwrap();
        assert_eq!(load_search_settings(dir.path()).unwrap().tavily_api_key,"tvly-example");
        save_search_settings(dir.path(),"").unwrap();
        assert!(load_search_settings(dir.path()).unwrap().tavily_api_key.is_empty());
    }
}
