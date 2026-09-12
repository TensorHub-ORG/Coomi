//! 工作区 Git 引擎：版本管理原语、轮次存档点（快照）与远程仓库辅助。
//!
//! 设计约定：
//! - 所有 git 命令通过 `tokio::process::Command` 参数化执行，绝不经过 shell，
//!   用户提供的路径/分支名一律作为独立参数传入。
//! - git 在本进程所在主机上执行（与 `task_manager::ConflictBaseline` 一致），
//!   仓库根 = 调用方传入的 workspace 绝对路径。
//! - 快照使用 git 对象法：临时索引 + `write-tree` + `commit-tree` + 独立 ref
//!   （`refs/coomi/snap/<id>`），不触碰用户暂存区，可被 `git reset --hard` 精确还原。
//! - 元数据索引落在 `<home>/coomi-snapshots.json`，与 git refs 双写；
//!   索引损坏时自动改名保留，避免写操作覆盖掉可恢复数据。
//! - 所有命令强制 `LC_ALL=C`，保证解析输出（如 `git clean -nd`）不随语言环境漂移。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

use crate::runtime::{ProotLinuxBackend, RuntimeBackend, RuntimeManager};

const SNAPSHOT_REF_PREFIX: &str = "refs/coomi/snap";
const SNAPSHOT_INDEX_FILE: &str = "coomi-snapshots.json";
const MAX_SNAPSHOTS: usize = 200;
const MAX_DIFF_BYTES: usize = 200 * 1024;
/// git 命令执行超时：PRoot guest 路由与宿主直跑均受此约束，防止 proot/git 卡死
/// （Android 上 proot 挂起、文件系统 I/O 冻结等）导致 API 请求无限挂起、前端
/// 「切换中…」永久卡住、分支列表永远不刷新。
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// 公开数据类型（全部可直接序列化为 JSON 返回给前端）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileEntry {
    pub path: String,
    /// porcelain v2 双字符状态码，如 "M."、"MM"、"??" 的压缩表示。
    pub status: String,
    pub old_path: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
    pub untracked: Vec<FileEntry>,
    pub conflicted: Vec<FileEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DiffInfo {
    pub stat: String,
    pub diff: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BranchInfo {
    pub current: Option<String>,
    pub branches: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Unix epoch 秒。
    pub date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    pub platform: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Snapshot {
    pub id: String,
    /// "turn"（轮次）/ "session"（会话起点）/ "manual"（手动）/ "pre-restore"（还原前自动备份）。
    pub kind: String,
    pub session_id: Option<String>,
    pub turn: Option<u64>,
    pub summary: String,
    pub created_at: u64,
    pub sha: String,
    pub file_count: usize,
    pub note: Option<String>,
    pub locked: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotPreview {
    pub snapshot: Snapshot,
    pub stat: String,
    /// 还原将被回退的已跟踪文件。
    pub reverted_files: Vec<String>,
    /// 还原将被删除的未跟踪文件（`git clean -nd` 模拟结果）。
    pub untracked_to_delete: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RestoreReport {
    pub restored_to: String,
    pub reverted_files: usize,
    pub deleted_untracked: usize,
    pub backup_snapshot_id: String,
}

/// 项目类型识别（用于状态栏展示与 .gitignore 向导）。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProjectInfo {
    pub detected: Vec<String>,
    pub gitignore: Option<String>,
}

// ---------------------------------------------------------------------------
// 引擎主体
// ---------------------------------------------------------------------------

pub struct GitEngine {
    home: PathBuf,
    workspace: PathBuf,
    /// Coomi home（含 runtime-v2）。Some 时 git 命令优先经 PRoot Linux 运行时
    /// 在 guest 内执行（Android 宿主通常没有 git 二进制）。
    runtime_home: Option<PathBuf>,
}

impl GitEngine {
    pub fn new(home: PathBuf, workspace: PathBuf) -> Self {
        Self {
            home,
            workspace,
            runtime_home: None,
        }
    }

    /// 启用 PRoot Linux 运行时路由：git 命令优先在 guest 内执行
    /// （workspace bind 为 /workspace），运行时不可用时自动回退宿主执行。
    pub fn with_runtime_home(mut self, runtime_home: PathBuf) -> Self {
        self.runtime_home = Some(runtime_home);
        self
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// 探测 git 可执行文件；返回版本号字符串（如 "2.34.1"）。
    pub async fn check_git(&self) -> Option<String> {
        let version = self.run_opt(&["--version"], &[]).await.ok().flatten()?;
        Some(version.trim().to_owned())
    }

    pub fn is_repo(&self) -> bool {
        self.workspace.join(".git").exists()
    }

    // -- 状态 --------------------------------------------------------------

    pub async fn status(&self) -> Result<GitStatus> {
        if !self.is_repo() {
            return Ok(GitStatus {
                is_repo: false,
                ..Default::default()
            });
        }
        let branch = self.run_opt(&["symbolic-ref", "--short", "HEAD"], &[]).await?;
        let (ahead, behind) = self.ahead_behind().await?;
        let mut status = GitStatus {
            is_repo: true,
            branch,
            ahead,
            behind,
            ..Default::default()
        };
        // 与 branches() 一致：porcelain v2 在有效仓库上失败必定是真实故障
        // （git 缺失/损坏等），必须上抛 stderr，避免面板静默显示「无改动」。
        let (code, raw, stderr) = self
            .run_output(&["status", "--porcelain=v2", "-z"], &[])
            .await?;
        if code != 0 {
            bail!("git status failed: {}", stderr.trim());
        }
        if !raw.is_empty() {
            parse_porcelain_v2(&raw, &mut status);
        }
        Ok(status)
    }

    async fn ahead_behind(&self) -> Result<(usize, usize)> {
        let Some(header) = self
            .run_opt(&["status", "--porcelain=v1", "--branch"], &[])
            .await?
        else {
            return Ok((0, 0));
        };
        let first = header.lines().next().unwrap_or_default();
        if let Some(start) = first.find("[ahead ") {
            let rest = &first[start + 7..];
            if let Some(sep) = rest.find(", behind ") {
                let ahead = rest[..sep].parse().unwrap_or(0);
                let tail = &rest[sep + 9..];
                let behind = tail.trim_end_matches(']').parse().unwrap_or(0);
                return Ok((ahead, behind));
            }
        }
        Ok((0, 0))
    }

    // -- 差异 --------------------------------------------------------------

    pub async fn diff(
        &self,
        path: Option<&str>,
        cached: bool,
        context: usize,
    ) -> Result<DiffInfo> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        let unified = format!("--unified={context}");
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-color",
            unified.as_str(),
        ];
        if cached {
            args.push("--cached");
        }
        let stat_args = {
            let mut v = vec!["diff", "--stat", "--no-ext-diff"];
            if cached {
                v.push("--cached");
            }
            v
        };
        let stat = self.diff_common(&stat_args, path).await?.unwrap_or_default();
        let mut diff_args = args.clone();
        push_path_arg(&mut diff_args, path);
        let full = self.run_opt(&diff_args, &[]).await?.unwrap_or_default();
        let truncated = full.len() > MAX_DIFF_BYTES;
        let diff = if truncated {
            let mut cut = full;
            cut.truncate(MAX_DIFF_BYTES);
            cut.push_str("\n... [diff truncated]");
            cut
        } else {
            full
        };
        Ok(DiffInfo {
            stat,
            diff,
            truncated,
        })
    }

    async fn diff_common(
        &self,
        args: &[&str],
        path: Option<&str>,
    ) -> Result<Option<String>> {
        let mut full = args.to_vec();
        push_path_arg(&mut full, path);
        self.run_opt(&full, &[]).await
    }

    /// 供 AI 提示词使用的完整差异文本（stat + diff）。
    pub async fn diff_for_ai(&self, path: Option<&str>, cached: bool) -> Result<String> {
        let info = self.diff(path, cached, 5).await?;
        Ok(format!("{}\n{}", info.stat, info.diff))
    }

    // -- 补丁应用 ----------------------------------------------------------

    /// 应用 AI 生成的 unified diff 补丁（参数化执行，patch 经 stdin 传入，不走 shell）。
    /// 先 `git apply --check -` 干跑校验，未通过则报错且不落地任何修改；
    /// 校验通过后再 `git apply -` 正式应用。patch 来自模型输出，必须校验后再写盘。
    pub async fn apply_patch(&self, patch: &str) -> Result<()> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        if patch.trim().is_empty() {
            bail!("patch is empty");
        }
        // 1. --check 干跑：校验通过前不触碰工作区。
        let (code, _stdout, stderr) = self
            .run_output_stdin(&["apply", "--check", "-"], &[], patch)
            .await?;
        if code != 0 {
            bail!(
                "git apply --check 未通过，补丁未应用（可通过快照回滚）：{}",
                stderr.trim()
            );
        }
        // 2. 校验通过后再正式应用。
        let (code, _stdout, stderr) = self
            .run_output_stdin(&["apply", "-"], &[], patch)
            .await?;
        if code != 0 {
            bail!("git apply 应用失败（可通过快照回滚）：{}", stderr.trim());
        }
        Ok(())
    }

    // -- 暂存与提交 --------------------------------------------------------

    pub async fn stage(&self, paths: &[String], all: bool) -> Result<()> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        if all {
            self.run(&["add", "-A"], &[]).await?;
        } else {
            let mut args = vec!["add", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.run(&args, &[]).await?;
        }
        Ok(())
    }

    pub async fn unstage(&self, paths: &[String], all: bool) -> Result<()> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        if all {
            self.run(&["restore", "--staged", "."], &[]).await?;
        } else {
            let mut args = vec!["restore", "--staged", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.run(&args, &[]).await?;
        }
        Ok(())
    }

    pub async fn commit(&self, message: &str) -> Result<String> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        let trimmed = message.trim();
        if trimmed.is_empty() {
            bail!("commit message cannot be empty");
        }
        let name = self
            .run_opt(&["config", "--get", "user.name"], &[])
            .await?
            .unwrap_or_else(|| "Coomi".to_owned());
        let email = self
            .run_opt(&["config", "--get", "user.email"], &[])
            .await?
            .unwrap_or_else(|| "coomi@local".to_owned());
        let name_arg = format!("user.name={name}");
        let email_arg = format!("user.email={email}");
        let args = [
            "-c",
            name_arg.as_str(),
            "-c",
            email_arg.as_str(),
            "commit",
            "-m",
            trimmed,
            "-q",
        ];
        self.run(&args, &[]).await?;
        self.rev_parse_head().await
    }

    pub async fn rev_parse_head(&self) -> Result<String> {
        self.run(&["rev-parse", "HEAD"], &[]).await
    }

    // -- 分支 --------------------------------------------------------------

    pub async fn branches(&self) -> Result<BranchInfo> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        // 分离头（detached HEAD）时 symbolic-ref 退出码非零属正常，保持容错；
        // 但 `git branch --format` 在有效仓库上失败必定是真实故障（git 缺失、
        // 仓库损坏等），必须把 stderr 上抛，否则前端会静默显示「暂无分支」，
        // 用户看到的现象就是「分支列表里没有、创建完也不出现」。
        let current = self.run_opt(&["symbolic-ref", "--short", "HEAD"], &[]).await?;
        let (code, raw, stderr) = self
            .run_output(&["branch", "--format=%(refname:short)"], &[])
            .await?;
        if code != 0 {
            bail!("git branch failed: {}", stderr.trim());
        }
        let branches = raw.lines().map(str::to_owned).collect();
        Ok(BranchInfo { current, branches })
    }

    pub async fn checkout(&self, branch: &str) -> Result<String> {
        if branch.trim().is_empty() {
            bail!("branch name cannot be empty");
        }
        let output = self.run(&["checkout", branch], &[]).await?;
        Ok(output.trim().to_owned())
    }

    pub async fn create_branch(&self, name: &str) -> Result<String> {
        if name.trim().is_empty() {
            bail!("branch name cannot be empty");
        }
        let output = self.run(&["checkout", "-b", name], &[]).await?;
        Ok(output.trim().to_owned())
    }

    // -- 提交历史 ----------------------------------------------------------

    pub async fn log(&self, path: Option<&str>, limit: usize) -> Result<Vec<CommitInfo>> {
        if !self.is_repo() {
            return Ok(Vec::new());
        }
        let limit_str = limit.clamp(1, 200).to_string();
        let mut args = vec![
            "log",
            "-n",
            limit_str.as_str(),
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%at",
        ];
        push_path_arg(&mut args, path);
        let Some(raw) = self.run_opt(&args, &[]).await? else {
            return Ok(Vec::new());
        };
        let mut commits = Vec::new();
        for line in raw.lines() {
            let fields: Vec<&str> = line.split('\u{1f}').collect();
            if fields.len() < 5 {
                continue;
            }
            commits.push(CommitInfo {
                hash: fields[0].to_owned(),
                short: fields[1].to_owned(),
                subject: fields[2].to_owned(),
                author: fields[3].to_owned(),
                date: fields[4].to_owned(),
            });
        }
        Ok(commits)
    }

    /// 两个提交/引用之间的共同基线提交（merge-base）。
    /// 参数化执行、不经 shell；分支不存在或无共同祖先时返回 Err。
    pub async fn merge_base(&self, a: &str, b: &str) -> Result<String> {
        self.run(&["merge-base", a, b], &[]).await
    }

    /// 展示单个提交，返回 (subject, diff)：
    /// - subject 用 `git show -s --pretty=format:%s rev` 单独取得；
    /// - diff 用 `git show --no-ext-diff --no-color --unified=5 rev` 取得
    ///   （默认相对第一个父提交；头部含提交信息，供根因分析结合上下文）。
    /// 两者均参数化执行、不经 shell；rev 不存在时返回 Err。
    pub async fn show_commit(&self, rev: &str) -> Result<(String, String)> {
        let subject = self.run(&["show", "-s", "--pretty=format:%s", rev], &[]).await?;
        let diff = self
            .run(&["show", "--no-ext-diff", "--no-color", "--unified=5", rev], &[])
            .await?;
        Ok((subject, diff))
    }

    // -- stash -------------------------------------------------------------

    pub async fn stash_list(&self) -> Result<Vec<StashEntry>> {
        if !self.is_repo() {
            return Ok(Vec::new());
        }
        let Some(raw) = self
            .run_opt(&["stash", "list", "--pretty=format:%gd%x1f%s"], &[])
            .await?
        else {
            return Ok(Vec::new());
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
            entries.push(StashEntry {
                index,
                message: fields[1].to_owned(),
            });
        }
        Ok(entries)
    }

    pub async fn stash_push(&self, message: Option<&str>) -> Result<String> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        let mut args = vec!["stash", "push", "-u"];
        if let Some(message) = message {
            if !message.trim().is_empty() {
                args.push("-m");
                args.push(message);
            }
        }
        let output = self.run(&args, &[]).await?;
        Ok(output.trim().to_owned())
    }

    pub async fn stash_pop(&self, index: usize) -> Result<String> {
        let stash_ref = format!("stash@{{{index}}}");
        let output = self.run(&["stash", "pop", stash_ref.as_str()], &[]).await?;
        Ok(output.trim().to_owned())
    }

    pub async fn stash_drop(&self, index: usize) -> Result<String> {
        let stash_ref = format!("stash@{{{index}}}");
        let output = self.run(&["stash", "drop", stash_ref.as_str()], &[]).await?;
        Ok(output.trim().to_owned())
    }

    // -- 远程仓库 ----------------------------------------------------------

    pub async fn remotes(&self) -> Result<Vec<RemoteInfo>> {
        if !self.is_repo() {
            return Ok(Vec::new());
        }
        let Some(raw) = self.run_opt(&["remote", "-v"], &[]).await? else {
            return Ok(Vec::new());
        };
        let mut remotes = Vec::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if !trimmed.ends_with("(fetch)") {
                continue;
            }
            let core = trimmed.trim_end_matches("(fetch)").trim();
            let Some((name, url)) = core.split_once('\t') else {
                continue;
            };
            let name = name.trim().to_owned();
            if remotes.iter().any(|r: &RemoteInfo| r.name == name) {
                continue;
            }
            let url = url.trim().to_owned();
            remotes.push(RemoteInfo {
                platform: detect_platform(&url),
                name,
                url,
            });
        }
        Ok(remotes)
    }

    pub async fn fetch(&self) -> Result<String> {
        let output = self.run(&["fetch", "--prune"], &[]).await?;
        Ok(output.trim().to_owned())
    }

    pub async fn pull(&self, remote: &str, branch: &str) -> Result<String> {
        let output = self.run(&["pull", remote, branch], &[]).await?;
        Ok(output.trim().to_owned())
    }

    /// 推送；`token` 存在时通过临时 credential helper 注入，helper 从环境变量
    /// `COOMI_GIT_TOKEN` 读取令牌，用完即删，不写 remote URL 与 .git-credentials。
    pub async fn push(&self, remote: &str, branch: &str, token: Option<&str>) -> Result<String> {
        let helper = match token {
            Some(token) => Some(self.write_credential_helper(token).await?),
            None => None,
        };
        let result = match &helper {
            Some(path) => {
                let helper_arg = format!("credential.helper={}", path.display());
                let token = token.context("token missing while helper exists")?;
                let args = vec![
                    "-c",
                    helper_arg.as_str(),
                    "push",
                    remote,
                    branch,
                ];
                self.run(&args, &[("COOMI_GIT_TOKEN", token)]).await
            }
            None => {
                let args = vec!["push", remote, branch];
                self.run(&args, &[]).await
            }
        };
        if let Some(helper) = helper {
            let _ = std::fs::remove_file(&helper);
        }
        let output = result?;
        Ok(output.trim().to_owned())
    }

    async fn write_credential_helper(&self, token: &str) -> Result<PathBuf> {
        let git_dir = self.workspace.join(".git");
        if !git_dir.is_dir() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        let path = git_dir.join(format!(
            "coomi-cred-helper-{}-{}",
            Uuid::new_v4(),
            token.len()
        ));
        let script = "#!/bin/sh\necho \"username=oauth2\"\necho \"password=${COOMI_GIT_TOKEN}\"\n";
        std::fs::write(&path, script)
            .with_context(|| format!("failed to write credential helper {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path)?.permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(&path, perms)?;
        }
        Ok(path)
    }

    // -- 项目识别与 .gitignore ---------------------------------------------

    pub async fn project_info(&self) -> Result<ProjectInfo> {
        let mut detected = Vec::new();
        for (file, label) in PROJECT_MARKERS {
            if self.workspace.join(file).exists() && !detected.iter().any(|d| d == label) {
                detected.push((*label).to_owned());
            }
        }
        let gitignore = if detected.is_empty() {
            None
        } else {
            let mut parts = Vec::new();
            for label in &detected {
                if let Some(template) = GITIGNORE_TEMPLATES.get(label.as_str()) {
                    parts.push((*template).to_owned());
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        };
        Ok(ProjectInfo { detected, gitignore })
    }

    // -- 快照（轮次存档点） ------------------------------------------------

    pub async fn snapshot_create(
        &self,
        kind: &str,
        session_id: Option<&str>,
        turn: Option<u64>,
        summary: &str,
    ) -> Result<Snapshot> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        let created_at = now_secs();
        let id = match (session_id, turn) {
            (Some(session), Some(turn)) => format!("turn-{session}-{turn}"),
            (Some(session), None) => format!("session-{session}"),
            _ => format!("manual-{created_at}-{}", Uuid::new_v4().simple()),
        };
        let ref_name = format!("{SNAPSHOT_REF_PREFIX}/{id}");

        let tmp_index = self.workspace.join(".git").join(format!(
            "coomi-index-{}-{}",
            Uuid::new_v4().simple(),
            created_at
        ));
        let index_env_key = "GIT_INDEX_FILE";
        let index_env_value = tmp_index.to_string_lossy().into_owned();
        let index_env_refs = [(index_env_key, index_env_value.as_str())];

        // 1. 用临时索引收集工作区全貌（含未跟踪文件），不触碰用户暂存区。
        self.run(&["add", "-A"], &index_env_refs).await?;
        // 2. 生成树对象。
        let tree = self.run(&["write-tree"], &index_env_refs).await?;
        let _ = std::fs::remove_file(&tmp_index);
        // 3. 生成提交对象（首次快照无父提交）。
        let head = self.run_opt(&["rev-parse", "--verify", "HEAD"], &[]).await?;
        let commit_message = format!("coomi {kind} {summary}");
        let mut commit_args = vec!["commit-tree", tree.trim(), "-m", &commit_message];
        if let Some(head) = &head {
            commit_args.push("-p");
            commit_args.push(head);
        }
        let commit = self.run(&commit_args, &[]).await?;
        let commit = commit.trim().to_owned();
        // 4. 建立独立 ref。
        self.run(&["update-ref", &ref_name, &commit], &[]).await?;
        // 5. 统计文件数。
        let file_count = self
            .run_opt(&["ls-tree", "-r", "--name-only", &commit], &[])
            .await?
            .map(|out| out.lines().count())
            .unwrap_or(0);

        let snapshot = Snapshot {
            id,
            kind: kind.to_owned(),
            session_id: session_id.map(str::to_owned),
            turn,
            summary: summary.to_owned(),
            created_at,
            sha: commit,
            file_count,
            note: None,
            locked: false,
        };
        self.index_add(&snapshot)?;
        self.prune_snapshots().await?;
        Ok(snapshot)
    }

    pub async fn snapshot_list(&self) -> Result<Vec<Snapshot>> {
        let mut list = self.index_load()?;
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list)
    }

    pub async fn snapshot_update(
        &self,
        id: &str,
        note: Option<&str>,
        locked: Option<bool>,
    ) -> Result<Snapshot> {
        let mut snap = self.index_find(id)?;
        if let Some(note) = note {
            snap.note = Some(note.to_owned());
        }
        if let Some(locked) = locked {
            snap.locked = locked;
        }
        self.index_replace(&snap)?;
        Ok(snap)
    }

    /// 还原预览：列出将回退的已跟踪文件与将删除的未跟踪文件（模拟，不删除）。
    pub async fn snapshot_preview(&self, id: &str) -> Result<SnapshotPreview> {
        let snap = self.index_find(id)?;
        let sha = snap.sha.as_str();
        let stat = self
            .run_opt(&["diff", "--stat", sha], &[])
            .await?
            .unwrap_or_default();
        let reverted_files = self
            .run_opt(&["diff", "--name-only", sha], &[])
            .await?
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect();
        let untracked_to_delete = self.simulate_clean().await?;
        Ok(SnapshotPreview {
            snapshot: snap,
            stat,
            reverted_files,
            untracked_to_delete,
        })
    }

    /// 执行还原：先自动打"还原前"备份，再 `reset --hard` + `clean -fd`。
    pub async fn snapshot_restore(&self, id: &str) -> Result<RestoreReport> {
        let snap = self.index_find(id)?;
        let sha = snap.sha.clone();
        let backup = self
            .snapshot_create("pre-restore", None, None, &format!("before restore {id}"))
            .await?;
        let reverted_files = self
            .run_opt(&["diff", "--name-only", &sha], &[])
            .await?
            .map(|out| out.lines().count())
            .unwrap_or(0);
        let deleted_untracked = self.simulate_clean().await?.len();
        self.run(&["reset", "--hard", &sha], &[]).await?;
        self.run(&["clean", "-fd"], &[]).await?;
        Ok(RestoreReport {
            restored_to: sha,
            reverted_files,
            deleted_untracked,
            backup_snapshot_id: backup.id,
        })
    }

    pub async fn snapshot_delete(&self, id: &str) -> Result<()> {
        self.index_remove(id)?;
        let _ = self
            .run_opt(&["update-ref", "-d", &format!("{SNAPSHOT_REF_PREFIX}/{id}")], &[])
            .await?;
        Ok(())
    }

    async fn simulate_clean(&self) -> Result<Vec<String>> {
        let Some(raw) = self.run_opt(&["clean", "-nd"], &[]).await? else {
            return Ok(Vec::new());
        };
        // 统一 LC_ALL=C 后，输出形如 "Would remove foo/bar.txt"。
        let mut paths = Vec::new();
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("Would remove ") {
                paths.push(rest.to_owned());
            }
        }
        Ok(paths)
    }

    /// 保留最近 MAX_SNAPSHOTS 个（跳过 locked），从最旧开始清理 ref。
    async fn prune_snapshots(&self) -> Result<()> {
        let mut list = self.index_load()?;
        list.sort_by_key(|s| s.created_at);
        while list.len() > MAX_SNAPSHOTS {
            match list.iter().position(|s| !s.locked) {
                Some(pos) => {
                    let victim = list.remove(pos);
                    let _ = self
                        .run_opt(
                            &["update-ref", "-d", &format!("{SNAPSHOT_REF_PREFIX}/{}", victim.id)],
                            &[],
                        )
                        .await?;
                }
                None => break,
            }
        }
        self.index_save(&list)
    }

    /// 按定时快照的 retain 配置清理：保留最近 `retain` 个（跳过 locked），
    /// 从最旧开始逐个删除非 locked 快照。`retain = 0` 表示不启用 retain 清理
    /// （系统默认 MAX_SNAPSHOTS=200 的行为由 [`Self::snapshot_create`] 内部保证）。
    /// 供定时快照调度触发后调用；不修改现有 MAX_SNAPSHOTS 上限逻辑。
    pub async fn prune_snapshots_retain(&self, retain: usize) -> Result<()> {
        if retain == 0 {
            return Ok(());
        }
        let mut list = self.index_load()?;
        list.sort_by_key(|s| s.created_at);
        // 先按 created_at 从旧到新找出需要清理的受害者（locked 跳过，保留最近 retain 个）。
        let mut victims = Vec::new();
        while list.len() > retain {
            match list.iter().position(|s| !s.locked) {
                Some(pos) => victims.push(list.remove(pos)),
                None => break,
            }
        }
        for victim in victims {
            self.snapshot_delete(&victim.id).await?;
        }
        Ok(())
    }

    // -- 快照索引（<home>/coomi-snapshots.json） ---------------------------

    fn index_path(&self) -> PathBuf {
        self.home.join(SNAPSHOT_INDEX_FILE)
    }

    fn index_load(&self) -> Result<Vec<Snapshot>> {
        let path = self.index_path();
        let Ok(bytes) = std::fs::read(&path) else {
            return Ok(Vec::new());
        };
        match serde_json::from_slice::<Vec<Snapshot>>(&bytes) {
            Ok(list) => Ok(list),
            Err(error) => {
                let backup = path.with_extension(format!(
                    "json.corrupt-{}",
                    now_secs()
                ));
                let _ = std::fs::rename(&path, &backup);
                anyhow::bail!("snapshot index corrupted (backed up to {}): {error}", backup.display())
            }
        }
    }

    fn index_save(&self, list: &[Snapshot]) -> Result<()> {
        let path = self.index_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(list)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn index_find(&self, id: &str) -> Result<Snapshot> {
        self.index_load()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| anyhow!("snapshot not found: {id}"))
    }

    fn index_add(&self, snapshot: &Snapshot) -> Result<()> {
        let mut list = self.index_load()?;
        list.retain(|s| s.id != snapshot.id);
        list.push(snapshot.clone());
        self.index_save(&list)
    }

    fn index_replace(&self, snapshot: &Snapshot) -> Result<()> {
        self.index_add(snapshot)
    }

    fn index_remove(&self, id: &str) -> Result<()> {
        let mut list = self.index_load()?;
        list.retain(|s| s.id != id);
        self.index_save(&list)
    }

    // -- 备份导出 ----------------------------------------------------------

    /// 将仓库打包为 `git bundle`，返回产物路径；空仓库降级为仅 HEAD。
    pub async fn bundle(&self, dest_dir: &Path) -> Result<PathBuf> {
        if !self.is_repo() {
            bail!("not a git repository: {}", self.workspace.display());
        }
        std::fs::create_dir_all(dest_dir)?;
        let dest = dest_dir.join(format!("workspace-{}.bundle", now_secs()));
        let result = self
            .run(&["bundle", "create", dest.to_str().context("non-utf8 dest")?, "--all"], &[])
            .await;
        if result.is_err() {
            self.run(
                &[
                    "bundle",
                    "create",
                    dest.to_str().context("non-utf8 dest")?,
                    "HEAD",
                ],
                &[],
            )
            .await?;
        }
        Ok(dest)
    }

    // -- 命令执行 ----------------------------------------------------------

    async fn run(&self, args: &[&str], envs: &[(&str, &str)]) -> Result<String> {
        let (code, stdout, stderr) = self.run_output(args, envs).await?;
        if code != 0 {
            bail!("git {} failed: {}", args.first().copied().unwrap_or(""), stderr.trim());
        }
        Ok(stdout.trim().to_owned())
    }

    /// 成功且有非空输出时返回 Some，否则 None（不把非零退出码当错误）。
    /// `pub(crate)`：data_tools 等同一 crate 内的 git 消费者复用 PRoot 路由。
    pub(crate) async fn run_opt(
        &self,
        args: &[&str],
        envs: &[(&str, &str)],
    ) -> Result<Option<String>> {
        let (code, stdout, _stderr) = self.run_output(args, envs).await?;
        if code != 0 {
            return Ok(None);
        }
        let trimmed = stdout.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Ok(Some(trimmed.to_owned()))
    }

    /// 执行 git 并返回 (退出码, stdout, stderr)。`pub(crate)`：ai_git 等
    /// 同一 crate 内的消费者需要原始输出时复用 PRoot 路由。
    pub(crate) async fn run_output(
        &self,
        args: &[&str],
        envs: &[(&str, &str)],
    ) -> Result<(i32, String, String)> {
        run_git(&self.workspace, args, envs, self.runtime_home.as_deref())
            .await
            .with_context(|| format!("failed to run git in {}", self.workspace.display()))
    }

    /// 同 [`Self::run_output`]，但把 `stdin_data` 经管道写入子进程 stdin
    /// （供 `git apply -` 等从 stdin 读取输入的参数化调用使用；PRoot guest 路由
    /// 与宿主直跑路由均支持）。
    async fn run_output_stdin(
        &self,
        args: &[&str],
        envs: &[(&str, &str)],
        stdin_data: &str,
    ) -> Result<(i32, String, String)> {
        run_git_stdin(&self.workspace, args, envs, stdin_data, self.runtime_home.as_deref())
            .await
            .with_context(|| format!("failed to run git in {}", self.workspace.display()))
    }
}

// ---------------------------------------------------------------------------
// git 命令执行（PRoot 路由优先，宿主直跑兜底）
// ---------------------------------------------------------------------------

/// 在指定工作区执行 git，返回 (退出码, stdout, stderr)。
///
/// - `runtime_home` 为 Some 且 PRoot Linux 运行时可用时，git 在 guest 内执行：
///   workspace bind 为 `/workspace`，`envs` 中落在 workspace 内的路径自动映射
///   （如快照的 `GIT_INDEX_FILE`）。Android 宿主通常没有 git 二进制，必须走此路由。
/// - 运行时不可用（未安装 / rootfs 不完整 / 无 active 版本）时回退宿主直接执行，
///   桌面与开发环境（宿主自带 git）行为与旧版一致。
pub async fn run_git(
    workspace: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    runtime_home: Option<&Path>,
) -> Result<(i32, String, String)> {
    if let Some(home) = runtime_home {
        if let Ok(backend) = proot_backend(home) {
            match run_git_in_guest(&backend, workspace, args, envs).await {
                Ok(output) => return Ok(output),
                Err(runtime_error) => {
                    // 仅当 guest 路由不可用（proot 缺失/rootfs 不完整）时回退宿主；
                    // git 在 guest 内的非零退出不在此列（已作为正常结果返回）。
                    let _ = runtime_error;
                }
            }
        }
    }
    run_git_direct(workspace, args, envs).await
}

/// 从 Coomi home 解析当前活跃的 PRoot Linux 后端（仅解析版本，不校验完整性；
/// 完整性由 `backend.command` 在构建命令时校验）。
fn proot_backend(home: &Path) -> Result<ProotLinuxBackend> {
    let manager = RuntimeManager::open(home)?;
    let state = manager.state()?;
    let version = state.active_version.context("no active runtime version")?;
    Ok(ProotLinuxBackend {
        runtime_root: home.join("runtime-v2"),
        version,
    })
}

/// 在 guest 内执行 git：workspace bind 为 /workspace，工作目录即 /workspace。
async fn run_git_in_guest(
    backend: &ProotLinuxBackend,
    workspace: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<(i32, String, String)> {
    let args_owned: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let mut runtime_command = backend
        .command(workspace, "git", &args_owned)
        .context("PRoot runtime is not ready")?;
    runtime_command
        .environment
        .insert("LC_ALL".into(), "C".into());
    runtime_command
        .environment
        .insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    for (key, value) in envs {
        runtime_command
            .environment
            .insert((*key).into(), map_guest_path(workspace, value));
    }
    let mut command = runtime_command.into_tokio();
    let output = run_child_limited(&mut command, "git inside PRoot runtime").await?;
    Ok(output)
}

/// 带超时运行子进程（stdout/stderr 均 piped）：超时 kill 后立即返回错误，绝不悬挂。
/// 并发排空两个管道是必须的——git 大输出（如大 diff）超过管道缓冲时，只 wait 不读
/// 会死锁。超时必须包住「排空 + 等待」整组操作：仅 kill 直接子进程时，孙进程
/// （如 proot 的 guest 命令、shell 脚本的子 sleep）可能仍持有管道写端，导致排空
/// future 永不完成；外层超时把整个 run future 一并丢弃（管道读端关闭）并返回错误。
/// 供 guest 路由与宿主直跑共用：Android 上 proot/git 卡死时若无限等待，HTTP 请求
/// 会一直挂起，前端 `switchingBranch` 守卫随之永久锁死（无法切换、创建后列表
/// 不刷新，与用户报告的现象一致）。
async fn run_child_limited(
    command: &mut tokio::process::Command,
    what: &str,
) -> Result<(i32, String, String)> {
    run_child_limited_with_timeout(command, what, GIT_COMMAND_TIMEOUT).await
}

/// `run_child_limited` 的实现体；超时时长可注入（测试用短超时验证「卡死即报错、
/// 绝不悬挂」），生产路径统一走 [`GIT_COMMAND_TIMEOUT`]。
async fn run_child_limited_with_timeout(
    command: &mut tokio::process::Command,
    what: &str,
    timeout: Duration,
) -> Result<(i32, String, String)> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn {what}"))?;
    let stdout_drain = drain_stream(child.stdout.take(), "stdout");
    let stderr_drain = drain_stream(child.stderr.take(), "stderr");
    let run = async {
        let (wait_result, stdout, stderr) = tokio::join!(
            async {
                child
                    .wait()
                    .await
                    .with_context(|| format!("failed to wait for {what}"))
            },
            stdout_drain,
            stderr_drain,
        );
        let status = wait_result?;
        Ok::<_, anyhow::Error>((status.code().unwrap_or(-1), stdout, stderr))
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.start_kill();
            bail!("{what} timed out after {} seconds", timeout.as_secs());
        }
    }
}

/// 把子进程管道流读到 EOF（进程退出、管道关闭即返回；读取失败按空串处理）。
async fn drain_stream<R>(reader: Option<R>, _label: &str) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    let Some(mut reader) = reader else {
        return String::new();
    };
    let mut buf = String::new();
    let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut buf).await;
    buf
}

/// 把 workspace 内的宿主路径映射为 guest 内路径（如 `<workspace>/.git/..` → `/workspace/.git/..`）。
/// `pub`：web.rs 的 git_remote_test 用同样的映射改写 `credential.helper=<path>` 参数。
pub fn map_guest_path(workspace: &Path, value: &str) -> String {
    let path = Path::new(value);
    match path.strip_prefix(workspace) {
        Ok(rest) => format!("/workspace/{}", rest.to_string_lossy()),
        Err(_) => value.to_owned(),
    }
}

/// 宿主直接执行 git（桌面/开发环境；Android 宿主无 git 时此处会报错）。
async fn run_git_direct(
    workspace: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<(i32, String, String)> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0");
    for (key, value) in envs {
        command.env(key, value);
    }
    let output = run_child_limited(&mut command, "git")
        .await
        .with_context(|| format!("failed to run git in {}", workspace.display()))?;
    Ok(output)
}

/// 与 [`run_git`] 等价，但把 `stdin_data` 经管道写入子进程 stdin（PRoot guest
/// 路由优先、宿主直跑兜底），供 `git apply -` 等从 stdin 读取输入的调用使用。
async fn run_git_stdin(
    workspace: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin_data: &str,
    runtime_home: Option<&Path>,
) -> Result<(i32, String, String)> {
    if let Some(home) = runtime_home {
        if let Ok(backend) = proot_backend(home) {
            match run_git_in_guest_stdin(&backend, workspace, args, envs, stdin_data).await {
                Ok(output) => return Ok(output),
                Err(runtime_error) => {
                    // 与 run_git 一致：仅 guest 路由不可用时回退宿主。
                    let _ = runtime_error;
                }
            }
        }
    }
    run_git_direct_stdin(workspace, args, envs, stdin_data).await
}

/// 在 guest 内执行 git 并写入 stdin（workspace bind 为 /workspace）。
async fn run_git_in_guest_stdin(
    backend: &ProotLinuxBackend,
    workspace: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin_data: &str,
) -> Result<(i32, String, String)> {
    let args_owned: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let mut runtime_command = backend
        .command(workspace, "git", &args_owned)
        .context("PRoot runtime is not ready")?;
    runtime_command
        .environment
        .insert("LC_ALL".into(), "C".into());
    runtime_command
        .environment
        .insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    for (key, value) in envs {
        runtime_command
            .environment
            .insert((*key).into(), map_guest_path(workspace, value));
    }
    let command = runtime_command.into_tokio();
    run_command_with_stdin(command, stdin_data)
        .await
        .context("failed to run git inside PRoot runtime")
}

/// 宿主直接执行 git 并写入 stdin（桌面/开发环境）。
async fn run_git_direct_stdin(
    workspace: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin_data: &str,
) -> Result<(i32, String, String)> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0");
    for (key, value) in envs {
        command.env(key, value);
    }
    run_command_with_stdin(command, stdin_data)
        .await
        .with_context(|| format!("failed to run git in {}", workspace.display()))
}

/// 以指定 stdin 内容启动子进程并等待结束，返回 (退出码, stdout, stderr)。
/// stdin 通过管道写入，写完立即关闭（EOF），避免子进程挂起等待输入；
/// 「写 stdin + 排空输出 + 等待退出」整组受 [`GIT_COMMAND_TIMEOUT`] 约束：
/// 超时 kill 后立即返回错误（排空 future 一并丢弃），绝不无限挂起。
async fn run_command_with_stdin(
    mut command: Command,
    stdin_data: &str,
) -> Result<(i32, String, String)> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .context("failed to spawn git subprocess")?;
    let mut stdin = child
        .stdin
        .take()
        .context("git subprocess stdin unavailable")?;
    let stdout_drain = drain_stream(child.stdout.take(), "stdout");
    let stderr_drain = drain_stream(child.stderr.take(), "stderr");
    let run = async {
        // 写 stdin；git 不读时管道写满会挂起，由外层超时兜底。
        stdin
            .write_all(stdin_data.as_bytes())
            .await
            .context("failed to write git stdin")?;
        drop(stdin); // 关闭 stdin，git 读到 EOF 后继续执行
        let (wait_result, stdout, stderr) = tokio::join!(
            async {
                child
                    .wait()
                    .await
                    .context("failed to wait for git subprocess")
            },
            stdout_drain,
            stderr_drain,
        );
        let status = wait_result?;
        Ok::<_, anyhow::Error>((status.code().unwrap_or(-1), stdout, stderr))
    };
    match tokio::time::timeout(GIT_COMMAND_TIMEOUT, run).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.start_kill();
            bail!(
                "git subprocess timed out after {} seconds",
                GIT_COMMAND_TIMEOUT.as_secs()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// porcelain v2 解析
// ---------------------------------------------------------------------------

fn parse_porcelain_v2(raw: &str, status: &mut GitStatus) {
    for entry in raw.split('\0') {
        let line = entry.trim();
        if line.is_empty() {
            continue;
        }
        let bytes = line.as_bytes();
        let marker = bytes[0] as char;
        match marker {
            '?' => status.untracked.push(FileEntry {
                path: line[2..].to_owned(),
                status: "??".to_owned(),
                old_path: None,
            }),
            '!' => {} // ignored entries are skipped
            '1' => {
                let Some(fields) = split_fields(line, 8) else {
                    continue;
                };
                let xy = fields[1];
                push_classified(status, xy, fields[7], None);
            }
            '2' => {
                let Some(fields) = split_fields(line, 10) else {
                    continue;
                };
                push_classified(status, fields[1], fields[8], Some(fields[9]));
            }
            'u' => {
                let Some(fields) = split_fields(line, 10) else {
                    continue;
                };
                status.conflicted.push(FileEntry {
                    path: fields[9].to_owned(),
                    status: fields[1].to_owned(),
                    old_path: None,
                });
            }
            _ => {}
        }
    }
}

/// 前 n 个字段按空格拆分（porcelain v2 字段无空格），path 可能含空格故取剩余部分。
fn split_fields<'a>(line: &'a str, count: usize) -> Option<Vec<&'a str>> {
    let mut fields = Vec::with_capacity(count);
    let mut rest = line;
    for index in 0..count {
        let split = if index == count - 1 {
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

fn push_classified(status: &mut GitStatus, xy: &str, path: &str, old_path: Option<&str>) {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    let entry = FileEntry {
        path: path.to_owned(),
        status: xy.to_owned(),
        old_path: old_path.map(str::to_owned),
    };
    if index == 'U' || worktree == 'U' || matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA") {
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
// 远程平台识别
// ---------------------------------------------------------------------------

/// 从 remote URL 解析托管平台；识别不出返回主机名（或 "Other"）。
pub fn detect_platform(url: &str) -> String {
    let host = extract_host(url).unwrap_or_default();
    let lower = host.to_ascii_lowercase();
    if lower == "github.com" {
        return "GitHub".into();
    }
    if lower == "gitee.com" {
        return "Gitee".into();
    }
    if lower.contains("atomgit") || lower.contains("gitcode") {
        return "AtomGit".into();
    }
    if lower.contains("gitlab") {
        return "GitLab".into();
    }
    if lower.is_empty() {
        "Other".into()
    } else {
        host.to_owned()
    }
}

fn extract_host(url: &str) -> Option<&str> {
    let rest = if let Some(idx) = url.find("://") {
        &url[idx + 3..]
    } else {
        url
    };
    let rest = rest.strip_prefix("git@").unwrap_or(rest);
    let host = if let Some(idx) = rest.find(':') {
        &rest[..idx]
    } else {
        let path_end = rest.find(['/', '?']).unwrap_or(rest.len());
        &rest[..path_end]
    };
    let host = host.trim_end_matches('.');
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

// ---------------------------------------------------------------------------
// 项目标记与 .gitignore 模板
// ---------------------------------------------------------------------------

const PROJECT_MARKERS: &[(&str, &str)] = &[
    ("Cargo.toml", "Rust (Cargo)"),
    ("package.json", "Node.js"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("pom.xml", "Java (Maven)"),
    ("build.gradle", "Gradle"),
    ("settings.gradle", "Gradle"),
    ("go.mod", "Go"),
    ("*.csproj", ".NET"),
];

static GITIGNORE_TEMPLATES: std::sync::LazyLock<std::collections::BTreeMap<&'static str, &'static str>> =
    std::sync::LazyLock::new(|| {
        let mut map = std::collections::BTreeMap::new();
        map.insert("Rust (Cargo)", "/target\nCargo.lock\n");
        map.insert(
            "Node.js",
            "node_modules/\ndist/\ncoverage/\n*.log\n.env\n.env.*\n!.env.example\n",
        );
        map.insert(
            "Python",
            "__pycache__/\n*.py[cod]\n*.so\n.Python\n.venv/\nvenv/\n.env\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n",
        );
        map.insert("Java (Maven)", "target/\n*.class\n*.jar\n*.war\n");
        map.insert("Gradle", ".gradle/\nbuild/\n!gradle/wrapper/gradle-wrapper.jar\n");
        map.insert("Go", "bin/\n*.exe\n*.test\n*.out\n");
        map.insert(
            ".NET",
            "bin/\nobj/\n*.user\n.vs/\n",
        );
        map.insert(
            "通用",
            ".DS_Store\nThumbs.db\n*.swp\n*~\n.idea/\n.vscode/\n*.iml\n",
        );
        map
    });

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

fn push_path_arg<'a>(args: &mut Vec<&'a str>, path: Option<&'a str>) {
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn repo() -> (tempfile::TempDir, GitEngine) {
        let dir = tempfile::tempdir().expect("tempdir");
        // 仓库与 home 放在同一临时目录下但互为兄弟，避免 home 出现在仓库内被
        // `git clean` 视为未跟踪目录（生产环境中 home 在 workspace 之外）。
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("repo dir");
        let engine = GitEngine::new(
            dir.path().join("home"),
            root.clone(),
        );
        let init = Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&root)
            .output()
            .await
            .expect("git init");
        assert!(init.status.success());
        let identity = Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&root)
            .output()
            .await
            .expect("set user.name");
        assert!(identity.status.success(), "set user.name failed");
        let identity = Command::new("git")
            .args(["config", "user.email", "test@local"])
            .current_dir(&root)
            .output()
            .await
            .expect("set user.email");
        assert!(identity.status.success(), "set user.email failed");
        let identity = Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init", "-q"])
            .current_dir(&root)
            .output()
            .await
            .expect("initial commit");
        assert!(identity.status.success(), "initial commit failed");
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
    async fn status_classifies_changes() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "tracked.txt", "v1").await;
        engine.stage(&["tracked.txt".into()], false).await?;
        engine
            .commit("add tracked")
            .await?;

        write(&root, "tracked.txt", "v2").await; // unstaged 修改
        write(&root, "new.txt", "hello").await; // untracked
        write(&root, "staged.txt", "x").await; // staged
        engine.stage(&["staged.txt".into()], false).await?;

        let status = engine.status().await?;
        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.staged.is_empty());
        assert!(!status.unstaged.is_empty());
        assert!(!status.untracked.is_empty());
        assert!(status.conflicted.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn commit_and_log_roundtrip() -> Result<()> {
        let (dir, engine) = repo().await;
        write(&dir.path().join("repo"), "a.txt", "content").await;
        engine.stage(&["a.txt".into()], false).await?;
        let hash = engine.commit("feat: add a.txt").await?;
        assert_eq!(hash.len(), 40);

        let commits = engine.log(None, 10).await?;
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "feat: add a.txt");
        assert_eq!(commits[0].author, "Test");

        let by_path = engine.log(Some("a.txt"), 10).await?;
        assert_eq!(by_path.len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn snapshot_create_list_restore_roundtrip() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "keep.txt", "keep").await;
        engine.stage(&["keep.txt".into()], false).await?;
        engine.commit("keep").await?;

        // 打快照（模拟"轮次开始前"）
        engine
            .snapshot_create("turn", Some("s1"), Some(1), "user asked something")
            .await?;
        // 之后 AI 修改工作区
        write(&root, "keep.txt", "changed").await;
        write(&root, "extra.txt", "untracked extra").await;

        let list = engine.snapshot_list().await?;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "turn");
        assert_eq!(list[0].summary, "user asked something");

        let preview = engine.snapshot_preview(&list[0].id).await?;
        assert!(preview.reverted_files.contains(&"keep.txt".to_owned()));
        assert!(preview.untracked_to_delete.contains(&"extra.txt".to_owned()));

        let report = engine.snapshot_restore(&list[0].id).await?;
        assert_eq!(report.reverted_files, 1);
        assert_eq!(report.deleted_untracked, 1);
        assert!(!report.backup_snapshot_id.is_empty());
        assert_eq!(std::fs::read_to_string(root.join("keep.txt"))?, "keep");
        assert!(!root.join("extra.txt").exists());
        Ok(())
    }

    #[tokio::test]
    async fn snapshot_delete_removes_ref_and_index() -> Result<()> {
        let (_dir, engine) = repo().await;
        let snap = engine
            .snapshot_create("manual", None, None, "manual point")
            .await?;
        assert!(engine.snapshot_list().await?.iter().any(|s| s.id == snap.id));
        engine.snapshot_delete(&snap.id).await?;
        assert!(engine.snapshot_list().await?.is_empty());
        Ok(())
    }

    /// 直写索引构造快照（created_at 精确可控，不依赖真实 git 提交的时钟粒度）。
    fn seed_snapshot(engine: &GitEngine, id: &str, created_at: u64, locked: bool) -> Result<()> {
        engine.index_add(&Snapshot {
            id: id.to_owned(),
            kind: "manual".into(),
            session_id: None,
            turn: None,
            summary: format!("seed {id}"),
            created_at,
            sha: "0".repeat(40),
            file_count: 0,
            note: None,
            locked,
        })
    }

    #[tokio::test]
    async fn prune_retain_deletes_oldest_non_locked_only() -> Result<()> {
        let (_dir, engine) = repo().await;
        // created_at 100..104；103 锁定。
        for i in 0..5u64 {
            seed_snapshot(&engine, &format!("manual-{i}"), 100 + i, i == 3)?;
        }
        // retain=2：从最旧开始删非 locked，直到剩 2 条；locked 快照保留。
        engine.prune_snapshots_retain(2).await?;
        let mut ids: Vec<String> = engine
            .snapshot_list()
            .await?
            .into_iter()
            .map(|snap| snap.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["manual-3", "manual-4"]);
        Ok(())
    }

    #[tokio::test]
    async fn prune_retain_skips_locked_oldest_and_keeps_newest() -> Result<()> {
        let (_dir, engine) = repo().await;
        // created_at 100..104；最旧的 100 锁定，其余非 locked。
        for i in 0..5u64 {
            seed_snapshot(&engine, &format!("manual-{i}"), 100 + i, i == 0)?;
        }
        engine.prune_snapshots_retain(2).await?;
        let mut ids: Vec<String> = engine
            .snapshot_list()
            .await?
            .into_iter()
            .map(|snap| snap.id)
            .collect();
        ids.sort();
        // 100 锁定保留；为满足 retain=2，继续删除 101、102、103，保留 104。
        assert_eq!(ids, vec!["manual-0", "manual-4"]);
        Ok(())
    }

    #[tokio::test]
    async fn prune_retain_zero_is_noop() -> Result<()> {
        let (_dir, engine) = repo().await;
        for i in 0..3u64 {
            seed_snapshot(&engine, &format!("manual-{i}"), 100 + i, false)?;
        }
        engine.prune_snapshots_retain(0).await?;
        assert_eq!(engine.snapshot_list().await?.len(), 3);
        Ok(())
    }

    #[tokio::test]
    async fn platform_detection() {
        assert_eq!(detect_platform("https://github.com/a/b.git"), "GitHub");
        assert_eq!(detect_platform("git@github.com:a/b.git"), "GitHub");
        assert_eq!(detect_platform("https://gitee.com/a/b.git"), "Gitee");
        assert_eq!(detect_platform("https://atomgit.com/a/b.git"), "AtomGit");
        assert_eq!(detect_platform("https://gitcode.com/a/b.git"), "AtomGit");
        assert_eq!(detect_platform("git@gitlab.com:g/a.git"), "GitLab");
        assert_eq!(detect_platform("https://git.example.com/a/b.git"), "git.example.com");
    }

    #[tokio::test]
    async fn project_info_detects_types() -> Result<()> {
        let (dir, engine) = repo().await;
        write(&dir.path().join("repo"), "Cargo.toml", "[package]\n").await;
        write(&dir.path().join("repo"), "package.json", "{}\n").await;
        let info = engine.project_info().await?;
        assert!(info.detected.contains(&"Rust (Cargo)".to_owned()));
        assert!(info.detected.contains(&"Node.js".to_owned()));
        let template = info.gitignore.expect("gitignore template");
        assert!(template.contains("node_modules"));
        Ok(())
    }

    #[tokio::test]
    async fn stash_push_pop_roundtrip() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "wip.txt", "v1").await;
        engine.stage(&["wip.txt".into()], false).await?;
        engine.commit("wip").await?;
        write(&root, "wip.txt", "v2").await;

        engine.stash_push(Some("half done")).await?;
        let list = engine.stash_list().await?;
        assert_eq!(list.len(), 1);
        assert!(list[0].message.contains("half done"));

        assert_eq!(std::fs::read_to_string(root.join("wip.txt"))?, "v1");
        engine.stash_pop(0).await?;
        assert_eq!(std::fs::read_to_string(root.join("wip.txt"))?, "v2");
        assert!(engine.stash_list().await?.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn diff_includes_stat_and_body() -> Result<()> {
        let (dir, engine) = repo().await;
        write(&dir.path().join("repo"), "a.txt", "one\ntwo\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("a").await?;
        write(&dir.path().join("repo"), "a.txt", "one\nchanged\n").await;
        let info = engine.diff(None, false, 3).await?;
        assert!(info.stat.contains("a.txt"));
        assert!(info.diff.contains("+changed"));
        assert!(!info.truncated);
        Ok(())
    }

    #[tokio::test]
    async fn apply_patch_check_then_apply_roundtrip() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "a.txt", "one\ntwo\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("a").await?;
        // 合法的 unified diff（无 index 行，git apply 同样接受）
        let patch = "\
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 one
-two
+changed
";
        engine.apply_patch(patch).await?;
        assert_eq!(std::fs::read_to_string(root.join("a.txt"))?, "one\nchanged\n");
        Ok(())
    }

    #[tokio::test]
    async fn merge_base_finds_common_ancestor() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        // 基线提交。
        write(&root, "a.txt", "v1\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        let base = engine.commit("base").await?;
        // 分支 A：基于基线的改动。
        engine.create_branch("feature-a").await?;
        write(&root, "a.txt", "va\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("impl a").await?;
        // 分支 B：基于基线的另一套改动。
        engine.checkout("main").await?;
        engine.create_branch("feature-b").await?;
        write(&root, "a.txt", "vb\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("impl b").await?;

        let merged = engine.merge_base("feature-a", "feature-b").await?;
        assert_eq!(merged, base);
        Ok(())
    }

    #[tokio::test]
    async fn merge_base_missing_ref_is_error() -> Result<()> {
        let (_dir, engine) = repo().await;
        assert!(engine.merge_base("main", "no-such-branch").await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn show_commit_returns_subject_and_diff() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "a.txt", "one\ntwo\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        let hash = engine.commit("feat: add a.txt").await?;
        write(&root, "a.txt", "one\nchanged\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        let hash2 = engine.commit("fix: change value").await?;

        // 最新提交：subject 正确，diff 含变更行。
        let (subject, diff) = engine.show_commit(&hash2).await?;
        assert_eq!(subject, "fix: change value");
        assert!(diff.contains("+changed"));
        assert!(diff.contains("-two"));

        // 首个提交：subject 正确，diff 含整树新增（根提交相对空树）。
        let (subject, diff) = engine.show_commit(&hash).await?;
        assert_eq!(subject, "feat: add a.txt");
        assert!(diff.contains("+one"));

        // 不存在的 rev → Err。
        assert!(engine.show_commit("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn apply_patch_rejects_invalid_patch_without_touching_worktree() -> Result<()> {
        let (dir, engine) = repo().await;
        let root = dir.path().join("repo");
        write(&root, "a.txt", "one\n").await;
        engine.stage(&["a.txt".into()], false).await?;
        engine.commit("a").await?;
        // 针对不存在文件的补丁：--check 必须失败且不落地修改。
        let bad = "\
diff --git a/nope.txt b/nope.txt
--- a/nope.txt
+++ b/nope.txt
@@ -1 +1 @@
-x
+y
";
        let error = match engine.apply_patch(bad).await {
            Err(error) => error,
            Ok(()) => bail!("expected apply_patch to reject invalid patch"),
        };
        assert!(format!("{error:#}").contains("--check 未通过"));
        assert_eq!(std::fs::read_to_string(root.join("a.txt"))?, "one\n");
        Ok(())
    }

    #[tokio::test]
    async fn apply_patch_rejects_empty_patch() -> Result<()> {
        let (_dir, engine) = repo().await;
        assert!(engine.apply_patch("   \n").await.is_err());
        assert!(engine.apply_patch("").await.is_err());
        Ok(())
    }

    /// 回归：用户报告的「创建完分支列表里没有、无法切换」。
    /// 验证创建即切换 → 列表包含新分支且 current 更新 → 切回旧分支后 current 恢复。
    #[tokio::test]
    async fn branch_create_list_switch_roundtrip() -> Result<()> {
        let (dir, engine) = repo().await;
        assert_eq!(engine.branches().await?.current.as_deref(), Some("main"));

        engine.create_branch("feat/panel").await?;
        let info = engine.branches().await?;
        assert!(info.branches.iter().any(|b| b == "feat/panel"), "创建后列表必须包含新分支");
        assert_eq!(info.current.as_deref(), Some("feat/panel"), "创建并切换后 current 必须更新");

        engine.checkout("main").await?;
        let info = engine.branches().await?;
        assert!(info.branches.iter().any(|b| b == "feat/panel"));
        assert_eq!(info.current.as_deref(), Some("main"), "切换后 current 必须恢复");
        Ok(())
    }

    /// 回归：git/proot 卡死时必须超时返回错误，绝不悬挂（否则前端
    /// `switchingBranch` 守卫永久锁死，表现为「无法切换、列表不刷新」）。
    #[tokio::test]
    async fn child_timeout_returns_error_without_hanging() -> Result<()> {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg("sleep 30");
        let started = std::time::Instant::now();
        let error = run_child_limited_with_timeout(&mut command, "hanging child", Duration::from_millis(500))
            .await
            .expect_err("卡死的子进程必须超时报错，而不是悬挂");
        assert!(format!("{error:#}").contains("timed out"), "错误信息须含 timed out：{error:#}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "必须在超时后立即返回，而不是等子进程自然结束"
        );
        Ok(())
    }
}
