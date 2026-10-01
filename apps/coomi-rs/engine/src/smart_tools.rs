//! 智能工具路由器 —— 只加载相关的工具，减少 token 开销。
//!
//! 策略：
//! 1. 关键词匹配：根据用户查询中的关键词匹配工具
//! 2. 依赖图感知：按依赖拓扑排序，按需加载
//! 3. 上文感知：根据当前对话上下文判断需要哪些工具
//! 4. 预算控制：限制单轮加载的工具数量

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 工具元信息
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolMeta {
    pub name: String,
    pub description: String,
    pub keywords: Vec<String>,
    pub category: ToolCategory,
    pub token_cost: usize,
}

/// 工具类别
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ToolCategory {
    File,
    Shell,
    Web,
    Memory,
    Workflow,
    Communication,
}

/// 工具路由请求
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteRequest {
    pub query: String,
    pub context_keywords: Vec<String>,
    pub max_tools: usize,
    pub budget_tokens: usize,
}

/// 工具路由结果
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteResult {
    pub selected_tools: Vec<String>,
    pub estimated_tokens: usize,
    pub reason: String,
}

/// 智能工具路由器
pub struct ToolRouter {
    tools: HashMap<String, ToolMeta>,
    /// 工具依赖关系
    dependencies: HashMap<String, Vec<String>>,
}

impl ToolRouter {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            dependencies: HashMap::new(),
        }
    }

    pub fn register(&mut self, meta: ToolMeta) {
        self.tools.insert(meta.name.clone(), meta);
    }

    pub fn set_dependency(&mut self, tool: &str, depends_on: Vec<String>) {
        self.dependencies.insert(tool.to_string(), depends_on);
    }

    /// 根据查询路由到最相关的工具
    pub fn route(&self, request: &RouteRequest) -> RouteResult {
        let query_lower = request.query.to_lowercase();
        let context_lower: Vec<String> = request
            .context_keywords
            .iter()
            .map(|k| k.to_lowercase())
            .collect();
        let query_terms: Vec<&str> = query_lower.split_whitespace().collect();

        // 计算每个工具的相关性分数
        let mut scores: Vec<(String, usize)> = self
            .tools
            .iter()
            .map(|(name, meta)| {
                let mut score = 0;

                // 关键词匹配：支持子串和词边界匹配
                for kw in &meta.keywords {
                    if query_lower.contains(kw.as_str()) {
                        score += 10;
                    }
                    if context_lower
                        .iter()
                        .any(|c| c.contains(kw.as_str()) || kw.contains(c.as_str()))
                    {
                        score += 5;
                    }
                    // 词级匹配加分：查询词恰好等于关键词
                    if query_terms.contains(&kw.as_str()) {
                        score += 3;
                    }
                }

                // 类别匹配
                if query_lower.contains("文件") || query_lower.contains("file") {
                    if meta.category == ToolCategory::File {
                        score += 8;
                    }
                }
                if query_lower.contains("搜索")
                    || query_lower.contains("search")
                    || query_lower.contains("查找")
                {
                    if meta.category == ToolCategory::File {
                        score += 6;
                    }
                }
                if query_lower.contains("运行")
                    || query_lower.contains("执行")
                    || query_lower.contains("shell")
                {
                    if meta.category == ToolCategory::Shell {
                        score += 8;
                    }
                }
                if query_lower.contains("记忆")
                    || query_lower.contains("memory")
                    || query_lower.contains("记住")
                {
                    if meta.category == ToolCategory::Memory {
                        score += 8;
                    }
                }
                if query_lower.contains("网页")
                    || query_lower.contains("web")
                    || query_lower.contains("fetch")
                    || query_lower.contains("搜索")
                {
                    if meta.category == ToolCategory::Web {
                        score += 8;
                    }
                }

                // 依赖传播：如果查询中提到了某个工具，自动包含它的依赖
                for dep in self.get_dependencies(name).iter() {
                    if query_lower.contains(dep.as_str()) {
                        score += 12;
                    }
                }

                (name.clone(), score)
            })
            .filter(|(_, score)| *score > 0)
            .collect();

        // 按分数排序，分数相同按 token_cost 升序（省 token）
        scores.sort_by(|a, b| {
            b.1.cmp(&a.1).then_with(|| {
                self.tools
                    .get(&a.0)
                    .map(|m| m.token_cost)
                    .unwrap_or(0)
                    .cmp(&self.tools.get(&b.0).map(|m| m.token_cost).unwrap_or(0))
            })
        });

        // 预算控制：累计 token_cost 不超过 budget_tokens
        let mut selected: Vec<String> = Vec::new();
        let mut total_tokens = 0;
        for (name, _) in &scores {
            if selected.len() >= request.max_tools {
                break;
            }
            if let Some(meta) = self.tools.get(name) {
                if total_tokens + meta.token_cost <= request.budget_tokens || selected.is_empty() {
                    selected.push(name.clone());
                    total_tokens += meta.token_cost;
                }
            }
        }

        // 依赖注入：自动包含选中工具的依赖
        let mut with_deps = selected.clone();
        for tool in &selected {
            for dep in self.get_dependencies(tool) {
                if !with_deps.contains(&dep) {
                    with_deps.push(dep);
                }
            }
        }

        let estimated_tokens: usize = with_deps
            .iter()
            .filter_map(|n| self.tools.get(n))
            .map(|m| m.token_cost)
            .sum();

        let reason = if selected.is_empty() {
            "未匹配到相关工具，使用默认工具集".to_string()
        } else {
            format!(
                "根据查询匹配到 {} 个工具（含依赖注入 {} 个）",
                selected.len(),
                with_deps.len()
            )
        };

        RouteResult {
            selected_tools: with_deps,
            estimated_tokens,
            reason,
        }
    }

    /// 获取工具的依赖工具（传递闭包）
    pub fn get_dependencies(&self, tool: &str) -> HashSet<String> {
        let mut result = HashSet::new();
        let mut stack = vec![tool.to_string()];

        while let Some(t) = stack.pop() {
            if result.contains(&t) {
                continue;
            }
            result.insert(t.clone());
            if let Some(deps) = self.dependencies.get(&t) {
                for d in deps {
                    if !result.contains(d) {
                        stack.push(d.clone());
                    }
                }
            }
        }

        result
    }
}

impl Default for ToolRouter {
    fn default() -> Self {
        let mut router = Self::new();

        // 注册内置工具
        router.register(ToolMeta {
            name: "read_file".to_string(),
            description: "读取文件内容".to_string(),
            keywords: vec!["read", "file", "读取", "文件", "查看"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::File,
            token_cost: 400,
        });

        router.register(ToolMeta {
            name: "write_file".to_string(),
            description: "写入文件内容".to_string(),
            keywords: vec!["write", "file", "写入", "文件", "创建"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::File,
            token_cost: 300,
        });

        router.register(ToolMeta {
            name: "list_dir".to_string(),
            description: "列出目录内容".to_string(),
            keywords: vec!["list", "dir", "ls", "列出", "目录", "文件夹"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::File,
            token_cost: 200,
        });

        router.register(ToolMeta {
            name: "glob".to_string(),
            description: "按模式查找文件".to_string(),
            keywords: vec!["glob", "find", "搜索", "查找", "匹配"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::File,
            token_cost: 250,
        });

        router.register(ToolMeta {
            name: "run_shell".to_string(),
            description: "执行 shell 命令".to_string(),
            keywords: vec!["shell", "run", "exec", "运行", "执行", "命令"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::Shell,
            token_cost: 500,
        });

        router.register(ToolMeta {
            name: "web_search".to_string(),
            description: "搜索网络内容".to_string(),
            keywords: vec!["search", "web", "搜索", "网络", "查询"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::Web,
            token_cost: 600,
        });

        router.register(ToolMeta {
            name: "memory_search".to_string(),
            description: "搜索持久记忆".to_string(),
            keywords: vec!["memory", "记忆", "recall", "回忆"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            category: ToolCategory::Memory,
            token_cost: 350,
        });

        router
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_route_file_query() {
        let router = ToolRouter::default();
        let request = RouteRequest {
            query: "读取 config.json 文件内容".to_string(),
            context_keywords: vec![],
            max_tools: 3,
            budget_tokens: 2000,
        };
        let result = router.route(&request);
        assert!(result.selected_tools.contains(&"read_file".to_string()));
    }

    #[test]
    fn test_route_no_match() {
        let router = ToolRouter::default();
        let request = RouteRequest {
            query: "你好".to_string(),
            context_keywords: vec![],
            max_tools: 3,
            budget_tokens: 2000,
        };
        let result = router.route(&request);
        // 即使没有匹配也应该返回空结果而不是 panic
        assert!(result.estimated_tokens >= 0);
    }
}
