//! A bounded replay of the current turn, independent of transport acknowledgements.
//! Disk checkpoints remain authoritative for execution; this journal only restores UI.
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENTS: usize = 8_192;

#[derive(Default)]
pub(crate) struct SessionView {
    pub base: Option<Value>,
    pub events: VecDeque<Value>,
    pub event_seq: u64,
    pub truncated: bool,
    bytes: usize,
    users: HashSet<String>,
}

impl SessionView {
    pub fn reset(&mut self, base: Value, seq: u64) {
        *self = Self { base: Some(base), event_seq: seq, ..Self::default() };
        if let Some(messages) = self.base.as_ref().and_then(|b| b["messages"].as_array()) {
            for message in messages {
                if let Some(id) = message["id"].as_str() {
                    self.users.insert(id.to_owned());
                }
            }
        }
    }

    /// Keep the pre-turn base: advancing it at every tool checkpoint would lose
    /// reasoning and duplicate text already represented by replayed deltas.
    /// New public user messages (including queued input) are journaled by ID.
    pub fn saved_messages(&mut self, session: Value) -> Vec<Value> {
        if self.truncated {
            self.reset(session, self.event_seq);
            return Vec::new();
        }
        session["messages"].as_array().into_iter().flatten()
            .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant"))
                && m["internal"] != true && m["compaction_summary"] != true)
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                self.users.insert(id.to_owned()).then(|| json!({
                    "event_type": if m["role"] == "user" { "user_message" } else { "assistant_message" },
                    "message_id": id, "content": m["content"],
                    "reasoning": m["reasoning"], "reasoning_state": m["reasoning_state"],
                }))
            }).collect()
    }

    pub fn push(&mut self, mut event: Value) {
        self.event_seq = event["event_seq"].as_u64().unwrap_or(self.event_seq);
        // Bound even a single unusually large tool/image event. The complete
        // result remains in SessionStore; the next successful checkpoint rebases.
        if event.to_string().len() > MAX_BYTES / 2 {
            self.truncated = true;
            event.as_object_mut().map(|object| object.remove("images"));
            for key in ["content", "result_preview"] {
                if let Some(text) = event[key].as_str() {
                    let mut end = text.len().min(MAX_BYTES / 4);
                    while !text.is_char_boundary(end) { end -= 1; }
                    event[key] = json!(format!("{}\n[视图内容过长，完整结果以会话记录为准]", &text[..end]));
                }
            }
        }
        let size = event.to_string().len();
        let kind = event["event_type"].as_str().unwrap_or_default();
        if matches!(kind, "text_chunk" | "reasoning_chunk")
            && self.events.back().is_some_and(|last| last["event_type"] == event["event_type"])
            && self.bytes + size < MAX_BYTES
        {
            let last = self.events.back_mut().unwrap();
            let old_size = last.to_string().len();
            let mut text = last["content"].as_str().unwrap_or_default().to_owned();
            text.push_str(event["content"].as_str().unwrap_or_default());
            last["content"] = json!(text);
            last["event_seq"] = event["event_seq"].clone();
            self.bytes = self.bytes.saturating_sub(old_size) + last.to_string().len();
        } else {
            self.bytes += size;
            self.events.push_back(event);
        }
        while self.bytes > MAX_BYTES || self.events.len() > MAX_EVENTS {
            let Some(old) = self.events.pop_front() else { break };
            self.bytes = self.bytes.saturating_sub(old.to_string().len());
            self.truncated = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoints_do_not_duplicate_output_or_lose_reasoning() {
        let mut view = SessionView::default();
        view.reset(json!({"messages": []}), 0);
        let session = json!({"messages": [{"id":"u", "role":"user", "content":"hello"}]});
        let users = view.saved_messages(session.clone());
        assert_eq!(users.len(), 1);
        assert!(view.saved_messages(session).is_empty());
        for (seq, kind, content) in [(1,"reasoning_chunk","think"),(2,"text_chunk","a"),(3,"text_chunk","b")] {
            view.push(json!({"event_seq":seq,"event_type":kind,"content":content}));
        }
        let committed = view.saved_messages(json!({"messages":[{"id":"u","role":"user"},{"id":"a","role":"assistant","content":"ab"}]}));
        assert_eq!(committed[0]["event_type"], "assistant_message");
        assert_eq!(committed[0]["message_id"], "a");
        assert_eq!(view.events.len(), 2);
        assert_eq!(view.events[0]["content"], "think");
        assert_eq!(view.events[1]["content"], "ab");
        assert_eq!(view.event_seq, 3);
        assert_eq!(view.base.as_ref().unwrap()["messages"], json!([]));
    }

    #[test]
    fn reset_boundaries_and_overflow_are_explicit() {
        let mut view = SessionView::default();
        view.reset(json!({"messages": []}), 0);
        for seq in 1..=MAX_EVENTS + 1 {
            view.push(json!({"event_seq":seq,"event_type":"tool_running","call_id":seq}));
        }
        assert!(view.truncated);
        assert!(view.events.len() <= MAX_EVENTS);
        view.saved_messages(json!({"messages":[{"role":"assistant","content":"saved"}]}));
        assert!(!view.truncated);
        assert!(view.events.is_empty());
        assert_eq!(view.event_seq, (MAX_EVENTS + 1) as u64);
        view.push(json!({"event_seq":MAX_EVENTS+2,"event_type":"stream_reset"}));
        view.push(json!({"event_seq":MAX_EVENTS+3,"event_type":"text_chunk","content":"new"}));
        assert_eq!(view.events.len(), 2);
    }
}
