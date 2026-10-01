//! Agent 技能系统 —— 可复用的多步工作流定义和执行。
//!
//! 技能是预定义的多步操作序列，可以被自然语言触发。
//! 类似于 Coomi 的 "skills" 命令，但提供了更结构化的定义方式。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 技能动作
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub enum SkillAction {
    CallTool {
        tool: String,
        args: serde_json::Value,
    },
    AskUser {
        question: String,
    },
    SetMemory {
        key: String,
        value: String,
    },
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        content: String,
    },
    RunCommand {
        command: String,
    },
    Wait {
        duration_ms: u64,
    },
    SetVariable {
        key: String,
        value: serde_json::Value,
    },
    If {
        condition: String,
        then: Box<SkillStep>,
        else_: Option<Box<SkillStep>>,
    },
}

/// 技能步骤
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SkillStep {
    pub action: SkillAction,
    pub condition: Option<String>,
    pub on_failure: FailureAction,
    pub name: Option<String>,
}

impl Default for SkillStep {
    fn default() -> Self {
        Self {
            action: SkillAction::Wait { duration_ms: 0 },
            condition: None,
            on_failure: FailureAction::Abort,
            name: None,
        }
    }
}

/// 失败处理策略
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub enum FailureAction {
    Retry { max_attempts: u32 },
    Skip,
    Abort,
    AskUser,
}

/// Agent 技能定义
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub triggers: Vec<String>,
    pub steps: Vec<SkillStep>,
    pub required_tools: Vec<String>,
    pub variables: HashMap<String, serde_json::Value>,
}

impl AgentSkill {
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            triggers: Vec::new(),
            steps: Vec::new(),
            required_tools: Vec::new(),
            variables: HashMap::new(),
        }
    }

    pub fn with_trigger(mut self, trigger: impl Into<String>) -> Self {
        self.triggers.push(trigger.into());
        self
    }

    pub fn with_step(mut self, step: SkillStep) -> Self {
        self.steps.push(step);
        self
    }

    pub fn with_required_tool(mut self, tool: impl Into<String>) -> Self {
        self.required_tools.push(tool.into());
        self
    }
}

/// 技能注册表
pub struct SkillRegistry {
    skills: HashMap<String, AgentSkill>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self {
            skills: HashMap::new(),
        }
    }

    pub fn register(&mut self, skill: AgentSkill) {
        self.skills.insert(skill.name.clone(), skill);
    }

    pub fn get(&self, name: &str) -> Option<&AgentSkill> {
        self.skills.get(name)
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut AgentSkill> {
        self.skills.get_mut(name)
    }

    /// 根据触发词查找技能
    pub fn find_by_trigger(&self, input: &str) -> Vec<&AgentSkill> {
        let input_lower = input.to_lowercase();
        self.skills
            .values()
            .filter(|s| {
                s.triggers
                    .iter()
                    .any(|t| input_lower.contains(&t.to_lowercase()))
            })
            .collect()
    }

    pub fn all(&self) -> Vec<&AgentSkill> {
        self.skills.values().collect()
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }
}

impl Default for SkillRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 内置技能定义
pub fn builtin_skills() -> SkillRegistry {
    let mut registry = SkillRegistry::new();

    // 代码审查技能
    registry.register(
        AgentSkill::new("code-review", "审查代码并指出问题")
            .with_trigger("code review")
            .with_trigger("审查代码")
            .with_trigger("review this")
            .with_required_tool("grep")
            .with_required_tool("fileRead")
            .with_step(SkillStep {
                name: Some("read_target_file".to_string()),
                action: SkillAction::ReadFile {
                    path: "{{target_file}}".to_string(),
                },
                condition: None,
                on_failure: FailureAction::Abort,
            })
            .with_step(SkillStep {
                name: Some("search_patterns".to_string()),
                action: SkillAction::CallTool {
                    tool: "grep".to_string(),
                    args: serde_json::json!({
                        "pattern": "{{pattern}}",
                        "path": "{{target_file}}"
                    }),
                },
                condition: None,
                on_failure: FailureAction::Skip,
            }),
    );

    // 测试生成技能
    registry.register(
        AgentSkill::new("generate-tests", "为代码生成测试用例")
            .with_trigger("generate tests")
            .with_trigger("写测试")
            .with_trigger("test this")
            .with_required_tool("fileRead")
            .with_required_tool("fileWrite")
            .with_step(SkillStep {
                name: Some("read_source".to_string()),
                action: SkillAction::ReadFile {
                    path: "{{target_file}}".to_string(),
                },
                condition: None,
                on_failure: FailureAction::Abort,
            })
            .with_step(SkillStep {
                name: Some("write_tests".to_string()),
                action: SkillAction::WriteFile {
                    path: "{{output_file}}".to_string(),
                    content: "{{generated_tests}}".to_string(),
                },
                condition: None,
                on_failure: FailureAction::AskUser,
            }),
    );

    // 文档生成技能
    registry.register(
        AgentSkill::new("generate-docs", "从代码生成文档")
            .with_trigger("generate docs")
            .with_trigger("生成文档")
            .with_trigger("document this")
            .with_required_tool("fileRead")
            .with_required_tool("fileWrite")
            .with_step(SkillStep {
                name: Some("read_code".to_string()),
                action: SkillAction::ReadFile {
                    path: "{{target_file}}".to_string(),
                },
                condition: None,
                on_failure: FailureAction::Abort,
            })
            .with_step(SkillStep {
                name: Some("write_docs".to_string()),
                action: SkillAction::WriteFile {
                    path: "{{output_file}}".to_string(),
                    content: "{{generated_docs}}".to_string(),
                },
                condition: None,
                on_failure: FailureAction::AskUser,
            }),
    );

    registry
}
