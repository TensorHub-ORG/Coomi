//! 前缀缓存诊断（**纯观测层**）。
//!
//! 用户报「双端缓存命中率上不去，最多 95%」，但现场没有任何数字能回答
//! 「95% 到底是被什么吃掉的」。本模块只做三件事，把猜测变成可测量的量：
//!
//! 1. **前缀 / 尾 token 计量**：每轮请求量出「稳定前缀 token 数」与「动态尾巴 token 数」
//!    （口径见 [PrefixTailTokens] 与 [measure_prefix_tail]）。
//! 2. **按原因累计**：把原本一次性打印的 `[cache] 前缀变更` 变成**按会话累计**
//!    （系统提示变更次数 / 工具定义变更次数 / 各次变更发生在第几轮）。
//! 3. **命中率落地**：把 provider 响应里的缓存命中 token 与本轮 prompt token 合成为
//!    `hit_ratio`，并按会话累计；**首轮冷启动单列**，不与稳定期混在一个平均里
//!    （混在一起的话，"必然 miss 的第一轮"会把稳态表现拉低，看起来像"优化没生效"）。
//!
//! ## 硬约束：本模块不构造、不改写、不重排任何发给模型的内容
//!
//! 这里所有函数都在**请求已经定型之后**做测量与记账，一个字节都不回写。
//! 这是本类改动最容易踩的坑——为了打点而"顺手整理一下"发给模型的内容，
//! 会亲手把前缀缓存作废，让命中率从 98% 掉到 0%，而且日志还显示"埋点已生效"。
//! 任何时候想往请求里加东西，先问一句：这会不会改字节？

use serde_json::{Value, json};

/// 字符/字节 → token 的估算口径。
///
/// 与 `web/mod.rs::estimated_tokens` **保持同一条公式**（字节数 + 3) / 4）。
/// 为什么两处必须一致：上下文分类面板（context_categories）和这里的缓存诊断
/// 是同一批字节的两种切法，口径不一致的话两个面板对不上，诊断结论就是假的。
/// 这是粗估（真实分词器因语言而异），只用于**趋势与归因**，不用于计费核对。
pub fn estimate_tokens(bytes: usize) -> u64 {
    u64::try_from(bytes).unwrap_or(u64::MAX).saturating_add(3) / 4
}

/// 一轮请求切出来的三段 token 量。
///
/// ## 口径（为什么这么切）
///
/// DeepSeek 是**字节级前缀缓存**：命中 = 与上一次请求的最长公共前缀 / 本次总长。
/// 请求体从上到下是 `system` → `tools` → `messages[]`，而 `messages[]` =
/// 更早的历史 + 本轮最后一条 user 消息（尾部上下文与工具结果随后继续追加）。
/// 于是三段的缓存地位完全不同：
///
/// - **稳定前缀**（[Self::prefix_tokens]）：系统提示 + 工具定义。跨轮**逐字节不变**才谈得上命中；
///   这里任何一点变化，其后全部作废。它是「能不能命中」的决定项。
/// - **历史**（[Self::history_tokens]）：本轮之前就发过的消息。上一轮已经进过缓存，
///   所以稳态下它是**命中主力**，也是拉高平均值的部分。
/// - **动态尾巴**（[Self::tail_tokens]）：本轮**新增**、因此本轮**必然 miss** 的部分。
///
/// 因此 [Self::ceiling_hit_ratio] 才是解释"95% 封顶"的那把尺子：
/// 上限 = (前缀 + 历史) / 总量 = 1 − 尾巴占比。尾巴每轮重编，它就是每轮必须重算的那块成本。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PrefixTailTokens {
    /// 稳定前缀 token 数：系统提示 + 工具定义（按实际序列化后的 JSON 字节估算）。
    pub prefix_tokens: u64,
    /// 本轮之前的历史消息 token 数（上一轮已进缓存，稳态命中主力）。
    pub history_tokens: u64,
    /// 动态尾巴 token 数：本轮最后一条 user 消息 + 尾部上下文 + 本轮工具结果。
    pub tail_tokens: u64,
}

impl PrefixTailTokens {
    /// 总量（与 provider 回报的 `prompt_tokens` 同一量纲）。
    pub fn total(&self) -> u64 {
        self.prefix_tokens
            .saturating_add(self.history_tokens)
            .saturating_add(self.tail_tokens)
    }

    /// 本轮**理论命中率上限** = (稳定前缀 + 历史) / 总量 = 1 − 尾巴占比。
    ///
    /// 为什么是"上限"而不是预测：它假设前缀与历史**全部命中**。实测比它低，
    /// 差值就是前缀被改动 / 路由漂移 / 冷启动吃掉的。拿实测和这个上限对比，
    /// 才能判断问题出在"尾巴太大"（改内容）还是"前缀老变"（改稳定性）。
    /// 没有任何额外分配。
    pub fn ceiling_hit_ratio(&self) -> Option<f64> {
        let total = self.total();
        (total > 0).then(|| {
            let cachedable = self.prefix_tokens.saturating_add(self.history_tokens);
            cachedable as f64 / total as f64
        })
    }
}

/// 量一轮请求的前缀/尾 token。
///
/// - `system_prompt`：本轮真正用的系统提示（不含任何尾部注入）。
/// - `tool_specs`：本轮真正发出去的工具清单（已排序），按 JSON 序列化字节算——
///   provider 就是把它序列进 `tools` 数组的，用序列化字节才是同一批字节。
/// - `history_chars`：更早历史消息的字节数合计。
/// - `turn_chars`：本轮最后一条 user 消息正文（附件/引用内联后的长度由调用方给出）。
/// - `request_context_chars`：尾部上下文限长**之后**的字符数。调用方必须传
///   限长后的值，否则这里量到的尾巴比实际发出去的还大。
///
/// 全部只读，不改任何入参。
pub fn measure_prefix_tail(
    system_prompt: &str,
    tool_specs: &[coomi_engine::ToolSpec],
    history_chars: usize,
    turn_chars: usize,
    request_context_chars: usize,
) -> PrefixTailTokens {
    let tools_chars = tool_specs
        .iter()
        .map(|spec| serde_json::to_string(spec).map_or(0, |json| json.len()))
        .sum();
    PrefixTailTokens {
        prefix_tokens: estimate_tokens(system_prompt.len()).saturating_add(estimate_tokens(tools_chars)),
        history_tokens: estimate_tokens(history_chars),
        tail_tokens: estimate_tokens(turn_chars).saturating_add(estimate_tokens(request_context_chars)),
    }
}

/// 一次「前缀变更」的原因分解。
///
/// 系统提示与工具定义分开记，因为两者的修法完全不同：系统提示变了要去查
/// 记忆/大纲/偏好有没有混进前缀，工具定义变了要去查 MCP 发现与按需注入。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrefixChange {
    /// 发生在会话的第几轮（1 起，run_turn 计数）。
    pub turn: u64,
    pub system_changed: bool,
    pub tools_changed: bool,
    /// 变更时的工具条数：条数变了基本就是"装了新 MCP/技能"，条数没变则是描述变了。
    pub tool_count: usize,
}

/// 会话级命中率。
///
/// - [Self::cold]：会话**首次**请求（冷启动）。必然接近 0，参考价值低。
/// - [Self::steady]：去掉首次请求后的累计口径 —— **这才是"优化有没有生效"的答案**。
/// - [Self::overall]：全部请求一起算，用于和历史口径对齐（会偏低，别拿它下结论）。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CacheHitRatios {
    pub cold: Option<f64>,
    pub steady: Option<f64>,
    pub overall: Option<f64>,
    pub requests: u64,
    /// 稳定期里"命中为 0"的请求数：>0 说明前缀真的被作废过（路由漂移 / 前缀抖动）。
    pub steady_full_miss: u64,
}

/// 会话内按原因累计的前缀缓存诊断账本。
///
/// 挂在 `SessionTask` 上（一个会话一个），活到会话收尾。**不落盘**：
/// 它服务的是"这一轮对话为什么没命中"这种现场问题，进程重启后重算比持久化更诚实
/// （重启后上游缓存早没了，接着算上一进程的数字只会误导）。
#[derive(Debug, Default)]
pub struct CacheDiag {
    /// 上一轮见到的稳定前缀指纹 (系统提示, 工具定义)。
    fingerprint: Option<(u64, u64)>,
    /// 会话内已发起的轮次（run_turn 计数，1 起）。
    turns: u64,
    /// 最近一轮的前缀/尾计量。
    last: PrefixTailTokens,
    /// 本轮起始尾巴 token（最后一条 user 消息 + 尾部上下文）。
    turn_tail_start_tokens: u64,
    /// 本轮工具结果累计 token：它们现在还是尾巴，下一轮才成为前缀。
    turn_tool_output_tokens: u64,
    system_changes: u64,
    tool_changes: u64,
    changes: Vec<PrefixChange>,
    cold_requests: u64,
    cold_prompt_tokens: u64,
    cold_cached_tokens: u64,
    steady_requests: u64,
    steady_prompt_tokens: u64,
    steady_cached_tokens: u64,
    steady_full_miss: u64,
    summary_printed: bool,
}

impl CacheDiag {
    /// 开始新一轮：记账轮次，落一次前缀/尾计量。
    ///
    /// 必须**先于** [Self::observe_fingerprint] 调用，否则前缀变更会被归到上一轮头上。
    pub fn begin_turn(&mut self, tokens: PrefixTailTokens) {
        self.turns = self.turns.saturating_add(1);
        self.last = tokens;
        self.turn_tail_start_tokens = tokens.tail_tokens;
        self.turn_tool_output_tokens = 0;
        // 重新武装汇总：每来一轮就允许收尾时再打一行，
        // 于是"一行汇总"落在每一次任务收尾上、而数字是全会话累计的。
        self.summary_printed = false;
    }

    /// 比对前缀指纹，把变更**按原因**记进本会话账本。
    ///
    /// 返回值就是原有的那行 `[cache]` 打印内容所描述的那次变更（用于即时打印），
    /// 但它同时已经被累计下来了 —— 会话结束时能回答"这轮对话里前缀一共抖了几次、
    /// 分别是谁抖的、分别在第几轮抖的"。首次见到指纹不算变更（那是冷启动，不是作废）。
    pub fn observe_fingerprint(
        &mut self,
        system_hash: u64,
        tools_hash: u64,
        tool_count: usize,
    ) -> Option<PrefixChange> {
        let previous = self.fingerprint;
        self.fingerprint = Some((system_hash, tools_hash));
        let change = match previous {
            // 首轮：前缀刚建立，上游缓存本来就是空的，记成"变更"会把账做假。
            None => return None,
            Some((old_system, old_tools)) if old_system == system_hash && old_tools == tools_hash => {
                return None;
            }
            Some((old_system, old_tools)) => PrefixChange {
                turn: self.turns.max(1),
                system_changed: old_system != system_hash,
                tools_changed: old_tools != tools_hash,
                tool_count,
            },
        };
        if change.system_changed {
            self.system_changes = self.system_changes.saturating_add(1);
        }
        if change.tools_changed {
            self.tool_changes = self.tool_changes.saturating_add(1);
        }
        self.changes.push(change);
        Some(change)
    }

    /// 本轮首次见到指纹时返回指纹，供调用方打印原来的"会话首轮"那行。
    pub fn is_first_observation(&self) -> bool {
        self.fingerprint.is_none()
    }

    /// 累计本轮工具结果的输出 token（每次工具完成时调用）。
    ///
    /// 为什么工具结果算"尾巴"：它们在这一轮是**新追加**在最后的内容，本轮必然 miss；
    /// 要到下一轮才成为可命中的前缀。忽略它们就会低估尾巴、低估成本。
    pub fn add_tool_output(&mut self, bytes: usize) {
        self.turn_tool_output_tokens = self.turn_tool_output_tokens.saturating_add(estimate_tokens(bytes));
    }

    /// 当前可见的前缀/尾计量（含本轮已产生的工具结果）。
    pub fn snapshot(&self) -> PrefixTailTokens {
        PrefixTailTokens {
            tail_tokens: self
                .turn_tail_start_tokens
                .saturating_add(self.turn_tool_output_tokens),
            ..self.last
        }
    }

    /// 累计一次请求的用量。粒度是**单次 provider 请求**（不是一轮），
    /// 因为前缀缓存的命中也是按请求算的。
    ///
    /// `prompt_tokens` 取 provider 回报的 `prompt_tokens`（DeepSeek 口径即
    /// `prompt_tokens`，已含缓存部分），`cached_tokens` 取 `prompt_cache_hit_tokens`。
    /// `available=false` 表示上游没报缓存字段（该 provider 不支持）——这类请求**整条丢弃**，
    /// 绝不能当 0 命中记进去，否则凭空多出一堆假的"全 miss"。
    pub fn record_request(&mut self, prompt_tokens: u64, cached_tokens: u64, available: bool) {
        if !available || prompt_tokens == 0 {
            return;
        }
        // 钳位：多模态/分块场景下 cached 可能大于 prompt，算出 >100% 的比率比算错更误导。
        let cached = cached_tokens.min(prompt_tokens);
        if self.cold_requests == 0 {
            self.cold_requests = 1;
            self.cold_prompt_tokens = prompt_tokens;
            self.cold_cached_tokens = cached;
            return;
        }
        self.steady_requests = self.steady_requests.saturating_add(1);
        self.steady_prompt_tokens = self.steady_prompt_tokens.saturating_add(prompt_tokens);
        self.steady_cached_tokens = self.steady_cached_tokens.saturating_add(cached);
        if cached == 0 {
            self.steady_full_miss = self.steady_full_miss.saturating_add(1);
        }
    }

    /// 会话级命中率（token 加权，不是"每轮比率求平均"）。
    ///
    /// 为什么按 token 加权：命中率本身就是 token 口径的量，对 token 求和再相除
    /// 才是同口径的平均；先算每轮比率再平均会让小请求和大请求等权，是另一种失真。
    pub fn hit_ratios(&self) -> CacheHitRatios {
        let ratio = |cached: u64, prompt: u64| {
            (prompt > 0).then(|| (cached.min(prompt) as f64 / prompt as f64).min(1.0))
        };
        CacheHitRatios {
            cold: ratio(self.cold_cached_tokens, self.cold_prompt_tokens),
            steady: ratio(self.steady_cached_tokens, self.steady_prompt_tokens),
            overall: ratio(
                self.cold_cached_tokens.saturating_add(self.steady_cached_tokens),
                self.cold_prompt_tokens.saturating_add(self.steady_prompt_tokens),
            ),
            requests: self.cold_requests.saturating_add(self.steady_requests),
            steady_full_miss: self.steady_full_miss,
        }
    }

    /// 会话结束时的单行汇总（数字是全会话累计的）。
    ///
    /// 一次任务收尾只产出一行（[Self::begin_turn] 会重新武装），
    /// 所以排队里连着跑好几轮也只打一次；没跑过任何一轮则不产（没有可汇总的东西）。
    pub fn take_summary_line(&mut self) -> Option<String> {
        // 注意用 replace(true) 而不是 mem::take：take 取完会把标志重置成 false，
        // 那就永远拦不住第二次输出（第一次跑出来的汇总行没有把闸门关上）。
        if self.turns == 0 || std::mem::replace(&mut self.summary_printed, true) {
            return None;
        }
        let ratios = self.hit_ratios();
        let snapshot = self.snapshot();
        let pct = |value: Option<f64>| match value {
            Some(ratio) => format!("{:.1}%", ratio * 100.0),
            None => "n/a".to_owned(),
        };
        let changes = if self.changes.is_empty() {
            "无".to_owned()
        } else {
            self.changes
                .iter()
                .map(|change| {
                    let causes = [
                        change.system_changed.then_some("系统提示"),
                        change.tools_changed.then_some("工具定义"),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("+");
                    format!("第{}轮[{causes}]", change.turn)
                })
                .collect::<Vec<_>>()
                .join("、")
        };
        Some(format!(
            "[cache] 会话汇总 · 轮次 {} · 前缀 {}tok / 历史 {}tok / 尾巴 {}tok（上限 {}）·              命中 稳态 {} · 冷启动 {} · 全量 {}（请求 {}，稳定期全 miss {}）·              前缀变更 {} 次（系统提示 {} · 工具定义 {}）· 明细：{changes}",
            self.turns,
            snapshot.prefix_tokens,
            snapshot.history_tokens,
            snapshot.tail_tokens,
            pct(snapshot.ceiling_hit_ratio()),
            pct(ratios.steady),
            pct(ratios.cold),
            pct(ratios.overall),
            ratios.requests,
            ratios.steady_full_miss,
            self.changes.len(),
            self.system_changes,
            self.tool_changes,
        ))
    }

    /// 挂进 `usage_update` 事件的诊断字段。
    ///
    /// 前端不必改就能忽略；将来要画"前缀/尾随时间"的图，这些字段直接可用。
    pub fn usage_json(&self) -> Value {
        let snapshot = self.snapshot();
        let ratios = self.hit_ratios();
        json!({
            "cache_prefix_tokens": snapshot.prefix_tokens,
            "cache_history_tokens": snapshot.history_tokens,
            "cache_tail_tokens": snapshot.tail_tokens,
            // 理论上限（假定前缀与历史全命中）：实测低于它，差值就是被吃掉的。
            "cache_hit_ceiling": snapshot.ceiling_hit_ratio(),
            // 稳态命中率 = 去掉首次请求后的累计值，用来判断优化有没有生效。
            "cache_session_hit_ratio_steady": ratios.steady,
            "cache_session_hit_ratio_cold": ratios.cold,
            "cache_session_hit_ratio_overall": ratios.overall,
            "cache_session_requests": ratios.requests,
            "cache_session_steady_full_miss": ratios.steady_full_miss,
            "cache_turns": self.turns,
            "cache_prefix_system_changes": self.system_changes,
            "cache_prefix_tool_changes": self.tool_changes,
            // 各次变更发生在第几轮，按发生顺序。
            "cache_prefix_change_turns": self
                .changes
                .iter()
                .map(|change| {
                    json!({
                        "turn": change.turn,
                        "system": change.system_changed,
                        "tools": change.tools_changed,
                        "tool_count": change.tool_count,
                    })
                })
                .collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> coomi_engine::ToolSpec {
        coomi_engine::ToolSpec {
            name: name.to_owned(),
            description: format!("{name} 的说明"),
            parameters: json!({"type": "object", "properties": {}}),
        }
    }

    #[test]
    fn estimate_tokens_uses_the_same_formula_as_context_categories() {
        // (bytes + 3) / 4，与 web/mod.rs::estimated_tokens 同一条公式。
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(4), 1);
        assert_eq!(estimate_tokens(400), 100);
    }

    #[test]
    fn prefix_ceiling_is_one_minus_tail_share() {
        let tokens = PrefixTailTokens {
            prefix_tokens: 800,
            history_tokens: 150,
            tail_tokens: 50,
        };
        let ceiling = tokens.ceiling_hit_ratio().expect("有总量");
        // (800 + 150) / 1000
        assert!((ceiling - 0.95).abs() < 1e-9, "ceiling = {ceiling}");
    }

    #[test]
    fn ceiling_is_none_when_request_is_empty() {
        assert_eq!(PrefixTailTokens::default().ceiling_hit_ratio(), None);
    }

    #[test]
    fn measure_prefix_tail_splits_three_sections() {
        let tokens = measure_prefix_tail(
            &"x".repeat(400),
            &[spec("read_file"), spec("write_file")],
            800,
            200,
            100,
        );
        assert_eq!(tokens.history_tokens, 200);
        assert_eq!(tokens.tail_tokens, 75);
        // 前缀 = 系统提示 100 + 两个工具定义的序列化字节估算，必大于系统提示本身。
        assert!(
            tokens.prefix_tokens > 100,
            "prefix = {}",
            tokens.prefix_tokens
        );
    }

    #[test]
    fn first_observation_is_not_counted_as_a_change() {
        let mut diag = CacheDiag::default();
        diag.begin_turn(measure_prefix_tail("s", &[], 0, 0, 0));
        assert!(diag.observe_fingerprint(1, 2, 3).is_none());
        assert!(!diag.is_first_observation());
        diag.begin_turn(measure_prefix_tail("s", &[], 0, 0, 0));
        assert!(diag.observe_fingerprint(1, 2, 3).is_none(), "指纹未变不算变更");
    }

    #[test]
    fn changes_are_accumulated_by_cause_and_turn() {
        let mut diag = CacheDiag::default();
        diag.begin_turn(measure_prefix_tail("s", &[], 0, 0, 0));
        diag.observe_fingerprint(1, 2, 3);
        // 第 2 轮：系统提示变了。
        diag.begin_turn(measure_prefix_tail("s2", &[], 0, 0, 0));
        let change = diag.observe_fingerprint(9, 2, 3).expect("系统提示变更");
        assert!(change.system_changed && !change.tools_changed);
        assert_eq!(change.turn, 2);
        // 第 3 轮：工具定义变了。
        diag.begin_turn(measure_prefix_tail("s2", &[spec("a")], 0, 0, 0));
        let change = diag.observe_fingerprint(9, 8, 1).expect("工具定义变更");
        assert!(!change.system_changed && change.tools_changed);
        assert_eq!(change.turn, 3);

        let summary = diag.take_summary_line().expect("产出一次汇总");
        assert!(summary.contains("前缀变更 2 次"), "{summary}");
        assert!(summary.contains("系统提示 1 · 工具定义 1"), "{summary}");
        assert!(summary.contains("第2轮[系统提示]"), "{summary}");
        assert!(summary.contains("第3轮[工具定义]"), "{summary}");
        assert!(diag.take_summary_line().is_none(), "同一次收尾只产一行");
        // 新一轮重新武装：收尾时会再打一行，数字继续累计。
        diag.begin_turn(measure_prefix_tail("s3", &[], 0, 0, 0));
        assert!(diag.take_summary_line().is_some(), "新一轮后可以再汇总一次");
    }

    #[test]
    fn cold_start_is_split_from_steady_state() {
        let mut diag = CacheDiag::default();
        // 首轮冷启动：全量 miss。
        diag.record_request(1000, 0, true);
        // 稳定期：一条 90% 命中，一条 0 命中（真被作废了）。
        diag.record_request(1000, 900, true);
        diag.record_request(1000, 0, true);
        let ratios = diag.hit_ratios();
        assert_eq!(ratios.cold, Some(0.0));
        assert!((ratios.steady.expect("稳态") - 0.45).abs() < 1e-9);
        assert_eq!(ratios.steady_full_miss, 1);
        assert_eq!(ratios.requests, 3);
    }

    #[test]
    fn providers_without_cache_fields_do_not_poison_the_ratio() {
        let mut diag = CacheDiag::default();
        // 上游没报缓存字段：整条丢弃，不能当成"命中 0"。
        diag.record_request(1000, 0, false);
        diag.record_request(1000, 0, true);
        assert_eq!(diag.hit_ratios().requests, 1);
        assert_eq!(diag.hit_ratios().overall, Some(0.0));
    }

    #[test]
    fn cached_tokens_larger_than_prompt_are_clamped() {
        let mut diag = CacheDiag::default();
        diag.record_request(100, 150, true);
        assert_eq!(diag.hit_ratios().overall, Some(1.0));
    }

    #[test]
    fn tool_output_grows_the_tail_until_the_next_turn_resets_it() {
        let mut diag = CacheDiag::default();
        let base = PrefixTailTokens {
            prefix_tokens: 10,
            history_tokens: 20,
            tail_tokens: 30,
        };
        diag.begin_turn(base);
        diag.add_tool_output(400);
        assert_eq!(diag.snapshot().tail_tokens, 130);
        // 下一轮重新计量，工具结果转入历史口径、尾巴归零重算。
        diag.begin_turn(PrefixTailTokens {
            prefix_tokens: 10,
            history_tokens: 120,
            tail_tokens: 30,
        });
        assert_eq!(diag.snapshot().tail_tokens, 30);
    }

    #[test]
    fn usage_json_carries_prefix_tail_and_cause_counts() {
        let mut diag = CacheDiag::default();
        diag.begin_turn(measure_prefix_tail(&"x".repeat(400), &[spec("a")], 400, 100, 100));
        diag.observe_fingerprint(1, 2, 1);
        diag.begin_turn(measure_prefix_tail(&"y".repeat(400), &[spec("a")], 800, 100, 100));
        diag.observe_fingerprint(7, 2, 1);
        diag.record_request(1000, 0, true);
        diag.record_request(1000, 950, true);
        let value = diag.usage_json();
        assert_eq!(value["cache_turns"], 2);
        assert_eq!(value["cache_prefix_system_changes"], 1);
        assert_eq!(value["cache_prefix_tool_changes"], 0);
        assert_eq!(value["cache_prefix_change_turns"][0]["turn"], 2);
        assert!(value["cache_hit_ceiling"].is_number());
        assert!((value["cache_session_hit_ratio_steady"].as_f64().expect("稳态") - 0.95).abs() < 1e-9);
    }
}
