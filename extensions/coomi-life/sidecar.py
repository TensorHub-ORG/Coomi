#!/usr/bin/env python3
"""Coomi Life JSON-RPC stdio sidecar.

Substantially modified implementation informed by the PSI state concepts in
LAAP AGI at commit fe98e1e61adefe5899a01db561143ee8f8c45086.
It does not open a network listener or call a model Provider.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
STATE_VERSION = 1
MAX_MEMORY_ITEMS = 5000
MAX_TEXT_CHARS = 12000
PROFILE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
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


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def now_ms() -> int:
    return int(time.time() * 1000)


def bounded(value: Any, limit: int = MAX_TEXT_CHARS) -> str:
    return str(value or "")[:limit]


def personality_for_state(state: dict[str, Any]) -> tuple[str, dict[str, str]]:
    preset = str(state.get("preset") or "balanced")
    if preset not in PERSONALITY_PRESETS:
        preset = "balanced"
    return preset, dict(PERSONALITY_PRESETS[preset])


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def default_state(name: str = "Coomi Life", address: str = "you", preset: str = "balanced") -> dict[str, Any]:
    preset = preset if preset in PERSONALITY_PRESETS else "balanced"
    return {
        "version": STATE_VERSION,
        "name": bounded(name, 48) or "Coomi Life",
        "address": bounded(address, 48) or "you",
        "preset": preset,
        "paused": False,
        "emotion": "neutral",
        "attention": "user",
        "bond": 0.0,
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
        "updated_at_ms": now_ms(),
    }


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
        if value.get("version") != STATE_VERSION:
            raise RpcError(-32011, "unsupported profile state version")
        # Migrate profiles created before preset IDs were persisted.  Keeping the
        # canonical ID in state prevents a save/refresh cycle from falling back
        # to the balanced preset.
        preset = str(value.get("preset") or "")
        if preset not in PERSONALITY_PRESETS:
            label = str(dict(value.get("personality") or {}).get("label") or "")
            preset = next((key for key, item in PERSONALITY_PRESETS.items() if item["label"] == label), "balanced")
            value["preset"] = preset
            value["personality"] = dict(PERSONALITY_PRESETS[preset])
            atomic_json(path, value)
        return value

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
                if item.get("version") == STATE_VERSION:
                    items.append(item)
        return items[-MAX_MEMORY_ITEMS:]

    def append_memory(self, profile_id: str, user_text: str, assistant_text: str) -> None:
        path = self.memory_path(profile_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        item = {
            "version": STATE_VERSION,
            "at_ms": now_ms(),
            "user": bounded(user_text, 4000),
            "assistant": bounded(assistant_text, 4000),
            "terms": sorted(terms(user_text) | terms(assistant_text))[:80],
        }
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            json.dump(item, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")

    def recall(self, profile_id: str, query: str, limit: int) -> list[str]:
        query_terms = terms(query)
        ranked: list[tuple[int, int, str]] = []
        for item in self.memory_items(profile_id):
            matched = len(query_terms & set(item.get("terms", [])))
            if query_terms and matched == 0:
                continue
            text = f"User: {bounded(item.get('user'), 800)}\nResponse: {bounded(item.get('assistant'), 800)}"
            ranked.append((matched, int(item.get("at_ms", 0)), text))
        ranked.sort(reverse=True)
        return [item[2] for item in ranked[: max(1, min(int(limit), 12))]]


def public_state(state: dict[str, Any]) -> dict[str, Any]:
    preset, personality = personality_for_state(state)
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
        "bond": float(state.get("bond", 0.0)),
        "needs": {
            str(key): float(value)
            for key, value in dict(state.get("needs", {})).items()
        },
        "memory_count": int(state.get("memory_count", 0)),
        "updated_at_ms": int(state.get("updated_at_ms", now_ms())),
    }


def terms(value: str) -> set[str]:
    return {
        token.lower()
        for token in re.findall(r"[\w+#.-]{2,}", bounded(value), flags=re.UNICODE)
    }


def update_psi(state: dict[str, Any], user_text: str, assistant_text: str) -> None:
    lower = user_text.lower()
    needs = state["needs"]
    for key in list(needs):
        needs[key] = round(float(needs[key]) * 0.98 + 0.5 * 0.02, 4)
    if any(word in lower for word in ("thanks", "thank you", "good", "great")):
        needs["relatedness"] = min(1.0, needs["relatedness"] + 0.08)
        state["emotion"] = "warm"
    elif any(word in lower for word in ("error", "failed", "wrong", "problem")):
        needs["certainty"] = max(0.0, needs["certainty"] - 0.08)
        state["emotion"] = "concerned"
    elif "?" in user_text or len(user_text) > 500:
        needs["growth"] = min(1.0, needs["growth"] + 0.05)
        state["emotion"] = "curious"
    else:
        state["emotion"] = "neutral"
    if assistant_text:
        needs["competence"] = min(1.0, needs["competence"] + 0.02)
    state["attention"] = "user"
    state["bond"] = round(min(1.0, float(state.get("bond", 0.0)) + 0.002), 4)
    state["turn_count"] = int(state.get("turn_count", 0)) + 1


class Dispatcher:
    def __init__(self, store: LifeStore) -> None:
        self.store = store
        self.running = True

    def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "ping":
            return {"version": PROTOCOL_VERSION, "transport": "stdio"}
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
            user_text = bounded(params.get("user_text"))
            memories = [] if os.environ.get("COOMI_SHARED_MEMORY") == "1" else self.store.recall(profile_id, user_text, 5)
            needs = "; ".join(
                f"{key}: {float(value):.2f}"
                for key, value in dict(state.get("needs", {})).items()
            )
            preset, personality = personality_for_state(state)
            return {
                "version": STATE_VERSION,
                "state_summary": (
                    f"Name: {bounded(state['name'], 48)}; "
                    f"Emotion: {bounded(state['emotion'], 32)}; "
                    f"attention: {bounded(state['attention'], 32)}; "
                    f"bond: {float(state['bond']):.2f}; "
                    f"needs: {needs}."
                ),
                "memories": memories,
                "personality": personality,
                "relationship": (
                    f"Address the user as {bounded(state['address'], 48)} and keep the configured "
                    f"{preset} personality preset consistent."
                ),
                "life_name": bounded(state.get("name"), 48),
                "user_address": bounded(state.get("address"), 48),
                "personality_label": bounded(personality.get("label"), 24),
                "personality_instruction": bounded(personality.get("instruction"), 2400),
            }
        if method == "after_turn":
            if state.get("paused"):
                return public_state(state)
            user_text = bounded(params.get("user_text"))
            assistant_text = bounded(params.get("assistant_text"))
            update_psi(state, user_text, assistant_text)
            if os.environ.get("COOMI_SHARED_MEMORY") != "1":
                self.store.append_memory(profile_id, user_text, assistant_text)
                state["memory_count"] = int(state.get("memory_count", 0)) + 1
            else:
                shared_count = params.get("shared_memory_count")
                if isinstance(shared_count, int) and shared_count >= 0:
                    state["memory_count"] = shared_count
            return self.store.save(profile_id, state)
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
            return float(state.get("bond", 0.0))
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
            replacement = default_state(state.get("name", ""), state.get("address", ""))
            memory = self.store.memory_path(profile_id)
            if memory.exists():
                memory.unlink()
            return self.store.save(profile_id, replacement)
        if method == "delete":
            shutil.rmtree(self.store.profile_dir(profile_id), ignore_errors=False)
            return {"deleted": True}
        raise RpcError(-32601, "method not found")

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
