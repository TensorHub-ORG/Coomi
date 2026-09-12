//! 对话内 Git 工具集：让 AI 在会话里直接查看/暂存/提交/打快照/还原。
//!
//! 设计约定（与 `services::git_engine` 思路对齐）：
//! - 所有 git 命令通过 `tokio::process::Command` 参数化执行，绝不经过 shell，
//!   用户提供的路径/分支名/消息一律作为独立参数传入。
//! - git 执行优先经 `services::git_engine::run_git` 的 PRoot Linux 路由：
//!   `runtime_home`（Coomi home，含 runtime-v2）可用时在 guest 内执行
//!   （Android 宿主通常没有 git 二进制），运行时不可用自动回退宿主。
//! - 强制 `LC_ALL=C` 与 `GIT_TERMINAL_PROMPT=0`，保证解析输出稳定且不会挂起等待输入。
//! - 仓库根 = 调用方传入的 workspace 绝对路径（`current_dir`）。
//! - 状态解析复用 porcelain v2 思路：`git status --porcelain=v2 --branch -z`，
//!   头部行（`# branch.head` / `# branch.ab`）与条目行均以 NUL 分隔，可直接按
//!   `\0` 切分后逐行归类到 staged / unstaged / untracked / conflicted。
//! - 快照使用 git 对象法：临时索引 + `write-tree` + `commit-tree` + 独立 ref
//!   （`refs/coomi/snap/<id>`），不触碰用户暂存区，可被 `reset --hard` 精确还原。
//! - 安全级别：只读工具（git_status / git_diff / git_branches / git_log /
//!   git_stash action=list / git_snapshot action=list）直接执行；变更类工具
//!   （git_stage / git_commit / git_snapshot create / git_restore /
//!   git_stash push|pop|drop）必须先经过 ApprovalHandler 批准；approvals 为
//!   None 时拒绝执行并返回 "requires approval"。

use coomi_engine::ApprovalHandler;
use coomi_engine::ToolCall;
use coomi_engine::ToolResult;
use coomi_engine::ToolSpec;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// 单次 diff 输出上限（约 200 KiB），超出截断并追加提示。
const MAX_DIFF_BYTES: usize = 200 * 1024;
/// git_log 的 limit 上限。
const MAX_LOG_LIMIT: usize = 200;
/// 快照独立 ref 前缀。
const SNAPSHOT_REF_PREFIX: &str = "refs/coomi/snap";
/// 保留的最近快照数（最旧先清理）。
const MAX_SNAPSHOTS: usize = 200;

/// `git for-each-ref` 常量参数：refname 去前 3 段得到快照 id，
/// `%00` 分隔 id/sha/创建时间/提交主题。
const SNAPSHOT_FOR_EACH_REF_ARGS: [&str; 3] = [
    "for-each-ref",
    "--format=%(refname:strip=3)%00%(objectname)%00%(creatordate:unix)%00%(contents:subject)",
    "refs/coomi/snap",
];

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

/// 返回对话内 Git 工具集的 ToolSpec 清单（并入 CoreTools::specs()）。
pub fn git_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "git_status".into(),
            description: "Git (read-only): show the repository state as GitStatus JSON (is_repo, branch, ahead/behind counts, and staged / unstaged / untracked / conflicted file lists, parsed from `git status --porcelain=v2`). Takes no arguments. Run this before staging or committing to see what changed in the workspace.".into(),
            parameters: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        },
        ToolSpec {
            name: "git_diff".into(),
            description: "Git (read-only): return the unified diff text of workspace changes. Options: path (string, restrict to one file or directory), cached (bool, diff the index / staged changes instead of the working tree), context (int, default 5, unified context lines). Output is capped at 200 KiB with a truncation marker.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Optional file or directory path to limit the diff to"},
                    "cached": {"type": "boolean", "description": "Diff staged (index) changes instead of the working tree"},
                    "context": {"type": "integer", "minimum": 1, "maximum": 50, "default": 5}
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "git_branches".into(),
            description: "Git (read-only): list local branches and mark the current one. Returns JSON with `current` and `branches`.".into(),
            parameters: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        },
        ToolSpec {
            name: "git_log".into(),
            description: "Git (read-only): show recent commit history as a JSON array of {hash, short, subject, author, date}. Option: limit (int, default 20, max 200).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200}
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "git_stage".into(),
            description: "Git (requires approval): stage files into the git index before committing. Pass paths (array of relative paths) or all (bool, stage everything including deletions and untracked files). Requires user approval.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "paths": {"type": "array", "items": {"type": "string"}},
                    "all": {"type": "boolean"}
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "git_commit".into(),
            description: "Git (requires approval): create a git commit with the currently staged changes using the given message (required string). Committer identity falls back to Coomi <coomi@local> when git config user.name/user.email are unset. Requires user approval.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "message": {"type": "string"}
                },
                "required": ["message"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "git_snapshot".into(),
            description: "Git checkpoint. Default action is `create` (requires approval): save a full snapshot of the workspace (tracked + untracked files) as an independent git ref under refs/coomi/snap without touching the user's staging area; returns the snapshot id for later git_restore. Options: kind (string, default \"turn\"; e.g. turn / session / manual), summary (string, required for create). Pass action=\"list\" (read-only, no approval needed) to enumerate existing snapshots as JSON (id, kind, summary, created_at, sha).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["create", "list"], "default": "create"},
                    "kind": {"type": "string", "default": "turn"},
                    "summary": {"type": "string"}
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "git_restore".into(),
            description: "Git (requires approval, DANGEROUS): reset the workspace to a previously created snapshot by id, running `git reset --hard <snapshot>` then `git clean -fd`. This discards ALL uncommitted changes and deletes untracked files. A pre-restore backup snapshot is created automatically first (kind \"pre-restore\"). Use git_snapshot with action=\"list\" to find snapshot ids. Requires explicit user approval.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Snapshot id from git_snapshot action=list"}
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "git_stash".into(),
            description: "Git stash operations. action=list (read-only) returns stash entries as JSON. action=push stashes uncommitted changes including untracked files (optional message); action=pop restores and removes a stash entry; action=drop permanently deletes a stash entry. push/pop/drop require user approval; pass index (int, default 0) for pop/drop.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "push", "pop", "drop"]},
                    "index": {"type": "integer", "minimum": 0},
                    "message": {"type": "string"}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        },
    ]
}

/// 分发执行一个 Git 工具。
///
/// `workspace` 为仓库根（CoreTools 持有的 cwd），`runtime_home` 为 Coomi home
/// （含 runtime-v2；`Some` 时 git 优先经 PRoot Linux 运行时在 guest 内执行，
/// 不可用自动回退宿主），`name` 为工具名，`args` 为 JSON 参数对象，
/// `approvals` 为批准句柄（lib.rs 的 dispatch 中总是传入 Some；外部无批准
/// 能力时可传 None，变更类工具将被拒绝）。
pub async fn run_git_tool(
    workspace: &Path,
    runtime_home: Option<&Path>,
    name: &str,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
) -> ToolResult {
    match name {
        "git_status" => git_status(workspace, runtime_home).await,
        "git_diff" => git_diff(workspace, runtime_home, args).await,
        "git_branches" => git_branches(workspace, runtime_home).await,
        "git_log" => git_log(workspace, runtime_home, args).await,
        "git_stage" => git_stage(workspace, runtime_home, args, approvals).await,
        "git_commit" => git_commit(workspace, runtime_home, args, approvals).await,
        "git_snapshot" => git_snapshot(workspace, runtime_home, args, approvals).await,
        "git_restore" => git_restore(workspace, runtime_home, args, approvals).await,
        "git_stash" => git_stash(workspace, runtime_home, args, approvals).await,
        _ => ToolResult::error(format!("unknown git tool: {name}")),
    }
}

// ---------------------------------------------------------------------------
// 批准机制
// ---------------------------------------------------------------------------

/// 变更类工具的统一批准入口：approvals 为 None 时直接拒绝（"requires
/// approval"），否则构造最小 ToolCall 交给 ApprovalHandler::approve；
/// 用户拒绝时返回 "<name> was not approved"。
async fn require_approval(
    name: &str,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
    reason: &str,
) -> Result<(), String> {
    let Some(handler) = approvals else {
        return Err("requires approval".into());
    };
    let call = ToolCall {
        id: String::new(),
        name: name.to_owned(),
        arguments: args.clone(),
    };
    if !handler.approve(&call, reason).await {
        return Err(format!("{name} was not approved"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// git 命令执行（参数化、无 shell、PRoot 路由优先、LC_ALL=C）
// ---------------------------------------------------------------------------

struct GitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// 执行 git 并返回原始输出。优先经 `services::git_engine::run_git` 的
/// PRoot Linux 路由（`runtime_home` 可用时在 guest 内执行，workspace bind 为
/// /workspace，`envs` 中落在 workspace 内的路径自动映射）；运行时不可用回退
/// 宿主直接执行。
async fn git_run_env(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<GitOutput, String> {
    let (code, stdout, stderr) =
        coomi_services::run_git(workspace, args, envs, runtime_home)
            .await
            .map_err(|error| {
                format!(
                    "failed to run git in {}: {error:#}",
                    workspace.display()
                )
            })?;
    Ok(GitOutput {
        code,
        stdout,
        stderr,
    })
}

async fn git_run(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &[&str],
) -> Result<GitOutput, String> {
    git_run_env(workspace, runtime_home, args, &[]).await
}

/// 要求命令成功并返回 stdout（去尾空白）；失败返回含 stderr 的错误。
async fn run_ok(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &[&str],
) -> Result<String, String> {
    let output = git_run(workspace, runtime_home, args).await?;
    if output.code != 0 {
        return Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or("git"),
            output.stderr.trim()
        ));
    }
    Ok(output.stdout.trim().to_owned())
}

/// 成功且有非空输出时返回 Some，否则 None（不把非零退出码当错误）。
async fn run_opt(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &[&str],
) -> Result<Option<String>, String> {
    let output = git_run(workspace, runtime_home, args).await?;
    if output.code != 0 {
        return Ok(None);
    }
    let trimmed = output.stdout.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_owned()))
}

/// 要求命令成功并返回 stdout（带环境变量的变体，供快照临时索引使用）。
async fn run_ok_env(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let output = git_run_env(workspace, runtime_home, args, envs).await?;
    if output.code != 0 {
        return Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or("git"),
            output.stderr.trim()
        ));
    }
    Ok(output.stdout.trim().to_owned())
}

fn is_repo(workspace: &Path) -> bool {
    workspace.join(".git").exists()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 参数小工具
// ---------------------------------------------------------------------------

fn string_arg<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn usize_arg(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

fn bool_arg(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn to_json_pretty<T: Serialize>(value: &T) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into())
}

// ---------------------------------------------------------------------------
// git_status：porcelain v2 解析
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct FileEntry {
    path: String,
    /// porcelain v2 双字符状态码，如 "M."、"MM"、"??"。
    status: String,
    old_path: Option<String>,
}

#[derive(Serialize)]
struct GitStatusJson {
    is_repo: bool,
    branch: Option<String>,
    ahead: usize,
    behind: usize,
    staged: Vec<FileEntry>,
    unstaged: Vec<FileEntry>,
    untracked: Vec<FileEntry>,
    conflicted: Vec<FileEntry>,
}

impl GitStatusJson {
    fn empty() -> Self {
        Self {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            staged: Vec::new(),
            unstaged: Vec::new(),
            untracked: Vec::new(),
            conflicted: Vec::new(),
        }
    }
}

async fn git_status(workspace: &Path, runtime_home: Option<&Path>) -> ToolResult {
    if !is_repo(workspace) {
        return ToolResult::success(to_json_pretty(&GitStatusJson::empty()));
    }
    let output = match git_run(workspace, runtime_home, &["status", "--porcelain=v2", "--branch", "-z"]).await {
        Ok(output) => output,
        Err(error) => return ToolResult::error(error),
    };
    if output.code != 0 {
        return ToolResult::error(format!("git status failed: {}", output.stderr.trim()));
    }
    let mut status = GitStatusJson {
        is_repo: true,
        ..GitStatusJson::empty()
    };
    parse_porcelain_v2(&output.stdout, &mut status);
    ToolResult::success(to_json_pretty(&status))
}

fn parse_porcelain_v2(raw: &str, status: &mut GitStatusJson) {
    for chunk in raw.split('\0') {
        let line = chunk.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(value) = line.strip_prefix("# branch.head ") {
            status.branch = Some(value.to_owned());
            continue;
        }
        if let Some(value) = line.strip_prefix("# branch.ab ") {
            parse_ahead_behind(value, status);
            continue;
        }
        if line.starts_with("# ") {
            continue;
        }
        let marker = line.as_bytes().first().copied().unwrap_or(b' ') as char;
        match marker {
            '?' => status.untracked.push(FileEntry {
                path: line.get(2..).unwrap_or("").to_owned(),
                status: "??".into(),
                old_path: None,
            }),
            '!' => {} // ignored 条目跳过
            '1' => {
                if let Some(fields) = split_fields(line, 8) {
                    push_classified(status, fields[1], fields[7], None);
                }
            }
            '2' => {
                if let Some(fields) = split_fields(line, 10) {
                    push_classified(status, fields[1], fields[8], Some(fields[9]));
                }
            }
            'u' => {
                if let Some(fields) = split_fields(line, 10) {
                    status.conflicted.push(FileEntry {
                        path: fields[9].to_owned(),
                        status: fields[1].to_owned(),
                        old_path: None,
                    });
                }
            }
            _ => {}
        }
    }
}

/// 解析 `# branch.ab +A -B` 行。
fn parse_ahead_behind(value: &str, status: &mut GitStatusJson) {
    let mut ahead = 0usize;
    let mut behind = 0usize;
    for part in value.split_whitespace() {
        if let Some(rest) = part.strip_prefix('+') {
            ahead = rest.parse().unwrap_or(0);
        } else if let Some(rest) = part.strip_prefix('-') {
            behind = rest.parse().unwrap_or(0);
        }
    }
    status.ahead = ahead;
    status.behind = behind;
}

/// 前 `count` 个字段按空格拆分（porcelain v2 字段不含空格），
/// path 可能含空格故取剩余部分。
fn split_fields<'a>(line: &'a str, count: usize) -> Option<Vec<&'a str>> {
    let mut fields = Vec::with_capacity(count);
    let mut rest = line;
    for index in 0..count {
        let split = if index + 1 == count {
            None
        } else {
            rest.find(' ')
        };
        match split {
            Some(pos) => {
                fields.push(&rest[..pos]);
                rest = &rest[pos + 1..];
            }
            None => {
                fields.push(rest);
                break;
            }
        }
    }
    if fields.len() < count {
        return None;
    }
    Some(fields)
}

fn push_classified(status: &mut GitStatusJson, xy: &str, path: &str, old_path: Option<&str>) {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    let entry = FileEntry {
        path: path.to_owned(),
        status: xy.to_owned(),
        old_path: old_path.map(str::to_owned),
    };
    if index == 'U'
        || worktree == 'U'
        || matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA")
    {
        status.conflicted.push(entry);
        return;
    }
    if index != '.' {
        status.staged.push(entry.clone());
    }
    if worktree != '.' {
        status.unstaged.push(entry);
    }
}

// ---------------------------------------------------------------------------
// git_diff / git_branches / git_log（只读）
// ---------------------------------------------------------------------------

async fn git_diff(workspace: &Path, runtime_home: Option<&Path>, args: &Value) -> ToolResult {
    if !is_repo(workspace) {
        return ToolResult::error(format!("not a git repository: {}", workspace.display()));
    }
    let path = string_arg(args, "path").map(str::to_owned);
    let cached = bool_arg(args, "cached");
    let context = usize_arg(args, "context").unwrap_or(5).clamp(1, 50);
    let unified = format!("--unified={context}");

    let mut stat_args = vec!["diff", "--stat", "--no-ext-diff", "--no-color"];
    if cached {
        stat_args.push("--cached");
    }
    if let Some(path) = &path {
        stat_args.push("--");
        stat_args.push(path);
    }
    let stat = match run_opt(workspace, runtime_home, &stat_args).await {
        Ok(Some(text)) => text,
        Ok(None) => String::new(),
        Err(error) => return ToolResult::error(error),
    };

    let mut diff_args = vec!["diff", "--no-ext-diff", "--no-color", unified.as_str()];
    if cached {
        diff_args.push("--cached");
    }
    if let Some(path) = &path {
        diff_args.push("--");
        diff_args.push(path);
    }
    let full = match run_opt(workspace, runtime_home, &diff_args).await {
        Ok(Some(text)) => text,
        Ok(None) => String::new(),
        Err(error) => return ToolResult::error(error),
    };
    let mut body = full;
    if body.len() > MAX_DIFF_BYTES {
        body.truncate(MAX_DIFF_BYTES);
        body.push_str("\n... [diff truncated]");
    }
    let combined = if stat.trim().is_empty() {
        body
    } else {
        format!("{stat}\n{body}")
    };
    ToolResult::success(combined)
}

#[derive(Serialize)]
struct BranchInfoJson {
    current: Option<String>,
    branches: Vec<String>,
}

async fn git_branches(workspace: &Path, runtime_home: Option<&Path>) -> ToolResult {
    if !is_repo(workspace) {
        return ToolResult::error(format!("not a git repository: {}", workspace.display()));
    }
    let current = match run_opt(workspace, runtime_home, &["symbolic-ref", "--short", "HEAD"]).await {
        Ok(value) => value,
        Err(error) => return ToolResult::error(error),
    };
    let branches = match run_opt(workspace, runtime_home, &["branch", "--format=%(refname:short)"]).await {
        Ok(Some(raw)) => raw.lines().map(str::to_owned).collect(),
        Ok(None) => Vec::new(),
        Err(error) => return ToolResult::error(error),
    };
    ToolResult::success(to_json_pretty(&BranchInfoJson { current, branches }))
}

#[derive(Serialize)]
struct CommitInfoJson {
    hash: String,
    short: String,
    subject: String,
    author: String,
    date: String,
}

async fn git_log(workspace: &Path, runtime_home: Option<&Path>, args: &Value) -> ToolResult {
    if !is_repo(workspace) {
        return ToolResult::success("[]");
    }
    let limit = usize_arg(args, "limit").unwrap_or(20).clamp(1, MAX_LOG_LIMIT);
    let limit_str = limit.to_string();
    let raw = match run_opt(
        workspace,
        runtime_home,
        &[
            "log",
            "-n",
            &limit_str,
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%at",
        ],
    )
    .await
    {
        Ok(Some(raw)) => raw,
        Ok(None) => return ToolResult::success("[]"),
        Err(error) => return ToolResult::error(error),
    };
    let mut commits = Vec::new();
    for line in raw.lines() {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() < 5 {
            continue;
        }
        commits.push(CommitInfoJson {
            hash: fields[0].to_owned(),
            short: fields[1].to_owned(),
            subject: fields[2].to_owned(),
            author: fields[3].to_owned(),
            date: fields[4].to_owned(),
        });
    }
    ToolResult::success(to_json_pretty(&commits))
}

// ---------------------------------------------------------------------------
// git_stage / git_commit（需批准）
// ---------------------------------------------------------------------------

async fn git_stage(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
) -> ToolResult {
    if let Err(error) = require_approval(
        "git_stage",
        args,
        approvals,
        "git_stage will add files to the git index (staging changes for a commit)",
    )
    .await
    {
        return ToolResult::error(error);
    }
    if !is_repo(workspace) {
        return ToolResult::error(format!("not a git repository: {}", workspace.display()));
    }
    let all = bool_arg(args, "all");
    let paths = string_array(args, "paths");
    let result = if all {
        run_ok(workspace, runtime_home, &["add", "-A"]).await
    } else if paths.is_empty() {
        Err("git_stage requires paths[] or all=true".into())
    } else {
        let mut command_args = vec!["add", "--"];
        command_args.extend(paths.iter().map(String::as_str));
        run_ok(workspace, runtime_home, &command_args).await
    };
    match result {
        Ok(output) if output.trim().is_empty() => ToolResult::success("staged changes"),
        Ok(output) => ToolResult::success(output),
        Err(error) => ToolResult::error(error),
    }
}

async fn git_commit(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
) -> ToolResult {
    if let Err(error) = require_approval(
        "git_commit",
        args,
        approvals,
        "git_commit will create a git commit with the staged changes",
    )
    .await
    {
        return ToolResult::error(error);
    }
    if !is_repo(workspace) {
        return ToolResult::error(format!("not a git repository: {}", workspace.display()));
    }
    let Some(message) = string_arg(args, "message") else {
        return ToolResult::error("missing string argument: message");
    };
    let message = message.trim();
    if message.is_empty() {
        return ToolResult::error("commit message cannot be empty");
    }
    // 身份回退：git 未配置 user.name/user.email 时使用 Coomi 默认身份。
    let name = match run_opt(workspace, runtime_home, &["config", "--get", "user.name"]).await {
        Ok(Some(value)) => value,
        _ => "Coomi".to_owned(),
    };
    let email = match run_opt(workspace, runtime_home, &["config", "--get", "user.email"]).await {
        Ok(Some(value)) => value,
        _ => "coomi@local".to_owned(),
    };
    let name_arg = format!("user.name={name}");
    let email_arg = format!("user.email={email}");
    let commit_args = [
        "-c",
        name_arg.as_str(),
        "-c",
        email_arg.as_str(),
        "commit",
        "-m",
        message,
        "-q",
    ];
    if let Err(error) = run_ok(workspace, runtime_home, &commit_args).await {
        return ToolResult::error(error);
    }
    match run_ok(workspace, runtime_home, &["rev-parse", "HEAD"]).await {
        Ok(hash) => ToolResult::success(format!("committed as {hash}")),
        Err(error) => ToolResult::error(error),
    }
}

// ---------------------------------------------------------------------------
// git_snapshot / git_restore（快照，需批准）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SnapshotListEntry {
    id: String,
    kind: String,
    summary: String,
    created_at: u64,
    sha: String,
}

#[derive(Serialize)]
struct SnapshotCreateJson {
    id: String,
    kind: String,
    summary: String,
    created_at: u64,
    sha: String,
    file_count: usize,
}

#[derive(Serialize)]
struct RestoreReportJson {
    restored_to: String,
    reverted_files: usize,
    deleted_untracked: usize,
    backup_snapshot_id: String,
}

async fn git_snapshot(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
) -> ToolResult {
    let action = string_arg(args, "action").unwrap_or("create");
    match action {
        "list" => {
            let mut entries = match snapshot_list_inner(workspace, runtime_home).await {
                Ok(entries) => entries,
                Err(error) => return ToolResult::error(error),
            };
            entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            ToolResult::success(to_json_pretty(&entries))
        }
        "create" => {
            if let Err(error) = require_approval(
                "git_snapshot",
                args,
                approvals,
                "git_snapshot will save a full workspace snapshot (automatic checkpoint)",
            )
            .await
            {
                return ToolResult::error(error);
            }
            let kind = string_arg(args, "kind").unwrap_or("turn");
            let summary = string_arg(args, "summary").unwrap_or("");
            match snapshot_create(workspace, runtime_home, kind, summary).await {
                Ok(snapshot) => {
                    ToolResult::success(format!("snapshot created: {}", to_json_pretty(&snapshot)))
                }
                Err(error) => ToolResult::error(error),
            }
        }
        other => ToolResult::error(format!("unknown git_snapshot action: {other}")),
    }
}

async fn git_restore(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
) -> ToolResult {
    if let Err(error) = require_approval(
        "git_restore",
        args,
        approvals,
        "git_restore will reset the workspace to a snapshot with `git reset --hard` and `git clean -fd`, discarding all uncommitted changes and untracked files",
    )
    .await
    {
        return ToolResult::error(error);
    }
    if !is_repo(workspace) {
        return ToolResult::error(format!("not a git repository: {}", workspace.display()));
    }
    let Some(id) = string_arg(args, "id") else {
        return ToolResult::error("missing string argument: id");
    };
    if !valid_snapshot_id(id) {
        return ToolResult::error("invalid snapshot id");
    }
    let ref_name = format!("{SNAPSHOT_REF_PREFIX}/{id}");
    let sha = match run_opt(workspace, runtime_home, &["rev-parse", "--verify", &ref_name]).await {
        Ok(Some(sha)) => sha,
        Ok(None) => {
            let available = snapshot_list_inner(workspace, runtime_home).await.unwrap_or_default();
            let ids = available
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let hint = if ids.is_empty() {
                "no snapshots exist".to_owned()
            } else {
                format!("available: {ids}")
            };
            return ToolResult::error(format!("snapshot not found: {id}; {hint}"));
        }
        Err(error) => return ToolResult::error(error),
    };
    // 还原前自动备份，确保可回滚。
    let backup = match snapshot_create(
        workspace,
        runtime_home,
        "pre-restore",
        &format!("before restore {id}"),
    )
    .await
    {
        Ok(backup) => backup,
        Err(error) => {
            return ToolResult::error(format!("failed to create pre-restore backup: {error}"));
        }
    };
    let reverted_files = match run_opt(workspace, runtime_home, &["diff", "--name-only", &sha]).await {
        Ok(Some(raw)) => raw.lines().count(),
        _ => 0,
    };
    let deleted_untracked = match simulate_clean(workspace, runtime_home).await {
        Ok(count) => count,
        Err(error) => return ToolResult::error(error),
    };
    if let Err(error) = run_ok(workspace, runtime_home, &["reset", "--hard", &sha]).await {
        return ToolResult::error(error);
    }
    if let Err(error) = run_ok(workspace, runtime_home, &["clean", "-fd"]).await {
        return ToolResult::error(error);
    }
    ToolResult::success(to_json_pretty(&RestoreReportJson {
        restored_to: sha,
        reverted_files,
        deleted_untracked,
        backup_snapshot_id: backup.id,
    }))
}

/// 创建快照：临时索引收集工作区全貌（含未跟踪文件，不触碰用户暂存区），
/// write-tree + commit-tree（父为 HEAD）+ 独立 ref `refs/coomi/snap/<id>`。
async fn snapshot_create(
    workspace: &Path,
    runtime_home: Option<&Path>,
    kind: &str,
    summary: &str,
) -> Result<SnapshotCreateJson, String> {
    if !is_repo(workspace) {
        return Err(format!("not a git repository: {}", workspace.display()));
    }
    if !valid_snapshot_kind(kind) {
        return Err(format!("invalid snapshot kind: {kind}"));
    }
    let summary = summary.trim();
    let created_at = now_secs();
    let id = format!("{kind}-{created_at}-{}", Uuid::new_v4().simple());
    let ref_name = format!("{SNAPSHOT_REF_PREFIX}/{id}");

    let git_dir = workspace.join(".git");
    let tmp_index = git_dir.join(format!("coomi-index-{}-{}", Uuid::new_v4().simple(), created_at));
    let index_path = tmp_index
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 index path: {}", tmp_index.display()))?;
    let index_envs = [("GIT_INDEX_FILE", index_path)];

    // 1. 用临时索引收集工作区全貌（含未跟踪文件）。
    run_ok_env(workspace, runtime_home, &["add", "-A"], &index_envs).await?;
    // 2. 生成树对象。
    let tree = run_ok_env(workspace, runtime_home, &["write-tree"], &index_envs).await?;
    let _ = std::fs::remove_file(&tmp_index);
    // 3. 生成提交对象（首次快照无父提交）。
    let head = run_opt(workspace, runtime_home, &["rev-parse", "--verify", "HEAD"]).await?;
    let commit_message = format!("coomi {kind} {summary}");
    let mut commit_args = vec!["commit-tree", tree.trim(), "-m", commit_message.as_str()];
    if let Some(head) = &head {
        commit_args.push("-p");
        commit_args.push(head);
    }
    let commit = run_ok(workspace, runtime_home, &commit_args).await?;
    let commit = commit.trim().to_owned();
    // 4. 建立独立 ref。
    let ref_arg = ref_name.as_str();
    let commit_arg = commit.as_str();
    run_ok(workspace, runtime_home, &["update-ref", ref_arg, commit_arg]).await?;
    // 5. 统计文件数。
    let file_count = match run_opt(workspace, runtime_home, &["ls-tree", "-r", "--name-only", &commit]).await {
        Ok(Some(out)) => out.lines().count(),
        _ => 0,
    };

    prune_snapshots(workspace, runtime_home).await?;
    Ok(SnapshotCreateJson {
        id,
        kind: kind.to_owned(),
        summary: summary.to_owned(),
        created_at,
        sha: commit,
        file_count,
    })
}

/// 枚举 `refs/coomi/snap/*` 下的全部快照（id/sha/时间/kind/summary）。
async fn snapshot_list_inner(
    workspace: &Path,
    runtime_home: Option<&Path>,
) -> Result<Vec<SnapshotListEntry>, String> {
    if !is_repo(workspace) {
        return Ok(Vec::new());
    }
    let Some(raw) = run_opt(workspace, runtime_home, &SNAPSHOT_FOR_EACH_REF_ARGS).await? else {
        return Ok(Vec::new());
    };
    Ok(parse_snapshot_list(&raw))
}

fn parse_snapshot_list(raw: &str) -> Vec<SnapshotListEntry> {
    let mut entries = Vec::new();
    for line in raw.lines() {
        let mut fields = line.split('\0');
        let id = fields.next().unwrap_or("");
        let sha = fields.next().unwrap_or("");
        let created_at = fields.next().unwrap_or("0");
        let subject = fields.next().unwrap_or("");
        if id.is_empty() || sha.is_empty() {
            continue;
        }
        let (kind, summary) = split_snapshot_subject(subject);
        entries.push(SnapshotListEntry {
            id: id.to_owned(),
            kind,
            summary,
            created_at: created_at.parse().unwrap_or(0),
            sha: sha.to_owned(),
        });
    }
    entries
}

/// 快照提交主题形如 "coomi <kind> <summary>"，kind 无空格（如 turn /
/// session / manual / pre-restore），取首个单词为 kind，其余为 summary。
fn split_snapshot_subject(subject: &str) -> (String, String) {
    let rest = subject.strip_prefix("coomi ").unwrap_or(subject);
    match rest.split_once(' ') {
        Some((kind, summary)) => (kind.to_owned(), summary.trim().to_owned()),
        None => (rest.to_owned(), String::new()),
    }
}

/// 保留最近 MAX_SNAPSHOTS 个快照，从最旧开始删除对应 ref。
async fn prune_snapshots(workspace: &Path, runtime_home: Option<&Path>) -> Result<(), String> {
    let mut list = snapshot_list_inner(workspace, runtime_home).await?;
    list.sort_by_key(|entry| entry.created_at);
    while list.len() > MAX_SNAPSHOTS {
        let victim = list.remove(0);
        let ref_name = format!("{SNAPSHOT_REF_PREFIX}/{}", victim.id);
        let _ = run_opt(workspace, runtime_home, &["update-ref", "-d", &ref_name]).await?;
    }
    Ok(())
}

/// `git clean -nd` 模拟：统计将被删除的未跟踪文件数（不实际删除）。
async fn simulate_clean(workspace: &Path, runtime_home: Option<&Path>) -> Result<usize, String> {
    let count = match run_opt(workspace, runtime_home, &["clean", "-nd"]).await? {
        Some(raw) => raw
            .lines()
            .filter(|line| line.starts_with("Would remove "))
            .count(),
        None => 0,
    };
    Ok(count)
}

fn valid_snapshot_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_snapshot_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind.len() <= 64
        && kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// ---------------------------------------------------------------------------
// git_stash（list 只读；push/pop/drop 需批准）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StashEntryJson {
    index: usize,
    message: String,
}

async fn git_stash(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
    approvals: Option<&dyn ApprovalHandler>,
) -> ToolResult {
    let action = string_arg(args, "action").unwrap_or("list");
    match action {
        "list" => git_stash_list(workspace, runtime_home).await,
        "push" => {
            if let Err(error) = require_approval(
                "git_stash",
                args,
                approvals,
                "git_stash push will stash uncommitted changes including untracked files",
            )
            .await
            {
                return ToolResult::error(error);
            }
            git_stash_push(workspace, runtime_home, args).await
        }
        "pop" => {
            if let Err(error) = require_approval(
                "git_stash",
                args,
                approvals,
                "git_stash pop will restore and drop a stash entry",
            )
            .await
            {
                return ToolResult::error(error);
            }
            git_stash_pop(workspace, runtime_home, args).await
        }
        "drop" => {
            if let Err(error) = require_approval(
                "git_stash",
                args,
                approvals,
                "git_stash drop will permanently delete a stash entry",
            )
            .await
            {
                return ToolResult::error(error);
            }
            git_stash_drop(workspace, runtime_home, args).await
        }
        other => ToolResult::error(format!("unknown git_stash action: {other}")),
    }
}

async fn git_stash_list(workspace: &Path, runtime_home: Option<&Path>) -> ToolResult {
    if !is_repo(workspace) {
        return ToolResult::success("[]");
    }
    let raw = match run_opt(workspace, runtime_home, &["stash", "list", "--pretty=format:%gd%x1f%s"]).await {
        Ok(Some(raw)) => raw,
        Ok(None) => return ToolResult::success("[]"),
        Err(error) => return ToolResult::error(error),
    };
    let mut entries = Vec::new();
    for line in raw.lines() {
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() < 2 {
            continue;
        }
        let index = fields[0]
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse()
            .unwrap_or(0);
        entries.push(StashEntryJson {
            index,
            message: fields[1].to_owned(),
        });
    }
    ToolResult::success(to_json_pretty(&entries))
}

async fn git_stash_push(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
) -> ToolResult {
    if !is_repo(workspace) {
        return ToolResult::error(format!("not a git repository: {}", workspace.display()));
    }
    let mut stash_args = vec!["stash", "push", "-u"];
    if let Some(message) = string_arg(args, "message").filter(|m| !m.trim().is_empty()) {
        stash_args.push("-m");
        stash_args.push(message);
    }
    match run_ok(workspace, runtime_home, &stash_args).await {
        Ok(output) if output.trim().is_empty() => ToolResult::success("stashed changes"),
        Ok(output) => ToolResult::success(output),
        Err(error) => ToolResult::error(error),
    }
}

async fn git_stash_pop(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
) -> ToolResult {
    let index = stash_index(args);
    let stash_ref = format!("stash@{{{index}}}");
    match run_ok(workspace, runtime_home, &["stash", "pop", &stash_ref]).await {
        Ok(output) => ToolResult::success(output),
        Err(error) => ToolResult::error(error),
    }
}

async fn git_stash_drop(
    workspace: &Path,
    runtime_home: Option<&Path>,
    args: &Value,
) -> ToolResult {
    let index = stash_index(args);
    let stash_ref = format!("stash@{{{index}}}");
    match run_ok(workspace, runtime_home, &["stash", "drop", &stash_ref]).await {
        Ok(output) if output.trim().is_empty() => {
            ToolResult::success(format!("dropped stash@{index}"))
        }
        Ok(output) => ToolResult::success(output),
        Err(error) => ToolResult::error(error),
    }
}

fn stash_index(args: &Value) -> usize {
    string_arg(args, "index")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}
