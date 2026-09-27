# -*- coding: utf-8 -*-
"""发布 v1.4.3 到 updates.septemc.com：稳定/测试两套源 + latest.json + nginx CORS。"""
import json
import os
import paramiko

HOST, PORT, USER, PASSWORD = "8.148.146.68", 50302, "root", "Root114514"
APK = r"apps/coomi-app/app/build/outputs/apk/release/coomi-app_apt-android-7-release_arm64-v8a.apk"
NAME = "Coomi-Android-arm64-v1.4.3.apk"
BASE = "/www/wwwroot/updates.septemc.com/coomi"
NOTES = """v1.4.3 更新说明【稳定】

- 检查更新双通道：新增「检查更新」二级页面，支持正式更新与测试更新（updates.septemc.com/coomi/android 与 /coomi/android_test）
- 工具调用更稳：兼容别名 XML 工具调用格式（<dots_function_call>/<invoke>）自动解析执行
- edit_file 容错：CRLF/行尾空白差异化匹配 + 失败引导重新读改；行级修改建议 apply_patch
- 会话内切模型 400 阶梯兜底，切换后会话保持连续
- Termux/proot 路径协同：文件导入返回 /workspace 别名路径并显式授权权限
- 崩溃采集：Java 异常 + logcat 快照落盘，Rust panic 记录 crash_rust.log
- 控制台设置四组分类；权限页两态按钮统一；二级页返回控制台"""
MANIFEST = {
    "versionCode": 33,
    "version": "1.4.3",
    "file": NAME,
    "channel": "stable",
    "date": "2026-08-24",
    "notes": NOTES,
}


def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=int(PORT), username=USER, password=PASSWORD,
                   timeout=30, allow_agent=False, look_for_keys=False)
    sftp = client.open_sftp()

    def run(cmd):
        stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
        out = stdout.read().decode("utf-8", "replace").strip()
        err = stderr.read().decode("utf-8", "replace").strip()
        if err and "warning" not in err.lower():
            print("ERR:", err[:300])
        return out

    for channel_dir in ("android", "android_test"):
        target_dir = f"{BASE}/{channel_dir}"
        run(f"mkdir -p {target_dir}")
        print(run(f"ls -ld {target_dir}"))

    # 上传 APK 到两个目录（与旧包同款命名）
    for channel_dir in ("android", "android_test"):
        target_dir = f"{BASE}/{channel_dir}"
        with open(APK, "rb") as f:
            sftp.putfo(f, f"{target_dir}/{NAME}")
        print(f"uploaded {channel_dir}/{NAME}")

    # sha256
    import hashlib
    hash_value = hashlib.sha256(open(APK, "rb").read()).hexdigest()
    for channel_dir in ("android", "android_test"):
        sftp.open(f"{BASE}/{channel_dir}/{NAME}.sha256", "w").write(hash_value)
        sftp.open(f"{BASE}/{channel_dir}/last.sha256", "w").write(hash_value)

    # latest.json（测试通道 channel 字段改 test）
    for channel_dir, channel in (("android", "stable"), ("android_test", "test")):
        manifest = dict(MANIFEST)
        manifest["channel"] = channel
        with sftp.open(f"{BASE}/{channel_dir}/latest.json", "w") as f:
            f.write(json.dumps(manifest, ensure_ascii=False, indent=2))
        print(f"latest.json -> {channel_dir}")

    # nginx CORS for the updates site (跨域供 App 内检查更新页直接 fetch)
    conf_path = "/www/server/panel/vhost/nginx/updates.septemc.com.conf"
    vhosts = run(f"ls /www/server/panel/vhost/nginx/ | grep updates")
    print("vhost files:", vhosts)
    conf = run(f"cat {conf_path}") if os.path.exists(conf_path) else ""
    if conf and "Access-Control-Allow-Origin" not in conf:
        # 在 server 块内 location / 之前插入 CORS 头（BT 配置通常为 ssl + server 块）
        new = conf.replace(
            "    location / {",
            "    add_header Access-Control-Allow-Origin * always;\n    add_header Access-Control-Allow-Methods 'GET, OPTIONS' always;\n    add_header Access-Control-Allow-Headers 'Content-Type' always;\n\n    location / {",
        )
        if new != conf:
            sftp.open(conf_path, "w").write(new)
            print("cors header added")
    else:
        print("cors already present or conf not found")

    run("chown -R www:www %s" % BASE)
    print("done")


if __name__ == "__main__":
    main()
