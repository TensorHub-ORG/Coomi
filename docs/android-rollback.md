# Android 保留数据回退

Android 普通安装器会拒绝比已安装应用 `versionCode` 更低的 APK；修改更新提示无法绕过这一限制。`versionName` 是展示版本，可回到稳定版名称。支持的回退方式是：**用已验证的旧版源码重新构建相同包名、相同签名、较高 `versionCode` 的回退包**。参见 [Android 版本管理文档](https://developer.android.com/studio/publish/versioning)。

1. 在独立工作目录检出需要恢复的稳定版本。旧版本如果没有本构建参数，先移植 `app/build.gradle` 中的版本覆盖逻辑和 `printVersionInfo` 任务。保留该稳定版本对应的前端、Rust 引擎和运行时资源，不能只修改版本名称。
2. 查询需要覆盖的手机和已发布测试包的最大 `versionCode`，分配一个更大的新值，并在后续正式版本继续递增。手机连接后可用 `adb shell dumpsys package com.coomi.android` 查看 `versionCode`。不要设置 `COOMI_DEV_BUILD=1`，其包名不同，不能覆盖 Coomi。
3. 使用原发布签名配置构建；本参数不会改变签名或包名。在仓库根目录执行以下 PowerShell 命令（版本号只是示例，必须按实际发布记录调整）：

   ```powershell
   $rollbackVersionCode = 100 # 示例：必须大于要覆盖的所有版本
   .\gradlew.bat :app:printVersionInfo "-PcoomiVersionCode=$rollbackVersionCode"
   .\gradlew.bat :app:assembleRelease "-PcoomiVersionCode=$rollbackVersionCode"
   ```

   `-PcoomiVersionCode` 优先于环境变量 `COOMI_VERSION_CODE`。未设置时保持源码默认版本号；显式无效值会中止构建。范围为 `1..2100000000` 的十进制整数。默认保留源码的 `versionName`；如需标明回退构建，可在同一个终端设置现有的 `TERMUX_APP_VERSION_NAME`，例如 `1.4.7+rollback.100`。
4. 检查 APK 的实际版本、包名和签名，先在保有新版本数据的测试设备上覆盖安装并验证启动、会话、配置和虚拟环境。较高 `versionCode` 解决的是安装限制，旧代码是否兼容新数据仍需验证，不能承诺任意版本无损回退。通过验证后再发布，并让更新源的版本名称、版本代码、APK 地址和校验值与 APK 一致。

不要通过卸载、清除数据或切换签名来“回退”。本能力不会把已发布的低版本 APK 自动变成可覆盖安装的包，也不会自动生成或发布某个稳定版回退包。
