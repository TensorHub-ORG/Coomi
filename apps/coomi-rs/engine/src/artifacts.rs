//! 一轮生成物（artifacts）汇总。
//!
//! 数据来源优先是「工具自己声明的落盘路径」（`ToolResult::artifacts`，宿主绝对路径），
//! 其次对写文件类工具的调用参数做一次兜底推导（模型给的相对路径或 guest 路径）。
//! 两条路都只产出**候选**：最终认定必须过真实文件校验（`fs::metadata` 且是普通文件），
//! 不存在 / 不是文件 / 无法读元数据的候选一律剔除，绝不凭空报一个路径给前端。
//! 类型（kind）按扩展名分类，口径与 `/api/sessions/{id}/artifacts` 完全一致。

use crate::types::{ToolCall, ToolResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 一轮结束时报给前端的生成物条目。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TurnArtifact {
    /// 宿主绝对路径。
    pub path: String,
    /// 文件名（前端列表直接用，不用自己再切路径）。
    pub name: String,
    /// 真实文件大小（字节）。
    pub size: u64,
    /// 按扩展名分类：image / text / code / other。
    pub kind: String,
}

/// 产物类型：给前端挑图标/预览方式用。
/// 注意与 mime 语义不同（后者是 Content-Type），不要互相复用。
pub fn artifact_kind(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" => "image",
        "txt" | "md" | "log" | "csv" | "json" | "yaml" | "yml" | "toml" | "ini" | "env" => "text",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "vue" | "py" | "sh" | "java" | "kt" | "go" | "c"
        | "cpp" | "h" | "html" | "css" | "sql" => "code",
        _ => "other",
    }
}

/// 写文件类工具的候选路径来源。
enum CandidateSource {
    /// 参数里直接带路径的键名。
    Argument(&'static str),
    /// apply_patch：补丁正文里的 `*** Add File:` / `*** Update File:` / `*** Move to:` 行。
    PatchBody,
}

/// 工具名（含模型常用别名）→ 候选路径来源；只读工具一律不在表里。
///
/// 说明：`shell` / `local_shell` / `ssh_exec` 这类「执行型」工具
/// 写出的文件只出现在命令输出里，引擎无法可靠还原，因此只认工具自己声明的
/// `ToolResult::artifacts`——宁缺勿错，不猜路径。
fn write_candidate_source(name: &str) -> Option<CandidateSource> {
    match name {
        "write_file" | "write" | "edit_file" | "edit" | "replace" => {
            Some(CandidateSource::Argument("path"))
        }
        "apply_patch" | "patch" => Some(CandidateSource::PatchBody),
        _ => None,
    }
}

/// 从一次工具调用里推导候选路径（尚未做真实文件校验）。
pub fn artifact_candidates(call: &ToolCall, result: &ToolResult) -> Vec<String> {
    // 失败/被拒的调用不产出生成物：半途中断的部分写入不算本轮成果。
    if !result.success {
        return Vec::new();
    }
    // 工具自己声明的路径最权威（已经过 SecurityPolicy 解析成宿主绝对路径）。
    if !result.artifacts.is_empty() {
        return result.artifacts.clone();
    }
    match write_candidate_source(call.name.as_str()) {
        Some(CandidateSource::Argument(key)) => call
            .arguments
            .get(key)
            .and_then(|value| value.as_str())
            .map(|value| vec![value.to_owned()])
            .unwrap_or_default(),
        Some(CandidateSource::PatchBody) => call
            .arguments
            .get("patch")
            .and_then(|value| value.as_str())
            .map(patch_sources)
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

/// 补丁正文里的文件路径（Add / Update / Move to）。
/// Delete 不算生成物；真的被删掉的路径也会在真实文件校验那一关被剔除。
fn patch_sources(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        let line = line.trim();
        let rest = line
            .strip_prefix("*** Add File:")
            .or_else(|| line.strip_prefix("*** Update File:"))
            .or_else(|| line.strip_prefix("*** Move to:"));
        if let Some(path) = rest {
            let path = path.trim();
            if !path.is_empty() {
                paths.push(path.to_owned());
            }
        }
    }
    paths
}

/// 候选路径 → 真实文件 → `[{path,name,size,kind}]`。
///
/// `base` 用于解析相对路径（会话 cwd）；绝对路径的候选原样使用。
/// 同一路径只报一次，保持首次出现顺序。
pub fn collect_turn_artifacts(candidates: &[String], base: &Path) -> Vec<TurnArtifact> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut artifacts = Vec::new();
    for candidate in candidates {
        let candidate = candidate.trim();
        if candidate.is_empty() {
            continue;
        }
        let raw = PathBuf::from(candidate);
        let path = if raw.is_absolute() { raw } else { base.join(raw) };
        if !seen.insert(path.to_string_lossy().into_owned()) {
            continue;
        }
        // 真实文件校验：不存在、不是普通文件、读不到元数据的候选全部剔除。
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_owned();
        artifacts.push(TurnArtifact {
            path: path.to_string_lossy().into_owned(),
            name,
            size: meta.len(),
            kind: artifact_kind(&path).to_owned(),
        });
    }
    artifacts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolResult;
    use serde_json::json;

    fn call(name: &str, arguments: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments,
        }
    }

    #[test]
    fn declared_artifacts_win_over_argument_fallback() {
        let result = ToolResult::success("ok").with_artifact("/tmp/declared.txt");
        let candidates = artifact_candidates(
            &call("write_file", json!({"path": "fallback.txt"})),
            &result,
        );
        assert_eq!(candidates, vec!["/tmp/declared.txt".to_owned()]);
    }

    #[test]
    fn failed_calls_do_not_produce_artifacts() {
        let result = ToolResult::error("nope").with_artifact("/tmp/declared.txt");
        assert!(artifact_candidates(&call("write_file", json!({"path": "a.txt"})), &result).is_empty());
    }

    #[test]
    fn patch_bodies_yield_added_and_updated_paths_only() {
        let patch = "*** Begin Patch\n*** Update File: src/a.rs\n*** Add File: docs/b.md\n*** Delete File: old.txt\n*** Move to: new/c.rs\n*** End Patch";
        let paths = patch_sources(patch);
        assert_eq!(
            paths,
            vec![
                "src/a.rs".to_owned(),
                "docs/b.md".to_owned(),
                "new/c.rs".to_owned()
            ]
        );
    }

    #[test]
    fn collect_drops_missing_candidates_and_keeps_real_files() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let kept = workspace.path().join("kept.rs");
        std::fs::write(&kept, "fn main() {}").expect("write fixture");
        let candidates = vec![
            "kept.rs".to_owned(),
            "kept.rs".to_owned(),
            "missing.rs".to_owned(),
            workspace.path().display().to_string(),
        ];
        let artifacts = collect_turn_artifacts(&candidates, workspace.path());
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].name, "kept.rs");
        assert_eq!(artifacts[0].size, 12);
        assert_eq!(artifacts[0].kind, "code");
        assert_eq!(artifacts[0].path, kept.display().to_string());
    }

    #[test]
    fn artifact_kind_matches_session_artifacts_endpoint() {
        assert_eq!(artifact_kind(Path::new("a.PNG")), "image");
        assert_eq!(artifact_kind(Path::new("a.md")), "text");
        assert_eq!(artifact_kind(Path::new("a.zip")), "other");
        assert_eq!(artifact_kind(Path::new("noext")), "other");
    }
}
