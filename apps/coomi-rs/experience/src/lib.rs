//! 经验沉淀库：Agent 在回合中「遇到问题 → 最终解决」后蒸馏出的经验条目的
//! 存储、去重、限频、相关性选择与统计。
//!
//! 存储：`{coomi_home}/experience/lessons.jsonl`（一行一条 JSON）。
//! 全程静默：调用方（web.rs）负责蒸馏与注入，本 crate 只管数据。

use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// 每天最多蒸馏的经验条数（成本护栏：每次蒸馏要调一次用户模型）。
pub const MAX_LESSONS_PER_DAY: usize = 6;
/// 经验库总容量上限：超过后按「得分最低、最旧」淘汰。
pub const MAX_TOTAL_LESSONS: usize = 200;
/// 注入回合上下文的最大字符数。
pub const PROMPT_SECTION_MAX_CHARS: usize = 1500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lesson {
    pub id: String,
    /// RFC3339 时间戳。
    pub time: String,
    /// 分类：environment（环境）/ tool（工具）/ network（网络）/ permission（权限）/ arguments（参数）。
    #[serde(default = "default_category")]
    pub category: String,
    /// 问题症状（现象描述）。
    pub symptom: String,
    /// 根因（证据确认或推测标注）。
    #[serde(default)]
    pub root_cause: String,
    /// 解决方式（最终生效的做法）。
    pub resolution: String,
    /// 适用条件/环境约束（如「仅 proot Ubuntu」「API<29」）。
    #[serde(default)]
    pub constraints: String,
    /// 置信度 0.0-1.0：重复沉淀同一经验会提升。
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    /// 被注入到回合上下文的次数。
    #[serde(default)]
    pub use_count: u32,
    /// 注入后回合成功的次数（经验被验证有效的信号）。
    #[serde(default)]
    pub helpful_count: u32,
}

fn default_category() -> String {
    "environment".to_owned()
}

fn default_confidence() -> f32 {
    0.5
}

pub fn lessons_path(home: &Path) -> PathBuf {
    home.join("experience").join("lessons.jsonl")
}

pub fn enabled_path(home: &Path) -> PathBuf {
    home.join("config").join("experience.json")
}

/// 经验沉淀总开关（默认开）。读 `{home}/config/experience.json` 的 enabled 字段。
pub fn enabled(home: &Path) -> bool {
    std::fs::read_to_string(enabled_path(home))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("enabled").and_then(serde_json::Value::as_bool))
        .unwrap_or(true)
}

pub fn set_enabled(home: &Path, value: bool) -> Result<()> {
    let path = enabled_path(home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::json!({ "enabled": value }))?,
    )?;
    Ok(())
}

/// 读取全部经验（按时间倒序，新的在前）。
pub fn load_lessons(home: &Path) -> Vec<Lesson> {
    let mut lessons = Vec::new();
    let Ok(file) = std::fs::File::open(lessons_path(home)) else {
        return lessons;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Lesson>(trimmed) {
            Ok(lesson) => lessons.push(lesson),
            Err(_) => continue,
        }
    }
    lessons.sort_by(|a, b| b.time.cmp(&a.time));
    lessons
}

pub fn count_lessons(home: &Path) -> usize {
    load_lessons(home).len()
}

/// 追加一条经验：与既有条目去重（症状+解决方式高度相似则合并升级置信度），
/// 触发每日限频与总量上限。返回是否真正入库。
pub fn append_lesson(home: &Path, mut lesson: Lesson) -> Result<bool> {
    if lesson.symptom.trim().is_empty() || lesson.resolution.trim().is_empty() {
        return Ok(false);
    }
    if lesson.time.is_empty() {
        lesson.time = Utc::now().to_rfc3339();
    }
    if lesson.id.is_empty() {
        lesson.id = format!("lesson_{}", Utc::now().timestamp_millis());
    }
    let path = lessons_path(home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut lessons = load_lessons(home);
    // 每日限频（按入库时间统计）。
    let today = Utc::now().date_naive().to_string();
    let today_count = lessons
        .iter()
        .filter(|existing| existing.time.starts_with(&today))
        .count();
    if today_count >= MAX_LESSONS_PER_DAY {
        return Ok(false);
    }
    // 去重：归一化后 symptom+resolution 相同视为同一经验，合并升级置信度。
    let key = dedup_key(&lesson);
    if let Some(existing) = lessons
        .iter_mut()
        .find(|existing| dedup_key(existing) == key)
    {
        existing.confidence = (existing.confidence + 0.1).min(1.0);
        existing.resolution = lesson.resolution;
        existing.time = lesson.time;
        return write_lessons(&path, &lessons).map(|_| false);
    }
    lessons.insert(0, lesson);
    // 总量上限：按（置信度 + helpful 权重）升序淘汰最弱且最旧的。
    while lessons.len() > MAX_TOTAL_LESSONS {
        let weakest = lessons
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| lesson_score(a).total_cmp(&lesson_score(b)))
            .map(|(index, _)| index)
            .unwrap_or(0);
        lessons.remove(weakest);
    }
    write_lessons(&path, &lessons).map(|_| true)
}

/// 记录注入：回合开始时被选中注入的经验 use_count+1。
pub fn record_injected(home: &Path, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let path = lessons_path(home);
    let mut lessons = load_lessons(home);
    for lesson in &mut lessons {
        if ids.contains(&lesson.id) {
            lesson.use_count = lesson.use_count.saturating_add(1);
        }
    }
    write_lessons(&path, &lessons).map(|_| ())
}

/// 记录有效：注入过的经验所在回合最终成功时 helpful_count+1。
pub fn mark_helpful(home: &Path, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let path = lessons_path(home);
    let mut lessons = load_lessons(home);
    for lesson in &mut lessons {
        if ids.contains(&lesson.id) {
            lesson.helpful_count = lesson.helpful_count.saturating_add(1);
        }
    }
    write_lessons(&path, &lessons).map(|_| ())
}

/// 清空经验库。
pub fn clear(home: &Path) -> Result<()> {
    let path = lessons_path(home);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// 按相关性选择经验：查询文本与经验文本的字符二元组重叠度打分，取 top-K。
/// 中文按 bigram、英文按小写词兼顾。
pub fn select_relevant(home: &Path, query: &str, top_k: usize) -> Vec<Lesson> {
    let lessons = load_lessons(home);
    if lessons.is_empty() || top_k == 0 {
        return Vec::new();
    }
    let query_bigrams = bigrams(query);
    if query_bigrams.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, &Lesson)> = lessons
        .iter()
        .map(|lesson| {
            let text = format!(
                "{} {} {} {}",
                lesson.category, lesson.symptom, lesson.root_cause, lesson.resolution
            );
            let lesson_bigrams = bigrams(&text);
            let overlap = query_bigrams
                .intersection(&lesson_bigrams)
                .count();
            (overlap, lesson)
        })
        .filter(|(overlap, _)| *overlap > 0)
        .collect();
    scored.sort_by(|a, b| {
        let weighted = |score: usize, lesson: &Lesson| {
            score as f32 * (1.0 + lesson.helpful_count as f32 * 0.2) * lesson.confidence
        };
        weighted(b.0, b.1)
            .total_cmp(&weighted(a.0, a.1))
            .then_with(|| b.1.time.cmp(&a.1.time))
    });
    scored.into_iter().map(|(_, lesson)| lesson.clone()).take(top_k).collect()
}

/// 生成注入系统提示的经验段（带大小上限，超出截断）。
pub fn prompt_section(lessons: &[Lesson]) -> String {
    if lessons.is_empty() {
        return String::new();
    }
    let mut section = String::from(
        "\n\n环境经验教训（此前任务中沉淀的已验证经验，优先参考，避免重复试错）：\n",
    );
    for lesson in lessons {
        let mut line = format!(
            "- [{}] {} → {}",
            lesson.category, lesson.symptom, lesson.resolution
        );
        if !lesson.constraints.trim().is_empty() {
            line.push_str(&format!("（适用：{}）", lesson.constraints));
        }
        line.push('\n');
        if section.chars().count() + line.chars().count() > PROMPT_SECTION_MAX_CHARS {
            section.push_str("- （更多经验已省略）\n");
            break;
        }
        section.push_str(&line);
    }
    section
}

fn write_lessons(path: &Path, lessons: &[Lesson]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(path)?;
    for lesson in lessons {
        writeln!(file, "{}", serde_json::to_string(lesson)?)?;
    }
    file.flush()?;
    Ok(())
}

fn lesson_score(lesson: &Lesson) -> f32 {
    lesson.confidence + lesson.helpful_count as f32 * 0.1
}

fn dedup_key(lesson: &Lesson) -> String {
    let combined = format!("{}|{}", lesson.symptom, lesson.resolution);
    combined
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn bigrams(text: &str) -> std::collections::HashSet<String> {
    let normalized: Vec<char> = text
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    normalized
        .windows(2)
        .map(|pair| pair.iter().collect::<String>())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_lesson(id: &str, symptom: &str, resolution: &str) -> Lesson {
        Lesson {
            id: id.to_owned(),
            time: Utc::now().to_rfc3339(),
            category: "environment".to_owned(),
            symptom: symptom.to_owned(),
            root_cause: String::new(),
            resolution: resolution.to_owned(),
            constraints: String::new(),
            confidence: 0.5,
            use_count: 0,
            helpful_count: 0,
        }
    }

    #[test]
    fn append_dedups_and_marks_helpful() {
        let home = tempfile::tempdir().unwrap();
        assert!(append_lesson(
            home.path(),
            sample_lesson("a", "apt install 报 permission denied", "使用 proot 环境内 apt")
        )
        .unwrap());
        // 相同内容视为重复，不再入库。
        assert!(!append_lesson(
            home.path(),
            sample_lesson("b", "apt install 报 permission denied", "使用 proot 环境内 apt")
        )
        .unwrap());
        assert_eq!(count_lessons(home.path()), 1);
        record_injected(home.path(), &["a".to_owned()]).unwrap();
        mark_helpful(home.path(), &["a".to_owned()]).unwrap();
        let lessons = load_lessons(home.path());
        assert_eq!(lessons[0].use_count, 1);
        assert_eq!(lessons[0].helpful_count, 1);
    }

    #[test]
    fn selects_by_bigram_overlap() {
        let home = tempfile::tempdir().unwrap();
        append_lesson(
            home.path(),
            sample_lesson("a", "apt permission denied", "proot 内执行"),
        )
        .unwrap();
        append_lesson(
            home.path(),
            sample_lesson("b", "网络超时 connection timeout", "切换镜像源"),
        )
        .unwrap();
        // 相关性最高的经验必须排最前（bigram 偶发重叠允许其余入选）。
        let selected = select_relevant(home.path(), "apt 安装软件时 permission denied", 2);
        assert!(!selected.is_empty());
        assert_eq!(selected[0].id, "a");
        assert!(!prompt_section(&selected).is_empty());
        // 完全无关的查询不注入任何经验。
        let unrelated = select_relevant(home.path(), "绘制一个三角形统计图", 2);
        assert!(unrelated.is_empty() || unrelated[0].id != "a");
    }
}
