use crate::ChatMessage;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use tokio::sync::Notify;

/// 一条「运行中插话」：结构化用户消息 + 前端回执用的 id。
///
/// 与排队的整轮消息（下一条独立 turn）不同，插话是在**当前轮的下一个安全点**
/// 并入本轮上下文继续跑，不新开一轮。
#[derive(Clone, Debug)]
pub struct Interjection {
    pub id: String,
    pub message: ChatMessage,
}

#[derive(Default)]
pub struct InputQueue {
    messages: Mutex<VecDeque<String>>,
    /// 运行中插话队列：只由「当前轮」的引擎循环消费。
    interjections: Mutex<VecDeque<Interjection>>,
    /// 待并入插话条数：流式循环每个 delta 都可能查一次，必须是原子的。
    pending: AtomicUsize,
    /// 插话唤醒：让正在流式输出的模型请求在选择点立刻醒来做软打断。
    notify: Notify,
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

    /// 运行中插话入队：返回它在队列里的位置（1 起，供界面显示「插话 #n」）。
    ///
    /// notify_one 而不是 notify_waiters：没有 waiter 时它会把 permit 留住，
    /// 「引擎刚查完还没开始等」这个瞬间入队的插话也不会丢唤醒。
    pub fn push_interjection(&self, id: impl Into<String>, message: ChatMessage) -> usize {
        let position = {
            let mut queue = self
                .interjections
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue.push_back(Interjection {
                id: id.into(),
                message,
            });
            queue.len()
        };
        self.pending.store(position, Ordering::SeqCst);
        self.notify.notify_one();
        position
    }

    pub fn has_pending_interjections(&self) -> bool {
        self.pending.load(Ordering::SeqCst) > 0
    }

    pub fn pending_interjections(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    /// 取走全部待并入插话（引擎在当前轮安全点调用）。
    pub fn drain_interjections(&self) -> Vec<Interjection> {
        let drained: Vec<Interjection> = {
            let mut queue = self
                .interjections
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue.drain(..).collect()
        };
        if !drained.is_empty() {
            self.pending.store(0, Ordering::SeqCst);
        }
        drained
    }

    /// 等待「有插话进来」。与 has_pending_interjections 配合使用：
    /// 先查标志再 await，避免查完到注册 waiter 之间的窗口丢事件。
    pub async fn wait_for_interjection(&self) {
        self.notify.notified().await;
    }
}
