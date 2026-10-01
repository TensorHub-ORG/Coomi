//! 分层提示词组装（批 5）。
//!
//! 把原先散落在各处的系统提示词拼装收敛成 6 个可组合的层：
//! ①身份与安全边界 ②环境 ③能力与工具说明 ④技能（按需）⑤记忆与上下文摘要 ⑥用户偏好与风格。
//!
//! 设计约束（任务要求）：
//! - 每层可独立开关（PromptBuilder::set_enabled / PromptBuilder::enable）；
//! - 空层不产生多余空行：空白内容在入队时就被忽略，渲染只在「非空层」之间插入一个空行；
//! - 渲染顺序固定为 PromptLayer::ALL 的顺序，与调用方 push 的先后无关；
//! - 默认输出与逐段 push_str 的旧拼装等价（内容顺序一致，只有首尾空白被规范化）。

use std::collections::{BTreeMap, HashMap};

/// 提示词分层。枚举顺序即渲染顺序。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub enum PromptLayer {
    /// ① 身份与安全边界：角色定位、授权范围、只读/越权禁令、隐私边界。
    Identity,
    /// ② 环境：工作目录、home、OS/架构、权限、运行时与路径映射。
    Environment,
    /// ③ 能力与工具说明：可用工具清单、调用规约、工作流建议。
    Capabilities,
    /// ④ 技能（按需）：按用户消息相关性挑选出的技能，未命中时整层为空。
    Skills,
    /// ⑤ 记忆与上下文摘要：持久记忆、项目指令、压缩摘要、目标栈。
    Memory,
    /// ⑥ 用户偏好与风格：沟通风格、输出规约、路径呈现习惯。
    Style,
}

impl PromptLayer {
    /// 全层列表（渲染顺序）。
    pub const ALL: [PromptLayer; 6] = [
        PromptLayer::Identity,
        PromptLayer::Environment,
        PromptLayer::Capabilities,
        PromptLayer::Skills,
        PromptLayer::Memory,
        PromptLayer::Style,
    ];

    /// 层序号（与 PromptLayer::ALL 下标一致）。
    pub const fn index(self) -> usize {
        match self {
            PromptLayer::Identity => 0,
            PromptLayer::Environment => 1,
            PromptLayer::Capabilities => 2,
            PromptLayer::Skills => 3,
            PromptLayer::Memory => 4,
            PromptLayer::Style => 5,
        }
    }

    /// 中文层名，仅用于调试与日志。
    pub const fn label(self) -> &'static str {
        match self {
            PromptLayer::Identity => "身份与安全边界",
            PromptLayer::Environment => "环境",
            PromptLayer::Capabilities => "能力与工具说明",
            PromptLayer::Skills => "技能",
            PromptLayer::Memory => "记忆与上下文摘要",
            PromptLayer::Style => "用户偏好与风格",
        }
    }
}

/// 6 层提示词组装器。
#[derive(Clone, Debug)]
pub struct PromptBuilder {
    enabled: [bool; 6],
    sections: [Vec<String>; 6],
}

impl PromptBuilder {
    /// 新建组装器：6 层全开、内容为空。
    pub fn new() -> Self {
        Self {
            enabled: [true; 6],
            sections: std::array::from_fn(|_| Vec::new()),
        }
    }

    /// 只使用指定层（其余层全部关闭）。
    pub fn only(layers: &[PromptLayer]) -> Self {
        let mut builder = Self::new();
        for layer in PromptLayer::ALL {
            builder.set_enabled(layer, layers.contains(&layer));
        }
        builder
    }

    /// 链式开关某层。
    #[must_use]
    pub fn enable(mut self, layer: PromptLayer, enabled: bool) -> Self {
        self.set_enabled(layer, enabled);
        self
    }

    /// 就地开关某层。关闭后该层已有的内容不会进入渲染结果（内容仍保留，可再次打开）。
    pub fn set_enabled(&mut self, layer: PromptLayer, enabled: bool) {
        self.enabled[layer.index()] = enabled;
    }

    pub fn is_enabled(&self, layer: PromptLayer) -> bool {
        self.enabled[layer.index()]
    }

    /// 追加一段内容到某层。纯空白内容直接忽略（保证「空层不产生多余空行」）。
    /// 返回是否真的写入了内容。
    pub fn push(&mut self, layer: PromptLayer, text: impl AsRef<str>) -> bool {
        let trimmed = text.as_ref().trim();
        if trimmed.is_empty() {
            return false;
        }
        self.sections[layer.index()].push(trimmed.to_owned());
        true
    }

    /// 条件写入：condition 为 false 时什么都不做。
    pub fn push_if(&mut self, layer: PromptLayer, condition: bool, text: impl AsRef<str>) -> bool {
        condition && self.push(layer, text)
    }

    /// 可空写入：None 或空白都不写入。
    pub fn push_optional(&mut self, layer: PromptLayer, text: Option<impl AsRef<str>>) -> bool {
        match text {
            Some(text) => self.push(layer, text),
            None => false,
        }
    }

    /// 该层的渲染内容（关闭或全空时返回 None）。
    pub fn layer_body(&self, layer: PromptLayer) -> Option<String> {
        if !self.is_enabled(layer) {
            return None;
        }
        let parts = self.sections[layer.index()]
            .iter()
            .filter(|section| !section.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return None;
        }
        Some(parts.join("\n\n"))
    }

    /// 所有开启且非空的层。
    pub fn active_layers(&self) -> Vec<PromptLayer> {
        PromptLayer::ALL
            .into_iter()
            .filter(|layer| self.layer_body(*layer).is_some())
            .collect()
    }

    /// 是否没有任何内容可渲染。
    pub fn is_empty(&self) -> bool {
        self.active_layers().is_empty()
    }

    /// 追加到已有字符串：仅在目标非空时插入层间分隔（不会产生多余空行）。
    pub fn render_into(&self, target: &mut String) {
        for layer in PromptLayer::ALL {
            let Some(body) = self.layer_body(layer) else {
                continue;
            };
            if !target.is_empty() {
                target.push_str("\n\n");
            }
            target.push_str(&body);
        }
    }

    /// 渲染成完整提示词（按 PromptLayer::ALL 顺序，空层不占位）。
    pub fn render(&self) -> String {
        let mut out = String::new();
        self.render_into(&mut out);
        out
    }

    /// 只渲染指定层（顺序仍按 PromptLayer::ALL）。
    pub fn render_layers(&self, layers: &[PromptLayer]) -> String {
        let mut out = String::new();
        for layer in PromptLayer::ALL {
            if !layers.contains(&layer) {
                continue;
            }
            let Some(body) = self.layer_body(layer) else {
                continue;
            };
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&body);
        }
        out
    }
}

impl Default for PromptBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// 技能候选：按需注入时的检索对象。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillCandidate {
    pub name: String,
    pub description: String,
    pub keywords: Vec<String>,
    /// 可选正文（SKILL.md 全文或节选）。为空时只注入名称与描述。
    pub body: String,
}

impl SkillCandidate {
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        let name = name.into();
        let mut candidate = Self {
            keywords: tokenize(&name),
            name,
            description: description.into(),
            body: String::new(),
        };
        candidate.normalize();
        candidate
    }

    /// 从 SKILL.md 原文构造候选：解析 front matter（description/keywords）与首个非标题行。
    pub fn from_markdown(name: impl Into<String>, markdown: &str) -> Self {
        let name = name.into();
        let (front_matter, body) = split_front_matter(markdown);
        let mut description = front_matter_description(front_matter);
        if description.is_empty() {
            description = body
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('#'))
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
        }
        let mut keywords = front_matter_keywords(front_matter);
        keywords.extend(tokenize(&name));
        let mut candidate = Self {
            name,
            description,
            keywords,
            body: String::new(),
        };
        candidate.normalize();
        candidate
    }

    #[must_use]
    pub fn with_keywords<I, S>(mut self, keywords: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.keywords.extend(keywords.into_iter().map(Into::into));
        self.normalize();
        self
    }

    #[must_use]
    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into().trim().to_owned();
        self
    }

    /// 用于检索与展示的整段文本。
    fn searchable(&self) -> String {
        let mut text = String::with_capacity(self.name.len() + self.description.len() + 64);
        text.push_str(&self.name);
        text.push(' ');
        text.push_str(&self.description);
        for keyword in &self.keywords {
            text.push(' ');
            text.push_str(keyword);
        }
        text
    }

    fn normalize(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.keywords = self
            .keywords
            .drain(..)
            .map(|keyword| keyword.trim().to_lowercase())
            .filter(|keyword| keyword.chars().count() >= 2)
            .filter(|keyword| seen.insert(keyword.clone()))
            .collect();
        self.description = self.description.trim().to_owned();
    }
}

/// 命中技能。
#[derive(Clone, Debug, PartialEq)]
pub struct ScoredSkill {
    /// 在候选集中的下标。
    pub index: usize,
    pub name: String,
    pub score: f64,
    /// 命中原因（用于展示与测试断言）。
    pub reasons: Vec<String>,
}

/// 默认命中上限（未命中时一个都不注入）。
pub const DEFAULT_SKILL_LIMIT: usize = 3;
/// 默认注入预算（字节）。
pub const DEFAULT_SKILL_CONTEXT_BYTES: usize = 8 * 1024;
/// 低于该分数视为未命中。
pub const MIN_SKILL_SCORE: f64 = 0.05;

/// 关键词 / 词频（TF-IDF 余弦）打分器。
///
/// 打分 = 查询与技能文本的 TF-IDF 余弦相似度 + 名称命中加成 + 策划关键词命中加成。
/// 分数低于 MIN_SKILL_SCORE 的候选视为「未命中」，调用方据此决定不注入。
#[derive(Clone, Debug)]
pub struct SkillSelector {
    candidates: Vec<SkillCandidate>,
    doc_tokens: Vec<BTreeMap<String, u32>>,
    idf: HashMap<String, f64>,
    norms: Vec<f64>,
}

impl SkillSelector {
    pub fn new(candidates: Vec<SkillCandidate>) -> Self {
        let doc_tokens = candidates
            .iter()
            .map(|candidate| term_counts(&tokenize(&candidate.searchable())))
            .collect::<Vec<_>>();
        let mut document_frequency: HashMap<String, u32> = HashMap::new();
        for tokens in &doc_tokens {
            for term in tokens.keys() {
                *document_frequency.entry(term.clone()).or_insert(0) += 1;
            }
        }
        let total = candidates.len().max(1) as f64;
        let idf = document_frequency
            .into_iter()
            .map(|(term, frequency)| {
                let value = ((total + 1.0) / (f64::from(frequency) + 1.0)).ln() + 1.0;
                (term, value)
            })
            .collect::<HashMap<_, _>>();
        let norms = doc_tokens
            .iter()
            .map(|tokens| {
                let sum = tokens
                    .iter()
                    .map(|(term, count)| {
                        let weight = f64::from(*count) * idf.get(term).copied().unwrap_or(1.0);
                        weight * weight
                    })
                    .sum::<f64>();
                sum.sqrt().max(f64::EPSILON)
            })
            .collect::<Vec<_>>();
        Self {
            candidates,
            doc_tokens,
            idf,
            norms,
        }
    }

    pub fn candidates(&self) -> &[SkillCandidate] {
        &self.candidates
    }

    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }

    pub fn len(&self) -> usize {
        self.candidates.len()
    }

    /// 按相关性挑选技能。limit 为命中上限（至少 1）；未命中返回空向量。
    pub fn select(&self, query: &str, limit: usize) -> Vec<ScoredSkill> {
        let limit = limit.max(1);
        let query_lower = query.trim().to_lowercase();
        if query_lower.is_empty() {
            return Vec::new();
        }
        let query_tokens = term_counts(&tokenize(&query_lower));
        let query_norm = query_tokens
            .iter()
            .map(|(term, count)| {
                let weight = f64::from(*count) * self.idf.get(term).copied().unwrap_or(1.0);
                weight * weight
            })
            .sum::<f64>()
            .sqrt()
            .max(f64::EPSILON);

        let mut scored = Vec::new();
        for (index, candidate) in self.candidates.iter().enumerate() {
            let mut score = 0.0_f64;
            for (term, count) in &query_tokens {
                let Some(document_count) = self.doc_tokens[index].get(term) else {
                    continue;
                };
                let idf = self.idf.get(term).copied().unwrap_or(1.0);
                score += f64::from(*count) * f64::from(*document_count) * idf;
            }
            score /= query_norm * self.norms[index];
            let mut reasons = Vec::new();
            if score > 0.0 {
                reasons.push("词频命中".to_owned());
            }
            let name_lower = candidate.name.to_lowercase();
            if name_lower.chars().count() >= 2 && query_lower.contains(&name_lower) {
                score += 0.9;
                reasons.push(format!("名称: {}", candidate.name));
            }
            for keyword in candidate.keywords.iter().take(8) {
                if query_lower.contains(keyword.as_str()) {
                    score += 0.25;
                    reasons.push(format!("关键词: {keyword}"));
                }
            }
            if score >= MIN_SKILL_SCORE && !reasons.is_empty() {
                scored.push(ScoredSkill {
                    index,
                    name: candidate.name.clone(),
                    score,
                    reasons,
                });
            }
        }
        scored.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.name.cmp(&right.name))
        });
        scored.truncate(limit);
        scored
    }

    /// 生成可注入提示词的技能块；未命中或超预算时返回 None。
    pub fn prompt_block(&self, query: &str, limit: usize, max_bytes: usize) -> Option<String> {
        let hits = self.select(query, limit);
        if hits.is_empty() {
            return None;
        }
        let mut block =
            String::from("## 相关技能（按当前消息相关性选中，可直接用 read_skill 读取；用户与项目规则优先）");
        for hit in hits {
            let candidate = &self.candidates[hit.index];
            let mut section = format!(
                "\n- {}: {}",
                candidate.name,
                if candidate.description.is_empty() {
                    "（无描述）"
                } else {
                    candidate.description.as_str()
                }
            );
            if !hit.reasons.is_empty() {
                section.push_str(&format!("（命中：{}）", hit.reasons.join("、")));
            }
            if !candidate.body.is_empty() {
                section.push('\n');
                section.push_str(&candidate.body);
            }
            if block.len().saturating_add(section.len()) > max_bytes {
                break;
            }
            block.push_str(&section);
        }
        if block.lines().count() <= 1 {
            return None;
        }
        Some(block)
    }
}

/// 词频统计（TF）。用 BTreeMap 而不是 HashMap：下面所有打分都要对 f64 累加，
/// 而浮点加法不满足结合律——HashMap 的随机迭代顺序会让同一个查询在不同次
/// 调用里算出末位不同的分数，技能排序随之抖动（注入提示词的技能都不一样）。
fn term_counts(tokens: &[String]) -> BTreeMap<String, u32> {
    let mut counts = BTreeMap::new();
    for token in tokens {
        *counts.entry(token.clone()).or_insert(0) += 1;
    }
    counts
}

/// 轻量分词：ASCII 词（长度 >= 2）+ 中文单字与相邻双字。用于关键词/词频打分。
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk, &mut tokens);
            ascii.push(ch);
        } else if is_cjk(ch) {
            flush_ascii(&mut ascii, &mut tokens);
            cjk.push(ch);
        } else {
            flush_ascii(&mut ascii, &mut tokens);
            flush_cjk(&mut cjk, &mut tokens);
        }
    }
    flush_ascii(&mut ascii, &mut tokens);
    flush_cjk(&mut cjk, &mut tokens);
    tokens
}

fn flush_ascii(ascii: &mut String, tokens: &mut Vec<String>) {
    if ascii.chars().count() >= 2 {
        tokens.push(ascii.to_lowercase());
    }
    ascii.clear();
}

fn flush_cjk(cjk: &mut Vec<char>, tokens: &mut Vec<String>) {
    for (index, ch) in cjk.iter().enumerate() {
        tokens.push(ch.to_string());
        if let Some(next) = cjk.get(index + 1) {
            tokens.push(format!("{ch}{next}"));
        }
    }
    cjk.clear();
}

const fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// 拆分 SKILL.md 的 YAML front matter，返回 (front matter, 正文)。
fn split_front_matter(markdown: &str) -> (&str, &str) {
    let trimmed = markdown.trim_start_matches('\u{feff}').trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return ("", markdown);
    };
    let Some(end) = rest.find("\n---") else {
        return ("", markdown);
    };
    let front_matter = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
    (front_matter, body)
}

fn front_matter_value<'a>(front_matter: &'a str, key: &str) -> Option<&'a str> {
    front_matter.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix(key)?.trim_start();
        let value = value.strip_prefix(':')?;
        Some(value.trim().trim_matches(['"', '\'']))
    })
}

fn front_matter_description(front_matter: &str) -> String {
    front_matter_value(front_matter, "description")
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

fn front_matter_keywords(front_matter: &str) -> Vec<String> {
    let Some(raw) = front_matter_value(front_matter, "keywords") else {
        return Vec::new();
    };
    raw.trim_start_matches('[')
        .trim_end_matches(']')
        .split([',', '，'])
        .map(|item| item.trim().trim_matches(['"', '\'']).to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layers_render_in_fixed_order_regardless_of_push_order() {
        let mut builder = PromptBuilder::new();
        builder.push(PromptLayer::Style, "风格层");
        builder.push(PromptLayer::Memory, "记忆层");
        builder.push(PromptLayer::Identity, "身份层");
        builder.push(PromptLayer::Skills, "技能层");
        builder.push(PromptLayer::Capabilities, "能力层");
        builder.push(PromptLayer::Environment, "环境层");

        let rendered = builder.render();
        assert_eq!(
            rendered,
            "身份层\n\n环境层\n\n能力层\n\n技能层\n\n记忆层\n\n风格层"
        );

        let positions = ["身份层", "环境层", "能力层", "技能层", "记忆层", "风格层"]
            .map(|needle| rendered.find(needle).expect("layer present"));
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn empty_and_disabled_layers_produce_no_blank_lines() {
        let mut builder = PromptBuilder::new();
        assert!(builder.is_empty());
        assert_eq!(builder.render(), "");

        builder.push(PromptLayer::Identity, "   \n  ");
        builder.push(PromptLayer::Skills, "");
        assert!(builder.is_empty(), "纯空白内容不应产生层");

        builder.push(PromptLayer::Identity, "只有身份层");
        assert_eq!(builder.render(), "只有身份层");
        assert!(!builder.render().starts_with('\n'));
        assert!(!builder.render().ends_with('\n'));
        assert!(!builder.render().contains("\n\n\n"));

        builder.set_enabled(PromptLayer::Identity, false);
        assert!(builder.is_empty());
        builder.set_enabled(PromptLayer::Identity, true);
        assert_eq!(builder.render(), "只有身份层");
    }

    #[test]
    fn content_is_preserved_and_sections_join_with_one_blank_line() {
        let mut builder = PromptBuilder::new();
        builder.push(PromptLayer::Identity, "  身份一  ");
        builder.push(PromptLayer::Identity, "身份二");
        builder.push(PromptLayer::Memory, "记忆");
        assert_eq!(builder.render(), "身份一\n\n身份二\n\n记忆");
        assert_eq!(
            builder.layer_body(PromptLayer::Identity).as_deref(),
            Some("身份一\n\n身份二")
        );
        assert_eq!(builder.layer_body(PromptLayer::Environment), None);
        assert_eq!(
            builder.active_layers(),
            vec![PromptLayer::Identity, PromptLayer::Memory]
        );
    }

    #[test]
    fn render_into_keeps_existing_prefix_without_extra_blank_lines() {
        let mut builder = PromptBuilder::new();
        builder.push(PromptLayer::Environment, "环境");
        let mut target = String::from("已有前缀");
        builder.render_into(&mut target);
        assert_eq!(target, "已有前缀\n\n环境");

        let mut empty_target = String::new();
        builder.render_into(&mut empty_target);
        assert_eq!(empty_target, "环境");
    }

    #[test]
    fn render_layers_filters_unselected_layers() {
        let mut builder = PromptBuilder::new();
        builder.push(PromptLayer::Identity, "身份");
        builder.push(PromptLayer::Style, "风格");
        assert_eq!(builder.render_layers(&[PromptLayer::Style]), "风格");
        assert_eq!(builder.render_layers(&[PromptLayer::Skills]), "");
    }

    #[test]
    fn push_if_and_push_optional_skip_empty_values() {
        let mut builder = PromptBuilder::new();
        assert!(!builder.push_if(PromptLayer::Memory, false, "不该出现"));
        assert!(!builder.push_optional(PromptLayer::Memory, None::<String>));
        assert!(builder.push_if(PromptLayer::Memory, true, "记忆"));
        assert!(builder.push_optional(PromptLayer::Memory, Some("补充")));
        assert_eq!(builder.render(), "记忆\n\n补充");
    }

    #[test]
    fn tokenize_handles_ascii_and_chinese() {
        let tokens = tokenize("Code Review 代码审查");
        assert!(tokens.contains(&"code".to_owned()));
        assert!(tokens.contains(&"review".to_owned()));
        assert!(tokens.contains(&"代码".to_owned()));
        assert!(tokens.contains(&"审查".to_owned()));
        assert!(tokens.contains(&"代".to_owned()));
        assert!(!tokenize("a b c").contains(&"a".to_owned()));
    }

    fn candidates() -> Vec<SkillCandidate> {
        vec![
            SkillCandidate::new("code-review", "审查代码并指出问题")
                .with_keywords(["review", "审查"]),
            SkillCandidate::new("generate-tests", "为代码生成测试用例")
                .with_keywords(["测试", "test"]),
            SkillCandidate::new("generate-docs", "从代码生成文档").with_keywords(["文档", "docs"]),
            SkillCandidate::new("skill-creator", "创建新的技能").with_keywords(["技能", "skill"]),
        ]
    }

    #[test]
    fn selector_picks_relevant_skills_and_respects_limit() {
        let selector = SkillSelector::new(candidates());
        let hits = selector.select("帮我审查一下这段代码，做个 code review", 2);
        assert!(!hits.is_empty(), "相关技能应命中");
        assert_eq!(hits[0].name, "code-review");
        assert!(hits.len() <= 2, "命中数不得超过上限");
        assert!(hits[0].score >= MIN_SKILL_SCORE);
    }

    #[test]
    fn selector_returns_nothing_when_nothing_matches() {
        let selector = SkillSelector::new(candidates());
        assert!(
            selector
                .select("今天天气怎么样", DEFAULT_SKILL_LIMIT)
                .is_empty()
        );
        assert!(
            selector
                .prompt_block(
                    "今天天气怎么样",
                    DEFAULT_SKILL_LIMIT,
                    DEFAULT_SKILL_CONTEXT_BYTES
                )
                .is_none(),
            "未命中时不得注入任何技能说明"
        );
        assert!(selector.select("", DEFAULT_SKILL_LIMIT).is_empty());
    }

    #[test]
    fn selector_is_deterministic_and_orders_by_score_then_name() {
        let selector = SkillSelector::new(candidates());
        let first = selector.select("生成文档和测试", 3);
        let second = selector.select("生成文档和测试", 3);
        assert_eq!(first, second);
        assert!(
            first.windows(2).all(|pair| pair[0].score >= pair[1].score),
            "必须按分数降序"
        );
    }

    #[test]
    fn prompt_block_lists_names_and_budget_is_respected() {
        let selector = SkillSelector::new(candidates());
        let block = selector
            .prompt_block("帮我写测试", DEFAULT_SKILL_LIMIT, DEFAULT_SKILL_CONTEXT_BYTES)
            .expect("测试技能应命中");
        assert!(block.contains("generate-tests"));
        assert!(block.starts_with("## 相关技能"));
        // 预算极小时不注入：只有标题行即视为空。
        assert!(
            selector
                .prompt_block("帮我写测试", DEFAULT_SKILL_LIMIT, 4)
                .is_none()
        );
    }

    #[test]
    fn candidate_from_markdown_reads_front_matter() {
        let markdown = "---\nname: pdf-tools\ndescription: 处理 PDF 文件\nkeywords: [pdf, 合并]\n---\n\n# PDF 工具\n\n正文内容\n";
        let candidate = SkillCandidate::from_markdown("pdf-tools", markdown);
        assert_eq!(candidate.description, "处理 PDF 文件");
        assert!(candidate.keywords.contains(&"pdf".to_owned()));
        assert!(candidate.keywords.contains(&"合并".to_owned()));

        let plain = SkillCandidate::from_markdown("plain", "# 标题\n\n第一段说明文字\n");
        assert_eq!(plain.description, "第一段说明文字");
        assert_eq!(plain.keywords, vec!["plain".to_owned()]);
    }

    #[test]
    fn builder_matches_legacy_string_concatenation() {
        // 旧写法：逐段 push_str，段落之间用两个换行连接。
        let legacy = format!("{}\n\n{}\n\n{}", "身份", "能力", "记忆");
        let mut builder = PromptBuilder::new();
        builder.push(PromptLayer::Identity, "身份");
        builder.push(PromptLayer::Environment, "  "); // 旧写法里这一层没内容
        builder.push(PromptLayer::Capabilities, "\n能力\n");
        builder.push(PromptLayer::Skills, "");
        builder.push(PromptLayer::Memory, "记忆");
        builder.push(PromptLayer::Style, "");
        assert_eq!(builder.render(), legacy);
    }
}
