//! 环境事实（批次八 1.2）：对 guest 执行一次真实探测并按 Runtime 版本缓存，产出
//! ① system prompt 用的"环境事实块"，② 每条 shell 工具结果尾部的环境标记。
//! 目标是让模型始终知道自己站在哪个环境里，而不是靠 Skill 警告文本猜。

use coomi_services::probe_guest_facts;
use coomi_services::ProotLinuxBackend;
use coomi_services::RuntimeBackendKind;
use coomi_services::RuntimeInstallStatus;
use coomi_services::RuntimeManager;
use std::path::Path;
use std::sync::OnceLock;
use tokio::sync::RwLock;

#[derive(Clone, Debug)]
struct CachedFacts {
    /// 探测到的 Runtime 版本；版本变化时重新探测。
    version: String,
    /// 探测失败时为 Err（同样缓存，避免每回合重付 20s 探测）。
    block: Result<String, String>,
    marker: String,
}

static CACHE: OnceLock<RwLock<Option<CachedFacts>>> = OnceLock::new();

fn cache() -> &'static RwLock<Option<CachedFacts>> {
    CACHE.get_or_init(|| RwLock::new(None))
}

/// 打开当前 ready 的 ProotLinux backend（与 runtime_doctor 同一链路）。
fn active_proot_backend(config_home: &Path) -> Option<(ProotLinuxBackend, String)> {
    let state = RuntimeManager::open(config_home).ok()?.state().ok()?;
    let version = state.active_version.clone()?;
    (state.status == RuntimeInstallStatus::Ready && state.backend == RuntimeBackendKind::ProotLinux)
        .then(|| {
            (
                ProotLinuxBackend {
                    runtime_root: config_home.join("runtime-v2"),
                    version: version.clone(),
                },
                version,
            )
        })
}

async fn cached_facts(config_home: &Path, cwd: &Path) -> CachedFacts {
    // 当前 Runtime 版本读取很便宜（读 state.json）；版本不变才直接吃缓存。
    let current_version = active_proot_backend(config_home)
        .map(|(_, version)| version)
        .unwrap_or_else(|| "unready".into());
    {
        let cache = cache().read().await;
        if let Some(facts) = cache.as_ref()
            && facts.version == current_version
        {
            return facts.clone();
        }
    }
    let probe = match active_proot_backend(config_home) {
        Some((backend, version)) => Some((version, probe_guest_facts(&backend, cwd).await.ok())),
        None => None,
    };
    let cached = match probe {
        Some((version, Some(facts))) if facts.sh => {
            let os = facts.os.clone().unwrap_or_else(|| "Debian (proot)".into());
            let toolchain = [
                ("python3", facts.python.clone()),
                ("git", facts.git.clone()),
                ("node", facts.node.clone()),
            ]
            .into_iter()
            .filter_map(|(name, version)| version.map(|v| format!("{name}: {v}")))
            .collect::<Vec<_>>()
            .join("，");
            let mut writable = vec![];
            if facts.workspace {
                writable.push("/workspace（当前工作区）");
            }
            if facts.tmp_writable {
                writable.push("/tmp");
            }
            writable.push("/home/coomi");
            let network = match facts.network.as_deref() {
                Some("200") => "可达（可直接下载）".to_owned(),
                Some(code) => format!("探测返回 {code}（下载可能受限）"),
                None => "未探测到（离线或 curl 缺失）".to_owned(),
            };
            let marker = format!(
                "[env: {} proot-debian]",
                os.split('/').next().unwrap_or("debian").to_lowercase()
            );
            CachedFacts {
                version,
                block: Ok(format!(
                    "环境事实（自动探测，单一事实源）：\n\
                     - 执行环境：{os}（proot guest）。所有 shell 命令都在这一个 Linux 环境内执行，路径一律用 Linux 格式。\n\
                     - 包管理器：apt。缺命令直接 `apt install <包名>`（已预配国内镜像源）；预装工具链：{toolchain}。\n\
                     - 推荐工作目录：{}；/home/coomi/.local/bin 已在 PATH 中（pip install --user 的脚本可直接调用）。guest 内为 root 视角，/etc 等系统路径也可写，但改动只影响 guest 环境、不影响 Android 系统，请谨慎修改。\n\
                     - 网络：{network}。",
                    writable.join("、")
                )),
                marker,
            }
        }
        Some((version, _)) => CachedFacts {
            version,
            block: Err("环境探测不可用（guest shell 异常）".into()),
            marker: "[env: unknown]".into(),
        },
        None => CachedFacts {
            version: "unready".into(),
            block: Err("环境探测不可用（Runtime 未就绪）".into()),
            marker: "[env: unknown]".into(),
        },
    };
    *cache().write().await = Some(cached.clone());
    cached
}

/// system prompt 用的环境事实块；探测失败返回 None（不污染 prompt）。
pub async fn environment_facts_block(config_home: &Path, cwd: &Path) -> Option<String> {
    let facts = cached_facts(config_home, cwd).await;
    facts.block.ok()
}

/// 每条 shell/local_shell 工具结果尾部的单行环境标记。
pub async fn environment_marker(config_home: &Path, cwd: &Path) -> String {
    cached_facts(config_home, cwd).await.marker
}
