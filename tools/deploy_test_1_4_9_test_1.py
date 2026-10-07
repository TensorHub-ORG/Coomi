# -*- coding: utf-8 -*-
"""发布 v1.4.9-test.1 到测试通道 updates.septemc.com/coomi/android_test 并更新官网测试版说明。"""
import hashlib
import json
import os
import re
import sys
import time

import paramiko

SSH_CFG = r"F:\_WorkSpace\Projects\AILab\SSH-Agent\ssh-configs\ssh-8.148.146.68-2C2G-阿里云.txt"
APK_LOCAL = r"apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk"
NAME = "Coomi-Android-arm64-v1.4.9-test.1-80.apk"
BASE = "/www/wwwroot/updates.septemc.com/coomi/android_test"
SITE_PATH = "/www/wwwroot/coomi.septemc.com/index.html"

VERSION = "1.4.9-test.1"
VERSION_CODE = 80
HEADING = "v1.4.9-test.1 更新说明【测试】"

NOTES = """v1.4.9-test.1 更新说明【测试】

本版基于 Comax 1.5.1o2 社区魔改底座（鸣谢 晚风 / maxtwin114514）合并 1.4.8 官方功能层，重点优化交互与修复引擎缺陷。

交互与界面：
1. 模型可用列表自动检查改为提供商设置里的开关，默认关闭——激活/切换模型不再因不可用供应商报 404。
2. 顶栏模型选择卡改为先按供应商分组，组内再按文本 / 图像理解 / 图像生成三区，切模型更快定位。
3. 设置页新增顶部标签（对话 / 连接与模型 / 应用），12 个设置分区归类收纳，不再挤成一页。
4. 返回逻辑全面统一：会话页返回 → 控制台；控制台主页返回 → 退到桌面；其余页面记住层级逐级返回；硬件返回键与页面内返回按钮行为完全一致。
5. 右缘阴影渐变视觉清理，恢复可见滚动条。
6. 推理强度粒子特效回归（1.4.8 同款，档位越高粒子越强），并支持系统减弱动效降级。

动画与稳定性：
7. 发送水滴动画重写：逐帧跟随目标气泡（自动滚动 / 键盘弹出不再错位）。
8. 引擎修复：DeepSeek 流式工具调用函数名缺失导致的「unknown / 工具参数纠正后仍未通过校验」失败——现在兼容 arguments 对象下发、从 arguments 内恢复函数名、并以正文 JSON 工具调用兜底。
9. 修复点击模型不生效：/select-model 端点的凭据校验已受「自动检查」开关控制。
10. 发送水滴特效按反馈移除，消息发出后立即渲染。
11. 右缘阴影渐变直接全部去除（不做软化）。
12. 顶栏供应商标签与设置页分类标签支持横向滑动。

底层升级（来自 Comax 1.5.1o2）：无障碍控制模式（让 Coomi 替你操作屏幕 + 桌面悬浮层 + Shizuku 兜底）、上下文压缩增强提示词、Provider 多 API Key 轮换、并行会话修复、DeepSeek 官方模型空 assistant 消息 400 修复等。

v1.5.1o2（Comax）合并说明【测试】

本次为社区魔改版 Comax 与官方 Coomi 的合并版本：保留官方双通道更新、AI 工作室、提示词库、Git 面板、数据运维等全部能力，同时引入 Comax 的控制模式、上下文压缩增强、多 API Key 轮换等特性。合并基于 Comax 1.5.1o2 源码与官方 v1.4.5 稳定基线完成三方合入，冲突 51 处全部人工解决。"""


def parse_ssh_config(path):
    ip = port = user = pwd = None
    for line in open(path, encoding="utf-8", errors="replace"):
        raw = line.strip().lstrip("-*· ").strip()
        if ":" not in raw and "：" not in raw:
            continue
        key, _, value = raw.partition("：" if "：" in raw else ":")
        key, value = key.strip(), value.strip()
        if not value:
            continue
        if "IP" in key and ip is None:
            ip = value
        elif "端口" in key and port is None:
            port = value
        elif "用户名" in key and user is None:
            user = value
        elif key == "密码" and pwd is None:
            pwd = value
    assert ip and pwd, "无法解析 SSH 配置"
    return {"host": ip, "port": int(port or 22), "user": user or "root", "password": pwd}


def main():
    cfg = parse_ssh_config(SSH_CFG)
    size = os.path.getsize(APK_LOCAL)
    digest = hashlib.sha256(open(APK_LOCAL, "rb").read()).hexdigest()

    manifest = {
        "versionCode": VERSION_CODE,
        "version": VERSION,
        "file": NAME,
        "channel": "test",
        "platform": "android",
        "arch": "arm64-v8a",
        "minAndroid": "7.0",
        "date": "2026-10-07",
        "size": size,
        "sha256": digest,
        "notes": NOTES,
    }

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(cfg["host"], port=cfg["port"], username=cfg["user"],
                   password=cfg["password"], timeout=30,
                   allow_agent=False, look_for_keys=False)
    sftp = client.open_sftp()

    def run(cmd, timeout=300):
        _, out, err = client.exec_command(cmd, timeout=timeout)
        o = out.read().decode("utf-8", "replace").strip()
        e = err.read().decode("utf-8", "replace").strip()
        if e and "warning" not in e.lower():
            print("ERR:", e[:300])
        return o

    run(f"mkdir -p {BASE}")
    print(run(f"cp {BASE}/latest.json {BASE}/latest.json.bak-1_4_9_test_1 2>/dev/null; "
              f"cp {BASE}/versions.json {BASE}/versions.json.bak-1_4_9_test_1 2>/dev/null; "
              f"cp {SITE_PATH} {SITE_PATH}.bak-1_4_9_test_1 2>/dev/null; echo backed-up"))

    # APK 上传（大文件，带进度）
    temporary_apk = f"{BASE}/{NAME}.upload"
    last = [0.0]

    def progress(done, total):
        now = time.monotonic()
        if not total or now - last[0] >= 20 or done == total:
            pct = f"{done / total:.0%}" if total else f"{done}B"
            print(f"APK upload: {done}/{total} ({pct})", flush=True)
            last[0] = now

    with open(APK_LOCAL, "rb") as f:
        sftp.putfo(f, temporary_apk, callback=progress)
    remote_digest = run(f"sha256sum {BASE}/{NAME}.upload").split()[0]
    if remote_digest != digest:
        raise SystemExit("上传后 SHA256 不匹配")
    sftp.chmod(temporary_apk, 0o644)
    sftp.posix_rename(temporary_apk, f"{BASE}/{NAME}")
    sftp.open(f"{BASE}/{NAME}.sha256", "w").write(digest + "\n")
    sftp.open(f"{BASE}/last.sha256", "w").write(digest + "\n")
    with sftp.open(f"{BASE}/latest.json", "w") as f:
        f.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print("APK + latest.json uploaded")

    # versions.json 追加
    old = {}
    try:
        with sftp.open(f"{BASE}/versions.json") as f:
            old = json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        pass
    versions = [v for v in old.get("versions", []) if v.get("file") != NAME]
    old["versions"] = [{"version": f"v{VERSION}", "file": NAME}] + versions
    old["channel"] = "android_test"
    with sftp.open(f"{BASE}/versions.json", "w") as f:
        f.write(json.dumps(old, ensure_ascii=False, indent=2) + "\n")
    print("versions.json:", [v["version"] for v in old["versions"]][:5])

    # 官网测试版区块：插入新版本说明，旧版折叠进历史
    with sftp.open(SITE_PATH) as f:
        site = f.read().decode("utf-8", errors="replace")
    if HEADING not in site:
        marker = "移动端测试版"
        mi = site.find(marker)
        assert mi > 0, "官网未找到测试版区块"
        # 找到测试版区块内的第一个 <details>（历史折叠容器）或其后第一个插入点
        block_start = site.index("\n", mi) + 1
        new_block = f"""
        <div class="rel-head"><strong>{HEADING}</strong><span class="rel-date">2026-10-07</span></div>
        <ul class="rel-list">
          <li>模型可用列表自动检查改为提供商设置里的开关（默认关闭），激活/切换模型不再因不可用供应商报 404。</li>
          <li>顶栏模型选择卡改为先按供应商分组，组内再按文本 / 图像理解 / 图像生成三区。</li>
          <li>设置页新增顶部标签（对话 / 连接与模型 / 应用），12 个分区归类收纳。</li>
          <li>返回逻辑全面统一：会话页返回 → 控制台；控制台主页返回 → 退到桌面；其余页面记住层级逐级返回。</li>
          <li>右缘阴影渐变视觉清理，恢复可见滚动条。</li>
          <li>推理强度粒子特效回归（1.4.8 同款，档位越高粒子越强）。</li>
          <li>发送水滴动画重写：逐帧跟随目标气泡，落点精准，到达后水波波纹发散。</li>
          <li>引擎修复：DeepSeek 流式工具调用函数名缺失导致的 unknown 失败。</li>
          <li>底层合并 Comax 1.5.1o2：无障碍控制模式、上下文压缩增强、多 API Key 轮换等（鸣谢社区魔改作者 晚风）。</li>
        </ul>
"""
        site = site[:block_start] + new_block + site[block_start:]
        with sftp.open(SITE_PATH + ".new", "w") as f:
            f.write(site.encode("utf-8"))
        sftp.chmod(SITE_PATH + ".new", 0o644)
        sftp.posix_rename(SITE_PATH + ".new", SITE_PATH)
        print("site index.html updated")
    else:
        print("site already contains", HEADING)

    run(f"chown -R www:www {BASE} {SITE_PATH}")

    # 回读验证
    out = run(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1/coomi/android_test/{NAME} -H 'Host: updates.septemc.com'")
    print("APK http:", out)
    lj = json.loads(run(f"curl -s http://127.0.0.1/coomi/android_test/latest.json -H 'Host: updates.septemc.com'"))
    print("latest.json:", lj["version"], lj["versionCode"], lj["channel"], "notes-len", len(lj["notes"]))
    out = run(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1/index.html -H 'Host: coomi.septemc.com'")
    print("site http:", out)
    ok = run(f"curl -s http://127.0.0.1/index.html -H 'Host: coomi.septemc.com' | grep -c '{HEADING}'")
    print("site heading count:", ok)
    client.close()
    print("DEPLOY DONE")


if __name__ == "__main__":
    main()
