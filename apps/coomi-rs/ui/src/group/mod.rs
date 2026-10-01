//! 独立群聊模块：类型 / 运行时 / 发言引擎 / 提示词 / 策略 / 信任 / 审计。
//!
//! 房间 → 成员（角色）→ 消息；支持轮流发言 / 开放抢麦 / 主持指定；
//! 话题锚定与发言配额；@波次队列；项目隔离与身份共享。
//! HTTP handlers 在 `crate::web::api::group`。

pub mod atmosphere;
pub mod audit;
pub mod engine;
pub mod prompt;
pub mod runtime;
pub mod speech_strategy;
pub mod trust;
pub mod types;

// 向后兼容 re-export
pub use runtime::GroupChatRuntime;
pub use types::*;

// 旧路径兼容（其他模块直接用 crate::group_chat::xxx）
pub use engine::{agent_speak_ex, run_member_reply, run_wave, user_speak_ex};
pub use prompt::{build_member_sys, parse_mentions, speaker_prompt, split_file_marker};
