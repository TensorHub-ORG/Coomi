#!/usr/bin/env python3
"""Read and summarize Coomi feedback files over SSH.

Usage:
  python scripts/analyze_coomi_feedback.py --ssh-config PATH --output feedback.csv
"""
import argparse
import csv
import json
import re
from collections import Counter
from datetime import datetime

import paramiko


def read_ssh_config(path):
    text = open(path, encoding="utf-8-sig").read()
    def value(pattern):
        match = re.search(pattern, text, re.I)
        return match.group(1).strip() if match else None
    host = value(r"IP\s*[:：]\s*([^\s\r\n]+)")
    port = int(value(r"SSH\s*[^\r\n]*?[:：]\s*(\d+)") or 22)
    user = value(r"用户名\s*[:：]\s*([^\s\r\n]+)") or "root"
    password = value(r"密码\s*[:：]\s*([^\s\r\n]+)")
    if not host or not password:
        raise ValueError("SSH config must contain IP and password")
    return host, port, user, password


def diagnostics(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def category(message):
    text = message.lower()
    if any(key in text for key in ("test-after", "endpoint-check", "cors-check", "deploy-verify")):
        return "测试探针"
    if "tool round limit" in text:
        return "工具轮次上限"
    if "context compaction" in text or "prompt exceeds max" in text:
        return "上下文/压缩"
    if any(key in text for key in ("401 unauthorized", "invalid api key", "authentication fails")):
        return "鉴权失败"
    if "429 too many" in text or "rpm exhausted" in text:
        return "限流/模型繁忙"
    if any(key in text for key in ("502 bad gateway", "504 gateway timeout", "upstream_timeout", "stream failed", "error sending request")):
        return "网络/上游/流式中断"
    if any(key in text for key in ("image_url", "tool call result", "tool arguments", "invalid assistant message", "invalid type for")):
        return "协议兼容/消息格式"
    if any(key in text for key in ("model not exist", "model_not_found", "not supported", "supported api model", "image model", "asr request", "tts model")):
        return "模型配置/能力不匹配"
    if "402 payment" in text or "insufficient balance" in text:
        return "余额不足"
    if "400 bad request" in text or "invalid params" in text:
        return "其他请求参数错误"
    return "其他"


def reasoning_statistics(value):
    if not isinstance(value, dict):
        return {}
    return {name: value.get(name, {}) for name in ("auto", "low", "medium", "high", "xhigh")}


def fetch(host, port, user, password, root):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=user, password=password, timeout=15)
    sftp = client.open_sftp()
    rows = []
    for name in sftp.listdir(root + "/data"):
        if not name.startswith("error_") or not name.endswith(".json"):
            continue
        try:
            raw = sftp.open(root + "/data/" + name, "rb").read().decode("utf-8")
            data = json.loads(raw)
            diag = diagnostics(data.get("diagnostics"))
            stats = reasoning_statistics(data.get("reasoning_statistics"))
            rows.append({
                "id": name,
                "time": data.get("received_at") or data.get("time") or "",
                "category": category(str(data.get("message", ""))),
                "message": str(data.get("message", "")),
                "detail": str(data.get("detail", "")),
                "provider": str(data.get("provider", "")),
                "model": str(data.get("model", "")),
                "version": str(diag.get("version_name", "")),
                "device": str(diag.get("device_model", "")),
                "attachments": len(data.get("attachments", [])) if isinstance(data.get("attachments"), list) else 0,
                "reasoning_statistics": json.dumps(stats, ensure_ascii=False, separators=(",", ":")) if stats else "",
            })
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
    sftp.close()
    client.close()
    return sorted(rows, key=lambda row: row["time"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ssh-config", required=True)
    parser.add_argument("--root", default="/www/wwwroot/updates.septemc.com/coomi/feedback")
    parser.add_argument("--output", help="write normalized rows to CSV")
    args = parser.parse_args()
    rows = fetch(*read_ssh_config(args.ssh_config), args.root)
    counts = Counter(row["category"] for row in rows)
    print(f"records={len(rows)}")
    for name, count in counts.most_common():
        print(f"{name}\t{count}")
    if args.output:
        with open(args.output, "w", newline="", encoding="utf-8-sig") as output:
            writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()) if rows else ["id"])
            writer.writeheader()
            writer.writerows(rows)


if __name__ == "__main__":
    main()
