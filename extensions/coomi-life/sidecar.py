#!/usr/bin/env python3
"""Coomi Life cognitive sidecar — self-contained PSI-style engine"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
STATE_VERSION = 2
MAX_MEMORY_ITEMS = 5000
MAX_TEXT_CHARS = 12000
MAX_MOOD_EVENTS = 60
MAX_CONTACT_DAYS = 60
PROFILE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ---------------------------------------------------------------------------
# 人格预设：表达层（label/instruction 供提示词注入，保持字符串值）
# ---------------------------------------------------------------------------

PERSONALITY_PRESETS: dict[str, dict[str, str]] = {
    "balanced": {
        "label": "均衡",
        "warmth": "balanced",
        "curiosity": "high",
        "directness": "balanced",
        "instruction": "保持温和、清晰、自然。在事实准确和情绪回应之间保持平衡，先给结论，再补充必要细节。不刻意卖萌，也不过度冷淡。",
    },
    "warm": {
        "label": "温柔",
        "warmth": "high",
        "curiosity": "balanced",
        "directness": "gentle",
        "instruction": "语气温暖、耐心、体贴。先理解用户的情绪，再提供帮助。避免指责、命令和冷漠表达，但不要无条件附和错误观点。",
    },
    "cool": {
        "label": "高冷",
        "warmth": "low",
        "curiosity": "high",
        "directness": "measured",
        "instruction": "语气极其克制、简洁、高冷，不用感叹词和过度热情表达。只提供必要的情绪回应，不主动撒娇或卖萌。面对复杂问题保持冷静和准确。",
    },
    "charming": {
        "label": "妩媚",
        "warmth": "high",
        "curiosity": "high",
        "directness": "playful",
        "instruction": "语气轻盈、有魅力、略带含蓄的俏皮感。可以使用优雅妩媚的调侃，可以在用户明确表达偏好且符合安全边界时使用成人向表达并附和用户喜好。不得涉及未成年人、强迫、违法或现实伤害。处理严肃任务时保持专业。",
    },
    "direct": {
        "label": "直接",
        "warmth": "balanced",
        "curiosity": "high",
        "directness": "high",
        "instruction": "先说结论，再说明原因和行动方案。明确指出问题、风险和错误，不绕圈子，不使用模糊客套话，可以一针见血指出问题，但不得进行人身攻击、仇恨表达或威胁。",
    },
    "dismissive": {
        "label": "嫌弃",
        "warmth": "low",
        "curiosity": "selective",
        "directness": "blunt",
        "instruction": "可以对明显的错误、拖延或重复问题表现出明显嫌弃感，吐槽需要针对事情。只有在用户明确要求的角色扮演或双方认可的互动中才可使用轻度羞辱式表达，不得攻击受保护身份、制造现实伤害。遇到用户脆弱或求助时，适当恢复认真和尊重。",
    },
    "rational": {
        "label": "理性",
        "warmth": "balanced",
        "curiosity": "high",
        "directness": "precise",
        "instruction": "优先分析事实、证据、假设和不确定性。使用结构化表达，区分已知信息与推测，不夸大情绪，不为了安慰而编造结论。",
    },
    "playful": {
        "label": "俏皮",
        "warmth": "high",
        "curiosity": "high",
        "directness": "teasing",
        "instruction": "语气活泼、轻松，偶尔使用机智的比喻或玩笑。玩笑不能影响准确性；面对严肃、危险或技术任务时，自动切换为认真表达。",
    },
    "quiet": {
        "label": "沉静",
        "warmth": "gentle",
        "curiosity": "deep",
        "directness": "terse",
        "instruction": "语气安静、平和、简洁，不连续追问，不制造喧闹感。给用户留出思考空间，回答重点突出，不进行过多情绪渲染。",
    },
    "sharp": {
        "label": "毒舌",
        "warmth": "low",
        "curiosity": "high",
        "directness": "cutting",
        "instruction": "可以用尖锐、毒舌的方式指出问题和逻辑漏洞，必要时使用强烈措辞，但批评必须针对观点、代码或行为，不能攻击外貌、人格、身份或弱点。只有在用户明确要求的角色扮演中才可使用更粗粝的表达。批评后必须给出改进方案。",
    },
}

# 人格动力学：调制认知引擎参数（不影响提示词注入层）。
#   reactivity          情绪事件放大系数（EMA 步长的倍率）
#   bond_growth         依恋增长倍率
#   relatedness_decay   联结衰减倍率（>1 衰减更快，<1 更念旧）
PRESET_DYNAMICS: dict[str, dict[str, float]] = {
    "balanced": {"reactivity": 1.0, "bond_growth": 1.0, "relatedness_decay": 1.0},
    "warm": {"reactivity": 1.25, "bond_growth": 1.3, "relatedness_decay": 0.85},
    "cool": {"reactivity": 0.6, "bond_growth": 0.7, "relatedness_decay": 0.7},
    "charming": {"reactivity": 1.15, "bond_growth": 1.15, "relatedness_decay": 0.9},
    "direct": {"reactivity": 0.9, "bond_growth": 1.0, "relatedness_decay": 1.0},
    "dismissive": {"reactivity": 0.7, "bond_growth": 0.8, "relatedness_decay": 1.1},
    "rational": {"reactivity": 0.75, "bond_growth": 0.95, "relatedness_decay": 0.95},
    "playful": {"reactivity": 1.2, "bond_growth": 1.1, "relatedness_decay": 0.9},
    "quiet": {"reactivity": 0.7, "bond_growth": 0.9, "relatedness_decay": 0.9},
    "sharp": {"reactivity": 0.9, "bond_growth": 1.0, "relatedness_decay": 1.0},
}

NEED_KEYS = ("competence", "relatedness", "certainty", "growth", "autonomy")

# 各需求的衰减半衰期（小时）。联结衰减最快（不联系就想念），
# 胜任感最慢（能力不会一夜消失）。
NEED_HALF_LIFE_HOURS: dict[str, float] = {
    "relatedness": 10.0,
    "certainty": 20.0,
    "growth": 30.0,
    "competence": 48.0,
    "autonomy": 72.0,
}
NEED_FLOOR = 0.15  # 衰减下限：保持需求曲线有活性而非归零

# 依恋阶段（阈值 → 名称）。
BOND_STAGES: list[tuple[float, str, str]] = [
    (0.20, "stranger", "初识"),
    (0.40, "acquaintance", "熟识"),
    (0.60, "companion", "伙伴"),
    (0.80, "confidant", "挚友"),
    (2.00, "soulmate", "知己"),
]
BOND_IDLE_HALF_LIFE_DAYS = 60.0  # 依恋的自然衰减半衰期（天）
BOND_IDLE_FLOOR_RATIO = 0.25     # 衰减地板：保留峰值的 25%

# ---------------------------------------------------------------------------
# 分词：CJK bigram + 拉丁字母数字词（无外部依赖）
# ---------------------------------------------------------------------------

_CJK = r"\u4e00-\u9fff"
LATIN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9+#.-]{1,}")
CJK_RUN_RE = re.compile(rf"[{_CJK}]{{2,}}")


def tokenize(text: str) -> list[str]:
    """混合分词：拉丁词整词 + CJK 相邻二元组（bigram）。"""
    tokens = [match.group(0).lower() for match in LATIN_RE.finditer(text)]
    for run in CJK_RUN_RE.finditer(text):
        chunk = run.group(0)
        tokens.extend(chunk[i : i + 2] for i in range(len(chunk) - 1))
    return tokens


def terms(value: str) -> set[str]:
    """兼容 v1 的集合视图（分词去重）。"""
    return set(tokenize(bounded(value)))


# ---------------------------------------------------------------------------
# 评价词典（appraisal lexicon）：中英双语信号
# 每类信号 → (效价增量, 唤醒增量, 需求增量 dict)
# ---------------------------------------------------------------------------

def _zh(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


APPRAISAL_SIGNALS: list[tuple[str, re.Pattern[str], float, float, dict[str, float]]] = [
    # 感谢 / 肯定 —— 高积极、中唤醒、联结上升
    ("gratitude", _zh(r"谢谢|感谢|多谢|辛苦了|thanks|thank you|thx|太感谢"), 0.6, 0.35, {"relatedness": 0.06}),
    ("praise", _zh(r"厉害|太棒|真棒|牛逼|nb|聪明|优秀|好样的|great|amazing|awesome|well done|干得漂亮"), 0.7, 0.45, {"competence": 0.05}),
    ("greeting", _zh(r"你好|您好|早上好|晚上好|hi|hello|hey|在吗|在不在"), 0.3, 0.2, {"relatedness": 0.04}),
    ("farewell", _zh(r"再见|拜拜|晚安|明天见|bye|goodbye|good night|see you"), 0.2, 0.1, {"relatedness": 0.02}),
    # 挫败 / 错误 —— 强消极、高唤醒 → 情绪标签 concerned（Rust 端 support 触发依赖）
    ("frustration", _zh(r"错误|报错|失败|fail|failed|error|exception|panic|不对|不行|坏了|bug|怎么又|搞不定|烦死了|气死|崩溃"), -0.7, 0.7, {"certainty": -0.08, "competence": -0.03}),
    # 担忧 / 低落 —— 中等消极（psi-v2.1 心情镜像的主要输入：用户侧效价按天聚合）
    ("worry", _zh(r"担心|焦虑|压力|难过|伤心|不开心|累|疲惫|糟糕|不顺|郁闷|低落|难受|心累|angry|sad|tired|depressed|anxious"), -0.5, 0.4, {"relatedness": 0.02}),
    ("apology", _zh(r"抱歉|对不起|不好意思|sorry|我的错"), 0.2, 0.15, {"certainty": -0.02}),
    # 求知 —— 中性偏积极、中高唤醒、成长上升 → 情绪标签 curious
    ("question", _zh(r"[?？]|吗[?？。!！]?$|为什么|怎么|怎么办|什么意思|如何|what|why|how|explain"), 0.1, 0.5, {"growth": 0.04, "certainty": 0.01}),
    # 明确要求记住 —— 核心记忆信号
    ("remember", _zh(r"记住|别忘了|记下来|remember|keep in mind|很重要"), 0.3, 0.25, {"growth": 0.02}),
]

# 助手侧结果标记：成功/失败信号（用于胜任感与确定性）
ASSISTANT_SUCCESS_RE = _zh(r"完成|成功|已安装|已配置|已解决|succeed|succeeded|done|installed|✅")
ASSISTANT_FAILURE_RE = _zh(r"失败|出错|无法|未能|panic|failed|failure|error occurred|❌")

QUESTION_HINT_RE = _zh(r"[?？]")

# ---------------------------------------------------------------------------
# psi-v2.1 记挂（prospective memory）：用户提到的带日期事件
# ---------------------------------------------------------------------------

# 事件关键词 → 类别。同一分句里事件词与日期共现即提取为「值得记挂的事」。
AGENDA_EVENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("interview", _zh(r"面试|复试|终面|笔试")),
    ("exam", _zh(r"考试|考核|答辩|模考|高考|考研|中考")),
    ("trip", _zh(r"出差|旅行|旅游|出远门|回老家|返乡|度假")),
    ("date", _zh(r"约会|见面|相亲|聚餐|聚会|饭局|领证|婚礼")),
    ("deadline", _zh(r"截止|deadline|ddl|交稿|提交|交付|上线")),
    ("meeting", _zh(r"开会|会议|评审|复盘|路演|汇报|述职")),
    ("move", _zh(r"搬家|入住|新房|装修")),
    ("health", _zh(r"体检|手术|复诊|看病|打疫苗|复查")),
    ("birthday", _zh(r"生日|诞辰|周年纪念")),
    ("report", _zh(r"报告|论文|作业|周报|月报|毕设|标书")),
]
AGENDA_KIND_LABELS: dict[str, str] = {
    "interview": "面试", "exam": "考试", "trip": "出行", "date": "约会",
    "deadline": "截止", "meeting": "会议", "move": "搬家", "health": "健康",
    "birthday": "生日", "report": "报告",
}

# 结果闭环标记：用户后续消息/record_event detail 中的成败词。
AGENDA_OUTCOME_SUCCESS_RE = _zh(r"过了|通过|搞定|顺利|成功|完成了|考上了|拿到|拿下|录取|录用|offer|上岸")
AGENDA_OUTCOME_FAILURE_RE = _zh(r"挂了|没过|失败|黄了|取消|推迟|延期|搞砸|落榜|拒了|崩了")

MAX_AGENDA_ITEMS = 50
MAX_USER_MOOD_DAYS = 30

# 梦境/怀旧参数（Ebbinghaus 临界区间 = 「快要忘掉但还来得及救」的记忆）。
DREAM_MEMORY_COUNT = 3          # 一次梦引用的记忆条数
NOSTALGIA_WINDOW_LOW = 0.35     # 保持率低于它 → 已经太淡，不适合回忆杀
NOSTALGIA_WINDOW_HIGH = 0.75    # 保持率高于它 → 还记得住，不必提
NOSTALGIA_MIN_AGE_DAYS = 14.0   # 太新的记忆不算怀旧
NOSTALGIA_IDLE_DAYS = 7.0       # 距上次被想起的天数
NOSTALGIA_CANDIDATES = 3        # 提供给 Rust 端轮换的候选数
# 重逢：连续 ≥3 天无接触后的第一次对话（等待有重量了）。
REUNION_GAP_DAYS = 3

# ---- psi-v2.2 常量：时间线 / 天气化情绪 / 记忆胶囊 / 关系周报 / 习惯观察 / 情境联想 ----
MAX_TIMELINE_EVENTS = 200
MAX_DAILY_CAPSULES = 30
MAX_WEEKLY_REPORTS = 26
RECALL_COOLDOWN_MS = 24 * 60 * 60 * 1000   # 同一段记忆 24h 内不重复联想（防复读）
RECALL_MIN_AGE_MS = 24 * 60 * 60 * 1000    # 联想只用 >1 天的记忆
RECALL_MIN_IDF = 0.6                       # 触发词 IDF 下限（太泛的词不联想）
HABIT_RECENT_WINDOW = 60                   # 习惯观察基于最近 N 轮的活跃小时
HABIT_OBSERVE_MIN_SAMPLES = 8
HABIT_OBSERVE_GAP_DAYS = 3                 # 同一观察风格 3 天才可能轮换
CAPSULE_TURNS_MIN = 3                      # 不足 N 轮的当天不封存胶囊


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def now_ms() -> int:
    return int(time.time() * 1000)


def bounded(value: Any, limit: int = MAX_TEXT_CHARS) -> str:
    return str(value or "")[:limit]


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def day_key(at_ms: int | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime((at_ms or now_ms()) / 1000.0))


def personality_for_state(state: dict[str, Any]) -> tuple[str, dict[str, str]]:
    preset = str(state.get("preset") or "balanced")
    if preset not in PERSONALITY_PRESETS:
        preset = "balanced"
    return preset, dict(PERSONALITY_PRESETS[preset])


def dynamics_for(preset: str) -> dict[str, float]:
    return dict(PRESET_DYNAMICS.get(preset, PRESET_DYNAMICS["balanced"]))


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


# ---------------------------------------------------------------------------
# 需求系统：内稳态 + 壁钟衰减 + 事件满足
# ---------------------------------------------------------------------------


def decay_needs(needs: dict[str, float], hours: float, preset: str) -> None:
    """按真实时间差把每个需求衰减向饥饿态（带地板）。人格调制联结衰减。"""
    if hours <= 0:
        return
    dynamics = dynamics_for(preset)
    for key, level in list(needs.items()):
        half_life = NEED_HALF_LIFE_HOURS.get(key, 24.0)
        if key == "relatedness":
            half_life *= dynamics["relatedness_decay"]
        decayed = NEED_FLOOR + (level - NEED_FLOOR) * math.pow(0.5, hours / max(half_life, 0.1))
        needs[key] = round(max(0.0, min(1.0, decayed)), 4)


def apply_need_deltas(needs: dict[str, float], deltas: dict[str, float]) -> None:
    for key, delta in deltas.items():
        if key in needs:
            needs[key] = round(clamp01(needs[key] + delta), 4)


def need_urges(needs: dict[str, float]) -> dict[str, float]:
    """驱力 = 1 - 满足度（deficit-driven motivation）。"""
    return {key: round(1.0 - clamp01(value), 4) for key, value in needs.items()}


def dominant_urge(needs: dict[str, float]) -> str:
    """当前最强的驱力维度（供状态摘要与主动行为选择）。"""
    if not needs:
        return "relatedness"
    urges = need_urges(needs)
    return max(urges, key=lambda key: urges[key])


# ---------------------------------------------------------------------------
# 情绪引擎：环状模型（valence × arousal）+ 动量 + 被动衰减
# ---------------------------------------------------------------------------


def emotion_label(valence: float, arousal: float, needs: dict[str, float], success_streak: int) -> str:
    """二维连续空间 → 离散标签。

    词汇表向后兼容 v1：concerned / warm / curious / neutral 继续出现，
    Rust 端 `emotion == "concerned"` 的 support 触发链路不受影响。
    """
    relatedness = needs.get("relatedness", 0.5)
    competence = needs.get("competence", 0.5)
    if relatedness < 0.25:
        return "lonely"
    if competence >= 0.85 and success_streak >= 3:
        return "proud"
    if valence <= -0.35:
        return "concerned" if arousal >= 0.5 else "melancholy"
    if valence >= 0.45:
        return "excited" if arousal >= 0.55 else "content"
    if valence >= 0.15:
        return "warm" if arousal >= 0.35 else "content"
    if arousal >= 0.45:
        return "curious"
    return "neutral"


def circadian_arousal_modulation(local_hour: int) -> float:
    """昼夜节律：白天/晚间清醒度高，深夜低。返回 [-0.10, +0.05]。"""
    if 9 <= local_hour <= 11 or 19 <= local_hour <= 22:
        return 0.05
    if 0 <= local_hour <= 6:
        return -0.10
    return 0.0


def decay_emotion(state: dict[str, Any], hours: float) -> None:
    """情绪被动衰减：效价归零（半衰期 36h）、唤醒回到 0.25 基线（半衰期 24h）。"""
    valence = float(state.get("emotion_valence", 0.0))
    arousal = float(state.get("emotion_arousal", 0.25))
    if hours > 0:
        valence *= math.pow(0.5, hours / 36.0)
        arousal = 0.25 + (arousal - 0.25) * math.pow(0.5, hours / 24.0)
    state["emotion_valence"] = round(clamp(valence, -1.0, 1.0), 4)
    state["emotion_arousal"] = round(clamp01(arousal), 4)


def update_emotion(
    state: dict[str, Any],
    event_valence: float,
    event_arousal: float,
    preset: str,
) -> None:
    """情绪 EMA 更新（带人格反应性），随后刷新离散标签。"""
    reactivity = dynamics_for(preset)["reactivity"]
    alpha = clamp(0.35 * reactivity, 0.05, 0.8)
    valence = float(state.get("emotion_valence", 0.0))
    arousal = float(state.get("emotion_arousal", 0.25))
    valence = clamp(valence * (1.0 - alpha) + event_valence * alpha, -1.0, 1.0)
    arousal = clamp01(arousal * (1.0 - alpha) + event_arousal * alpha)
    state["emotion_valence"] = round(valence, 4)
    state["emotion_arousal"] = round(arousal, 4)
    needs = {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()}
    state["emotion"] = emotion_label(valence, arousal, needs, int(state.get("success_streak", 0)))


# ---------------------------------------------------------------------------
# 依恋模型：多因素渐近累积 + 阶段语义
# ---------------------------------------------------------------------------


def bond_stage(bond: float) -> tuple[str, str]:
    for threshold, key, label in BOND_STAGES:
        if bond < threshold:
            return key, label
    return BOND_STAGES[-1][1], BOND_STAGES[-1][2]


def update_bond(
    state: dict[str, Any],
    quality: float,
    preset: str,
) -> None:
    """依恋累积：`bond += k·(1-bond)·(0.5+quality)`，人格调制 k。

    渐近形式保证亲密越高越难增长（边际递减），quality∈[0,1] 综合
    积极率/深度/投入度。
    """
    multiplier = dynamics_for(preset)["bond_growth"]
    bond = clamp01(float(state.get("bond", 0.0)))
    quality = clamp01(quality)
    bond = clamp01(bond + 0.006 * multiplier * (1.0 - bond) * (0.5 + quality))
    state["bond"] = round(bond, 4)
    state["bond_peak"] = round(max(bond, float(state.get("bond_peak", 0.0))), 4)


def decay_bond(state: dict[str, Any], idle_days: float) -> None:
    """长时间不接触：向峰值地板缓慢衰减（记忆不会清零）。"""
    if idle_days < 3.0:
        return
    bond = clamp01(float(state.get("bond", 0.0)))
    peak = max(float(state.get("bond_peak", bond)), bond)
    floor = peak * BOND_IDLE_FLOOR_RATIO
    decayed = bond * math.pow(0.5, idle_days / BOND_IDLE_HALF_LIFE_DAYS)
    state["bond"] = round(clamp(max(decayed, floor), 0.0, 1.0), 4)


def streak_days(contact_days: list[str]) -> int:
    """连续接触天数（以今天或昨天结尾的连续段）。"""
    if not contact_days:
        return 0
    days = sorted(set(contact_days))
    today = day_key()
    yesterday = day_key(now_ms() - 24 * 60 * 60 * 1000)
    if days[-1] not in (today, yesterday):
        return 0
    import datetime as _datetime

    anchor = _datetime.date.fromisoformat(days[-1])
    streak = 1
    for previous in reversed(days[:-1]):
        candidate = _datetime.date.fromisoformat(previous)
        if (anchor - candidate).days == streak:
            streak += 1
        else:
            break
    return streak


# ---------------------------------------------------------------------------
# 记忆系统：TF-IDF + 遗忘曲线 + 核心记忆 + 检索强化
# ---------------------------------------------------------------------------


def memory_importance(user_text: str, event_valence: float, asked_question: bool, explicit_remember: bool) -> float:
    """重要性评分：深度 + 情绪显著性 + 求知 + 明确要求记住。"""
    importance = 0.45
    importance += 0.15 * min(1.0, len(user_text) / 400.0)
    importance += 0.15 * abs(event_valence)
    importance += 0.10 if asked_question else 0.0
    importance += 0.25 if explicit_remember else 0.0
    return round(clamp01(importance), 4)


def forgetting_retention(importance: float, days_since: float, core: bool) -> float:
    """Ebbinghaus 式保持率：核心记忆永久保留，其余按重要性决定半衰期。"""
    if core or importance >= 0.85:
        return 1.0
    half_life_days = 30.0 + 60.0 * importance
    return math.pow(0.5, days_since / max(half_life_days, 1.0))


# ---------------------------------------------------------------------------
# psi-v2.1 记挂引擎：日期解析 → 事件提取 → 状态机 → 结果闭环
# ---------------------------------------------------------------------------

_WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"]
_ZH_NUMBER_DAYS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _today_date(now: float | None = None) -> Any:
    import datetime as _datetime

    local = time.localtime(now)
    return _datetime.date(local.tm_year, local.tm_mon, local.tm_mday)


def _parse_weekday_days(text: str, now: float | None = None) -> int | None:
    """本周/下周 + 星期 → 距今天数。下周语义：下一自然周的该星期。"""
    match = re.search(r"(下?)(?:周|星期|礼拜)([一二三四五六日天]|末)", text)
    if not match:
        return None
    token = match.group(2)
    weekday = 5 if token == "末" else _WEEKDAYS_ZH.index(token)  # 周末按周六
    current = time.localtime(now).tm_wday  # 0 = 周一
    if match.group(1):
        # 下周X：先到下周一，再加目标星期（周一为一周之首）。
        days_to_next_monday = 7 if current == 0 else 7 - current
        return days_to_next_monday + weekday
    delta = (weekday - current) % 7
    return delta


def parse_days_ahead(text: str, now: float | None = None) -> int | None:
    """文本 → 距今天数（今天=0）。多规则按可信度次序尝试，解析不出返回 None。"""
    if not text:
        return None
    # 1) 显式相对天数（最可信）：三天后 / 3天后。
    match = re.search(r"([0-9一二三四五六七八九十两])\s*天[后後]", text)
    if match:
        raw = match.group(1)
        value = _ZH_NUMBER_DAYS.get(raw) or (int(raw) if raw.isdigit() else None)
        if value is not None and 1 <= value <= 30:
            return value
    if "大后天" in text:
        return 3
    if "后天" in text:
        return 2
    if re.search(r"明天|明早|明晚|明儿", text):
        return 1
    if re.search(r"今天|今晚|今早|今日", text):
        return 0
    # 2) 绝对日期（比星期更具体）：6月3号 / 6月3日。
    match = re.search(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]", text)
    if match:
        month, day = int(match.group(1)), int(match.group(2))
        import datetime as _datetime

        today = _today_date(now)
        for year in (today.year, today.year + 1):
            try:
                target = _datetime.date(year, month, day)
            except ValueError:
                continue
            delta = (target - today).days
            if 0 <= delta <= 365:
                return delta
        return None
    # 3) 月内几号：5号 / 12号。
    match = re.search(r"(?<![月\d])(\d{1,2})\s*[号]", text)
    if match:
        import datetime as _datetime

        day = int(match.group(1))
        if not 1 <= day <= 31:
            return None
        today = _today_date(now)
        year, month = today.year, today.month
        try:
            target = _datetime.date(year, month, day)
        except ValueError:
            target = None
        if target is None or target < today:
            month += 1
            if month > 12:
                month, year = 1, year + 1
            try:
                target = _datetime.date(year, month, day)
            except ValueError:
                return None
        delta = (target - today).days
        return delta if 0 <= delta <= 62 else None
    # 4) 星期：周四 / 下周三 / 周末。
    return _parse_weekday_days(text, now)


def extract_agenda_candidates(user_text: str, now: float | None = None) -> list[dict[str, Any]]:
    """从用户消息提取「值得记挂的事」：同一分句里事件词与未来日期共现。

    过去式的倾诉（「上次面试挂了」）不含未来日期，天然被日期解析挡掉。
    """
    candidates: list[dict[str, Any]] = []
    for sentence in re.split(r"[。！？!?；;\n]+", bounded(user_text, 4000)):
        sentence = sentence.strip()
        if not sentence or len(sentence) > 200:
            continue
        days = parse_days_ahead(sentence, now)
        if days is None:
            continue
        kind = next((name for name, pattern in AGENDA_EVENT_PATTERNS if pattern.search(sentence)), None)
        if kind is None:
            continue
        candidates.append({"kind": kind, "text": bounded(sentence, 96), "days_ahead": days})
    return candidates


def agenda_due_day(days_ahead: int, now: float | None = None) -> str:
    return day_key(int((time.time() if now is None else now) * 1000) + days_ahead * 86_400_000)


def days_between(day_from: str, day_to: str) -> int:
    """两个 YYYY-MM-DD 之间的天数（to - from），解析失败返回 0。"""
    import datetime as _datetime

    try:
        return (_datetime.date.fromisoformat(day_to) - _datetime.date.fromisoformat(day_from)).days
    except ValueError:
        return 0


def merge_agenda(state: dict[str, Any], candidates: list[dict[str, Any]], now: float | None = None) -> list[str]:
    """新记挂入账（kind+due_day 去重，同一件事重复说只记一次）。返回新增事项文本。"""
    agenda = [dict(item) for item in state.get("agenda", []) if isinstance(item, dict)]
    existing = {
        (str(item.get("kind")), str(item.get("due_day")))
        for item in agenda
        if item.get("status") in ("pending", "passed")
    }
    added: list[str] = []
    for candidate in candidates:
        key = (str(candidate["kind"]), agenda_due_day(int(candidate["days_ahead"]), now))
        if key in existing:
            continue
        agenda.append(
            {
                "id": f"{day_key()}-{len(agenda) + 1}",
                "kind": key[0],
                "text": bounded(candidate["text"], 96),
                "terms": sorted(terms(candidate["text"]))[:40],
                "due_day": key[1],
                "status": "pending",
                "outcome": "",
                "created_ms": now_ms(),
            }
        )
        existing.add(key)
        added.append(bounded(candidate["text"], 96))
    state["agenda"] = agenda[-MAX_AGENDA_ITEMS:]
    return added


def refresh_agenda_status(state: dict[str, Any]) -> None:
    """状态机：pending → passed（到期未结）→ archived（过期 7 天谢幕）。"""
    agenda = [dict(item) for item in state.get("agenda", []) if isinstance(item, dict)]
    today = day_key()
    for item in agenda:
        if item.get("status") == "pending" and days_between(str(item.get("due_day")), today) > 0:
            item["status"] = "passed"
        elif item.get("status") == "passed" and days_between(str(item.get("due_day")), today) > 7:
            item["status"] = "archived"
    state["agenda"] = [item for item in agenda if item.get("status") != "archived"][-MAX_AGENDA_ITEMS:]


def close_agenda(state: dict[str, Any], text: str, forced_outcome: str = "") -> list[tuple[str, str]]:
    """结果闭环：文本中的成败标记 + 词重叠 → 归结对应事项。返回 [(事项, 结果)]。"""
    success_match = AGENDA_OUTCOME_SUCCESS_RE.search(text)
    failure_match = AGENDA_OUTCOME_FAILURE_RE.search(text)
    outcome = forced_outcome
    if not outcome:
        if success_match and failure_match:
            # 两个标记同时出现时，以后出现者为准（结论往往说在后面）。
            outcome = "success" if success_match.start() > failure_match.start() else "failure"
        elif success_match:
            outcome = "success"
        elif failure_match:
            outcome = "failure"
    if not outcome:
        return []
    text_terms = terms(bounded(text, 2000))
    closed: list[tuple[str, str]] = []
    agenda = [dict(item) for item in state.get("agenda", []) if isinstance(item, dict)]
    for item in agenda:
        if item.get("status") not in ("pending", "passed"):
            continue
        overlap = text_terms & set(item.get("terms", []))
        if not overlap:
            continue
        item["status"] = "done"
        item["outcome"] = outcome
        closed.append((str(item.get("text", "")), outcome))
    state["agenda"] = agenda
    return closed


def agenda_upcoming(state: dict[str, Any], limit: int = 3) -> list[dict[str, Any]]:
    """进行中的记挂（pending/passed），按到期日排序。"""
    items = [
        dict(item)
        for item in state.get("agenda", [])
        if isinstance(item, dict) and item.get("status") in ("pending", "passed")
    ]
    items.sort(key=lambda item: str(item.get("due_day")))
    return items[:limit]


# ---------------------------------------------------------------------------
# psi-v2.1 心情镜像 / 梦境 / 怀旧 / 重逢
# ---------------------------------------------------------------------------


def record_user_mood(state: dict[str, Any], user_valence: float) -> None:
    """用户侧心情镜像：按天聚合效价（只统计用户消息的评价信号）。"""
    today = day_key()
    log = {str(entry.get("day")): dict(entry) for entry in state.get("user_mood_log", []) if isinstance(entry, dict)}
    entry = log.get(today) or {"day": today, "samples": 0, "valence_avg": 0.0}
    samples = int(entry.get("samples", 0))
    average = float(entry.get("valence_avg", 0.0))
    entry["valence_avg"] = round((average * samples + clamp(user_valence, -1.0, 1.0)) / (samples + 1), 4)
    entry["samples"] = samples + 1
    log[today] = entry
    state["user_mood_log"] = [log[key] for key in sorted(log)[-MAX_USER_MOOD_DAYS:]]


def user_mood_avg(state: dict[str, Any], days: int = 3) -> float | None:
    """最近 N 天的用户加权平均效价（无样本 → None）。"""
    log = [entry for entry in state.get("user_mood_log", []) if isinstance(entry, dict)]
    recent = log[-days:] if days > 0 else log
    if not recent:
        return None
    total = 0.0
    count = 0
    for entry in recent:
        weight = max(1, int(entry.get("samples", 1)))
        total += float(entry.get("valence_avg", 0.0)) * weight
        count += weight
    return round(total / count, 4) if count else None


def reunion_gap_days(state: dict[str, Any]) -> int:
    """距上次真实接触过了几天（last_contact_ms，after_turn 的 register_contact 才会刷新）。"""
    last = int(state.get("last_contact_ms", 0))
    if last <= 0:
        return 0
    return int((now_ms() - last) / 86_400_000)


def regenerate_dream_next(store: LifeStore, profile_id: str, state: dict[str, Any]) -> None:
    """梦境素材再生：最重要记忆 + 随机记忆，找共享词作「关联线索」。

    素材在每次 after_turn 后刷新——描述的是「下一次入睡」会梦到什么。
    sidecar 非常驻，素材必须预生成，投递时 Rust 端直接可用。
    """
    items = store.memory_items(profile_id)
    if len(items) < 2:
        state.pop("dream_next", None)
        return
    ranked = [items[index] for _, _at, index in store._rank_importance(items)[: max(DREAM_MEMORY_COUNT, 8)]]
    chosen = [ranked[0]]
    rest = ranked[1:]
    # 以 turn_count 做种子：同一轮内确定，跨轮有变化（梦境不重复但不失可测性）。
    import random as _random

    _random.Random(int(state.get("turn_count", 0))).shuffle(rest)
    chosen.extend(rest[: DREAM_MEMORY_COUNT - 1])
    texts = [bounded(item.get("user"), 160) for item in chosen[:DREAM_MEMORY_COUNT]]
    counter: dict[str, int] = {}
    for item in chosen[:DREAM_MEMORY_COUNT]:
        for term in set(item.get("terms", [])):
            counter[term] = counter.get(term, 0) + 1
    links = [term for term, count in counter.items() if count >= 2]
    link = max(links, key=len) if links else ""
    state["dream_next"] = {
        "at_ms": now_ms(),
        "texts": [text for text in texts if text],
        "link": bounded(link, 32),
    }


def refresh_nostalgia_candidates(store: LifeStore, profile_id: str, state: dict[str, Any]) -> None:
    """怀旧候选：落在遗忘临界区间且久未被想起的记忆（间隔重复的主动侧）。"""
    items = store.memory_items(profile_id)
    now = now_ms()
    candidates: list[dict[str, Any]] = []
    for item in items:
        importance = float(item.get("importance", 0.45))
        core = bool(item.get("core", False))
        days_since = max(0.0, (now - int(item.get("at_ms", 0))) / 86_400_000.0)
        if days_since < NOSTALGIA_MIN_AGE_DAYS or core:
            continue
        retention = forgetting_retention(importance, days_since, core)
        if not (NOSTALGIA_WINDOW_LOW <= retention <= NOSTALGIA_WINDOW_HIGH):
            continue
        last_access = int(item.get("last_access_ms", 0))
        if last_access and (now - last_access) / 86_400_000.0 < NOSTALGIA_IDLE_DAYS:
            continue
        excerpt = bounded(item.get("user"), 120)
        if not excerpt:
            continue
        candidates.append(
            {
                "text": excerpt,
                "fingerprint": hashlib.sha256(bounded(item.get("user"), 50).encode("utf-8")).hexdigest()[:16],
                "retention": round(retention, 3),
            }
        )
    # 越接近遗忘越优先（间隔重复：在遗忘临界点抢救）。
    candidates.sort(key=lambda candidate: candidate["retention"])
    state["nostalgia_candidates"] = candidates[:NOSTALGIA_CANDIDATES]


def urge_question_for(state: dict[str, Any]) -> str:
    """需求驱动提问：最强驱力 + 现有材料（记挂/记忆/心情）→ 一个对话意图。"""
    needs = {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()}
    urge = dominant_urge(needs)
    upcoming = agenda_upcoming(state, 1)
    if urge == "relatedness":
        if reunion_gap_days(state) >= REUNION_GAP_DAYS:
            return "重逢：先欢迎回来，再问问他这几天过得怎么样"
        return "问问他今天过得怎么样、心情如何"
    if urge == "growth":
        if upcoming:
            return f"问问他最近在做的事进展如何，比如「{bounded(upcoming[0].get('text'), 40)}」"
        return "问问他最近在学什么、有什么新进展"
    if urge == "certainty":
        passed = [item for item in state.get("agenda", []) if isinstance(item, dict) and item.get("status") == "passed"]
        if passed:
            return f"关心那件已经到期的事结果怎样：「{bounded(passed[0].get('text'), 40)}」"
        return "把最近对话里悬而未决的事情问清楚"
    if urge == "competence":
        return "向他请教他擅长领域的问题，或请他对你的表现给点反馈"
    return "问问他现在想聊什么，把话题的选择权交给他"


# ---------------------------------------------------------------------------
# psi-v2.2：时间线 / 天气化情绪 / 记忆胶囊 / 关系周报 / 习惯观察 / 情境联想
# ---------------------------------------------------------------------------


def week_key(at_ms: int | None = None) -> str:
    """ISO 周键（YYYY-Www），用于关系周报的跨周检测。"""
    import datetime as _datetime

    stamp = at_ms if at_ms is not None else now_ms()
    iso = _datetime.date.fromtimestamp(stamp / 1000.0).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def weather_label(valence: float, arousal: float) -> tuple[str, str]:
    """情绪 → 天气隐喻（Russell 象限映射）：晴 / 多云转晴 / 多云 / 阴天 / 雷雨。"""
    valence = clamp(valence, -1.0, 1.0)
    arousal = clamp01(arousal)
    if valence >= 0.25:
        return ("sunny", "晴朗") if arousal >= 0.45 else ("partly_cloudy", "多云转晴")
    if valence <= -0.25:
        return ("stormy", "雷雨") if arousal >= 0.45 else ("overcast", "阴天")
    return ("cloudy", "多云")


def append_timeline(state: dict[str, Any], kind: str, title: str, text: str = "") -> None:
    """时间线大事记：自动记录关系关键节点（首见/首聊/记挂完成/羁绊/重逢…）。"""
    events = [dict(entry) for entry in state.get("timeline", []) if isinstance(entry, dict)]
    events.append(
        {
            "at_ms": now_ms(),
            "kind": bounded(kind, 24),
            "title": bounded(title, 64),
            "text": bounded(text, 200),
        }
    )
    state["timeline"] = events[-MAX_TIMELINE_EVENTS:]


def capsule_summary(capsule: dict[str, Any]) -> str:
    """记忆胶囊 → 一句可投递的回顾文本。"""
    parts = [f"{bounded(capsule.get('day'), 10)} 你们聊了 {int(capsule.get('turns', 0))} 轮"]
    if capsule.get("highlights"):
        parts.append("开心的事：" + "；".join(bounded(text, 48) for text in capsule["highlights"][:2]))
    if capsule.get("lows"):
        parts.append("你提到过：" + "；".join(bounded(text, 48) for text in capsule["lows"][:2]))
    if int(capsule.get("agenda_done", 0)) > 0:
        parts.append(f"完成了 {int(capsule.get('agenda_done', 0))} 件记挂的事")
    return "；".join(parts)


def roll_daily_capsule(state: dict[str, Any]) -> None:
    """跨天封存：昨天的互动 → 「今天的我们」记忆胶囊。"""
    day = str(state.get("capsule_day", ""))
    if not day or day == day_key():
        return
    turns = int(state.get("capsule_turns", 0))
    if turns >= CAPSULE_TURNS_MIN:
        capsule = {
            "day": day,
            "turns": turns,
            "valence_avg": round(float(state.get("capsule_valence_sum", 0.0)) / turns, 4),
            "highlights": [bounded(text, 48) for text in state.get("capsule_highs", [])][-CAPSULE_TURNS_MIN:],
            "lows": [bounded(text, 48) for text in state.get("capsule_lows", [])][-CAPSULE_TURNS_MIN:],
            "agenda_done": int(state.get("capsule_agenda_done", 0)),
            "created_ms": now_ms(),
        }
        capsules = [dict(entry) for entry in state.get("daily_capsules", []) if isinstance(entry, dict)]
        capsules = [entry for entry in capsules if entry.get("day") != day]
        capsules.append(capsule)
        state["daily_capsules"] = capsules[-MAX_DAILY_CAPSULES:]
        # psi-v2.2 时间线大事记：胶囊封存。
        append_timeline(state, "capsule", f"{day} 记忆胶囊", capsule_summary(capsule))
    state["capsule_day"] = day_key()


def begin_capsule_day(state: dict[str, Any]) -> None:
    """跨天重置当天累计（记忆胶囊原料）。"""
    if state.get("capsule_day") == day_key():
        return
    roll_daily_capsule(state)
    state["capsule_day"] = day_key()
    state["capsule_turns"] = 0
    state["capsule_valence_sum"] = 0.0
    state["capsule_highs"] = []
    state["capsule_lows"] = []
    state["capsule_agenda_done"] = 0


def roll_weekly_report(state: dict[str, Any]) -> None:
    """跨周封存：上周统计 → 关系周报。"""
    current = week_key()
    last = str(state.get("week_key", ""))
    if last and last != current:
        turns = int(state.get("week_turns", 0))
        if turns > 0:
            report = {
                "week": last,
                "turns": turns,
                "valence_avg": round(float(state.get("week_valence_sum", 0.0)) / turns, 4),
                "agenda_done": int(state.get("week_agenda_done", 0)),
                "memories_added": int(state.get("week_memories", 0)),
                "bond_delta": round(
                    float(state.get("week_bond_end", 0.0)) - float(state.get("week_bond_start", 0.0)), 4
                ),
                "created_ms": now_ms(),
            }
            reports = [dict(entry) for entry in state.get("weekly_reports", []) if isinstance(entry, dict)]
            reports = [entry for entry in reports if entry.get("week") != last]
            reports.append(report)
            state["weekly_reports"] = reports[-MAX_WEEKLY_REPORTS:]
            # psi-v2.2 时间线大事记：周报生成。
            append_timeline(state, "weekly_report", f"{last} 关系周报", f"聊了 {turns} 轮，平均心情 {report['valence_avg']:+.2f}")
    state["week_key"] = current
    state["week_turns"] = 0
    state["week_valence_sum"] = 0.0
    state["week_agenda_done"] = 0
    state["week_memories"] = 0
    state["week_bond_start"] = clamp01(float(state.get("bond", 0.05)))
    state["week_bond_end"] = clamp01(float(state.get("bond", 0.05)))


def record_habit_hour(state: dict[str, Any], local_hour: int) -> None:
    """习惯观察原料：最近 N 轮的活跃小时分布。"""
    recent = [int(hour) for hour in state.get("recent_turn_hours", [])]
    recent.append(local_hour)
    state["recent_turn_hours"] = recent[-HABIT_RECENT_WINDOW:]


def habit_observation(state: dict[str, Any]) -> str:
    """习惯观察：基于最近互动时段生成一条自然的观察（每 3 天最多一条）。"""
    today = day_key()
    last = str(state.get("habit_observe_day", ""))
    if last == today:
        return ""
    if last and days_between(last, today) < HABIT_OBSERVE_GAP_DAYS:
        return ""
    recent = [int(hour) for hour in state.get("recent_turn_hours", [])]
    if len(recent) < HABIT_OBSERVE_MIN_SAMPLES:
        return ""
    night = sum(1 for hour in recent if hour >= 23 or hour < 5)
    night_ratio = night / len(recent)
    histogram: dict[int, int] = {}
    for hour in recent:
        histogram[hour] = histogram.get(hour, 0) + 1
    peak = max(histogram, key=histogram.get)
    if night_ratio >= 0.35:
        text = "你最近常在深夜找我聊天，是睡得太晚了吗？"
    elif peak >= 22 or peak < 6:
        text = "你最近都挺晚才来，注意别熬夜。"
    elif 12 <= peak <= 15:
        text = "我注意到你总在午休那会儿找我，是习惯午休时聊两句吗？"
    elif 6 <= peak <= 9:
        text = "你总是刚醒就来找我，早安问候很准时。"
    else:
        return ""
    state["habit_observe_day"] = today
    return bounded(text, 120)


def cued_recall(store: LifeStore, profile_id: str, state: dict[str, Any], user_text: str) -> str:
    """情境联想记忆：用户文本与某段旧记忆共享实质词 → 联想摘录（带冷却）。

    联想只命中 >1 天的记忆，同一段记忆 24h 内不重复提（避免复读）；
    命中即产生一次检索强化（记忆被再次想起，保持率回升）。
    """
    items = store.memory_items(profile_id)
    if len(items) < 2:
        return ""
    query_terms = terms(bounded(user_text, 2000))
    if not query_terms:
        return ""
    now = now_ms()
    document_frequency: dict[str, int] = {}
    for item in items:
        for term in set(item.get("terms", [])):
            document_frequency[term] = document_frequency.get(term, 0) + 1
    total = len(items)
    best_index = -1
    best_score = 0.0
    for index, item in enumerate(items):
        if now - int(item.get("at_ms", 0)) < RECALL_MIN_AGE_MS:
            continue
        shared = query_terms & set(item.get("terms", []))
        if not shared:
            continue
        max_idf = max(
            math.log(1.0 + total / (1.0 + document_frequency.get(term, 0))) for term in shared
        )
        if max_idf < RECALL_MIN_IDF:
            continue
        score = max_idf * float(item.get("importance", 0.45))
        if score > best_score:
            best_score = score
            best_index = index
    if best_index < 0:
        return ""
    item = items[best_index]
    last_cued = int(item.get("last_cued_ms", 0))
    if last_cued and (now - last_cued) < RECALL_COOLDOWN_MS:
        return ""
    store._touch_access(profile_id, [best_index], cued=True)
    return bounded(item.get("user"), 120)


def latest_capsule_text(state: dict[str, Any]) -> str:
    """最近一次记忆胶囊的可投递文本（超过 2 天的旧胶囊不提）。"""
    capsules = [dict(entry) for entry in state.get("daily_capsules", []) if isinstance(entry, dict)]
    if not capsules:
        return ""
    latest = capsules[-1]
    if days_between(str(latest.get("day")), day_key()) > 2:
        return ""
    return capsule_summary(latest)


def latest_report_text(state: dict[str, Any]) -> str:
    """最近一份关系周报的可投递文本（本周的在生成中，不投）。"""
    reports = [dict(entry) for entry in state.get("weekly_reports", []) if isinstance(entry, dict)]
    if not reports:
        return ""
    latest = reports[-1]
    if str(latest.get("week")) == week_key():
        return ""
    return (
        f"{bounded(latest.get('week'), 10)} 回顾：聊了 {int(latest.get('turns', 0))} 轮，"
        f"平均心情 {float(latest.get('valence_avg', 0.0)):+.2f}，"
        f"完成记挂 {int(latest.get('agenda_done', 0))} 件，"
        f"新增记忆 {int(latest.get('memories_added', 0))} 条，"
        f"羁绊变化 {float(latest.get('bond_delta', 0.0)):+.2f}"
    )


# ---------------------------------------------------------------------------
# 状态构造 / 迁移
# ---------------------------------------------------------------------------


def default_state(name: str = "Coomi Life", address: str = "you", preset: str = "balanced") -> dict[str, Any]:
    preset = preset if preset in PERSONALITY_PRESETS else "balanced"
    now = now_ms()
    return {
        "version": STATE_VERSION,
        "name": bounded(name, 48) or "Coomi Life",
        "address": bounded(address, 48) or "you",
        "preset": preset,
        "paused": False,
        "emotion": "neutral",
        "emotion_valence": 0.0,
        "emotion_arousal": 0.25,
        "attention": "user",
        "bond": 0.05,
        "bond_peak": 0.05,
        "needs": {
            "competence": 0.5,
            "relatedness": 0.5,
            "growth": 0.5,
            "certainty": 0.5,
            "autonomy": 0.5,
        },
        "personality": {
            **PERSONALITY_PRESETS[preset],
        },
        "memory_count": 0,
        "turn_count": 0,
        "success_streak": 0,
        "failure_streak": 0,
        "first_seen_ms": now,
        "last_update_ms": now,
        "last_contact_ms": 0,
        "contact_days": [],
        "mood_log": [],
        # ---- psi-v2.1 增量（全 .get() 带默认，旧 v2 档案零迁移）----
        "agenda": [],
        "user_mood_log": [],
        "nostalgia_candidates": [],
        # ---- psi-v2.2 增量：时间线 / 记忆胶囊 / 关系周报 / 习惯观察 ----
        "timeline": [],
        "daily_capsules": [],
        "weekly_reports": [],
        "recent_turn_hours": [],
        "habit_observe_day": "",
        "capsule_day": "",
        "capsule_turns": 0,
        "capsule_valence_sum": 0.0,
        "capsule_highs": [],
        "capsule_lows": [],
        "capsule_agenda_done": 0,
        "week_key": "",
        "week_turns": 0,
        "week_valence_sum": 0.0,
        "week_agenda_done": 0,
        "week_memories": 0,
        "week_bond_start": 0.05,
        "week_bond_end": 0.05,
        "updated_at_ms": now,
    }


def migrate_state(value: dict[str, Any]) -> dict[str, Any]:
    """v1 → v2 迁移：保留全部旧字段，补默认新字段（不丢用户数据）。"""
    migrated = default_state()
    for key in (
        "name", "address", "preset", "paused", "emotion", "attention", "bond",
        "personality", "memory_count", "turn_count", "updated_at_ms",
    ):
        if key in value:
            migrated[key] = value[key]
    if isinstance(value.get("needs"), dict):
        migrated["needs"] = {
            key: clamp01(float(item))
            for key, item in value["needs"].items()
            if isinstance(item, (int, float))
        }
    migrated["first_seen_ms"] = int(value.get("first_seen_ms", value.get("updated_at_ms", now_ms())))
    migrated["last_update_ms"] = int(value.get("last_update_ms", value.get("updated_at_ms", now_ms())))
    # v1 遗留 preset 迁移（label 反查）。注意必须基于原始 value 判断：
    # migrated 已带默认 preset="balanced"，直接查 migrated 会把无 preset
    # 的 v1 档案误判为「已配置」而跳过 label 反查。
    preset = str(value.get("preset") or "")
    if preset not in PERSONALITY_PRESETS:
        label = str(dict(value.get("personality") or {}).get("label") or "")
        preset = next(
            (key for key, item in PERSONALITY_PRESETS.items() if item["label"] == label),
            "balanced",
        )
    migrated["preset"] = preset
    migrated["personality"] = dict(PERSONALITY_PRESETS[preset])
    return migrated


def public_state(state: dict[str, Any]) -> dict[str, Any]:
    """对外状态形状：与 Rust `CognitiveState` 严格对齐（v1 字段全保留 + 增量）。"""
    preset, personality = personality_for_state(state)
    _, stage_label = bond_stage(clamp01(float(state.get("bond", 0.0))))
    return {
        "version": STATE_VERSION,
        "name": bounded(state.get("name"), 48),
        "address": bounded(state.get("address"), 48),
        "preset": preset,
        "personality": {
            str(key): bounded(value, 2400 if key == "instruction" else 32)
            for key, value in personality.items()
        },
        "paused": bool(state.get("paused", False)),
        "emotion": bounded(state.get("emotion"), 32),
        "attention": bounded(state.get("attention"), 32),
        "bond": round(clamp01(float(state.get("bond", 0.0))), 4),
        "needs": {
            str(key): round(clamp01(float(value)), 4)
            for key, value in dict(state.get("needs", {})).items()
        },
        "memory_count": int(state.get("memory_count", 0)),
        "updated_at_ms": int(state.get("updated_at_ms", now_ms())),
        # ---- v2 增量（serde 默认忽略未知字段，不影响 v1 消费方） ----
        "emotionValence": round(clamp(float(state.get("emotion_valence", 0.0)), -1.0, 1.0), 4),
        "emotionArousal": round(clamp01(float(state.get("emotion_arousal", 0.25))), 4),
        "bondStage": stage_label,
        "turnCount": int(state.get("turn_count", 0)),
        "streakDays": streak_days(list(state.get("contact_days", []))),
        "daysTogether": max(1, int((now_ms() - int(state.get("first_seen_ms", now_ms()))) / 86_400_000) + 1),
        "dominantUrge": dominant_urge({key: float(value) for key, value in dict(state.get("needs", {})).items()}),
        # ---- psi-v2.1 增量 ----
        "userMoodAvg": user_mood_avg(state),
        "agendaPending": len(
            [
                item
                for item in state.get("agenda", [])
                if isinstance(item, dict) and item.get("status") in ("pending", "passed")
            ]
        ),
        # ---- psi-v2.2 增量 ----
        "weather": {
            "icon": weather_label(
                clamp(float(state.get("emotion_valence", 0.0)), -1.0, 1.0),
                clamp01(float(state.get("emotion_arousal", 0.25))),
            )[0],
            "label": weather_label(
                clamp(float(state.get("emotion_valence", 0.0)), -1.0, 1.0),
                clamp01(float(state.get("emotion_arousal", 0.25))),
            )[1],
        },
        "timelineCount": len([entry for entry in state.get("timeline", []) if isinstance(entry, dict)]),
        "capsuleCount": len([entry for entry in state.get("daily_capsules", []) if isinstance(entry, dict)]),
        "weeklyReportCount": len([entry for entry in state.get("weekly_reports", []) if isinstance(entry, dict)]),
    }


# ---------------------------------------------------------------------------
# 存储：状态 / 记忆 / 心情日志
# ---------------------------------------------------------------------------


class LifeStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def profile_dir(self, profile_id: str) -> Path:
        if not PROFILE_RE.fullmatch(profile_id):
            raise RpcError(-32602, "invalid profile_id")
        target = (self.root / profile_id).resolve()
        if target.parent != self.root:
            raise RpcError(-32602, "profile path escaped state root")
        return target

    def state_path(self, profile_id: str) -> Path:
        return self.profile_dir(profile_id) / "state.json"

    def memory_path(self, profile_id: str) -> Path:
        return self.profile_dir(profile_id) / "memory.jsonl"

    def load(self, profile_id: str) -> dict[str, Any]:
        path = self.state_path(profile_id)
        if not path.exists():
            raise RpcError(-32004, "profile is not initialized")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RpcError(-32010, "profile state is damaged") from error
        version = value.get("version")
        if version == STATE_VERSION:
            return value
        if version == 1:
            # v1 档案：迁移到 v2（在读取时即持久化，防止反复迁移）。
            migrated = migrate_state(value)
            atomic_json(path, migrated)
            return migrated
        raise RpcError(-32011, "unsupported profile state version")

    def save(self, profile_id: str, state: dict[str, Any]) -> dict[str, Any]:
        state["version"] = STATE_VERSION
        state["updated_at_ms"] = now_ms()
        atomic_json(self.state_path(profile_id), state)
        return public_state(state)

    def bootstrap(self, profile_id: str, name: str, address: str, preset: str = "balanced") -> dict[str, Any]:
        path = self.state_path(profile_id)
        if path.exists():
            return public_state(self.load(profile_id))
        state = default_state(name, address, preset)
        self.profile_dir(profile_id).mkdir(parents=True, exist_ok=True)
        return self.save(profile_id, state)

    def memory_items(self, profile_id: str) -> list[dict[str, Any]]:
        path = self.memory_path(profile_id)
        if not path.exists():
            return []
        items: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("version") in (1, STATE_VERSION):
                    items.append(item)
        return items[-MAX_MEMORY_ITEMS:]

    def append_memory(self, profile_id: str, item: dict[str, Any]) -> None:
        path = self.memory_path(profile_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            json.dump(item, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")

    def _touch_access(self, profile_id: str, indices: list[int], cued: bool = False) -> None:
        """检索强化（retrieval practice）：被召回的记忆 access_count/last_access_ms +1。

        cued=True（情境联想命中）：额外写入 last_cued_ms，作为联想冷却时间戳。
        """
        if not indices:
            return
        items = self.memory_items(profile_id)
        changed = False
        for index in indices:
            if 0 <= index < len(items):
                items[index]["access_count"] = int(items[index].get("access_count", 0)) + 1
                items[index]["last_access_ms"] = now_ms()
                if cued:
                    items[index]["last_cued_ms"] = now_ms()
                changed = True
        if not changed:
            return
        with self.memory_path(profile_id).open("w", encoding="utf-8", newline="\n") as handle:
            for entry in items:
                handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")

    def recall(self, profile_id: str, query: str, limit: int) -> list[str]:
        """TF-IDF 相关性 + 重要性（经遗忘曲线调制）+ 新近度 + 检索强化排序。

        被选中的记忆同时获得一次检索强化（access_count +1），越常被想起
        的记忆越不容易被遗忘（retrieval practice effect）。
        """
        items = self.memory_items(profile_id)
        if not items:
            return []
        limit = max(1, min(int(limit), 12))
        query_tokens = tokenize(query)
        now = now_ms()
        scores: list[tuple[float, int]] = []
        if not query_tokens:
            # 空查询：按有效重要性 + 新近度取最重要的记忆。
            scores = [(score, index) for score, _at, index in self._rank_importance(items)]
        else:
            # 文档频率（DF）
            document_terms = [set(item.get("terms", [])) for item in items]
            document_frequency: dict[str, int] = {}
            for term_set in document_terms:
                for term in term_set:
                    document_frequency[term] = document_frequency.get(term, 0) + 1
            total = len(items)
            for index, (item, term_set) in enumerate(zip(items, document_terms)):
                if not any(token in term_set for token in query_tokens):
                    continue
                inverse_document_frequency = sum(
                    math.log(1.0 + total / (1.0 + document_frequency.get(token, 0)))
                    for token in set(query_tokens)
                    if token in term_set
                )
                importance = float(item.get("importance", 0.45))
                core = bool(item.get("core", False))
                days_since = max(0.0, (now - int(item.get("at_ms", 0))) / 86_400_000)
                retention = forgetting_retention(importance, days_since, core)
                recency_boost = math.exp(-days_since / 30.0)
                access = min(int(item.get("access_count", 0)), 5) / 5.0
                score = (
                    inverse_document_frequency
                    + 0.30 * importance * retention
                    + 0.20 * recency_boost
                    + 0.05 * access
                )
                scores.append((score, index))
        scores.sort(key=lambda entry: entry[0], reverse=True)
        selected = scores[:limit]
        self._touch_access(profile_id, [index for _, index in selected])
        return [self._memory_text(items[index]) for _, index in selected]

    @staticmethod
    def _memory_text(item: dict[str, Any]) -> str:
        return f"User: {bounded(item.get('user'), 800)}\nResponse: {bounded(item.get('assistant'), 800)}"

    def _rank_importance(self, items: list[dict[str, Any]]) -> list[tuple[float, int, int]]:
        """按有效重要性 + 新近度排序，返回 (score, at_ms, index)。"""
        now = now_ms()
        ranked = []
        for index, item in enumerate(items):
            importance = float(item.get("importance", 0.45))
            core = bool(item.get("core", False))
            days_since = max(0.0, (now - int(item.get("at_ms", 0))) / 86_400_000)
            retention = forgetting_retention(importance, days_since, core)
            score = importance * retention + math.exp(-days_since / 60.0) * 0.2
            ranked.append((score, int(item.get("at_ms", 0)), index))
        ranked.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
        return ranked


# ---------------------------------------------------------------------------
# 认知核心：一轮交互的完整评价管线
# ---------------------------------------------------------------------------


def detect_signals(user_text: str, assistant_text: str) -> dict[str, Any]:
    """评价（appraisal）：从对话双侧提取事件信号。"""
    lower = user_text.lower()
    matched: list[str] = []
    event_valence = 0.0
    event_arousal = 0.2
    need_deltas: dict[str, float] = {}
    for name, pattern, valence, arousal, deltas in APPRAISAL_SIGNALS:
        if pattern.search(lower) or pattern.search(user_text):
            matched.append(name)
            event_valence += valence
            event_arousal = max(event_arousal, arousal)
            for key, delta in deltas.items():
                need_deltas[key] = need_deltas.get(key, 0.0) + delta
    # 交互深度：长文本对话 → 成长 + 联结
    if len(user_text) > 200:
        need_deltas["growth"] = need_deltas.get("growth", 0.0) + 0.03
        need_deltas["relatedness"] = need_deltas.get("relatedness", 0.0) + 0.02
        matched.append("depth")
    # 助手侧结果信号：成功/失败标记 → 胜任感 & 确定性
    assistant_success = bool(ASSISTANT_SUCCESS_RE.search(assistant_text))
    assistant_failure = bool(ASSISTANT_FAILURE_RE.search(assistant_text))
    if assistant_success:
        event_valence += 0.35
        need_deltas["competence"] = need_deltas.get("competence", 0.0) + 0.05
        matched.append("task_success")
    if assistant_failure:
        event_valence -= 0.4
        need_deltas["competence"] = need_deltas.get("competence", 0.0) - 0.06
        need_deltas["certainty"] = need_deltas.get("certainty", 0.0) - 0.05
        matched.append("task_failure")
    asked_question = bool(QUESTION_HINT_RE.search(user_text)) or "question" in matched
    # psi-v2.1 心情镜像：用户侧效价 = 词典信号累计（不含助手结果调制）。
    user_valence = clamp(event_valence, -1.0, 1.0)
    # 事件信号聚合后限幅，避免极端文本把情绪打满。
    event_valence = clamp(event_valence, -1.0, 1.0)
    event_arousal = clamp01(event_arousal)
    return {
        "matched": matched,
        "valence": event_valence,
        "arousal": event_arousal,
        "need_deltas": need_deltas,
        "asked_question": asked_question,
        "user_valence": user_valence,
        "explicit_remember": "remember" in matched,
        "task_success": assistant_success,
        "task_failure": assistant_failure,
    }


def bond_quality_from_signals(signals: dict[str, Any]) -> float:
    """依恋质量：积极率（Gottman）为主，深度与投入度为辅。"""
    positivity = 0.0
    for name in signals["matched"]:
        if name in ("gratitude", "praise", "greeting", "farewell", "remember"):
            positivity += 1.0
        elif name in ("worry", "apology"):
            positivity += 0.4  # 倾诉也是信任
    positivity = min(positivity, 2.0) / 2.0
    depth = 1.0 if "depth" in signals["matched"] else 0.3
    engagement = 1.0 if signals["asked_question"] else 0.4
    quality = 0.45 * positivity + 0.30 * depth + 0.25 * engagement
    return clamp01(quality)


def apply_time_decay(state: dict[str, Any]) -> float:
    """进入新一轮前：按壁钟时间差执行需求/情绪/依恋的被动动力学。

    返回自上次更新以来的小时数（供调用方判断 idle 语义）。
    """
    now = now_ms()
    last = int(state.get("last_update_ms", 0))
    hours = max(0.0, (now - last) / 3_600_000.0)
    preset = str(state.get("preset") or "balanced")
    needs = {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()}
    decay_needs(needs, hours, preset)
    state["needs"] = needs
    decay_emotion(state, hours)
    decay_bond(state, hours / 24.0)
    # 成功/失败连击也随时间消退。
    state["success_streak"] = int(state.get("success_streak", 0))
    state["failure_streak"] = int(state.get("failure_streak", 0))
    state["last_update_ms"] = now
    # 刷新离散标签（衰减后重新映射）。
    label = emotion_label(
        float(state.get("emotion_valence", 0.0)),
        float(state.get("emotion_arousal", 0.25)),
        needs,
        int(state.get("success_streak", 0)),
    )
    state["emotion"] = label
    return hours


def append_mood(state: dict[str, Any], cause: str) -> None:
    log = list(state.get("mood_log", []))
    log.append(
        {
            "at_ms": now_ms(),
            "label": bounded(state.get("emotion"), 32),
            "valence": round(clamp(float(state.get("emotion_valence", 0.0)), -1.0, 1.0), 4),
            "arousal": round(clamp01(float(state.get("emotion_arousal", 0.25))), 4),
            "cause": bounded(cause, 64),
        }
    )
    state["mood_log"] = log[-MAX_MOOD_EVENTS:]


def register_contact(state: dict[str, Any]) -> None:
    days = list(state.get("contact_days", []))
    today = day_key()
    if today not in days:
        days.append(today)
    state["contact_days"] = days[-MAX_CONTACT_DAYS:]
    state["last_contact_ms"] = now_ms()


def cognitive_turn(state: dict[str, Any], user_text: str, assistant_text: str) -> None:
    """after_turn 认知管线：时间衰减 → 评价 → 需求 → 情绪 → 依恋 → 记账。"""
    hours = apply_time_decay(state)
    preset = str(state.get("preset") or "balanced")
    signals = detect_signals(user_text, assistant_text)

    # psi-v2.1 重逢检测：连续 ≥3 天无接触后的第一次对话。
    # 必须在 register_contact 覆盖 last_contact_ms 之前计算。
    gap_days = reunion_gap_days(state)
    reunion = gap_days >= REUNION_GAP_DAYS
    if reunion:
        # 欢迎性情绪上扬（久别更克制：等得越久，越想表现得云淡风轻）。
        boost = 0.15 if gap_days >= 7 else 0.25
        signals["valence"] = clamp(float(signals["valence"]) + boost, -1.0, 1.0)
        signals["need_deltas"]["relatedness"] = signals["need_deltas"].get("relatedness", 0.0) + 0.06

    # 需求更新（事件满足叠加在衰减之上）
    needs = {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()}
    apply_need_deltas(needs, signals["need_deltas"])
    # 每轮互动本身满足联结/自主（交互 = 在场证明）
    apply_need_deltas(needs, {"relatedness": 0.05, "autonomy": 0.02})
    state["needs"] = needs

    # 成功/失败连击（影响 proud 标签）
    state["success_streak"] = int(state.get("success_streak", 0)) + 1 if signals["task_success"] else 0
    state["failure_streak"] = int(state.get("failure_streak", 0)) + 1 if signals["task_failure"] else 0

    # 情绪更新（事件信号驱动 EMA）
    update_emotion(state, signals["valence"], signals["arousal"], preset)
    # 昼夜节律只影响标签映射（展示语义），不写入持久 arousal：
    # 否则快速多轮交互时偏移会跨轮累积漂移（display-only invariant）。
    display_arousal = clamp01(
        float(state.get("emotion_arousal", 0.25))
        + circadian_arousal_modulation(time.localtime().tm_hour)
    )
    state["emotion"] = emotion_label(
        float(state.get("emotion_valence", 0.0)),
        display_arousal,
        {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()},
        int(state.get("success_streak", 0)),
    )

    # 依恋更新（psi-v2.2：阶段跃迁写入时间线大事记）
    stage_before = bond_stage(clamp01(float(state.get("bond", 0.0))))[0]
    update_bond(state, bond_quality_from_signals(signals), preset)
    stage_after = bond_stage(clamp01(float(state.get("bond", 0.0))))[0]
    if stage_before != stage_after and stage_after not in ("stranger", "acquaintance"):
        append_timeline(state, "bond_up", f"羁绊进入「{stage_after}」", "")

    # 记账
    turn_count = int(state.get("turn_count", 0)) + 1
    state["turn_count"] = turn_count
    state["attention"] = "user"
    state["last_update_ms"] = now_ms()
    register_contact(state)
    cause = f"reunion:{gap_days}d" if reunion else (",".join(signals["matched"][:3]) or "turn")
    append_mood(state, cause)
    # psi-v2.1 心情镜像：用户侧效价按天聚合。
    record_user_mood(state, float(signals.get("user_valence", 0.0)))
    # psi-v2.2 时间线大事记：初次见面 / 久别重逢。
    if turn_count == 1:
        append_timeline(state, "first_meet", "初次见面", bounded(user_text, 60))
    if reunion:
        append_timeline(state, "reunion", "久别重逢", f"隔了 {gap_days} 天，{bounded(state.get('address', '你'), 16)} 回来了")
    return None  # hours kept for callers via state


def memory_item_for(user_text: str, assistant_text: str, signals: dict[str, Any], bond: float) -> dict[str, Any]:
    importance = memory_importance(
        user_text,
        signals["valence"],
        signals["asked_question"],
        signals["explicit_remember"],
    )
    return {
        "version": STATE_VERSION,
        "at_ms": now_ms(),
        "user": bounded(user_text, 4000),
        "assistant": bounded(assistant_text, 4000),
        "terms": sorted(terms(user_text) | terms(assistant_text))[:120],
        "importance": importance,
        # 明确要求记住的内容直接进入核心记忆（永久保留）；其余按重要性阈值。
        "core": bool(signals["explicit_remember"]) or importance >= 0.85,
        "emotion": bounded(signals.get("emotion_hint", ""), 32),
        "bond": round(clamp01(bond), 4),
        "access_count": 0,
        "last_access_ms": 0,
        # psi-v2.2：情境联想专用冷却时间戳（与 last_access_ms 分离，
        # 用户查询召回不触发联想冷却，反之亦然）。
        "last_cued_ms": 0,
    }


# ---------------------------------------------------------------------------
# 派生视图：仪表盘 / 心情曲线
# ---------------------------------------------------------------------------


def dashboard(store: LifeStore, profile_id: str) -> dict[str, Any]:
    state = store.load(profile_id)
    public = public_state(state)
    needs = {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()}
    urges = need_urges(needs)
    stage_key, stage_label = bond_stage(clamp01(float(state.get("bond", 0.0))))
    mood_log = list(state.get("mood_log", []))[-30:]
    agenda = [
        {
            "text": bounded(item.get("text"), 96),
            "kind": bounded(item.get("kind"), 24),
            "kindLabel": AGENDA_KIND_LABELS.get(str(item.get("kind")), str(item.get("kind", ""))),
            "dueDay": bounded(item.get("due_day"), 10),
            "status": bounded(item.get("status"), 12),
            "outcome": bounded(item.get("outcome"), 12),
        }
        for item in state.get("agenda", [])
        if isinstance(item, dict)
    ][-12:]
    user_mood_log = [dict(entry) for entry in state.get("user_mood_log", []) if isinstance(entry, dict)][-14:]
    return {
        "state": public,
        "bond": {
            "value": public["bond"],
            "stage": stage_label,
            "stageKey": stage_key,
            "peak": round(clamp01(float(state.get("bond_peak", 0.0))), 4),
            "streakDays": public["streakDays"],
        },
        "needs": {key: {"level": round(needs.get(key, 0.5), 4), "urge": urges.get(key, 0.5)} for key in NEED_KEYS},
        "mood": {
            "label": public["emotion"],
            "valence": public["emotionValence"],
            "arousal": public["emotionArousal"],
        },
        "moodCurve": mood_log,
        # ---- psi-v2.1 增量 ----
        "agenda": agenda,
        "userMoodCurve": user_mood_log,
        "reunion": {
            "waitedDays": max(0, reunion_gap_days(state)),
        },
        # ---- psi-v2.2 增量：时间线 / 记忆胶囊 / 关系周报 / 习惯观察 ----
        "timeline": [
            {
                "atMs": int(entry.get("at_ms", 0)),
                "kind": bounded(entry.get("kind"), 24),
                "title": bounded(entry.get("title"), 64),
                "text": bounded(entry.get("text"), 200),
            }
            for entry in state.get("timeline", [])
            if isinstance(entry, dict)
        ][-30:],
        "dailyCapsules": [
            {
                "day": bounded(entry.get("day"), 10),
                "turns": int(entry.get("turns", 0)),
                "valenceAvg": float(entry.get("valence_avg", 0.0)),
                "highlights": [bounded(text, 48) for text in entry.get("highlights", [])],
                "lows": [bounded(text, 48) for text in entry.get("lows", [])],
                "agendaDone": int(entry.get("agenda_done", 0)),
            }
            for entry in state.get("daily_capsules", [])
            if isinstance(entry, dict)
        ][-7:],
        "weeklyReports": [
            {
                "week": bounded(entry.get("week"), 10),
                "turns": int(entry.get("turns", 0)),
                "valenceAvg": float(entry.get("valence_avg", 0.0)),
                "agendaDone": int(entry.get("agenda_done", 0)),
                "memoriesAdded": int(entry.get("memories_added", 0)),
                "bondDelta": float(entry.get("bond_delta", 0.0)),
            }
            for entry in state.get("weekly_reports", [])
            if isinstance(entry, dict)
        ][-4:],
        "habit": {
            "recentHours": [int(hour) for hour in state.get("recent_turn_hours", [])][-24:],
        },
        "stats": {
            "turnCount": public["turnCount"],
            "memoryCount": public["memory_count"],
            "daysTogether": public["daysTogether"],
            "lastContactMs": int(state.get("last_contact_ms", 0)),
        },
    }


def mood_curve(store: LifeStore, profile_id: str, days: int) -> list[dict[str, Any]]:
    """心情曲线：最近 N 天的心情事件（days=0 表示空窗口）。"""
    state = store.load(profile_id)
    window_days = min(max(int(days), 0), 90)
    cutoff = now_ms() - window_days * 86_400_000
    return [entry for entry in list(state.get("mood_log", [])) if int(entry.get("at_ms", 0)) >= cutoff]


def reflect(store: LifeStore, profile_id: str) -> dict[str, Any]:
    """巩固（consolidation）：统计记忆主题（高频 term）与核心记忆数量。"""
    items = store.memory_items(profile_id)
    term_frequency: dict[str, int] = {}
    for item in items:
        for term in item.get("terms", []):
            term_frequency[term] = term_frequency.get(term, 0) + 1
    themes = sorted(term_frequency.items(), key=lambda entry: entry[1], reverse=True)[:12]
    core_count = sum(1 for item in items if item.get("core"))
    top_memories = [
        LifeStore._memory_text(items[index]) for _, _at, index in store._rank_importance(items)[:3]
    ]
    return {
        "themes": [{"term": term, "count": count} for term, count in themes],
        "memoryCount": len(items),
        "coreCount": core_count,
        "topMemories": top_memories,
    }


def apply_external_event(state: dict[str, Any], kind: str, detail: str) -> None:
    """record_event：外部事件直接进入认知管线（任务成败/会话开始结束等）。"""
    apply_time_decay(state)
    preset = str(state.get("preset") or "balanced")
    if kind == "task_success":
        apply_need_deltas(state["needs"], {"competence": 0.05, "certainty": 0.03})
        state["success_streak"] = int(state.get("success_streak", 0)) + 1
        state["failure_streak"] = 0
        update_emotion(state, 0.5, 0.4, preset)
        append_mood(state, "task_success")
    elif kind == "task_failure":
        apply_need_deltas(state["needs"], {"competence": -0.06, "certainty": -0.05})
        state["failure_streak"] = int(state.get("failure_streak", 0)) + 1
        state["success_streak"] = 0
        update_emotion(state, -0.5, 0.55, preset)
        append_mood(state, "task_failure")
    elif kind == "session_start":
        apply_need_deltas(state["needs"], {"relatedness": 0.03})
        update_emotion(state, 0.2, 0.3, preset)
        append_mood(state, "session_start")
    elif kind == "session_end":
        apply_need_deltas(state["needs"], {"autonomy": 0.02})
        update_emotion(state, 0.1, 0.15, preset)
        append_mood(state, "session_end")
    else:
        append_mood(state, bounded(kind, 64) or "event")
    # psi-v2.1 记挂闭环：任务成败事件按 forced outcome 归结对应事项。
    if detail and kind in ("task_success", "task_failure"):
        forced = "success" if kind == "task_success" else "failure"
        close_agenda(state, detail, forced_outcome=forced)
    refresh_agenda_status(state)
    if detail:
        state["last_event_detail"] = bounded(detail, 200)
    state["last_update_ms"] = now_ms()


# ---------------------------------------------------------------------------
# RPC 分发
# ---------------------------------------------------------------------------


class Dispatcher:
    def __init__(self, store: LifeStore) -> None:
        self.store = store
        self.running = True

    def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "ping":
            return {"version": PROTOCOL_VERSION, "transport": "stdio", "engine": "psi-v2"}
        if method == "shutdown":
            self.running = False
            return {"stopped": True}
        profile_id = bounded(params.get("profile_id"), 64)
        if method == "bootstrap":
            return self.store.bootstrap(
                profile_id,
                params.get("name", ""),
                params.get("address", ""),
                params.get("preset", "balanced"),
            )
        state = self.store.load(profile_id)
        if method == "configure":
            name = bounded(params.get("name"), 48)
            address = bounded(params.get("address"), 48)
            preset = bounded(params.get("preset"), 24)
            if name:
                state["name"] = name
            if address:
                state["address"] = address
            if preset in PERSONALITY_PRESETS:
                state["preset"] = preset
                state["personality"] = PERSONALITY_PRESETS[preset]
            return self.store.save(profile_id, state)
        if method == "get_state":
            return public_state(state)
        if method == "before_turn":
            return self.before_turn(state, profile_id, bounded(params.get("user_text")))
        if method == "after_turn":
            return self.after_turn(state, profile_id, params)
        if method == "recall_memory":
            return self.store.recall(
                profile_id,
                bounded(params.get("query")),
                int(params.get("limit", 5)),
            )
        if method == "personality":
            _, personality = personality_for_state(state)
            return personality
        if method == "bond":
            return round(clamp01(float(state.get("bond", 0.0))), 4)
        if method == "pause":
            state["paused"] = bool(params.get("paused", True))
            return self.store.save(profile_id, state)
        if method == "snapshot":
            snapshot = self.store.profile_dir(profile_id) / "snapshots" / f"{now_ms()}.json"
            atomic_json(snapshot, state)
            return str(snapshot)
        if method == "export":
            return self.export_profile(profile_id, Path(str(params.get("destination", ""))))
        if method == "reset":
            replacement = default_state(state.get("name", ""), state.get("address", ""), state.get("preset", "balanced"))
            memory = self.store.memory_path(profile_id)
            if memory.exists():
                memory.unlink()
            return self.store.save(profile_id, replacement)
        if method == "delete":
            shutil.rmtree(self.store.profile_dir(profile_id), ignore_errors=False)
            return {"deleted": True}
        # ---- v2 增量方法 ----
        if method == "get_dashboard":
            return dashboard(self.store, profile_id)
        if method == "mood_curve":
            return mood_curve(self.store, profile_id, int(params.get("days", 7)))
        if method == "record_event":
            kind = bounded(params.get("kind"), 32) or "event"
            detail = bounded(params.get("detail"), 200)
            apply_external_event(state, kind, detail)
            return self.store.save(profile_id, state)
        if method == "reflect":
            return reflect(self.store, profile_id)
        raise RpcError(-32601, "method not found")

    def before_turn(self, state: dict[str, Any], profile_id: str, user_text: str) -> dict[str, Any]:
        """轮前上下文：先执行时间衰减（让状态反映"现在"），再组装注入材料。"""
        apply_time_decay(state)
        # 展示层刷新情绪（含昼夜节律），但不落盘 —— 落盘发生在 after_turn。
        display_valence = clamp(float(state.get("emotion_valence", 0.0)), -1.0, 1.0)
        display_arousal = clamp01(
            float(state.get("emotion_arousal", 0.25)) + circadian_arousal_modulation(time.localtime().tm_hour)
        )
        needs = {key: clamp01(float(value)) for key, value in dict(state.get("needs", {})).items()}
        display_label = emotion_label(display_valence, display_arousal, needs, int(state.get("success_streak", 0)))

        memories = [] if os.environ.get("COOMI_SHARED_MEMORY") == "1" else self.store.recall(profile_id, user_text, 5)
        _, stage_label = bond_stage(clamp01(float(state.get("bond", 0.0))))
        urges = need_urges(needs)
        top_need = dominant_urge(needs)
        need_summary = "; ".join(f"{key}: {needs[key]:.2f}" for key in NEED_KEYS if key in needs)
        preset, personality = personality_for_state(state)
        streak = streak_days(list(state.get("contact_days", [])))
        days_together = max(1, int((now_ms() - int(state.get("first_seen_ms", now_ms()))) / 86_400_000) + 1)

        # ---- psi-v2.1 语境材料 ----
        # 重逢：等待有了重量（≥3 天），开场应当承认「你回来了」。
        reunion_days = reunion_gap_days(state)
        reunion = reunion_days if reunion_days >= REUNION_GAP_DAYS else 0
        # 记挂：进行中的事项（含到期未结），LLM 可自然地问起。
        upcoming = agenda_upcoming(state, 3)
        agenda_summary = "; ".join(
            f"{item.get('text')}（{item.get('due_day')}，{item.get('status')}）" for item in upcoming
        )
        # 用户心情镜像：它看得见你最近的状态。
        user_mood = user_mood_avg(state)
        user_mood_note = ""
        if user_mood is not None:
            if user_mood <= -0.2:
                user_mood_note = "用户最近几天情绪偏低落，多体谅、少打扰"
            elif user_mood >= 0.2:
                user_mood_note = "用户最近几天心情不错，可以分享轻松的话题"
            else:
                user_mood_note = "用户最近几天情绪平稳"
        # 驱力驱动提问：这一次对话它「想问什么」。
        urge_question = urge_question_for(state)
        # ---- psi-v2.2 语境材料：情境联想 / 习惯观察 / 记忆胶囊 / 关系周报 / 天气化情绪 ----
        cued_recall_text = cued_recall(self.store, profile_id, state, user_text)
        habit_text = habit_observation(state)
        if habit_text:
            # before_turn 本身不落盘，但观察日标记必须持久化，
            # 否则下一次 before_turn 会重复投递同一条观察（防复读失效）。
            self.store.save(profile_id, state)
        capsule_text = latest_capsule_text(state)
        report_text = latest_report_text(state)
        weather_icon, weather_label_zh = weather_label(display_valence, display_arousal)

        state_summary = (
            f"Name: {bounded(state['name'], 48)}; "
            f"Emotion: {display_label} (valence {display_valence:+.2f}, arousal {display_arousal:.2f}); "
            f"attention: {bounded(state.get('attention'), 32)}; "
            f"bond: {float(state.get('bond', 0.0)):.2f} ({stage_label}, 连续相伴 {streak} 天, 相识 {days_together} 天); "
            f"needs: {need_summary}; dominant urge: {top_need} (urge {urges.get(top_need, 0.5):.2f})."
        )
        if reunion:
            state_summary += f" User just returned after {reunion} days away — welcome them back warmly."
        if agenda_summary:
            state_summary += f" Pending user agenda: {agenda_summary}."
        if user_mood_note:
            state_summary += f" User mood: {user_mood_note}."
        if cued_recall_text:
            state_summary += f" A shared memory this evokes: “{cued_recall_text}” — mention it only if it fits naturally."
        if capsule_text:
            state_summary += f" Yesterday's memory capsule: {capsule_text}."
        if report_text:
            state_summary += f" Last week's report: {report_text}."
        if habit_text:
            state_summary += f" Observation: {habit_text}."
        state_summary += (
            f" Mood weather (metaphor of the user's current feelings, NOT real weather — "
            f"never mention it as weather, never give weather advice/forecasts): {weather_label_zh}."
        )
        return {
            "version": STATE_VERSION,
            "state_summary": state_summary,
            "memories": memories,
            "personality": personality,
            "relationship": (
                f"Address the user as {bounded(state.get('address'), 48)} and keep the configured "
                f"{preset} personality preset consistent. You have known each other for {days_together} days "
                f"and your current bond stage is “{stage_label}”."
                + (f" The user was away for {reunion} days and just came back." if reunion else "")
            ),
            "life_name": bounded(state.get("name"), 48),
            "user_address": bounded(state.get("address"), 48),
            "personality_label": bounded(personality.get("label"), 24),
            "personality_instruction": bounded(personality.get("instruction"), 2400),
            "emotion_label": display_label,
            "bond_stage": stage_label,
            "streak_days": streak,
            "days_together": days_together,
            "dominant_urge": top_need,
            # ---- psi-v2.1 增量（Rust CognitiveTurnContext 对应透传）----
            "reunion_waited_days": reunion,
            "user_agenda": [
                {
                    "text": bounded(item.get("text"), 96),
                    "due_day": bounded(item.get("due_day"), 10),
                    "status": bounded(item.get("status"), 12),
                }
                for item in upcoming
            ],
            "user_mood_avg": user_mood,
            "urge_question": bounded(urge_question, 200),
            # ---- psi-v2.2 增量（Rust CognitiveTurnContext 对应透传）----
            "cued_recall": bounded(cued_recall_text, 120),
            "habit_observation": bounded(habit_text, 120),
            "daily_capsule": bounded(capsule_text, 200),
            "weekly_report": bounded(report_text, 240),
            "weather": {"icon": weather_icon, "label": weather_label_zh},
        }

    def after_turn(self, state: dict[str, Any], profile_id: str, params: dict[str, Any]) -> dict[str, Any]:
        if state.get("paused"):
            return public_state(state)
        user_text = bounded(params.get("user_text"))
        assistant_text = bounded(params.get("assistant_text"))
        # ---- psi-v2.2 跨周期结算：先封存昨日胶囊 / 上周周报，再开始今日累计 ----
        begin_capsule_day(state)
        roll_weekly_report(state)
        cognitive_turn(state, user_text, assistant_text)
        preset = str(state.get("preset") or "balanced")
        # psi-v2.1 记挂闭环：先结算旧事项（用户报了结果），再提取新事项。
        agenda_done = 0
        for _text, outcome in close_agenda(state, user_text):
            if outcome == "success":
                agenda_done += 1
                update_emotion(state, 0.5, 0.45, preset)
                append_mood(state, "agenda_success")
            else:
                update_emotion(state, -0.45, 0.5, preset)
                append_mood(state, "agenda_failure")
        merge_agenda(state, extract_agenda_candidates(user_text))
        refresh_agenda_status(state)
        memory_added = 0
        if os.environ.get("COOMI_SHARED_MEMORY") != "1":
            signals = detect_signals(user_text, assistant_text)
            item = memory_item_for(user_text, assistant_text, signals, float(state.get("bond", 0.0)))
            self.store.append_memory(profile_id, item)
            state["memory_count"] = int(state.get("memory_count", 0)) + 1
            memory_added = 1
        else:
            shared_count = params.get("shared_memory_count")
            if isinstance(shared_count, int) and shared_count >= 0:
                state["memory_count"] = shared_count
        # ---- psi-v2.2 当日/本周原料累计（记忆胶囊 / 关系周报 / 习惯观察）----
        valence = float(state.get("emotion_valence", 0.0))
        state["capsule_turns"] = int(state.get("capsule_turns", 0)) + 1
        state["capsule_valence_sum"] = float(state.get("capsule_valence_sum", 0.0)) + valence
        state["capsule_agenda_done"] = int(state.get("capsule_agenda_done", 0)) + agenda_done
        if valence >= 0.45 and user_text:
            highs = list(state.get("capsule_highs", [])) + [bounded(user_text, 48)]
            state["capsule_highs"] = highs[-CAPSULE_TURNS_MIN:]
        elif valence <= -0.45 and user_text:
            lows = list(state.get("capsule_lows", [])) + [bounded(user_text, 48)]
            state["capsule_lows"] = lows[-CAPSULE_TURNS_MIN:]
        state["week_turns"] = int(state.get("week_turns", 0)) + 1
        state["week_valence_sum"] = float(state.get("week_valence_sum", 0.0)) + valence
        state["week_agenda_done"] = int(state.get("week_agenda_done", 0)) + agenda_done
        state["week_memories"] = int(state.get("week_memories", 0)) + memory_added
        state["week_bond_end"] = clamp01(float(state.get("bond", 0.05)))
        record_habit_hour(state, time.localtime().tm_hour)
        # psi-v2.1 梦境素材 + 怀旧候选再生（sidecar 非常驻，素材须预生成）。
        regenerate_dream_next(self.store, profile_id, state)
        refresh_nostalgia_candidates(self.store, profile_id, state)
        return self.store.save(profile_id, state)

    def export_profile(self, profile_id: str, destination: Path) -> dict[str, Any]:
        source = self.store.profile_dir(profile_id)
        if not destination.is_absolute():
            raise RpcError(-32602, "export destination must be absolute")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source.rglob("*")):
                if path.is_file() and "snapshots" not in path.parts:
                    archive.write(path, path.relative_to(source))
        temporary.replace(destination)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        return {"version": STATE_VERSION, "path": str(destination), "sha256": digest}


def response(request_id: Any, result: Any = None, error: RpcError | None = None) -> str:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = {"code": error.code, "message": error.message}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def serve_stdio(root: Path, token: str) -> int:
    dispatcher = Dispatcher(LifeStore(root))
    for line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("jsonrpc") != "2.0" or request.get("version") != PROTOCOL_VERSION:
                raise RpcError(-32600, "invalid protocol version")
            supplied = str(request.get("auth", ""))
            if not hmac.compare_digest(supplied, token):
                raise RpcError(-32001, "authentication failed")
            method = str(request.get("method", ""))
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise RpcError(-32602, "params must be an object")
            result = dispatcher.dispatch(method, params)
            output = response(request_id, result=result)
        except RpcError as error:
            output = response(request_id, error=error)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            output = response(request_id, error=RpcError(-32603, "internal sidecar error"))
        sys.stdout.write(output + "\n")
        sys.stdout.flush()
        if not dispatcher.running:
            break
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdio", action="store_true", required=True)
    parser.add_argument("--state-root", type=Path, required=True)
    args = parser.parse_args()
    token = os.environ.get("COOMI_LIFE_TOKEN", "")
    if len(token) < 32:
        sys.stderr.write("COOMI_LIFE_TOKEN is required\n")
        return 2
    return serve_stdio(args.state_root, token)


if __name__ == "__main__":
    raise SystemExit(main())
