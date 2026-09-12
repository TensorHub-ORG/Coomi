//! 定时快照（P1-3）：调度配置存储与后台 tick 循环。
//!
//! - 配置落在 `<home>/coomi-snapshot-schedule.json`，字段 `{enabled, cron, retain}`；
//!   `retain` 默认 20，0 表示用系统默认 MAX_SNAPSHOTS=200。文件损坏时改名保留
//!   （`.corrupt-<时间戳>`），与快照索引 `coomi-snapshots.json` 的容错模式一致。
//! - 后台循环每 15 秒检查一次分钟变化（与 `WorkflowScheduler` 同款跨分钟补触发
//!   机制），命中 cron 时调用 `GitEngine::snapshot_create("scheduled", ...)` 打快照，
//!   再按 retain 配置调用 `prune_snapshots_retain` 清理（retain=0 走系统默认 200）。
//! - 所有 git 命令经 GitEngine 参数化执行，不经 shell。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use coomi_services::GitEngine;

const SCHEDULE_FILE: &str = "coomi-snapshot-schedule.json";
/// 默认保留数量；0 表示使用系统默认 MAX_SNAPSHOTS=200。
pub const DEFAULT_RETAIN: usize = 20;

/// 定时快照调度配置。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotSchedule {
    /// 总开关。
    pub enabled: bool,
    /// cron 表达式（无秒 5 段或带秒 6 段均可）；None = 未配置定时触发。
    pub cron: Option<String>,
    /// 保留数量；0 表示用系统默认（200）。
    pub retain: usize,
}

impl Default for SnapshotSchedule {
    fn default() -> Self {
        Self {
            enabled: false,
            cron: None,
            retain: DEFAULT_RETAIN,
        }
    }
}

fn schedule_path(home: &Path) -> PathBuf {
    home.join(SCHEDULE_FILE)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 当前 Unix 分钟数（跨分钟补触发的去重基准）。
fn now_minute() -> u64 {
    now_secs() / 60
}

/// 读取调度配置：文件缺失返回默认值；内容损坏时改名保留原始文件并返回默认值
/// （与快照索引 `index_load` 的容错模式一致，避免写操作覆盖可恢复数据）。
pub fn load_schedule(home: &Path) -> SnapshotSchedule {
    let path = schedule_path(home);
    let Ok(bytes) = std::fs::read(&path) else {
        return SnapshotSchedule::default();
    };
    match serde_json::from_slice::<SnapshotSchedule>(&bytes) {
        Ok(config) => config,
        Err(_) => {
            let backup = path.with_extension(format!("json.corrupt-{}", now_secs()));
            let _ = std::fs::rename(&path, &backup);
            SnapshotSchedule::default()
        }
    }
}

/// 保存调度配置（临时文件 + rename 原子替换，风格与快照索引 `index_save` 一致）。
pub fn save_schedule(home: &Path, config: &SnapshotSchedule) -> Result<()> {
    let path = schedule_path(home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(config)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// cron 表达式合法性校验（与 workflow.rs 的 `cron_matches_minute` 使用同一解析器）。
pub fn is_valid_cron(expr: &str) -> bool {
    croner::Cron::new(expr)
        .with_seconds_optional()
        .parse()
        .is_ok()
}

/// 启动定时快照后台循环（每 15 秒检查一次分钟；跨分钟只触发一次）。
/// 复用 `workflow::cron_matches_minute` 的匹配逻辑；GitEngine 按需从 home/cwd
/// 构造（与 web.rs `git_engine(&state)` 等价，PRoot 路由优先、宿主直跑兜底）。
pub fn start_snapshot_scheduler(home: PathBuf, cwd: PathBuf) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        let mut last_minute: u64 = 0;
        loop {
            interval.tick().await;
            let minute = now_minute();
            if last_minute == minute {
                continue;
            }
            last_minute = minute;
            let config = load_schedule(&home);
            if !config.enabled {
                continue;
            }
            let Some(expr) = config.cron.clone() else {
                continue;
            };
            if !crate::workflow::cron_matches_minute(&expr, minute) {
                continue;
            }
            // 命中 cron：打「scheduled」快照，再按 retain 配置清理。
            let engine =
                GitEngine::new(home.clone(), cwd.clone()).with_runtime_home(home.clone());
            match engine
                .snapshot_create("scheduled", None, None, "scheduled snapshot")
                .await
            {
                Ok(snapshot) => {
                    if config.retain > 0 {
                        if let Err(error) = engine.prune_snapshots_retain(config.retain).await {
                            eprintln!("[snapshot-schedule] retain prune failed: {error:#}");
                        }
                    }
                    eprintln!("[snapshot-schedule] snapshot {} created", snapshot.id);
                }
                Err(error) => {
                    eprintln!("[snapshot-schedule] scheduled snapshot failed: {error:#}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_roundtrip_preserves_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = SnapshotSchedule {
            enabled: true,
            cron: Some("0 9 * * *".to_owned()),
            retain: 7,
        };
        save_schedule(dir.path(), &config).expect("save schedule");
        let loaded = load_schedule(dir.path());
        assert_eq!(loaded, config);
        assert!(dir.path().join(SCHEDULE_FILE).exists());
    }

    #[test]
    fn schedule_default_when_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = load_schedule(dir.path());
        assert_eq!(config, SnapshotSchedule::default());
        assert!(!config.enabled);
        assert_eq!(config.retain, DEFAULT_RETAIN);
    }

    #[test]
    fn schedule_corrupt_file_is_backed_up_and_defaulted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let corrupt = dir.path().join(SCHEDULE_FILE);
        std::fs::write(&corrupt, "not json {").expect("write corrupt");
        let config = load_schedule(dir.path());
        assert_eq!(config, SnapshotSchedule::default());
        // 损坏文件被改名保留（.corrupt-<时间戳>），原名不再存在，数据可恢复。
        assert!(!corrupt.exists(), "原文件名已被改名保留");
        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries
                .iter()
                .any(|name| name.starts_with("coomi-snapshot-schedule.json.corrupt-")),
            "corrupt backup exists"
        );
    }

    #[test]
    fn cron_validation() {
        assert!(is_valid_cron("* * * * *"));
        assert!(is_valid_cron("0 9 * * 1-5"));
        assert!(is_valid_cron("*/30 * * * *"));
        assert!(!is_valid_cron("not a cron"));
        assert!(!is_valid_cron(""));
    }
}
