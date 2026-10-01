//! 向后兼容 re-export：新实现在 `crate::group` 模块。
//! 旧路径 `crate::group_chat::*` 继续可用，无需改调用方。
pub use crate::group::*;
