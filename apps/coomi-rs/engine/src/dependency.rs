//! 工具执行依赖图 —— 分析工具调用之间的依赖关系，实现并行执行。
//!
//! 当 Agent 同时计划多个工具调用时，分析它们之间的数据依赖，
//! 构建 DAG 并按拓扑排序分层，无依赖的工具可以并行执行。

use crate::ToolCall;
use std::collections::{HashMap, HashSet, VecDeque};

/// 工具依赖图
pub struct ToolDependencyGraph {
    nodes: HashMap<String, ToolCall>,
    edges: HashMap<String, Vec<String>>, // node -> [dependencies]
}

impl ToolDependencyGraph {
    /// 从工具调用列表构建依赖图
    pub fn build(calls: &[ToolCall]) -> Self {
        let mut nodes = HashMap::new();
        let mut edges: HashMap<String, Vec<String>> = HashMap::new();

        for call in calls {
            nodes.insert(call.id.clone(), call.clone());
            edges.insert(call.id.clone(), Vec::new());
        }

        // 分析依赖关系：如果 call A 的 arguments 中引用了 call B 的 id，则 A 依赖 B
        for (i, call_a) in calls.iter().enumerate() {
            let args_str = call_a.arguments.to_string();
            for (j, call_b) in calls.iter().enumerate() {
                if i == j {
                    continue;
                }
                if args_str.contains(&call_b.id) {
                    edges
                        .entry(call_a.id.clone())
                        .or_default()
                        .push(call_b.id.clone());
                }
            }
        }

        Self { nodes, edges }
    }

    /// 获取节点的所有依赖
    pub fn dependencies(&self, node: &str) -> Vec<&str> {
        self.edges
            .get(node)
            .map(|deps| deps.iter().map(|d| d.as_str()).collect())
            .unwrap_or_default()
    }

    /// 获取依赖此节点的节点
    pub fn dependents(&self, node: &str) -> Vec<&str> {
        let mut result = Vec::new();
        for (n, deps) in &self.edges {
            if deps.contains(&node.to_string()) {
                result.push(n.as_str());
            }
        }
        result
    }

    /// 检测循环依赖
    pub fn has_cycle(&self) -> bool {
        let mut visited = HashSet::new();
        let mut in_stack = HashSet::new();

        for node in self.nodes.keys() {
            if !visited.contains(node) {
                if self.dfs(node, &mut visited, &mut in_stack) {
                    return true;
                }
            }
        }
        false
    }

    fn dfs(
        &self,
        node: &str,
        visited: &mut HashSet<String>,
        in_stack: &mut HashSet<String>,
    ) -> bool {
        visited.insert(node.to_string());
        in_stack.insert(node.to_string());

        if let Some(deps) = self.edges.get(node) {
            for dep in deps {
                if !visited.contains(dep) {
                    if self.dfs(dep, visited, in_stack) {
                        return true;
                    }
                } else if in_stack.contains(dep) {
                    return true;
                }
            }
        }

        in_stack.remove(node);
        false
    }

    /// 反向边：node -> 依赖它的那些节点。
    fn dependents_map(&self) -> HashMap<String, Vec<String>> {
        let mut dependents: HashMap<String, Vec<String>> = HashMap::new();
        for (node, deps) in &self.edges {
            for dep in deps {
                dependents.entry(dep.clone()).or_default().push(node.clone());
            }
        }
        dependents
    }

    /// 每个节点还欠多少个依赖没完成 —— 也就是 Kahn 算法里的入度。
    fn pending_counts(&self) -> HashMap<String, usize> {
        self.nodes
            .keys()
            .map(|k| (k.clone(), self.edges.get(k).map_or(0, Vec::len)))
            .collect()
    }

    /// 当前可以执行的节点（还欠 0 个依赖）。同层排序，保证顺序稳定：
    /// HashMap 的迭代顺序不能当成执行计划的契约。
    fn ready_nodes(pending: &HashMap<String, usize>) -> Vec<String> {
        let mut ready: Vec<String> = pending
            .iter()
            .filter(|&(_, count)| *count == 0)
            .map(|(node, _)| node.clone())
            .collect();
        ready.sort();
        ready
    }

    /// 拓扑排序（Kahn 算法）：依赖在前，依赖方在后。
    pub fn topological_sort(&self) -> Option<Vec<String>> {
        if self.has_cycle() {
            return None;
        }

        // edges 记的是 node -> 它的依赖，所以入度就是「依赖个数」；
        // 每弹出一个节点，把依赖它的那些节点的欠账减一。
        let dependents = self.dependents_map();
        let mut pending = self.pending_counts();

        let mut queue: VecDeque<String> = Self::ready_nodes(&pending).into();

        let mut result = Vec::new();

        while let Some(node) = queue.pop_front() {
            result.push(node.clone());
            if let Some(list) = dependents.get(&node) {
                let mut unlocked: Vec<String> = Vec::new();
                for dependent in list {
                    if let Some(count) = pending.get_mut(dependent) {
                        *count -= 1;
                        if *count == 0 {
                            unlocked.push(dependent.clone());
                        }
                    }
                }
                unlocked.sort();
                queue.extend(unlocked);
            }
        }

        if result.len() == self.nodes.len() {
            Some(result)
        } else {
            None
        }
    }

    /// 返回可并行执行的层级（拓扑分层）：第 0 层没有任何未满足的依赖。
    pub fn execution_layers(&self) -> Vec<Vec<String>> {
        let dependents = self.dependents_map();
        let mut pending = self.pending_counts();

        let mut layers: Vec<Vec<String>> = Vec::new();
        let mut current = Self::ready_nodes(&pending);

        while !current.is_empty() {
            layers.push(current.clone());
            let mut next: Vec<String> = Vec::new();
            for node in &current {
                if let Some(list) = dependents.get(node) {
                    for dependent in list {
                        if let Some(count) = pending.get_mut(dependent) {
                            *count -= 1;
                            if *count == 0 {
                                next.push(dependent.clone());
                            }
                        }
                    }
                }
            }
            next.sort();
            next.dedup();
            current = next;
        }

        layers
    }

    /// 获取无依赖的根节点
    pub fn roots(&self) -> Vec<&str> {
        self.edges
            .iter()
            .filter(|(_, deps)| deps.is_empty())
            .map(|(n, _)| n.as_str())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_graph_no_deps() {
        let calls = vec![
            ToolCall {
                id: "1".into(),
                name: "read".into(),
                arguments: serde_json::json!({}),
            },
            ToolCall {
                id: "2".into(),
                name: "write".into(),
                arguments: serde_json::json!({}),
            },
        ];
        let graph = ToolDependencyGraph::build(&calls);
        assert_eq!(graph.len(), 2);
        assert!(!graph.has_cycle());
        assert_eq!(graph.roots().len(), 2);
    }

    #[test]
    fn test_execution_layers() {
        let calls = vec![
            ToolCall {
                id: "a".into(),
                name: "read".into(),
                arguments: serde_json::json!({}),
            },
            ToolCall {
                id: "b".into(),
                name: "grep".into(),
                arguments: serde_json::json!({"pattern": "use a"}),
            },
            ToolCall {
                id: "c".into(),
                name: "write".into(),
                arguments: serde_json::json!({"content": "use b"}),
            },
        ];
        let graph = ToolDependencyGraph::build(&calls);
        let layers = graph.execution_layers();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0], vec!["a"]);
        assert_eq!(layers[1], vec!["b"]);
        assert_eq!(layers[2], vec!["c"]);
    }
}
