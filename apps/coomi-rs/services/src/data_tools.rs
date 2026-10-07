//! 开发数据工具：Git 贡献统计、会话导出、会话全文搜索、用量统计聚合。
//!
//! 数据源约定（与 `ui/src/web.rs` 保持一致）：
//! - 会话存储：`<home>/sessions/<uuid>.json`，即 `coomi_engine::SessionStore` 的
//!   持久化格式（`/api/sessions`、`/api/sessions/history` 读取的同一份数据）。
//! - 用量流水：`<home>/usage/ledger.jsonl`，即 `/api/usage`（`usage_ledger`）
//!   读取的同一份数据，每行一个 JSON 记录。
//!
//! 所有 git 命令均通过 `tokio::process::Command` 参数化执行，绝不经过 shell，
//! 与 `git_engine.rs` 的设计约定一致。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::git_engine::GitEngine;
use coomi_engine::{ChatMessage, Role, Session, SessionStore};

// ---------------------------------------------------------------------------
// Git 贡献统计
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AuthorContribution {
    pub name: String,
    pub email: String,
    pub commits: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DayCount {
    /// YYYY-MM-DD（本地时区）。
    pub date: String,
    pub commits: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ContributionReport {
    pub authors: Vec<AuthorContribution>,
    pub total_commits: usize,
    pub first_commit_at: Option<u64>,
    pub last_commit_at: Option<u64>,
    pub by_day: Vec<DayCount>,
}

/// Git 贡献统计：作者列表（`git shortlog -sne --all`）与按天提交数
/// （`git log --all --pretty=%at`；`since_days` 给定时追加 `--since=<N> days ago`），
/// 同时取最早/最近提交时间。非仓库时返回空报告，不报错。
pub async fn contribution_stats(
    engine: &GitEngine,
    since_days: Option<u64>,
) -> Result<ContributionReport> {
    if !engine.is_repo() {
        return Ok(ContributionReport::default());
    }

    let authors = parse_shortlog(
        &engine
            .run_opt(&["shortlog", "-sne", "--all"], &[])
            .await?
            .unwrap_or_default(),
    );
    let total_commits = authors.iter().map(|author| author.commits).sum();

    let mut log_args = vec!["log", "--all", "--pretty=%at"];
    let since_arg;
    if let Some(days) = since_days {
        since_arg = format!("{days} days ago");
        log_args.push("--since");
        log_args.push(since_arg.as_str());
    }
    let timestamps = parse_timestamps(
        &engine
            .run_opt(&log_args, &[])
            .await?
            .unwrap_or_default(),
    );

    let mut by_day: BTreeMap<String, usize> = BTreeMap::new();
    for ts in &timestamps {
        let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp(*ts as i64, 0) else {
            continue;
        };
        let day = dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
        *by_day.entry(day).or_insert(0) += 1;
    }

    Ok(ContributionReport {
        authors,
        total_commits,
        first_commit_at: timestamps.iter().copied().min(),
        last_commit_at: timestamps.iter().copied().max(),
        by_day: by_day
            .into_iter()
            .map(|(date, commits)| DayCount { date, commits })
            .collect(),
    })
}

/// 解析 `git shortlog -sne --all` 输出（每行 `数字  名字 <邮箱>`）。
fn parse_shortlog(raw: &str) -> Vec<AuthorContribution> {
    let mut authors = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(split) = line.find(char::is_whitespace) else {
            continue;
        };
        let Ok(commits) = line[..split].trim().parse::<usize>() else {
            continue;
        };
        let author = line[split..].trim();
        let (name, email) = match author.rfind('<') {
            Some(open) if author.ends_with('>') => (
                author[..open].trim().to_owned(),
                author[open + 1..author.len() - 1].trim().to_owned(),
            ),
            _ => (author.to_owned(), String::new()),
        };
        authors.push(AuthorContribution {
            name,
            email,
            commits,
        });
    }
    authors
}

/// 解析 `git log --pretty=%at` 输出（每行一个 Unix 秒时间戳）。
fn parse_timestamps(raw: &str) -> Vec<u64> {
    raw.lines()
        .filter_map(|line| line.trim().parse::<u64>().ok())
        .collect()
}

// ---------------------------------------------------------------------------
// 会话导出
// ---------------------------------------------------------------------------

/// 将会话导出为 Markdown，写入 `home/exports/session-<id>-<unix秒>.md` 并返回路径。
/// 会话不存在（或 id 非法）时返回明确错误。
pub async fn export_session_markdown(home: &Path, session_id: &str) -> Result<PathBuf> {
    let id = session_id
        .parse::<uuid::Uuid>()
        .with_context(|| format!("invalid session id: {session_id}"))?;
    let store = SessionStore::new(home);
    let session = store
        .load(id)
        .with_context(|| format!("session not found: {session_id}"))?;

    let mut md = String::new();
    let title = if session.title.trim().is_empty() {
        session.id.to_string()
    } else {
        session.title.clone()
    };
    md.push_str(&format!("# {title}\n\n"));
    md.push_str(&format!("- 会话 ID：`{}`\n", session.id));
    md.push_str(&format!("- 创建时间：{}\n", session.created_at));
    md.push_str(&format!("- 更新时间：{}\n", session.updated_at));
    md.push_str(&format!(
        "- 模型：{} / {}\n\n",
        session.provider_id, session.model
    ));

    for (index, message) in session.messages.iter().enumerate() {
        md.push_str(&format!(
            "## 消息 {}（{}）\n\n",
            index + 1,
            role_label(message.role)
        ));
        if message.role == Role::Tool {
            // 工具结果折叠为代码块。
            md.push_str("```text\n");
            md.push_str(&message.content);
            md.push('\n');
            md.push_str("```\n\n");
            continue;
        }
        if !message.content.trim().is_empty() {
            md.push_str(&message.content);
            md.push_str("\n\n");
        }
        if !message.tool_calls.is_empty() {
            md.push_str("工具调用：\n\n");
            for call in &message.tool_calls {
                let call_json = serde_json::json!({
                    "id": call.id,
                    "name": call.name,
                    "arguments": call.arguments,
                });
                let pretty = serde_json::to_string_pretty(&call_json)
                    .unwrap_or_else(|_| "{}".to_owned());
                md.push_str("```json\n");
                md.push_str(&pretty);
                md.push_str("\n```\n\n");
            }
        }
    }

    let exports_dir = home.join("exports");
    std::fs::create_dir_all(&exports_dir)
        .with_context(|| format!("failed to create export dir {}", exports_dir.display()))?;
    let path = exports_dir.join(format!("session-{id}-{}.md", now_secs()));
    tokio::fs::write(&path, md)
        .await
        .with_context(|| format!("failed to write export {}", path.display()))?;
    Ok(path)
}

fn role_label(role: Role) -> &'static str {
    match role {
        Role::System => "系统",
        Role::User => "用户",
        Role::Assistant => "助手",
        Role::Tool => "工具",
    }
}

// ---------------------------------------------------------------------------
// 会话全文搜索
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SearchHit {
    pub session_id: String,
    pub message_index: usize,
    pub snippet: String,
}

/// 遍历会话存储文件做大小写不敏感全文匹配。命中返回会话 id、消息序号与
/// 前后各 40 字符片段（去换行）；最多返回 `limit` 条（0 视为默认 50）。
pub async fn search_sessions(home: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let limit = if limit == 0 { 50 } else { limit };
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let needle: Vec<char> = query.to_lowercase().chars().collect();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let sessions_dir = home.join("sessions");
    if !sessions_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<PathBuf> = std::fs::read_dir(&sessions_dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect();
    entries.sort();

    let mut hits = Vec::new();
    for path in entries {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_slice::<Session>(&bytes) else {
            continue;
        };
        let session_id = session.id.to_string();
        for (index, message) in session.messages.iter().enumerate() {
            let single = message_searchable(message)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let chars: Vec<char> = single.chars().collect();
            if let Some(pos) = find_ci(&chars, &needle) {
                hits.push(SearchHit {
                    session_id: session_id.clone(),
                    message_index: index,
                    snippet: make_snippet(&chars, pos, needle.len()),
                });
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

/// 消息可检索文本：正文 + 工具调用（名称与参数 JSON）。
fn message_searchable(message: &ChatMessage) -> String {
    let mut text = message.content.clone();
    for call in &message.tool_calls {
        text.push('\n');
        text.push_str(&call.name);
        text.push(' ');
        text.push_str(&call.arguments.to_string());
    }
    text
}

/// 大小写不敏感子串查找，返回命中起点（char 索引）。
fn find_ci(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let lower: Vec<String> = needle
        .iter()
        .map(|ch| ch.to_lowercase().collect())
        .collect();
    'outer: for start in 0..=haystack.len() - needle.len() {
        for (offset, want) in lower.iter().enumerate() {
            let got: String = haystack[start + offset].to_lowercase().collect();
            if &got != want {
                continue 'outer;
            }
        }
        return Some(start);
    }
    None
}

/// 以命中点为中心，前后各 40 字符截取片段（已去换行），截断处加省略号。
fn make_snippet(chars: &[char], pos: usize, match_len: usize) -> String {
    const RADIUS: usize = 40;
    let start = pos.saturating_sub(RADIUS);
    let end = (pos + match_len + RADIUS).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

// ---------------------------------------------------------------------------
// 用量统计聚合
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DayUsage {
    /// YYYY-MM-DD（本地时区）。
    pub date: String,
    pub requests: usize,
    /// 当日 token 总量；数据源缺少 token 字段时只聚合请求数（None）。
    pub tokens: Option<u64>,
}

/// 基于 `/api/usage` 同源的用量流水 `<home>/usage/ledger.jsonl`，按天聚合
/// 请求数与 token，输出按日期倒序。
///
/// token 优先取 `total_tokens` 字段，缺失时回退 `input_tokens + output_tokens`；
/// 某条记录两个都没有时，该日只聚合请求数（`tokens = None`）。
pub async fn usage_by_day(home: &Path) -> Result<Vec<DayUsage>> {
    let ledger = home.join("usage").join("ledger.jsonl");
    let text = match tokio::fs::read_to_string(&ledger).await {
        Ok(text) => text,
        Err(_) => return Ok(Vec::new()),
    };

    // date -> (requests, tokens)
    let mut by_day: BTreeMap<String, (usize, Option<u64>)> = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let timestamp_ms = value
            .get("timestamp_ms")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms) else {
            continue;
        };
        let date = dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();

        let entry = by_day.entry(date).or_insert((0, Some(0)));
        entry.0 += 1;
        let tokens = value
            .get("total_tokens")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                let has_token_field =
                    value.get("input_tokens").is_some() || value.get("output_tokens").is_some();
                if !has_token_field {
                    return None;
                }
                let input = value
                    .get("input_tokens")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let output = value
                    .get("output_tokens")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                Some(input.saturating_add(output))
            });
        match (entry.1, tokens) {
            (Some(acc), Some(amount)) => entry.1 = Some(acc.saturating_add(amount)),
            // 任一记录缺 token 字段：整日退化为只聚合请求数。
            _ => entry.1 = None,
        }
    }

    let mut days: Vec<DayUsage> = by_day
        .into_iter()
        .map(|(date, (requests, tokens))| DayUsage {
            date,
            requests,
            tokens,
        })
        .collect();
    days.sort_by(|left, right| right.date.cmp(&left.date));
    Ok(days)
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command as TokioCommand;

    /// 参考 git_engine.rs 测试的 repo() 辅助：临时目录 + 初始化仓库 + 一次空提交。
    async fn repo() -> (tempfile::TempDir, GitEngine) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("repo dir");
        let engine = GitEngine::new(dir.path().join("home"), root.clone());

        let init = TokioCommand::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&root)
            .output()
            .await
            .expect("git init");
        assert!(init.status.success());
        for (key, value) in [("user.name", "Test"), ("user.email", "test@local")] {
            let identity = TokioCommand::new("git")
                .args(["config", key, value])
                .current_dir(&root)
                .output()
                .await
                .expect("git config");
            assert!(identity.status.success(), "git config {key} failed");
        }
        let commit = TokioCommand::new("git")
            .args(["commit", "--allow-empty", "-m", "init", "-q"])
            .current_dir(&root)
            .output()
            .await
            .expect("initial commit");
        assert!(commit.status.success(), "initial commit failed");
        (dir, engine)
    }

    async fn write(root: &Path, name: &str, content: &str) {
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent dir");
        }
        std::fs::write(path, content).expect("write file");
    }

    #[tokio::test]
    async fn contribution_stats_reports_at_least_one_author() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "a.txt", "content").await;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("feat: add a.txt").await?;

        let report = contribution_stats(&engine, None).await?;
        assert!(!report.authors.is_empty(), "expected at least one author");
        assert_eq!(report.authors[0].name, "Test");
        assert_eq!(report.authors[0].email, "test@local");
        assert!(report.total_commits >= 2);
        assert!(report.first_commit_at.is_some());
        assert!(report.last_commit_at.is_some());
        assert!(!report.by_day.is_empty());
        let by_day_total: usize = report.by_day.iter().map(|day| day.commits).sum();
        assert_eq!(by_day_total, report.total_commits);

        let since = contribution_stats(&engine, Some(1)).await?;
        assert!(!since.by_day.is_empty());
        assert!(since.last_commit_at == report.last_commit_at);
        Ok(())
    }

    #[tokio::test]
    async fn contribution_stats_non_repo_returns_empty_report() -> Result<()> {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = dir.path().join("not-a-repo");
        std::fs::create_dir_all(&workspace).expect("create dir");
        let engine = GitEngine::new(dir.path().join("home"), workspace);
        let report = contribution_stats(&engine, None).await?;
        assert!(report.authors.is_empty());
        assert_eq!(report.total_commits, 0);
        assert!(report.by_day.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn export_session_markdown_writes_file() -> Result<()> {
        let home = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new(home.path());
        let mut session = Session::new("provider", "model", home.path().to_path_buf());
        session.title = "重构示例".to_owned();
        session.messages.push(ChatMessage::user("帮我重构这段代码"));
        session
            .messages
            .push(ChatMessage::assistant("已完成重构", Vec::new()));
        store.save(&session).expect("save session");

        let id = session.id.to_string();
        let path = export_session_markdown(home.path(), &id).await?;
        assert!(path.starts_with(home.path().join("exports")));
        assert!(path.exists());
        let content = std::fs::read_to_string(&path)?;
        assert!(content.starts_with("# 重构示例"));
        assert!(content.contains("帮我重构这段代码"));
        assert!(content.contains("已完成重构"));

        let missing = export_session_markdown(home.path(), "00000000-0000-0000-0000-000000000000")
            .await;
        assert!(missing.is_err(), "missing session should error");
        let invalid = export_session_markdown(home.path(), "not-a-uuid").await;
        assert!(invalid.is_err(), "invalid id should error");
        Ok(())
    }

    #[tokio::test]
    async fn search_sessions_finds_case_insensitive_hits() -> Result<()> {
        let home = tempfile::tempdir().expect("tempdir");
        let store = SessionStore::new(home.path());
        let mut session = Session::new("provider", "model", home.path().to_path_buf());
        session.title = "Rust 重构".to_owned();
        session.messages.push(ChatMessage::user("帮我修复 Token 计数 bug"));
        session
            .messages
            .push(ChatMessage::assistant("已修复，token 缓存命中率提升", Vec::new()));
        store.save(&session).expect("save session");

        let hits = search_sessions(home.path(), "token", 50).await?;
        assert!(!hits.is_empty(), "expected hits for `token`");
        assert_eq!(hits[0].session_id, session.id.to_string());
        assert!(
            hits.iter().any(|hit| hit.snippet.to_lowercase().contains("token")),
            "snippet should contain the match"
        );

        let missing = search_sessions(home.path(), "不存在的关键词xyz", 50).await?;
        assert!(missing.is_empty());

        let limited = search_sessions(home.path(), "token", 1).await?;
        assert_eq!(limited.len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn usage_by_day_aggregates_requests_and_tokens() -> Result<()> {
        let home = tempfile::tempdir().expect("tempdir");
        let dir = home.path().join("usage");
        std::fs::create_dir_all(&dir).expect("usage dir");
        let lines = [
            r#"{"timestamp_ms": 1757520000000, "input_tokens": 100, "output_tokens": 50, "total_tokens": 150}"#,
            r#"{"timestamp_ms": 1757523600000, "input_tokens": 200, "output_tokens": 60, "total_tokens": 260}"#,
            r#"{"timestamp_ms": 1757606400000, "input_tokens": 10, "output_tokens": 5, "total_tokens": 15}"#,
        ];
        std::fs::write(&dir.join("ledger.jsonl"), format!("{}\n", lines.join("\n")))
            .expect("write ledger");

        let days = usage_by_day(home.path()).await?;
        assert_eq!(days.len(), 2);
        assert!(days[0].date > days[1].date, "should be sorted descending");
        assert_eq!(days[0].requests, 1);
        assert_eq!(days[0].tokens, Some(15));
        assert_eq!(days[1].requests, 2);
        assert_eq!(days[1].tokens, Some(410));
        Ok(())
    }

    #[tokio::test]
    async fn usage_by_day_missing_token_fields_counts_requests_only() -> Result<()> {
        let home = tempfile::tempdir().expect("tempdir");
        let dir = home.path().join("usage");
        std::fs::create_dir_all(&dir).expect("usage dir");
        std::fs::write(
            &dir.join("ledger.jsonl"),
            "{\"timestamp_ms\": 1757520000000}\n",
        )
        .expect("write ledger");

        let days = usage_by_day(home.path()).await?;
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].requests, 1);
        assert_eq!(days[0].tokens, None);
        Ok(())
    }
}
