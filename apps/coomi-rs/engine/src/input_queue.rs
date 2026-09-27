use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Default)]
pub struct InputQueue {
    messages: Mutex<VecDeque<String>>,
}

impl InputQueue {
    pub fn push(&self, message: String) {
        self.messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(message);
    }

    pub fn drain(&self) -> Vec<String> {
        self.messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect()
    }

    pub fn discard_front(&self, message: &str) {
        let mut messages = self
            .messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if messages.front().is_some_and(|queued| queued == message) {
            messages.pop_front();
        }
    }
}
