use anyhow::Context;
use anyhow::Result;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

const STALE_AFTER_DAYS: i64 = 7;
const MAX_PROMPT_CHARS: usize = 32_000;
const CORE_MEMORY_LIMIT: usize = 10;
const NEW_MEMORY_PROTECTION_DAYS: i64 = 14;
/// 单次 list() 加载的记忆条目上限，防止磁盘文件过多时全量加载导致 OOM/卡顿。
const MAX_LOADED_MEMORIES: usize = 500;
/// list() 结果的内存缓存有效期（秒）。短 TTL 避免 stale 但减少磁盘 I/O。
const LIST_CACHE_TTL_SECS: i64 = 30;
/// 经验条目保留多少条证据 / 会话（多了只会让 front matter 变胖）。
const MAX_LESSON_EVIDENCE: usize = 20;
/// 新经验默认置信度。
fn default_confidence() -> f32 {
    0.5
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    #[default]
    User,
    Feedback,
    Project,
    Reference,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Local,
    Project,
    Global,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Memory {
    pub name: String,
    pub description: String,
    #[serde(rename = "type", default)]
    pub memory_type: MemoryType,
    pub created: DateTime<Utc>,
    pub updated: DateTime<Utc>,
    #[serde(default)]
    pub hit_count: u64,
    #[serde(default)]
    pub last_triggered: Option<DateTime<Utc>>,
    /// 经验置信度 0..1。蒸馏时由模型给出，合并时随证据累积抬高。
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    /// 证据：产出 / 更新这条经验的轨迹标识（最多 MAX_LESSON_EVIDENCE 条）。
    #[serde(default)]
    pub evidence: Vec<String>,
    /// 贡献过这条经验的会话（去重）：跨会话复用是"这是一条通用经验"的判据。
    #[serde(default)]
    pub sessions: Vec<String>,
    /// 注入之后该轮**成功**的次数。
    #[serde(default)]
    pub outcomes_ok: u64,
    /// 注入之后该轮**失败**的次数 —— 用来淘汰"看着有理但其实没用"的经验。
    #[serde(default)]
    pub outcomes_bad: u64,
    #[serde(skip)]
    pub content: String,
    #[serde(skip)]
    pub stale: bool,
    #[serde(skip)]
    pub scope: Option<MemoryScope>,
    #[serde(skip)]
    pub lifecycle: MemoryLifecycle,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryLifecycle {
    #[default]
    Candidate,
    Stable,
    Core,
}

#[derive(Debug)]
pub struct MemoryManager {
    local_dir: PathBuf,
    project_dir: PathBuf,
    global_dir: PathBuf,
    /// list() 结果缓存：避免每次调用都遍历磁盘。
    list_cache: std::sync::Arc<std::sync::Mutex<Option<(Vec<Memory>, DateTime<Utc>)>>>,
}

impl Clone for MemoryManager {
    fn clone(&self) -> Self {
        Self {
            local_dir: self.local_dir.clone(),
            project_dir: self.project_dir.clone(),
            global_dir: self.global_dir.clone(),
            list_cache: std::sync::Arc::clone(&self.list_cache),
        }
    }
}

impl MemoryManager {
    pub fn new(home: &Path, project_path: &Path) -> Self {
        let project_key = format!(
            "{:x}",
            md5::compute(project_path.to_string_lossy().as_bytes())
        );
        Self {
            local_dir: project_path.join(".coomi").join("memory"),
            project_dir: home
                .join("projects")
                .join(&project_key[..12.min(project_key.len())])
                .join("memory"),
            global_dir: home.join("memory"),
            list_cache: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn list(&self) -> Vec<Memory> {
        // 短 TTL 缓存：30 秒内避免重复遍历磁盘
        if let Ok(cache) = self.list_cache.lock() {
            if let Some((memories, cached_at)) = cache.as_ref() {
                if Utc::now().signed_duration_since(*cached_at)
                    < Duration::seconds(LIST_CACHE_TTL_SECS)
                {
                    return memories.clone();
                }
            }
        }

        let mut seen = BTreeSet::new();
        let mut memories = Vec::new();
        for (scope, directory) in self.directories() {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            let mut paths = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension().and_then(|value| value.to_str()) == Some("md")
                        && path.file_name().and_then(|value| value.to_str()) != Some("MEMORY.md")
                })
                .collect::<Vec<_>>();
            paths.sort();
            for path in paths {
                if memories.len() >= MAX_LOADED_MEMORIES {
                    break;
                }
                let Ok(mut memory) = read_memory(&path) else {
                    continue;
                };
                if !seen.insert(memory.name.clone()) {
                    continue;
                }
                memory.scope = Some(scope);
                memory.stale = matches!(
                    memory.memory_type,
                    MemoryType::Project | MemoryType::Reference
                ) && Utc::now().signed_duration_since(memory.updated)
                    > Duration::days(STALE_AFTER_DAYS);
                memories.push(memory);
            }
        }
        assign_lifecycle(&mut memories);
        memories.sort_by(|left, right| {
            lifecycle_rank(right.lifecycle)
                .cmp(&lifecycle_rank(left.lifecycle))
                .then_with(|| right.hit_count.cmp(&left.hit_count))
                .then_with(|| left.created.cmp(&right.created))
        });
        memories.truncate(MAX_LOADED_MEMORIES);

        if let Ok(mut cache) = self.list_cache.lock() {
            *cache = Some((memories.clone(), Utc::now()));
        }
        memories
    }

    pub fn get(&self, name: &str) -> Option<Memory> {
        self.list().into_iter().find(|memory| memory.name == name)
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<Memory> {
        let terms = query
            .split(|character: char| {
                !character.is_alphanumeric() && character != '_' && character != '-'
            })
            .filter(|term| term.chars().count() >= 2)
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        let mut scored = self
            .list()
            .into_iter()
            .filter_map(|memory| {
                let name = memory.name.to_lowercase();
                let description = memory.description.to_lowercase();
                let content = memory.content.to_lowercase();
                let score = terms.iter().fold(0usize, |score, term| {
                    score
                        + usize::from(name.contains(term)) * 5
                        + usize::from(description.contains(term)) * 3
                        + usize::from(content.contains(term))
                });
                (score > 0).then_some((score, memory))
            })
            .collect::<Vec<_>>();
        scored.sort_by_key(|item| std::cmp::Reverse(item.0));
        scored
            .into_iter()
            .take(limit.max(1))
            .map(|(_, memory)| memory)
            .collect()
    }

    pub fn save(
        &self,
        scope: MemoryScope,
        name: &str,
        description: &str,
        memory_type: MemoryType,
        content: &str,
    ) -> Result<PathBuf> {
        validate_name(name)?;
        let directory = self.directory(scope);
        fs::create_dir_all(directory)?;
        let path = directory.join(format!("{name}.md"));
        let existing = read_memory(&path).ok();
        let now = Utc::now();
        let memory = Memory {
            name: name.to_owned(),
            description: description.to_owned(),
            memory_type,
            created: existing.as_ref().map_or(now, |memory| memory.created),
            updated: now,
            hit_count: existing.as_ref().map_or(0, |memory| memory.hit_count),
            last_triggered: existing.as_ref().and_then(|memory| memory.last_triggered),
            // 手工保存不能把"越用积累出来的"统计与证据抹掉。
            confidence: existing
                .as_ref()
                .map_or_else(default_confidence, |memory| memory.confidence),
            evidence: existing
                .as_ref()
                .map_or_else(Vec::new, |memory| memory.evidence.clone()),
            sessions: existing
                .as_ref()
                .map_or_else(Vec::new, |memory| memory.sessions.clone()),
            outcomes_ok: existing.as_ref().map_or(0, |memory| memory.outcomes_ok),
            outcomes_bad: existing.as_ref().map_or(0, |memory| memory.outcomes_bad),
            content: content.to_owned(),
            stale: false,
            scope: Some(scope),
            lifecycle: MemoryLifecycle::Candidate,
        };
        fs::write(&path, render_memory(&memory))
            .with_context(|| format!("failed to save memory {}", path.display()))?;
        self.refresh_index()?;
        self.invalidate_list_cache();
        Ok(path)
    }

    /// 写入 / 合并一条「经验」——总结记忆的落点。
    ///
    /// 与 `save` 的区别：同名条目已存在就**合并**（抬置信度、累加证据与会话），
    /// 而不是新建。否则同一件事反复总结会把记忆库撑爆，并留下互相矛盾的条目。
    #[allow(clippy::too_many_arguments)]
    pub fn save_lesson(
        &self,
        scope: MemoryScope,
        name: &str,
        description: &str,
        memory_type: MemoryType,
        content: &str,
        confidence: f32,
        evidence: &str,
        session_id: &str,
    ) -> Result<PathBuf> {
        validate_name(name)?;
        let directory = self.directory(scope);
        fs::create_dir_all(directory)?;
        let path = directory.join(format!("{name}.md"));
        let now = Utc::now();
        let confidence = confidence.clamp(0.0, 1.0);
        if let Ok(mut memory) = read_memory(&path) {
            // 合并：正文以最新一次蒸馏为准；置信度取"更保守的抬升"（两次的均值），
            // 但绝不因为一次低置信的重复总结把已有经验拉低。
            let before = memory.confidence;
            memory.description = description.to_owned();
            memory.content = content.to_owned();
            memory.updated = now;
            memory.confidence = ((before + confidence) / 2.0).max(before.min(confidence)).clamp(0.0, 1.0);
            push_capped(&mut memory.evidence, evidence, MAX_LESSON_EVIDENCE);
            push_capped(&mut memory.sessions, session_id, MAX_LESSON_EVIDENCE);
            fs::write(&path, render_memory(&memory))
                .with_context(|| format!("failed to save memory {}", path.display()))?;
            self.refresh_index()?;
            self.invalidate_list_cache();
            return Ok(path);
        }
        let memory = Memory {
            name: name.to_owned(),
            description: description.to_owned(),
            memory_type,
            created: now,
            updated: now,
            hit_count: 0,
            last_triggered: None,
            confidence,
            evidence: vec![evidence.to_owned()],
            sessions: vec![session_id.to_owned()],
            outcomes_ok: 0,
            outcomes_bad: 0,
            content: content.to_owned(),
            stale: false,
            scope: Some(scope),
            lifecycle: MemoryLifecycle::Candidate,
        };
        fs::write(&path, render_memory(&memory))
            .with_context(|| format!("failed to save memory {}", path.display()))?;
        self.refresh_index()?;
        self.invalidate_list_cache();
        Ok(path)
    }

    /// 记一次「注入 → 该轮结果」。这是"越用越好用"的反馈信号：
    /// 一条经验如果在失败的轮次里反复出现，assign_lifecycle 会把它降级、不再注入。
    pub fn record_outcome(&self, names: &[String], session_id: &str, ok: bool) -> Result<()> {
        for name in names {
            let Some((_, path)) = self.locate(name) else {
                continue;
            };
            let Ok(mut memory) = read_memory(&path) else {
                continue;
            };
            if ok {
                memory.outcomes_ok = memory.outcomes_ok.saturating_add(1);
            } else {
                memory.outcomes_bad = memory.outcomes_bad.saturating_add(1);
            }
            push_capped(&mut memory.sessions, session_id, MAX_LESSON_EVIDENCE);
            fs::write(&path, render_memory(&memory))?;
        }
        self.refresh_index()?;
        self.invalidate_list_cache();
        Ok(())
    }

    /// 按名字在三个作用域里找文件（本地优先）。
    fn locate(&self, name: &str) -> Option<(MemoryScope, PathBuf)> {
        self.directories().into_iter().find_map(|(scope, dir)| {
            let path = dir.join(format!("{name}.md"));
            path.is_file().then_some((scope, path))
        })
    }

    /// 可注入的经验块 + 本次注入了哪些名字（回合结束时用它做效果归因）。
    ///
    /// 三条守则：
    /// ① **Candidate 不注入** —— 未经验证的经验最容易变成偏见；
    /// ② 层级优先、其次命中数、最后按名字 —— 排序键必须稳定，否则前缀缓存全废；
    /// ③ 有字符预算，不与工具 / 上下文抢位置。
    pub fn injectable(&self, query: &str, limit: usize, budget_chars: usize) -> (String, Vec<String>) {
        let mut hits = self.search(query, limit.saturating_mul(3));
        hits.retain(|memory| memory.lifecycle != MemoryLifecycle::Candidate && !memory.stale);
        hits.sort_by(|left, right| {
            lifecycle_rank(right.lifecycle)
                .cmp(&lifecycle_rank(left.lifecycle))
                .then_with(|| right.hit_count.cmp(&left.hit_count))
                .then_with(|| left.name.cmp(&right.name))
        });
        let mut output = String::new();
        let mut names = Vec::new();
        for memory in hits.into_iter().take(limit) {
            let entry = format!(
                "### {}
_（经验，仅供参考；用户当次的明确要求优先）_
{}

",
                memory.name,
                memory.content.trim()
            );
            if !names.is_empty() && output.chars().count() + entry.chars().count() > budget_chars {
                break;
            }
            output.push_str(&entry);
            names.push(memory.name);
        }
        (output, names)
    }

    /// 睡眠期整合：**合并语义近似** + **遗忘长期无用**。返回 (合并数, 删除数)。
    ///
    /// 为什么需要：在此之前记忆只有"增"（同名才合并），用久了必然膨胀，
    /// 而且近似的条目会互相竞争注入位置 —— 越用越差。两条规则都是**确定性**的：
    ///  · 合并：正文 bigram 相似度 >= threshold，保留更有价值的一条（命中多 > 置信度高 > 更新晚），
    ///    把证据与来源会话并过去，删掉另一条；
    ///  · 遗忘：仍是 Candidate（从未升层）**且**从未命中、也没带来过成功、且很久没更新 → 删。
    pub fn prune_and_merge(&self, max_age_days: i64, threshold: f64) -> Result<(usize, usize)> {
        let memories = self.list();
        if memories.len() < 2 {
            return Ok((0, 0));
        }
        // ① 遗忘：先删掉确定没用的，剩下的再参与合并（少一半比较）。
        let now = Utc::now();
        let mut removed = 0usize;
        for memory in &memories {
            let stale = now.signed_duration_since(memory.updated).num_days() >= max_age_days;
            if memory.lifecycle == MemoryLifecycle::Candidate
                && memory.hit_count == 0
                && memory.outcomes_ok == 0
                && stale
                && self.delete(&memory.name).unwrap_or(false)
            {
                removed += 1;
            }
        }
        // ② 合并：相似度用 bigram 的 Jaccard，纯本地、无模型成本。
        let survivors = self.list();
        let grams: Vec<HashSet<String>> = survivors
            .iter()
            .map(|memory| text_bigrams(&format!("{} {}", memory.description, memory.content)))
            .collect();
        let mut dropped: HashSet<String> = HashSet::new();
        let mut merged = 0usize;
        for i in 0..survivors.len() {
            if dropped.contains(&survivors[i].name) {
                continue;
            }
            for j in (i + 1)..survivors.len() {
                if dropped.contains(&survivors[j].name) {
                    continue;
                }
                if jaccard(&grams[i], &grams[j]) < threshold {
                    continue;
                }
                // 保留"更有价值"的一条：命中多 > 置信度高 > 更新晚。
                let keep_right = (
                    survivors[j].hit_count,
                    survivors[j].confidence,
                    survivors[j].updated,
                ) > (
                    survivors[i].hit_count,
                    survivors[i].confidence,
                    survivors[i].updated,
                );
                let (keep, drop) = if keep_right {
                    (&survivors[j], &survivors[i])
                } else {
                    (&survivors[i], &survivors[j])
                };
                if self.merge_into(keep, drop).is_ok() {
                    dropped.insert(drop.name.clone());
                    merged += 1;
                }
            }
        }
        if merged + removed > 0 {
            self.refresh_index()?;
            self.invalidate_list_cache();
        }
        Ok((merged, removed))
    }

    /// 把 `drop` 合并进 `keep`：证据与会话取并集，命中与效果分相加，正文保留更长的那个。
    fn merge_into(&self, keep: &Memory, drop: &Memory) -> Result<()> {
        let Some((_, path)) = self.locate(&keep.name) else {
            return Ok(());
        };
        let Ok(mut memory) = read_memory(&path) else {
            return Ok(());
        };
        for item in drop.evidence.iter().chain(drop.sessions.iter()) {
            push_capped(&mut memory.evidence, item, MAX_LESSON_EVIDENCE);
        }
        push_capped(&mut memory.sessions, &drop.name, MAX_LESSON_EVIDENCE);
        memory.hit_count = memory.hit_count.saturating_add(drop.hit_count);
        memory.outcomes_ok = memory.outcomes_ok.saturating_add(drop.outcomes_ok);
        memory.outcomes_bad = memory.outcomes_bad.saturating_add(drop.outcomes_bad);
        if drop.content.len() > memory.content.len() {
            memory.content = drop.content.clone();
        }
        memory.confidence = memory.confidence.max(drop.confidence);
        memory.updated = Utc::now();
        fs::write(&path, render_memory(&memory))?;
        self.delete(&drop.name)?;
        Ok(())
    }

    pub fn delete(&self, name: &str) -> Result<bool> {
        validate_name(name)?;
        for (_, directory) in self.directories() {
            let path = directory.join(format!("{name}.md"));
            if path.is_file() {
                fs::remove_file(&path)?;
                self.refresh_index()?;
                self.invalidate_list_cache();
                return Ok(true);
            }
        }
        self.invalidate_list_cache();
        Ok(false)
    }

    /// 使 list() 缓存失效：save/delete 后必须重新扫描磁盘。
    fn invalidate_list_cache(&self) {
        if let Ok(mut cache) = self.list_cache.lock() {
            *cache = None;
        }
    }

    pub fn prompt_context(&self) -> String {
        let mut output = String::new();
        for memory in self.list().into_iter().filter(|memory| !memory.stale) {
            let entry = format!(
                "### {} [{:?}, {} hits]\n_{}_\n\n{}\n\n",
                memory.name, memory.lifecycle, memory.hit_count, memory.description, memory.content
            );
            if output.len().saturating_add(entry.len()) > MAX_PROMPT_CHARS {
                break;
            }
            output.push_str(&entry);
        }
        output
    }

    /// Observe one direct user message. Matching and counters are deterministic;
    /// the model is never responsible for remembering to update statistics.
    pub fn observe_user_message(&self, message: &str) -> Result<Vec<String>> {
        let sanitized = sanitize_memory_text(message);
        if sanitized.is_empty() {
            return Ok(Vec::new());
        }
        let now = Utc::now();
        let input_grams = text_bigrams(&sanitized);
        let mut hits = Vec::new();
        for (_, directory) in self.directories() {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for path in entries.flatten().map(|entry| entry.path()).filter(|path| {
                path.extension().and_then(|value| value.to_str()) == Some("md")
                    && path.file_name().and_then(|value| value.to_str()) != Some("MEMORY.md")
            }) {
                let Ok(mut memory) = read_memory(&path) else {
                    continue;
                };
                if memory_matches(&input_grams, &memory) {
                    memory.hit_count = memory.hit_count.saturating_add(1);
                    memory.last_triggered = Some(now);
                    memory.updated = now;
                    fs::write(&path, render_memory(&memory))?;
                    hits.push(memory.name);
                }
            }
        }

        if is_memory_signal(message) {
            let digest = format!("{:x}", md5::compute(sanitized.as_bytes()));
            let name = format!("reminder-{}", &digest[..12]);
            if self.get(&name).is_none() {
                self.save(
                    MemoryScope::Global,
                    &name,
                    &sanitized.chars().take(80).collect::<String>(),
                    if contains_correction_signal(message) {
                        MemoryType::Feedback
                    } else {
                        MemoryType::User
                    },
                    &sanitized,
                )?;
                let path = self.global_dir.join(format!("{name}.md"));
                if let Ok(mut memory) = read_memory(&path) {
                    memory.hit_count = 1;
                    memory.last_triggered = Some(now);
                    fs::write(path, render_memory(&memory))?;
                }
                hits.push(name);
            }
        }
        self.refresh_index()?;
        Ok(hits)
    }

    pub fn report(&self) -> String {
        let memories = self.list();
        if memories.is_empty() {
            return "当前没有 Coomi 内建持久记忆。此指令不会读取任何 MCP、Skill 或第三方记忆扩展。"
                .into();
        }
        let mut output = format!(
            "当前共有 {} 条 Coomi 内建持久记忆（不含任何 MCP、Skill 或第三方记忆扩展）。核心层最多保留 {} 条，排序由生命周期、命中次数和创建时间共同决定。\n\n",
            memories.len(),
            CORE_MEMORY_LIMIT
        );
        for memory in memories {
            output.push_str(&format!(
                "- {} [{:?}/{:?}]：命中 {} 次，最近命中 {}。{}\n  {}\n",
                memory.name,
                memory.lifecycle,
                memory.scope.unwrap_or(MemoryScope::Project),
                memory.hit_count,
                memory.last_triggered.map_or_else(
                    || "从未".into(),
                    |time| time.format("%Y-%m-%d %H:%M").to_string()
                ),
                memory.description,
                memory.content,
            ));
        }
        output
    }

    pub fn refresh_index(&self) -> Result<()> {
        let directory = if self.local_dir.is_dir() {
            &self.local_dir
        } else {
            &self.project_dir
        };
        fs::create_dir_all(directory)?;
        let mut lines = vec![
            "# Memory Index".to_owned(),
            "> Auto-generated. Local entries override project and global entries.".to_owned(),
            String::new(),
        ];
        for memory in self.list() {
            lines.push(format!(
                "- [{}](./{}.md) - {}{}",
                memory.name,
                memory.name,
                memory.description,
                if memory.stale { " [stale]" } else { "" }
            ));
        }
        fs::write(directory.join("MEMORY.md"), lines.join("\n"))?;
        Ok(())
    }

    fn directories(&self) -> [(MemoryScope, &Path); 3] {
        [
            (MemoryScope::Local, &self.local_dir),
            (MemoryScope::Project, &self.project_dir),
            (MemoryScope::Global, &self.global_dir),
        ]
    }

    fn directory(&self, scope: MemoryScope) -> &Path {
        match scope {
            MemoryScope::Local => &self.local_dir,
            MemoryScope::Project => &self.project_dir,
            MemoryScope::Global => &self.global_dir,
        }
    }
}

/// 两个集合的 Jaccard 相似度（0~1）。空集返回 0，避免除零。
fn jaccard(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(right).count() as f64;
    let union = left.union(right).count() as f64;
    if union == 0.0 { 0.0 } else { intersection / union }
}

/// 追加并去重，只保留最近的 cap 条（旧的先丢）。
fn push_capped(list: &mut Vec<String>, value: &str, cap: usize) {
    if value.is_empty() || list.iter().any(|item| item == value) {
        return;
    }
    list.push(value.to_owned());
    if list.len() > cap {
        let overflow = list.len() - cap;
        list.drain(0..overflow);
    }
}

fn validate_name(name: &str) -> Result<()> {
    anyhow::ensure!(
        !name.is_empty()
            && name.len() <= 80
            && name.chars().all(
                |character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            ),
        "memory name must use 1-80 ASCII letters, numbers, hyphens, or underscores"
    );
    Ok(())
}

fn read_memory(path: &Path) -> Result<Memory> {
    let text = fs::read_to_string(path)?;
    let rest = text
        .strip_prefix("---\n")
        .context("memory has no frontmatter")?;
    let (frontmatter, content) = rest
        .split_once("\n---\n")
        .context("memory frontmatter is not closed")?;
    let mut memory: Memory = serde_yaml::from_str(frontmatter)?;
    memory.content = content.trim().to_owned();
    memory.lifecycle = MemoryLifecycle::Candidate;
    Ok(memory)
}

fn lifecycle_rank(lifecycle: MemoryLifecycle) -> u8 {
    match lifecycle {
        MemoryLifecycle::Candidate => 0,
        MemoryLifecycle::Stable => 1,
        MemoryLifecycle::Core => 2,
    }
}

/// 效果门：被注入之后总是伴随失败的经验不许升层，已升层的也要降回来。
/// 没有效果反馈时（还没有归因数据）一律放行 —— 不因为"暂时没数据"而拦住新经验。
fn outcome_gate_ok(memory: &Memory) -> bool {
    let total = memory.outcomes_ok + memory.outcomes_bad;
    total == 0 || (memory.outcomes_ok as f64 / total as f64) >= 0.5
}

fn assign_lifecycle(memories: &mut [Memory]) {
    let now = Utc::now();
    let mut eligible = memories
        .iter()
        .enumerate()
        .filter(|(_, memory)| memory.hit_count >= 3 && outcome_gate_ok(memory))
        .map(|(index, memory)| {
            let age = memory.last_triggered.map_or(365.0, |time| {
                now.signed_duration_since(time).num_hours().max(0) as f64 / 24.0
            });
            let score = ((memory.hit_count + 1) as f64).log2() * (-age / 30.0).exp();
            (index, score)
        })
        .collect::<Vec<_>>();
    eligible.sort_by(|left, right| right.1.total_cmp(&left.1));
    let core = eligible
        .into_iter()
        .take(CORE_MEMORY_LIMIT)
        .map(|(index, _)| index)
        .collect::<HashSet<_>>();
    for (index, memory) in memories.iter_mut().enumerate() {
        memory.lifecycle = if !outcome_gate_ok(memory) {
            // 有明确的反证：降回候选，不再注入。
            MemoryLifecycle::Candidate
        } else if core.contains(&index) {
            MemoryLifecycle::Core
        } else if memory.hit_count >= 2
            || now.signed_duration_since(memory.created)
                <= Duration::days(NEW_MEMORY_PROTECTION_DAYS)
        {
            MemoryLifecycle::Stable
        } else {
            MemoryLifecycle::Candidate
        };
    }
}

fn is_memory_signal(message: &str) -> bool {
    let explicit_signal = [
        "请记住",
        "记住",
        "以后请",
        "永远不要",
        "必须",
        "你可以",
        "你有",
        "你做错了",
        "下次应该",
        "我希望你",
        "默认",
        "优先",
    ]
    .iter()
    .any(|signal| message.contains(signal));
    explicit_signal || (message.contains("不是") && message.contains("而是"))
}

fn contains_correction_signal(message: &str) -> bool {
    ["你做错了", "下次应该", "不要说你不能"]
        .iter()
        .any(|signal| message.contains(signal))
        || (message.contains("不是") && message.contains("而是"))
}

fn sanitize_memory_text(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if part.contains('@')
                || lower.contains("token=")
                || lower.contains("api_key")
                || lower.contains("apikey")
                || lower.starts_with("sk-")
            {
                "[已脱敏]".to_owned()
            } else if part.starts_with('/') || part.contains(":\\") {
                "[路径]".to_owned()
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1_000)
        .collect()
}

fn text_bigrams(text: &str) -> HashSet<String> {
    let normalized = text
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect::<Vec<_>>();
    normalized
        .windows(2)
        .map(|pair| pair.iter().collect())
        .collect()
}

fn memory_matches(input: &HashSet<String>, memory: &Memory) -> bool {
    let target = text_bigrams(&format!(
        "{} {} {}",
        memory.name, memory.description, memory.content
    ));
    if target.is_empty() {
        return false;
    }
    let overlap = input.intersection(&target).count();
    overlap >= 3 && overlap * 3 >= target.len().min(30)
}

fn render_memory(memory: &Memory) -> String {
    let frontmatter = serde_yaml::to_string(memory).unwrap_or_default();
    format!("---\n{}---\n\n{}\n", frontmatter, memory.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_for_test(name: &str, created: DateTime<Utc>, hit_count: u64) -> Memory {
        Memory {
            name: name.to_owned(),
            description: name.to_owned(),
            memory_type: MemoryType::User,
            created,
            updated: created,
            hit_count,
            last_triggered: Some(created),
            // 测试基线：置信度默认、无证据、无效果归因（与新建经验一致）。
            confidence: default_confidence(),
            evidence: Vec::new(),
            sessions: Vec::new(),
            outcomes_ok: 0,
            outcomes_bad: 0,
            content: name.to_owned(),
            stale: false,
            scope: Some(MemoryScope::Global),
            lifecycle: MemoryLifecycle::Candidate,
        }
    }

    #[test]
    fn local_memory_overrides_project_and_global() {
        let home = tempfile::tempdir().expect("home");
        let project = tempfile::tempdir().expect("project");
        let manager = MemoryManager::new(home.path(), project.path());
        manager
            .save(
                MemoryScope::Global,
                "preference",
                "global",
                MemoryType::User,
                "dark",
            )
            .expect("global memory");
        manager
            .save(
                MemoryScope::Local,
                "preference",
                "local",
                MemoryType::User,
                "light",
            )
            .expect("local memory");
        let memories = manager.list();
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].content, "light");
        assert_eq!(memories[0].scope, Some(MemoryScope::Local));
    }

    #[test]
    fn legacy_frontmatter_loads_with_zero_hits() {
        let directory = tempfile::tempdir().expect("memory directory");
        let path = directory.path().join("legacy.md");
        fs::write(
            &path,
            "---\nname: legacy\ndescription: old format\ntype: user\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-02T00:00:00Z\n---\n\nlegacy content\n",
        )
        .expect("legacy memory");
        let memory = read_memory(&path).expect("load legacy memory");
        assert_eq!(memory.hit_count, 0);
        assert_eq!(memory.last_triggered, None);
        assert_eq!(memory.content, "legacy content");
    }

    #[test]
    fn observation_updates_hits_without_model_assistance() {
        let home = tempfile::tempdir().expect("home");
        let project = tempfile::tempdir().expect("project");
        let manager = MemoryManager::new(home.path(), project.path());
        manager
            .save(
                MemoryScope::Global,
                "absolute-paths",
                "export files with absolute paths",
                MemoryType::User,
                "所有导出文件必须使用完整路径",
            )
            .expect("save memory");
        let hits = manager
            .observe_user_message("所有导出文件必须使用完整路径")
            .expect("observe message");
        assert!(hits.contains(&"absolute-paths".to_owned()));
        assert_eq!(manager.get("absolute-paths").expect("memory").hit_count, 1);
    }

    #[test]
    fn core_is_limited_and_new_low_hit_memory_is_protected() {
        let now = Utc::now();
        let mut memories = (0..12)
            .map(|index| memory_for_test(&format!("frequent-{index}"), now, 3 + index))
            .collect::<Vec<_>>();
        memories.push(memory_for_test("new-reminder", now, 0));
        assign_lifecycle(&mut memories);
        assert_eq!(
            memories
                .iter()
                .filter(|memory| memory.lifecycle == MemoryLifecycle::Core)
                .count(),
            CORE_MEMORY_LIMIT
        );
        assert_eq!(
            memories
                .iter()
                .find(|memory| memory.name == "new-reminder")
                .expect("new memory")
                .lifecycle,
            MemoryLifecycle::Stable
        );
    }

    #[test]
    fn plain_negation_does_not_create_a_memory_signal() {
        assert!(!is_memory_signal("今天不是晴天"));
        assert!(is_memory_signal("你不是不能导出，而是应该使用完整路径"));
    }
}
