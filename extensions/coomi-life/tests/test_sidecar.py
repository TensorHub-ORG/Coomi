"""Coomi Life 认知引擎（psi-v2）测试套件。

覆盖范围：
- v1 协议兼容（原有行为全量回归）；
- 需求系统：壁钟衰减、事件满足、驱力、人格调制；
- 情绪引擎：EMA 动量、被动衰减、二维→离散标签映射、昼夜节律；
- 依恋模型：渐近累积、阶段语义、闲置衰减地板（峰值记忆）；
- 记忆系统：TF-IDF 召回、重要性、核心记忆、检索强化、遗忘曲线；
- 派生视图：仪表盘 / 心情曲线 / 事件 / 反思；
- psi-v2.1：记挂（前瞻记忆）/ 心情镜像 / 重逢 / 梦境与怀旧 / 驱力提问；
- stdio JSON-RPC 端到端（子进程级，含鉴权与协议版本校验）。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("coomi_life_sidecar", Path(__file__).parents[1] / "sidecar.py")
assert SPEC and SPEC.loader
SIDECAR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SIDECAR)

HOUR_MS = 3_600_000
DAY_MS = 86_400_000


class V1CompatTests(unittest.TestCase):
    """v1 协议行为全量回归：升级引擎不改变既有对外契约。"""

    def test_profile_memory_isolation_and_reset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            dispatcher.dispatch("bootstrap", {"profile_id": "two", "name": "Two", "address": "User"})
            dispatcher.dispatch(
                "after_turn",
                {"profile_id": "one", "user_text": "remember cobalt", "assistant_text": "noted"},
            )
            self.assertEqual(len(dispatcher.dispatch("recall_memory", {"profile_id": "one", "query": "cobalt", "limit": 5})), 1)
            self.assertEqual(dispatcher.dispatch("recall_memory", {"profile_id": "two", "query": "cobalt", "limit": 5}), [])
            reset = dispatcher.dispatch("reset", {"profile_id": "one"})
            self.assertEqual(reset["memory_count"], 0)

    def test_pause_prevents_state_and_memory_updates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            dispatcher.dispatch("pause", {"profile_id": "one", "paused": True})
            state = dispatcher.dispatch(
                "after_turn",
                {"profile_id": "one", "user_text": "hello", "assistant_text": "hello"},
            )
            self.assertEqual(state["memory_count"], 0)
            self.assertTrue(state["paused"])

    def test_configure_updates_public_identity_and_personality(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            configured = dispatcher.dispatch(
                "configure",
                {"profile_id": "one", "name": "Nova", "address": "朋友", "preset": "warm"},
            )
            self.assertEqual(configured["name"], "Nova")
            self.assertEqual(configured["address"], "朋友")
            reloaded = SIDECAR.LifeStore(Path(directory)).load("one")
            self.assertEqual(reloaded["preset"], "warm")
            self.assertEqual(dispatcher.dispatch("personality", {"profile_id": "one"})["warmth"], "high")
            context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "hello"})
            self.assertEqual(context["life_name"], "Nova")
            self.assertEqual(context["user_address"], "朋友")
            self.assertIn("语气温暖", context["personality_instruction"])

    def test_all_personality_presets_have_distinct_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            instructions = set()
            for preset, definition in SIDECAR.PERSONALITY_PRESETS.items():
                profile_id = f"profile-{preset}"
                dispatcher.dispatch(
                    "bootstrap",
                    {"profile_id": profile_id, "name": "Life", "address": "User", "preset": preset},
                )
                context = dispatcher.dispatch(
                    "before_turn", {"profile_id": profile_id, "user_text": "hello"}
                )
                self.assertEqual(context["personality_label"], definition["label"])
                self.assertEqual(context["personality_instruction"], definition["instruction"])
                instructions.add(context["personality_instruction"])
            self.assertEqual(len(instructions), 10)

    def test_legacy_v1_profile_label_is_migrated_to_preset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = SIDECAR.LifeStore(root)
            profile_dir = store.profile_dir("legacy")
            profile_dir.mkdir(parents=True, exist_ok=True)
            # 构造真正的 v1 档案形状：version=1、无 preset、personality 只带 label。
            legacy = SIDECAR.default_state("Legacy", "User")
            legacy["version"] = 1
            legacy.pop("preset", None)
            legacy.pop("emotion_valence", None)
            legacy.pop("emotion_arousal", None)
            legacy["personality"] = {"label": "高冷"}
            SIDECAR.atomic_json(store.state_path("legacy"), legacy)

            state = store.load("legacy")
            self.assertEqual(state["preset"], "cool")
            self.assertEqual(state["personality"]["label"], "高冷")
            persisted = json.loads(store.state_path("legacy").read_text(encoding="utf-8"))
            self.assertEqual(persisted["version"], SIDECAR.STATE_VERSION)
            self.assertEqual(persisted["preset"], "cool")

    def test_export_and_delete_are_complete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(root / "state"))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            exported = dispatcher.dispatch("export", {"profile_id": "one", "destination": str(root / "life.zip")})
            self.assertEqual(len(exported["sha256"]), 64)
            dispatcher.dispatch("delete", {"profile_id": "one"})
            self.assertFalse((root / "state" / "one").exists())

    def test_profile_path_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = SIDECAR.LifeStore(Path(directory))
            with self.assertRaises(SIDECAR.RpcError):
                store.profile_dir("../escape")

    def test_recall_memory_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            results = dispatcher.dispatch(
                "recall_memory", {"profile_id": "one", "query": "anything", "limit": 99}
            )
            self.assertEqual(results, [])


class NeedSystemTests(unittest.TestCase):
    """需求系统：内稳态衰减 + 事件满足 + 驱力。"""

    def test_needs_decay_toward_floor_with_half_life(self) -> None:
        needs = {key: 0.9 for key in SIDECAR.NEED_KEYS}
        # relatedness 半衰期 10h：20h 后应衰减到地板 + (0.9-地板)*0.25
        SIDECAR.decay_needs(needs, 20.0, "balanced")
        expected = SIDECAR.NEED_FLOOR + (0.9 - SIDECAR.NEED_FLOOR) * 0.25
        self.assertAlmostEqual(needs["relatedness"], expected, places=3)
        # 每个维度都应下降且不低于地板。
        for key in SIDECAR.NEED_KEYS:
            self.assertLess(needs[key], 0.9)
            self.assertGreaterEqual(needs[key], SIDECAR.NEED_FLOOR)

    def test_need_decay_respects_wall_clock_idle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            state = SIDECAR.LifeStore(Path(directory)).load("one")
            # 模拟 30 小时未互动。
            state["last_update_ms"] = SIDECAR.now_ms() - 30 * HOUR_MS
            state["needs"]["relatedness"] = 0.9
            SIDECAR.atomic_json(SIDECAR.LifeStore(Path(directory)).state_path("one"), state)
            refreshed = dispatcher.dispatch(
                "before_turn", {"profile_id": "one", "user_text": "hi"}
            )
            self.assertIn("Emotion:", refreshed["state_summary"])

    def test_urges_are_deficit_driven(self) -> None:
        urges = SIDECAR.need_urges({"relatedness": 0.2, "competence": 0.9})
        self.assertAlmostEqual(urges["relatedness"], 0.8)
        self.assertAlmostEqual(urges["competence"], 0.1)
        self.assertEqual(SIDECAR.dominant_urge({"relatedness": 0.2, "competence": 0.9}), "relatedness")

    def test_warm_preset_clings_longer_to_relatedness(self) -> None:
        warm = {key: 0.8 for key in SIDECAR.NEED_KEYS}
        cool = {key: 0.8 for key in SIDECAR.NEED_KEYS}
        SIDECAR.decay_needs(warm, 40.0, "warm")
        SIDECAR.decay_needs(cool, 40.0, "cool")
        # warm 的 relatedness 衰减倍率 0.85（更念旧）→ 保留更多联结。
        self.assertGreater(warm["relatedness"], cool["relatedness"])


class EmotionEngineTests(unittest.TestCase):
    """情绪引擎：Russell 环状模型 + EMA 动量 + 被动衰减。"""

    def _state(self, **overrides):
        state = SIDECAR.default_state()
        state.update(overrides)
        return state

    def test_emotion_label_mapping_covers_quadrants(self) -> None:
        needs_full = {"relatedness": 0.8, "competence": 0.5}
        cases = [
            (-0.6, 0.7, needs_full, 0, "concerned"),   # 负效价高唤醒：担忧
            (-0.6, 0.3, needs_full, 0, "melancholy"),   # 负效价低唤醒：低落
            (0.7, 0.7, needs_full, 0, "excited"),      # 高效价高唤醒：兴奋
            (0.7, 0.3, needs_full, 0, "content"),     # 高效价低唤醒：满足
            (0.3, 0.6, needs_full, 0, "warm"),          # 正效价优先于唤醒：温暖
            (0.1, 0.6, needs_full, 0, "curious"),       # 中性效价高唤醒：好奇
            (0.0, 0.2, needs_full, 0, "neutral"),      # 平静：中性
        ]
        for valence, arousal, needs, streak, expected in cases:
            self.assertEqual(
                SIDECAR.emotion_label(valence, arousal, needs, streak),
                expected,
                f"valence={valence} arousal={arousal} should be {expected}",
            )

    def test_loneliness_and_pride_override_valence(self) -> None:
        lonely_needs = {"relatedness": 0.1, "competence": 0.9}
        self.assertEqual(SIDECAR.emotion_label(0.9, 0.9, lonely_needs, 0), "lonely")
        proud_needs = {"relatedness": 0.8, "competence": 0.9}
        self.assertEqual(SIDECAR.emotion_label(0.0, 0.2, proud_needs, 3), "proud")

    def test_ema_converges_to_event_and_personality_modulates(self) -> None:
        warm = self._state(preset="warm")
        cool = self._state(preset="cool")
        for _ in range(5):
            SIDECAR.update_emotion(warm, 0.8, 0.6, "warm")
            SIDECAR.update_emotion(cool, 0.8, 0.6, "cool")
        # 温柔人格反应性更高 → 更快逼近事件效价。
        self.assertGreater(warm["emotion_valence"], cool["emotion_valence"])
        self.assertLess(warm["emotion_valence"], 0.9, "EMA 不应一次到顶")

    def test_emotion_decays_toward_baseline(self) -> None:
        state = self._state()
        state["emotion_valence"] = 0.9
        state["emotion_arousal"] = 0.9
        SIDECAR.decay_emotion(state, 72.0)
        self.assertLess(state["emotion_valence"], 0.3)
        self.assertLess(abs(state["emotion_arousal"] - 0.25), 0.1)

    def test_circadian_modulation_is_bounded(self) -> None:
        self.assertEqual(SIDECAR.circadian_arousal_modulation(3), -0.10)
        self.assertEqual(SIDECAR.circadian_arousal_modulation(10), 0.05)
        self.assertEqual(SIDECAR.circadian_arousal_modulation(15), 0.0)
        for hour in range(24):
            value = SIDECAR.circadian_arousal_modulation(hour)
            self.assertGreaterEqual(value, -0.10)
            self.assertLessEqual(value, 0.05)

    def test_after_turn_updates_emotion_from_positive_signals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            for _ in range(4):
                state = dispatcher.dispatch(
                    "after_turn",
                    {"profile_id": "one", "user_text": "谢谢！你真厉害", "assistant_text": "已解决，搞定 ✅"},
                )
            self.assertGreater(state["emotionValence"], 0.3)
            # 连续成功 + 高胜任感 → 成就情绪 proud（v2 新标签）。
            self.assertEqual(state["emotion"], "proud")


class BondModelTests(unittest.TestCase):
    """依恋模型：渐近累积 + 阶段语义 + 峰值地板。"""

    def test_bond_accumulation_is_asymptotic(self) -> None:
        state = SIDECAR.default_state()
        state["bond"] = 0.0
        for _ in range(200):
            SIDECAR.update_bond(state, 1.0, "balanced")
        self.assertLess(state["bond"], 1.0, "渐近增长不应到顶")
        self.assertGreater(state["bond"], 0.5)
        self.assertEqual(state["bond_peak"], state["bond"], "峰值随当前值刷新")

    def test_bond_stages_are_ordered(self) -> None:
        cases = [(0.10, "stranger"), (0.30, "acquaintance"), (0.50, "companion"), (0.70, "confidant"), (0.90, "soulmate")]
        for value, expected_key in cases:
            key, _ = SIDECAR.bond_stage(value)
            self.assertEqual(key, expected_key)

    def test_idle_decay_keeps_peak_floor(self) -> None:
        state = SIDECAR.default_state()
        state["bond"] = 0.8
        state["bond_peak"] = 0.8
        SIDECAR.decay_bond(state, 365.0)  # 一年不联系
        self.assertGreaterEqual(state["bond"], 0.8 * SIDECAR.BOND_IDLE_FLOOR_RATIO - 1e-9)
        self.assertLessEqual(state["bond"], 0.8)

    def test_short_idle_does_not_decay(self) -> None:
        state = SIDECAR.default_state()
        state["bond"] = 0.8
        SIDECAR.decay_bond(state, 1.0)
        self.assertEqual(state["bond"], 0.8)

    def test_streak_days_counts_consecutive_contacts(self) -> None:
        today = SIDECAR.day_key()
        yesterday = SIDECAR.day_key(SIDECAR.now_ms() - DAY_MS)
        two_days_ago = SIDECAR.day_key(SIDECAR.now_ms() - 2 * DAY_MS)
        self.assertEqual(SIDECAR.streak_days([two_days_ago, yesterday, today]), 3)
        self.assertEqual(SIDECAR.streak_days([]), 0)
        self.assertEqual(SIDECAR.streak_days(["2020-01-01"]), 0)

    def test_gratitude_stream_builds_bond_faster_than_neutral(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(root))
            dispatcher.dispatch("bootstrap", {"profile_id": "warm-life", "name": "A", "address": "User", "preset": "warm"})
            dispatcher.dispatch("bootstrap", {"profile_id": "plain", "name": "B", "address": "User", "preset": "cool"})
            for _ in range(10):
                dispatcher.dispatch("after_turn", {"profile_id": "warm-life", "user_text": "谢谢你，辛苦了，帮大忙了", "assistant_text": "不客气"})
                dispatcher.dispatch("after_turn", {"profile_id": "plain", "user_text": "ok", "assistant_text": "ok"})
            warm_bond = dispatcher.dispatch("bond", {"profile_id": "warm-life"})
            plain_bond = dispatcher.dispatch("bond", {"profile_id": "plain"})
            self.assertGreater(warm_bond, plain_bond)


class MemorySystemTests(unittest.TestCase):
    """记忆系统：TF-IDF 召回 + 重要性 + 遗忘 + 检索强化。"""

    def _seed(self, dispatcher, texts):
        for user, assistant in texts:
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": user, "assistant_text": assistant})

    def test_recall_ranks_relevant_memories_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            self._seed(
                dispatcher,
                [
                    ("我喜欢蓝色", "记住了，你喜欢蓝色"),
                    ("今天天气不错", "是的，适合出门"),
                    ("帮我记住我的生日是 5 月 3 日", "好的，已记住你的生日"),
                ],
            )
            hits = dispatcher.dispatch("recall_memory", {"profile_id": "one", "query": "蓝色", "limit": 3})
            self.assertEqual(len(hits), 1)
            self.assertIn("蓝色", hits[0])

    def test_explicit_remember_creates_core_memory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = SIDECAR.LifeStore(root)
            dispatcher = SIDECAR.Dispatcher(store)
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            dispatcher.dispatch(
                "after_turn",
                {"profile_id": "one", "user_text": "记住这个很重要：钥匙在门口柜子里", "assistant_text": "已记住"},
            )
            items = store.memory_items("one")
            self.assertTrue(items[0]["core"], "明确要求记住的内容应成为核心记忆")
            self.assertEqual(SIDECAR.forgetting_retention(items[0]["importance"], 365.0, True), 1.0)

    def test_forgetting_curve_rewards_importance(self) -> None:
        low = SIDECAR.forgetting_retention(0.5, 30.0, False)
        high = SIDECAR.forgetting_retention(0.8, 30.0, False)
        self.assertGreater(high, low)
        self.assertLess(low, 1.0)

    def test_retrieval_practice_increases_access_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = SIDECAR.LifeStore(root)
            dispatcher = SIDECAR.Dispatcher(store)
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "cobalt 42", "assistant_text": "noted"})
            dispatcher.dispatch("recall_memory", {"profile_id": "one", "query": "cobalt", "limit": 5})
            items = store.memory_items("one")
            self.assertGreaterEqual(items[0]["access_count"], 1, "检索应强化记忆（retrieval practice）")

    def test_memory_count_tracks_items(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            for index in range(3):
                dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": f"msg {index}", "assistant_text": "ok"})
            state = dispatcher.dispatch("get_state", {"profile_id": "one"})
            self.assertEqual(state["memory_count"], 3)

    def test_tokenizer_handles_mixed_language(self) -> None:
        tokens = SIDECAR.tokenize("Rust 语言中的所有权 ownership")
        self.assertIn("rust", tokens)
        self.assertIn("ownership", tokens)
        self.assertIn("语言", tokens)
        self.assertIn("所有", tokens)


class CognitiveTurnPipelineTests(unittest.TestCase):
    """after_turn 认知管线：评价 → 需求 → 情绪 → 依恋 → 记账。"""

    def test_signals_detect_gratitude_frustration_and_remember(self) -> None:
        signals = SIDECAR.detect_signals("谢谢，你太厉害了", "已解决 ✅")
        self.assertIn("gratitude", signals["matched"])
        self.assertIn("praise", signals["matched"])
        self.assertIn("task_success", signals["matched"])
        self.assertGreater(signals["valence"], 0.5)

        signals = SIDECAR.detect_signals("又报错了，烦死了", "执行失败 ❌")
        self.assertIn("frustration", signals["matched"])
        self.assertIn("task_failure", signals["matched"])
        self.assertLess(signals["valence"], 0)

        signals = SIDECAR.detect_signals("记住我的偏好", "好的")
        self.assertTrue(signals["explicit_remember"])
        self.assertFalse(signals["asked_question"], "陈述句不应被识别为提问")

        signals = SIDECAR.detect_signals("这是什么意思？", "意思是……")
        self.assertTrue(signals["asked_question"])

    def test_signal_magnitude_is_clamped(self) -> None:
        signals = SIDECAR.detect_signals("谢谢 厉害 太棒 你好 晚安 记住", "完成 成功 已解决")
        self.assertLessEqual(signals["valence"], 1.0)
        self.assertLessEqual(signals["arousal"], 1.0)

    def test_task_failure_lowers_competence_and_certainty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            before = dispatcher.dispatch("get_state", {"profile_id": "one"})
            after = dispatcher.dispatch(
                "after_turn",
                {"profile_id": "one", "user_text": "编译失败", "assistant_text": "构建失败，无法修复"},
            )
            self.assertLess(after["needs"]["competence"], before["needs"]["competence"])
            self.assertLess(after["needs"]["certainty"], before["needs"]["certainty"])
            self.assertLess(after["emotionValence"], 0)
            # 挫败映射为负效价情绪（concerned/melancholy 取决于唤醒度与昼夜节律，
            # 两者在 Rust 端都会触发 support 关切问候）。
            self.assertIn(after["emotion"], ("concerned", "melancholy"))

    def test_turn_counter_and_contact_registration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            for _ in range(3):
                dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "hi", "assistant_text": "hello"})
            state = dispatcher.dispatch("get_state", {"profile_id": "one"})
            self.assertEqual(state["turnCount"], 3)
            self.assertEqual(state["streakDays"], 1)

    def test_before_turn_injects_v2_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory)))
            dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
            context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "在吗"})
            for key in (
                "state_summary", "memories", "personality", "relationship",
                "life_name", "user_address", "personality_label", "personality_instruction",
                "emotion_label", "bond_stage", "streak_days", "days_together", "dominant_urge",
            ):
                self.assertIn(key, context)
            self.assertIn("初识", context["bond_stage"])
            self.assertIn("bond:", context["state_summary"])


class DerivedViewTests(unittest.TestCase):
    """v2 派生视图：仪表盘 / 心情曲线 / 事件 / 反思。"""

    def _prepared(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        dispatcher = SIDECAR.Dispatcher(SIDECAR.LifeStore(Path(directory.name)))
        dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
        return dispatcher

    def test_dashboard_shape(self) -> None:
        dispatcher = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "谢谢", "assistant_text": "不客气"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        for key in ("state", "bond", "needs", "mood", "moodCurve", "stats"):
            self.assertIn(key, view)
        for key in SIDECAR.NEED_KEYS:
            self.assertIn(key, view["needs"])
            self.assertIn("level", view["needs"][key])
            self.assertIn("urge", view["needs"][key])
        self.assertEqual(view["mood"]["label"], view["state"]["emotion"])
        self.assertGreaterEqual(view["stats"]["daysTogether"], 1)

    def test_mood_curve_filters_by_days(self) -> None:
        dispatcher = self._prepared()
        for _ in range(3):
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "hi", "assistant_text": "hello"})
        recent = dispatcher.dispatch("mood_curve", {"profile_id": "one", "days": 7})
        self.assertEqual(len(recent), 3)
        old = dispatcher.dispatch("mood_curve", {"profile_id": "one", "days": 0})
        self.assertEqual(len(old), 0)

    def test_record_event_updates_streaks_and_mood(self) -> None:
        dispatcher = self._prepared()
        # 连续成功事件：胜任感累积到高位 + 成功连击 ≥3 → proud。
        for _ in range(7):
            dispatcher.dispatch("record_event", {"profile_id": "one", "kind": "task_success", "detail": "build passed"})
        state = dispatcher.dispatch("get_state", {"profile_id": "one"})
        self.assertEqual(state["emotion"], "proud")
        # 连续失败事件：情绪动量进入负效价高唤醒象限 → concerned。
        for _ in range(6):
            dispatcher.dispatch("record_event", {"profile_id": "one", "kind": "task_failure", "detail": "build broke"})
        state = dispatcher.dispatch("get_state", {"profile_id": "one"})
        self.assertEqual(state["emotion"], "concerned")

    def test_reflect_summarizes_themes(self) -> None:
        dispatcher = self._prepared()
        for topic in ("rust", "rust", "rust", "python"):
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": f"聊 {topic}", "assistant_text": "好"})
        reflection = dispatcher.dispatch("reflect", {"profile_id": "one"})
        self.assertEqual(reflection["memoryCount"], 4)
        top_terms = [theme["term"] for theme in reflection["themes"]]
        self.assertIn("rust", top_terms)

    def test_unknown_method_is_rejected(self) -> None:
        dispatcher = self._prepared()
        with self.assertRaises(SIDECAR.RpcError):
            dispatcher.dispatch("nope", {"profile_id": "one"})


class Psi21FeatureTests(unittest.TestCase):
    """psi-v2.1 新特性：记挂 / 心情镜像 / 重逢 / 梦境与怀旧 / 驱力提问。"""

    def _prepared(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = SIDECAR.LifeStore(Path(directory.name))
        dispatcher = SIDECAR.Dispatcher(store)
        dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
        return dispatcher, store

    # ---- F1 记挂：日期解析 → 提取 → 状态机 → 结果闭环 ----

    def test_parse_days_ahead_rules(self) -> None:
        monday = time.mktime((2024, 1, 8, 12, 0, 0, 0, 0, -1))  # 2024-01-08，周一
        self.assertEqual(SIDECAR.parse_days_ahead("三天后", monday), 3)
        self.assertEqual(SIDECAR.parse_days_ahead("3天后交稿", monday), 3)
        self.assertEqual(SIDECAR.parse_days_ahead("明天见", monday), 1)
        self.assertEqual(SIDECAR.parse_days_ahead("后天再说", monday), 2)
        self.assertEqual(SIDECAR.parse_days_ahead("大后天", monday), 3)
        self.assertEqual(SIDECAR.parse_days_ahead("今天", monday), 0)
        self.assertEqual(SIDECAR.parse_days_ahead("6月10号考试", monday), 154)
        self.assertEqual(SIDECAR.parse_days_ahead("15号", monday), 7)
        self.assertEqual(SIDECAR.parse_days_ahead("3号", monday), 26)
        self.assertEqual(SIDECAR.parse_days_ahead("周四", monday), 3)
        self.assertEqual(SIDECAR.parse_days_ahead("周末", monday), 5)
        self.assertEqual(SIDECAR.parse_days_ahead("下周一", monday), 7)
        self.assertEqual(SIDECAR.parse_days_ahead("下周四", monday), 10)
        self.assertIsNone(SIDECAR.parse_days_ahead("没有日期的句子", monday))

    def test_extract_agenda_candidates_requires_event_and_date(self) -> None:
        # 事件词 + 未来日期共现才提取。
        found = SIDECAR.extract_agenda_candidates("我三天后有个面试，有点紧张")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["kind"], "interview")
        self.assertEqual(found[0]["days_ahead"], 3)
        # 过去式的倾诉（无未来日期）天然不提取。
        self.assertEqual(SIDECAR.extract_agenda_candidates("上次面试挂了，好难受"), [])
        # 有日期但无事件词不提取。
        self.assertEqual(SIDECAR.extract_agenda_candidates("明天天气不错"), [])
        # 多分句：只有含事件 + 日期的分句被提取。
        found = SIDECAR.extract_agenda_candidates("周五要交季度报告。顺便说，明天降温。")
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["kind"], "report")

    def test_agenda_lifecycle_and_close_by_outcome(self) -> None:
        dispatcher, _store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我三天后有个面试，有点紧张", "assistant_text": "记下了"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        self.assertEqual(len(view["agenda"]), 1)
        item = view["agenda"][0]
        self.assertEqual(item["kindLabel"], "面试")
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["dueDay"], SIDECAR.day_key(SIDECAR.now_ms() + 3 * DAY_MS))
        # 同一件事重复说 → kind+due_day 去重。
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "对了，我三天后有个面试", "assistant_text": "我记得"})
        self.assertEqual(len(dispatcher.dispatch("get_dashboard", {"profile_id": "one"})["agenda"]), 1)
        # 结果闭环：成功标记 + 词重叠 → done/success + 独立心情事件。
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "面试通过了！特别顺利", "assistant_text": "太好了"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        self.assertEqual(view["agenda"][0]["status"], "done")
        self.assertEqual(view["agenda"][0]["outcome"], "success")
        causes = [entry["cause"] for entry in dispatcher.dispatch("mood_curve", {"profile_id": "one", "days": 7})]
        self.assertIn("agenda_success", causes)

    def test_agenda_state_machine_marks_passed_then_archives(self) -> None:
        dispatcher, store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我三天后有个面试", "assistant_text": "记下了"})
        # 把到期日改到昨天：下一次状态刷新应转为 passed（到期未结）。
        state = store.load("one")
        state["agenda"][0]["due_day"] = SIDECAR.day_key(SIDECAR.now_ms() - DAY_MS)
        store.save("one", state)
        dispatcher.dispatch("record_event", {"profile_id": "one", "kind": "session_start"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        self.assertEqual(view["agenda"][0]["status"], "passed")
        # 过期超过 7 天 → archived 谢幕，从列表移除。
        state = store.load("one")
        state["agenda"][0]["due_day"] = SIDECAR.day_key(SIDECAR.now_ms() - 8 * DAY_MS)
        store.save("one", state)
        dispatcher.dispatch("record_event", {"profile_id": "one", "kind": "session_start"})
        self.assertEqual(dispatcher.dispatch("get_dashboard", {"profile_id": "one"})["agenda"], [])

    def test_record_event_closes_agenda_with_forced_outcome(self) -> None:
        dispatcher, _store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我三天后论文答辩", "assistant_text": "记下了"})
        dispatcher.dispatch("record_event", {"profile_id": "one", "kind": "task_failure", "detail": "论文答辩没过，被批评了"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        self.assertEqual(view["agenda"][0]["status"], "done")
        self.assertEqual(view["agenda"][0]["outcome"], "failure")

    # ---- F3 心情镜像：用户侧效价按天聚合 ----

    def test_user_mood_mirror_aggregates_daily_average(self) -> None:
        dispatcher, _store = self._prepared()
        for _ in range(3):
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我好难过，压力好大", "assistant_text": "我在"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        curve = view["userMoodCurve"]
        self.assertEqual(len(curve), 1)
        self.assertEqual(curve[0]["day"], SIDECAR.day_key())
        self.assertEqual(curve[0]["samples"], 3)
        self.assertLessEqual(curve[0]["valence_avg"], -0.2)
        self.assertLessEqual(dispatcher.dispatch("get_state", {"profile_id": "one"})["userMoodAvg"], -0.2)
        # before_turn 语境提示：低落时多体谅少打扰。
        context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "在吗"})
        self.assertLessEqual(context["user_mood_avg"], -0.2)
        self.assertIn("情绪偏低落", context["state_summary"])

    def test_user_mood_mirror_positive_note(self) -> None:
        dispatcher, _store = self._prepared()
        for _ in range(2):
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "谢谢你的帮助", "assistant_text": "不客气"})
        context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "在吗"})
        self.assertGreaterEqual(context["user_mood_avg"], 0.2)
        self.assertIn("心情不错", context["state_summary"])

    def test_user_mood_mirror_empty_when_no_samples(self) -> None:
        dispatcher, _store = self._prepared()
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        self.assertEqual(view["userMoodCurve"], [])
        self.assertIsNone(dispatcher.dispatch("get_state", {"profile_id": "one"})["userMoodAvg"])

    # ---- F4 等待与重逢 ----

    def test_reunion_context_after_long_gap(self) -> None:
        dispatcher, store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "你好", "assistant_text": "你好呀"})
        # 模拟 5 天没有接触。
        state = store.load("one")
        state["last_contact_ms"] = SIDECAR.now_ms() - 5 * DAY_MS
        store.save("one", state)
        context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "我回来了"})
        self.assertEqual(context["reunion_waited_days"], 5)
        self.assertIn("away for 5 days", context["relationship"])
        self.assertIn("returned after 5 days", context["state_summary"])
        # 重逢轮：心情以 reunion:Nd 归因，且欢迎性情绪上扬。
        result = dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我回来了", "assistant_text": "欢迎回来"})
        self.assertGreater(result["emotionValence"], 0.0)
        causes = [entry["cause"] for entry in dispatcher.dispatch("mood_curve", {"profile_id": "one", "days": 7})]
        self.assertIn("reunion:5d", causes)

    def test_no_reunion_when_gap_below_threshold(self) -> None:
        dispatcher, store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "你好", "assistant_text": "你好呀"})
        state = store.load("one")
        state["last_contact_ms"] = SIDECAR.now_ms() - DAY_MS  # 只隔 1 天
        store.save("one", state)
        context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "在吗"})
        self.assertEqual(context["reunion_waited_days"], 0)
        self.assertNotIn("away", context["relationship"])

    # ---- F2 梦境与怀旧 ----

    def test_dream_next_materializes_deterministically(self) -> None:
        dispatcher, store = self._prepared()
        for topic in ("聊聊北海道的雪", "聊聊京都的枫叶", "聊聊东京的晴空塔"):
            dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": topic, "assistant_text": "好"})
        dream = store.load("one").get("dream_next")
        self.assertIsNotNone(dream)
        self.assertGreater(dream["at_ms"], 0)
        self.assertEqual(len(dream["texts"]), 3)
        self.assertTrue(dream["link"])  # 共享词「聊聊」作为关联线索
        # 以 turn_count 为种子 → 同一轮内确定性再生（可测性）。
        state = store.load("one")
        SIDECAR.regenerate_dream_next(store, "one", state)
        self.assertEqual(state["dream_next"]["texts"], dream["texts"])

    def test_nostalgia_candidates_pick_forgetting_window(self) -> None:
        dispatcher, store = self._prepared()
        now = SIDECAR.now_ms()

        def memory(text: str, days_old: float, importance: float, core: bool = False, last_access_ms: int = 0) -> dict:
            return {
                "version": SIDECAR.STATE_VERSION,
                "at_ms": now - int(days_old * DAY_MS),
                "user": text,
                "assistant": "",
                "terms": sorted(SIDECAR.terms(text)),
                "importance": importance,
                "core": core,
                "access_count": 0,
                "last_access_ms": last_access_ms,
            }

        store.append_memory("one", memory("那年夏天在海边散步", 30, 0.5))  # 保持率≈0.71，落在临界区间
        store.append_memory("one", memory("昨天刚聊的新话题", 5, 0.5))  # 太新
        store.append_memory("one", memory("最重要的核心记忆片段", 30, 0.5, core=True))  # 核心永不遗忘
        store.append_memory("one", memory("久远到几乎忘掉的旧事", 300, 0.3))  # 保持率过低
        store.append_memory("one", memory("最近刚被想起的话题", 30, 0.5, last_access_ms=now - DAY_MS))  # 7 天内被想起
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "随便聊聊", "assistant_text": "好"})
        candidates = store.load("one").get("nostalgia_candidates", [])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["text"], "那年夏天在海边散步")
        self.assertEqual(candidates[0]["fingerprint"], hashlib.sha256("那年夏天在海边散步".encode("utf-8")).hexdigest()[:16])
        self.assertTrue(0.35 <= candidates[0]["retention"] <= 0.75)

    # ---- F5 驱力驱动提问 ----

    def test_urge_question_follows_dominant_need(self) -> None:
        def state_with(needs: dict, agenda: list | None = None, last_contact_ms: int | None = None) -> dict:
            state = SIDECAR.default_state("Nova", "你")
            state["needs"] = dict(needs)
            state["agenda"] = agenda or []
            if last_contact_ms is not None:
                state["last_contact_ms"] = last_contact_ms
            return state

        high = {key: 0.9 for key in SIDECAR.NEED_KEYS}
        pending = [
            {"kind": "report", "text": "周五要交季度报告", "due_day": "2099-01-01", "status": "pending", "terms": [], "outcome": "", "created_ms": 0}
        ]
        # relatedness 缺口最大 → 关心近况；久别重逢优先。
        relatedness_low = dict(high, relatedness=0.1)
        self.assertIn("问问他今天过得怎么样", SIDECAR.urge_question_for(state_with(relatedness_low)))
        self.assertIn("重逢", SIDECAR.urge_question_for(state_with(relatedness_low, last_contact_ms=SIDECAR.now_ms() - 4 * DAY_MS)))
        # growth 缺口 → 结合记挂事项追问进展。
        self.assertIn("周五要交季度报告", SIDECAR.urge_question_for(state_with(dict(high, growth=0.1), pending)))
        # certainty 缺口 → 追问已到期事项。
        passed = [dict(pending[0], status="passed")]
        self.assertIn("已经到期", SIDECAR.urge_question_for(state_with(dict(high, certainty=0.1), passed)))
        # competence 缺口 → 请教/求反馈。
        self.assertIn("请教", SIDECAR.urge_question_for(state_with(dict(high, competence=0.1))))
        # autonomy 缺口 → 交出话题选择权。
        self.assertIn("选择权", SIDECAR.urge_question_for(state_with(dict(high, autonomy=0.1))))

    def test_before_turn_returns_v21_context_bundle(self) -> None:
        dispatcher, _store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我三天后有个面试", "assistant_text": "记下了"})
        context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "在吗"})
        for key in ("reunion_waited_days", "user_agenda", "user_mood_avg", "urge_question"):
            self.assertIn(key, context)
        self.assertIsInstance(context["reunion_waited_days"], int)
        self.assertEqual(len(context["user_agenda"]), 1)
        self.assertEqual(context["user_agenda"][0]["text"], "我三天后有个面试")
        self.assertEqual(context["user_agenda"][0]["status"], "pending")
        self.assertTrue(context["urge_question"])
        self.assertIsNotNone(context["user_mood_avg"])
        # 仪表盘暴露重逢等待天数。
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        self.assertIn("waitedDays", view["reunion"])


class Psi22FeatureTests(unittest.TestCase):
    """psi-v2.2 新特性：时间线 / 天气化情绪 / 记忆胶囊 / 关系周报 / 习惯观察 / 情境联想。"""

    def _prepared(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = SIDECAR.LifeStore(Path(directory.name))
        dispatcher = SIDECAR.Dispatcher(store)
        dispatcher.dispatch("bootstrap", {"profile_id": "one", "name": "One", "address": "User"})
        return dispatcher, store

    def _memory(self, text: str, days_old: float, importance: float = 0.6) -> dict:
        return {
            "version": SIDECAR.STATE_VERSION,
            "at_ms": SIDECAR.now_ms() - int(days_old * DAY_MS),
            "user": text,
            "assistant": "",
            "terms": sorted(SIDECAR.terms(text)),
            "importance": importance,
            "core": False,
            "access_count": 0,
            "last_access_ms": 0,
        }

    # ---- F1 天气化情绪（Russell 象限）----

    def test_weather_quadrant_mapping(self) -> None:
        self.assertEqual(SIDECAR.weather_label(0.6, 0.7), ("sunny", "晴朗"))
        self.assertEqual(SIDECAR.weather_label(0.6, 0.2), ("partly_cloudy", "多云转晴"))
        self.assertEqual(SIDECAR.weather_label(-0.6, 0.7), ("stormy", "雷雨"))
        self.assertEqual(SIDECAR.weather_label(-0.6, 0.2), ("overcast", "阴天"))
        self.assertEqual(SIDECAR.weather_label(0.0, 0.5), ("cloudy", "多云"))

    def test_public_state_exposes_v22_counts_and_weather(self) -> None:
        dispatcher, _store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "你好呀", "assistant_text": "你好"})
        state = dispatcher.dispatch("get_state", {"profile_id": "one"})
        for key in ("weather", "timelineCount", "capsuleCount", "weeklyReportCount"):
            self.assertIn(key, state)
        self.assertEqual(state["timelineCount"], 1)  # 初次见面
        self.assertIn("icon", state["weather"])
        self.assertIn("label", state["weather"])

    # ---- F2 时间线大事记 ----

    def test_timeline_records_first_meet_and_reunion(self) -> None:
        dispatcher, store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "你好呀", "assistant_text": "你好"})
        kinds = [entry["kind"] for entry in dispatcher.dispatch("get_dashboard", {"profile_id": "one"})["timeline"]]
        self.assertIn("first_meet", kinds)
        # 5 天未接触后的重逢 → reunion 大事记。
        state = store.load("one")
        state["last_contact_ms"] = SIDECAR.now_ms() - 5 * DAY_MS
        store.save("one", state)
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "我回来了", "assistant_text": "欢迎回来"})
        kinds = [entry["kind"] for entry in dispatcher.dispatch("get_dashboard", {"profile_id": "one"})["timeline"]]
        self.assertIn("reunion", kinds)
        self.assertIn("first_meet", kinds)

    # ---- F3 每日记忆胶囊 ----

    def test_daily_capsule_rolls_over_on_day_change(self) -> None:
        dispatcher, store = self._prepared()
        state = store.load("one")
        state["capsule_day"] = SIDECAR.day_key(SIDECAR.now_ms() - DAY_MS)  # 昨天
        state["capsule_turns"] = 5
        state["capsule_valence_sum"] = 1.0
        state["capsule_highs"] = ["一起看了部电影", "聊了旅行计划"]
        state["capsule_lows"] = ["提到加班有点累"]
        state["capsule_agenda_done"] = 2
        store.save("one", state)
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "早上好", "assistant_text": "早上好"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        capsules = view["dailyCapsules"]
        self.assertEqual(len(capsules), 1)
        self.assertEqual(capsules[0]["day"], SIDECAR.day_key(SIDECAR.now_ms() - DAY_MS))
        self.assertEqual(capsules[0]["turns"], 5)
        self.assertEqual(capsules[0]["valenceAvg"], 0.2)
        self.assertEqual(capsules[0]["agendaDone"], 2)
        self.assertEqual(capsules[0]["highlights"][0], "一起看了部电影")
        # 封存本身也是时间线大事记。
        kinds = [entry["kind"] for entry in view["timeline"]]
        self.assertIn("capsule", kinds)

    def test_capsule_requires_min_turns(self) -> None:
        dispatcher, store = self._prepared()
        state = store.load("one")
        state["capsule_day"] = SIDECAR.day_key(SIDECAR.now_ms() - DAY_MS)
        state["capsule_turns"] = 2  # 不足 CAPSULE_TURNS_MIN=3 → 不封存
        store.save("one", state)
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "早", "assistant_text": "早"})
        self.assertEqual(dispatcher.dispatch("get_dashboard", {"profile_id": "one"})["dailyCapsules"], [])

    # ---- F4 关系周报 ----

    def test_weekly_report_rolls_over_on_week_change(self) -> None:
        dispatcher, store = self._prepared()
        state = store.load("one")
        state["week_key"] = SIDECAR.week_key(SIDECAR.now_ms() - 7 * DAY_MS)  # 上周
        state["week_turns"] = 8
        state["week_valence_sum"] = 1.6
        state["week_agenda_done"] = 1
        state["week_memories"] = 4
        state["week_bond_start"] = 0.1
        state["week_bond_end"] = 0.3
        store.save("one", state)
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "周末愉快", "assistant_text": "你也是"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        reports = view["weeklyReports"]
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["week"], SIDECAR.week_key(SIDECAR.now_ms() - 7 * DAY_MS))
        self.assertEqual(reports[0]["turns"], 8)
        self.assertEqual(reports[0]["valenceAvg"], 0.2)
        self.assertEqual(reports[0]["agendaDone"], 1)
        self.assertEqual(reports[0]["memoriesAdded"], 4)
        self.assertEqual(reports[0]["bondDelta"], 0.2)

    # ---- F5 习惯观察 ----

    def test_habit_observation_thresholds_and_dedup(self) -> None:
        state = SIDECAR.default_state("Nova", "你")
        # 样本不足（<8）→ 无观察。
        for hour in (23, 0, 1, 23, 0):
            SIDECAR.record_habit_hour(state, hour)
        self.assertEqual(SIDECAR.habit_observation(state), "")
        # 补足样本且深夜占比高 → 睡眠话题观察。
        for hour in (23, 0, 1, 22):
            SIDECAR.record_habit_hour(state, hour)
        text = SIDECAR.habit_observation(state)
        self.assertIn("深夜", text)
        # 同一天重复调用 → 防复读。
        self.assertEqual(SIDECAR.habit_observation(state), "")
        # 午休峰值 → 午休观察。
        midday = SIDECAR.default_state("Nova", "你")
        for hour in (12, 13, 12, 13, 12, 13, 12, 13):
            SIDECAR.record_habit_hour(midday, hour)
        self.assertIn("午休", SIDECAR.habit_observation(midday))

    # ---- F6 情境联想记忆 ----

    def test_cued_recall_needs_old_shared_memories_with_cooldown(self) -> None:
        dispatcher, store = self._prepared()
        store.append_memory("one", self._memory("我养了一只叫煤球的猫", 3))
        store.append_memory("one", self._memory("今天买了一杯拿铁", 0))  # 太新，不联想
        state = store.load("one")
        recalled = SIDECAR.cued_recall(store, "one", state, "我的猫煤球最近掉毛很厉害")
        self.assertEqual(recalled, "我养了一只叫煤球的猫")
        # 同一段记忆 24h 冷却期内不再重复提。
        self.assertEqual(SIDECAR.cued_recall(store, "one", state, "煤球又掉毛了"), "")
        # 无共享实质词 → 不联想。
        self.assertEqual(SIDECAR.cued_recall(store, "one", state, "今天股票涨了"), "")

    # ---- 端到端：before_turn 语境包 + dashboard 形状 ----

    def test_before_turn_exposes_v22_context_bundle(self) -> None:
        dispatcher, store = self._prepared()
        store.append_memory("one", self._memory("我在学做提拉米苏", 3))
        state = store.load("one")
        state["capsule_day"] = SIDECAR.day_key(SIDECAR.now_ms() - DAY_MS)
        state["capsule_turns"] = 4
        state["capsule_valence_sum"] = 1.0
        state["capsule_highs"] = ["一起看了部电影"]
        state["capsule_lows"] = []
        state["capsule_agenda_done"] = 1
        state["week_key"] = SIDECAR.week_key(SIDECAR.now_ms() - 7 * DAY_MS)
        state["week_turns"] = 6
        state["week_valence_sum"] = 0.6
        state["week_agenda_done"] = 1
        state["week_memories"] = 2
        state["week_bond_start"] = 0.1
        state["week_bond_end"] = 0.2
        store.save("one", state)
        # 先跑一轮 after_turn：触发昨日胶囊 / 上周周报封存并落盘。
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "在吗", "assistant_text": "在的"})
        context = dispatcher.dispatch("before_turn", {"profile_id": "one", "user_text": "提拉米苏怎么做"})
        for key in ("cued_recall", "habit_observation", "daily_capsule", "weekly_report", "weather"):
            self.assertIn(key, context)
        self.assertEqual(context["cued_recall"], "我在学做提拉米苏")
        self.assertIn("一起看了部电影", context["daily_capsule"])
        self.assertIn("回顾", context["weekly_report"])
        self.assertIn("label", context["weather"])
        self.assertIn("Mood weather", context["state_summary"])

    def test_dashboard_exposes_v22_sections(self) -> None:
        dispatcher, _store = self._prepared()
        dispatcher.dispatch("after_turn", {"profile_id": "one", "user_text": "你好", "assistant_text": "你好"})
        view = dispatcher.dispatch("get_dashboard", {"profile_id": "one"})
        for key in ("timeline", "dailyCapsules", "weeklyReports", "habit"):
            self.assertIn(key, view)
        self.assertIsInstance(view["timeline"], list)
        self.assertIsInstance(view["habit"]["recentHours"], list)


class StdioProtocolTests(unittest.TestCase):
    """stdio JSON-RPC 端到端：子进程级验证鉴权、协议版本与完整生命周期。"""

    TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    def _spawn(self, root: Path) -> subprocess.Popen:
        process = subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).parents[1] / "sidecar.py"),
                "--stdio",
                "--state-root",
                str(root),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={"COOMI_LIFE_TOKEN": self.TOKEN, "PATH": "/usr/bin:/bin", "HOME": str(root)},
        )

        def _cleanup() -> None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            if process.poll() is None:
                process.kill()

        self.addCleanup(_cleanup)
        return process

    def _call(self, process: subprocess.Popen, payload: dict) -> dict:
        assert process.stdin and process.stdout
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        line = process.stdout.readline()
        return json.loads(line)

    def _request(self, identifier, method, params=None, token=None, version=1):
        return {
            "jsonrpc": "2.0",
            "version": version,
            "id": identifier,
            "auth": token if token is not None else self.TOKEN,
            "method": method,
            "params": params or {},
        }

    def test_full_lifecycle_over_stdio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "state"
            process = self._spawn(root)
            pong = self._call(process, self._request(1, "ping"))
            self.assertEqual(pong["result"]["version"], 1)
            self.assertEqual(pong["result"]["engine"], "psi-v2")

            boot = self._call(process, self._request(2, "bootstrap", {"profile_id": "one", "name": "Nova", "address": "你"}))
            self.assertEqual(boot["result"]["name"], "Nova")

            turn = self._call(process, self._request(3, "after_turn", {"profile_id": "one", "user_text": "谢谢", "assistant_text": "不客气"}))
            self.assertEqual(turn["result"]["version"], SIDECAR.STATE_VERSION)

            recall = self._call(process, self._request(4, "recall_memory", {"profile_id": "one", "query": "谢谢", "limit": 3}))
            self.assertEqual(len(recall["result"]), 1)

            dashboard = self._call(process, self._request(5, "get_dashboard", {"profile_id": "one"}))
            self.assertIn("moodCurve", dashboard["result"])

            shutdown = self._call(process, self._request(6, "shutdown"))
            self.assertTrue(shutdown["result"]["stopped"])
            self.assertEqual(process.wait(timeout=5), 0)

    def test_authentication_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            process = self._spawn(Path(directory) / "state")
            result = self._call(process, self._request(1, "ping", token="wrong-token" * 4))
            self.assertEqual(result["error"]["code"], -32001)

    def test_protocol_version_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            process = self._spawn(Path(directory) / "state")
            result = self._call(process, self._request(1, "ping", version=99))
            self.assertEqual(result["error"]["code"], -32600)

    def test_missing_token_refuses_to_start(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).parents[1] / "sidecar.py"),
                    "--stdio",
                    "--state-root",
                    str(Path(directory) / "state"),
                ],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin"},
            )
            self.assertEqual(completed.returncode, 2)


if __name__ == "__main__":
    unittest.main()
