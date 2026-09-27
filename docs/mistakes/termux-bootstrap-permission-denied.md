# Termux bootstrap `Permission denied` 复盘

## 事故概述

Coomi-Android 1.2.6 将 `targetSdkVersion` 从 28 提升到 36。应用仍把 Termux bootstrap 解压到私有可写目录，并从以下路径启动 shell：

```text
/data/data/com.coomi.android/files/usr/bin/bash
```

Android 会根据目标 SDK 为普通应用选择 SELinux 执行域。target 29 及以上的普通应用不能执行私有可写目录中的代码，因此安装向导报错：

```text
/system/bin/sh: /data/data/com.coomi.android/files/usr/bin/bash: Permission denied
```

这不是通知权限、Root 权限、文件模式或网络问题。`chmod 0700` 不能绕过 SELinux 策略。

## 为什么第一次修复仍然失败

把 APK 改回 target 28 后使用 `adb install -r` 覆盖安装，`dumpsys package` 已显示 target 28，但进程仍处于旧的 `u:r:untrusted_app` 域。Android 不会通过覆盖安装降低既有共享 UID 的安全域，以免应用利用降级逃逸新策略。

另一个误判来自 `run-as`：它运行在 `u:r:runas_app` 域，能够执行 bash，并不能证明普通应用进程也能执行。验证必须观察真实应用 PID 的 SELinux 域，并让安装向导自身完成命令。

## 最终修复

1. 将两个 Gradle 入口的 `targetSdkVersion` 恢复为 28，`compileSdkVersion` 保持 36。
2. 在应用 Gradle 配置中加入硬保护，target SDK 高于 28 时直接中止构建。
3. bootstrap 完整性检查同时验证 `bash` 存在且具有执行位，损坏安装会自动重装。
4. 对曾安装 target 36 构建的设备执行一次干净卸载和重装，使新 UID 进入 `u:r:untrusted_app_27`。
5. Root 保持为可选能力探测，不参与 bootstrap 安装判定。

## 正确验收方法

```text
1. aapt dump badging：确认 APK targetSdkVersion=28。
2. ps -AZ：确认真实 Coomi 进程为 untrusted_app_27，而不是 runas_app。
3. 由 CoomiSetupActivity 自身执行部署，不使用 run-as 代测。
4. 确认 ~/.coomi_deployed 存在并记录 coomi 版本与 APK 原生库路径。
5. 确认安装向导自动进入模型配置，日志没有 Coomi 相关 Permission denied。
```

## 发布检查清单

- 不得把 Termux 架构的 target SDK 直接提升到 29 以上；如需提升，必须先把所有可执行文件和动态库迁移到 APK 只读可执行区域并完成全链路验证。
- 升级测试必须覆盖“旧版覆盖安装”和“干净安装”，两者的 SELinux 状态可能不同。
- `File.canExecute()`、Unix 文件模式和 `run-as` 都不是应用进程可执行性的充分证明。
- 修改 target SDK 后必须记录应用 PID 的 SELinux 域。
- 发布说明应明确：安装过错误 target 36 构建且仍报权限错误的设备，需要先备份，再卸载重装修复版。
