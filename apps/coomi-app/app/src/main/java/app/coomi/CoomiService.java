package app.coomi;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;

import com.termux.shared.logger.Logger;
import com.termux.shared.termux.TermuxConstants;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Owns deployment and lifecycle of the native coomi-rs process. */
public class CoomiService extends Service {

    private static final String LOG_TAG = "CoomiService";
    private static final int HEALTH_CHECK_TIMEOUT_MS = 2000;
    private static final int CMD_TIMEOUT_SEC = 30;
    /** ~/.profile 与 ~/.bashrc 里由 Coomi 管理的块标记：块内整体替换，块外保留用户内容。 */
    private static final String SHELL_BLOCK_START = "# >>> Coomi Android managed block >>>";
    private static final String SHELL_BLOCK_END = "# <<< Coomi Android managed block <<<";

    private final IBinder mBinder = new LocalBinder();
    private final ExecutorService mExecutor = Executors.newSingleThreadExecutor();

    private volatile Process mEngineProcess;
    private volatile int mEnginePort = CoomiConstants.DEFAULT_ENGINE_PORT;
    /** 每次引擎启动生成的随机访问令牌（WebView 经 URL query 注入，防同设备 app 直连）。 */
    private volatile String mEngineToken = "";
    private volatile boolean mIsEngineRunning;
    /** 引擎启动流程进行中（含部署检查/进程拉起/健康探测），供控制台显示「引擎启动中」。 */
    private volatile boolean mIsEngineStarting;
    private volatile boolean mUpdateInProgress;

    private static String prefix() { return TermuxConstants.TERMUX_PREFIX_DIR_PATH; }
    private static String home() { return TermuxConstants.TERMUX_HOME_DIR_PATH; }
    private static String preload() { return prefix() + "/lib/libtermux-exec-ld-preload.so"; }

    private static String termuxEnvironment() {
        return "export HOME=" + shellQuote(home())
            + " PREFIX=" + shellQuote(prefix())
            + " TMPDIR=" + shellQuote(prefix() + "/tmp")
            + " PATH=" + shellQuote(prefix() + "/bin:/system/bin")
            + " LD_LIBRARY_PATH=" + shellQuote(prefix() + "/lib")
            + " LD_PRELOAD=" + shellQuote(preload())
            + " COOMI_HOME=" + shellQuote(CoomiConstants.COOMI_CONFIG_DIR)
            + " COOMI_SHELL=" + shellQuote(prefix() + "/bin/bash")
            + " SSL_CERT_FILE=" + shellQuote(prefix() + "/etc/tls/cert.pem")
            + "; ";
    }

    private CommandResult execTermux(String command) {
        try {
            String shell = termuxEnvironment()
                + "exec " + shellQuote(prefix() + "/bin/bash") + " -lc " + shellQuote(command);
            ProcessBuilder builder = new ProcessBuilder("/system/bin/sh", "-c", shell);
            builder.redirectErrorStream(true);
            Process process = builder.start();
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) output.append(line).append('\n');
            }
            boolean exited = process.waitFor(CMD_TIMEOUT_SEC, TimeUnit.SECONDS);
            if (!exited) process.destroyForcibly();
            int code = exited ? process.exitValue() : -1;
            return new CommandResult(code == 0, output.toString().trim(), "", code);
        } catch (Exception e) {
            Logger.logError(LOG_TAG, "Termux command failed: " + e.getMessage());
            return new CommandResult(false, "", e.getMessage(), -1);
        }
    }

    public static class CommandResult {
        public final boolean success;
        public final String stdout;
        public final String stderr;
        public final int exitCode;

        public CommandResult(boolean success, String stdout, String stderr, int exitCode) {
            this.success = success;
            this.stdout = stdout == null ? "" : stdout;
            this.stderr = stderr == null ? "" : stderr;
            this.exitCode = exitCode;
        }
    }

    public interface ProgressCallback {
        void onStep(String message);
        void onError(String error);
        void onComplete();
    }

    public class LocalBinder extends Binder {
        public CoomiService getService() { return CoomiService.this; }
    }

    @Override public IBinder onBind(Intent intent) { return mBinder; }
    @Override public void onCreate() { Logger.logInfo(LOG_TAG, "Native service created"); }
    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }

    @Override
    public void onDestroy() {
        stopEngineSync();
        mExecutor.shutdownNow();
        super.onDestroy();
    }

    public static boolean isBootstrapInstalled() {
        return new File(prefix() + "/bin/bash").isFile();
    }

    public static boolean isDeployComplete() {
        return new File(CoomiConstants.INSTALL_MARKER_PATH).isFile()
            && new File(prefix() + "/bin/coomi").isFile();
    }

    private File nativeBinary() {
        return new File(getApplicationInfo().nativeLibraryDir, CoomiConstants.NATIVE_BINARY_NAME);
    }

    public String getRuntimeVersion() {
        CommandResult result = execTermux("coomi --version");
        return result.success ? result.stdout : result.stderr;
    }

    public void deployCoomi(ProgressCallback callback) {
        mExecutor.execute(() -> {
            mUpdateInProgress = true;
            try {
                File binary = nativeBinary();
                File web = ensureCurrentWebAssets();
                if (!binary.isFile()) {
                    callback.onError("APK 中缺少 ARM64 coomi-rs 二进制：" + binary.getAbsolutePath());
                    return;
                }
                if (!new File(web, "index.html").isFile()) {
                    callback.onError("APK 中缺少已构建的前端 web.zip");
                    return;
                }

                callback.onStep("准备 Rust 运行目录");
                CommandResult directories = execTermux(
                    "mkdir -p " + shellQuote(home() + "/.coomi/config")
                        + " " + shellQuote(home() + "/.coomi/sessions")
                        + " " + shellQuote(home() + "/coomi"));
                if (!directories.success) {
                    callback.onError("无法创建运行目录：" + directories.stdout);
                    return;
                }

                callback.onStep("部署 coomi-rs ARM64 二进制");
                CommandResult link = execTermux(
                    "ln -sf " + shellQuote(binary.getAbsolutePath())
                        + " " + shellQuote(prefix() + "/bin/coomi"));
                if (!link.success) {
                    callback.onError("无法部署 coomi-rs：" + link.stdout);
                    return;
                }

                callback.onStep("校验原生引擎");
                CommandResult version = execTermux("coomi --version");
                if (!version.success || !version.stdout.contains("coomi")) {
                    callback.onError("coomi-rs 无法启动：\n" + version.stdout + "\n" + version.stderr);
                    return;
                }
                callback.onStep(version.stdout);

                writeShellEnvironment();
                removeLegacyRuntimePayloads();
                try (FileWriter writer = new FileWriter(CoomiConstants.INSTALL_MARKER_PATH)) {
                    writer.write(version.stdout + "\n" + binary.getAbsolutePath() + "\n");
                }
                callback.onComplete();
            } catch (Exception e) {
                Logger.logError(LOG_TAG, "Native deployment failed: " + e.getMessage());
                callback.onError(e.getMessage());
            } finally {
                mUpdateInProgress = false;
            }
        });
    }

    /**
     * 把 Coomi 需要的环境变量写入 ~/.profile / ~/.bashrc。
     * 用「托管块」而非整文件覆盖：软件升级不会丢用户自定义的终端环境。
     */
    private void writeShellEnvironment() throws Exception {
        writeShellBlock(new File(home(), ".profile"),
            "# Created by Coomi Android\n"
                + "export PREFIX=\"" + prefix() + "\"\n"
                + "export HOME=\"" + home() + "\"\n"
                + "export COOMI_HOME=\"$HOME/.coomi\"\n"
                + "export COOMI_SHELL=\"$PREFIX/bin/bash\"\n"
                + "export SSL_CERT_FILE=\"$PREFIX/etc/tls/cert.pem\"\n"
                + "export PATH=\"$PREFIX/bin:$PATH\"\n"
                + "[ -f ~/.bashrc ] && . ~/.bashrc\n");
        writeShellBlock(new File(home(), ".bashrc"),
            "# Created by Coomi Android\n"
                + "export COOMI_HOME=\"$HOME/.coomi\"\n"
                + "export COOMI_SHELL=\"$PREFIX/bin/bash\"\n"
                + "export SSL_CERT_FILE=\"$PREFIX/etc/tls/cert.pem\"\n"
                + "alias ll='ls -la'\n");
    }

    /** 幂等合并写入：仅替换两个标记之间的托管块，块外用户内容原样保留。 */
    private void writeShellBlock(File file, String body) throws Exception {
        String existing = file.exists() ? readText(file) : "";
        // 旧版（无块标记）整文件都是 Coomi 生成的：整体迁移为新格式。
        // 旧版本来就是覆盖写，用户内容无从保留，一次性迁移后进入块保护。
        if (!existing.isEmpty() && !existing.contains(SHELL_BLOCK_START)
            && existing.contains("# Created by Coomi Android")) {
            existing = "";
        }
        String block = SHELL_BLOCK_START + "\n" + body + SHELL_BLOCK_END + "\n";
        if (existing.contains(SHELL_BLOCK_START)) {
            int start = existing.indexOf(SHELL_BLOCK_START);
            int end = existing.indexOf(SHELL_BLOCK_END, start);
            if (end >= 0) end += SHELL_BLOCK_END.length();
            else end = start; // 块未闭合（被用户截断过），从标记处截掉
            existing = existing.substring(0, start) + existing.substring(end);
        }
        String content = existing;
        if (!content.isEmpty() && !content.endsWith("\n")) content += "\n";
        content += block;
        try (FileWriter writer = new FileWriter(file)) {
            writer.write(content);
        }
    }

    private static String readText(File file) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    private void removeLegacyRuntimePayloads() {
        CoomiBootstrap.deleteRecursive(new File(getFilesDir(), "pysrc"));
        CoomiBootstrap.deleteRecursive(new File(getFilesDir(), "wheels"));
        new File(home() + "/.coomi/config.json").delete();
        new File(home() + "/.coomi/credentials.json").delete();
        new File(prefix() + "/share/coomi/install.sh").delete();
    }

    public void startEngine(Consumer<CommandResult> callback) {
        mExecutor.execute(() -> callback.accept(startEngineSync()));
    }

    /** 引擎自身写入的指纹（~/.coomi/engine.version，MD5+版本）是否与 APK 内二进制一致。 */
    private boolean engineMatchesApk() {
        try {
            File versionFile = new File(CoomiConstants.COOMI_CONFIG_DIR, "engine.version");
            if (!versionFile.isFile()) return false; // 旧引擎无指纹文件：视为不匹配，重启以加载新代码
            String recorded = new String(
                java.nio.file.Files.readAllBytes(versionFile.toPath()),
                java.nio.charset.StandardCharsets.UTF_8
            ).trim();
            String current = binaryFingerprint(nativeBinary());
            if (current.isEmpty()) return false;
            return recorded.startsWith(current);
        } catch (Exception e) {
            Logger.logError(LOG_TAG, "engine fingerprint check failed: " + e.getMessage());
            return true; // 读不到指纹时不冒险杀引擎
        }
    }

    /** 文件 MD5（十六进制小写）；失败返回空串。 */
    private static String binaryFingerprint(File file) {
        try (java.io.InputStream in = new java.io.FileInputStream(file)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private CommandResult startEngineSync() {
        mIsEngineStarting = true;
        try {
            if (mEngineProcess != null && mEngineProcess.isAlive()) {
                if (checkHealth(mEnginePort)) {
                    // 引擎进程活着且健康，但 APK 更新后引擎二进制可能已换新：
                    // 旧进程加载的还是旧代码（新旧 API 不匹配，前端会 404）。
                    // 对比引擎自身写入的二进制指纹，不一致则重启。
                    if (engineMatchesApk()) {
                        mIsEngineStarting = false;
                        return new CommandResult(true, "already running", "", 0);
                    }
                    Logger.logInfo(LOG_TAG, "Engine binary changed (APK updated), restarting engine");
                    stopEngineSync();
                } else {
                    // 进程活着但健康检查失败（假死/端口错乱）：先清理旧进程再重启，
                    // 避免双引擎并发写同一会话目录。
                    Logger.logInfo(LOG_TAG, "Engine process alive but unhealthy, killing before restart");
                    stopEngineSync();
                }
            }
            if (!isDeployComplete()) {
                mIsEngineStarting = false;
                return new CommandResult(false, "", "coomi-rs is not deployed", -1);
            }
            File binary = nativeBinary();
            File web = ensureCurrentWebAssets();
            if (!binary.isFile() || !new File(web, "index.html").isFile()) {
                mIsEngineStarting = false;
                return new CommandResult(false, "", "native binary or frontend is missing", -1);
            }

            int port = findFreePort();
            String token = generateToken();
            mEngineToken = token;
            String command = termuxEnvironment()
                + "export RUST_BACKTRACE=1; cd " + shellQuote(home()) + "; "
                + "exec >>" + shellQuote(CoomiConstants.ENGINE_LOG_PATH) + " 2>&1; "
                + "exec " + shellQuote(binary.getAbsolutePath())
                + " --home " + shellQuote(CoomiConstants.COOMI_CONFIG_DIR)
                + " --cwd " + shellQuote(home())
                + " serve --port " + port
                + " --token " + shellQuote(token)
                + " --static-dir " + shellQuote(web.getAbsolutePath());
            ProcessBuilder builder = new ProcessBuilder("/system/bin/sh", "-c", command);
            builder.redirectErrorStream(true);
            mEngineProcess = builder.start();
            mEnginePort = port;
            mIsEngineRunning = true;

            Process process = mEngineProcess;
            new Thread(() -> {
                try {
                    int code = process.waitFor();
                    Logger.logInfo(LOG_TAG, "coomi-rs exited with code " + code);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    if (mEngineProcess == process) {
                        mEngineProcess = null;
                        mIsEngineRunning = false;
                    }
                }
            }, "coomi-rs-waiter").start();

            return new CommandResult(true, "Engine started on port " + port, "", 0);
        } catch (Exception e) {
            mEngineProcess = null;
            mIsEngineRunning = false;
            return new CommandResult(false, "", e.getMessage(), -1);
        } finally {
            mIsEngineStarting = false;
        }
    }

    private synchronized File ensureCurrentWebAssets() throws Exception {
        File web = new File(getFilesDir(), CoomiConstants.WEB_DIR_BASENAME);
        File stampFile = new File(web, ".app-stamp");
        String expected = CoomiBootstrap.appStamp(this);
        String actual = "";
        if (stampFile.isFile()) {
            actual = new String(java.nio.file.Files.readAllBytes(stampFile.toPath()), java.nio.charset.StandardCharsets.UTF_8).trim();
        }
        if (!expected.equals(actual) || !new File(web, "index.html").isFile()) {
            CoomiBootstrap.deleteRecursive(web);
            int count = CoomiBootstrap.deployZipAsset(this, CoomiConstants.WEB_ASSET, web);
            if (count < 1 || !new File(web, "index.html").isFile()) {
                throw new IllegalStateException("无法部署 APK 内置前端");
            }
            try (FileWriter writer = new FileWriter(stampFile)) {
                writer.write(expected);
            }
        }
        return web;
    }

    public void stopEngine(Consumer<CommandResult> callback) {
        mExecutor.execute(() -> {
            stopEngineSync();
            if (callback != null) callback.accept(new CommandResult(true, "stopped", "", 0));
        });
    }

    private void stopEngineSync() {
        Process process = mEngineProcess;
        if (process != null) {
            process.destroy();
            try { process.waitFor(5, TimeUnit.SECONDS); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (process.isAlive()) process.destroyForcibly();
        }
        // 兜底：清掉可能残留的 coomi 进程（Rust 侧收到 SIGTERM 会先清理全部工具子进程）。
        // ^/[^ ]*libcoomi\.so 锚定引擎二进制路径开头，避免误匹配执行本命令的 shell 自身。
        try {
            execTermux("pkill -f '^/[^ ]*" + CoomiConstants.NATIVE_BINARY_NAME + "' 2>/dev/null; true");
        } catch (Exception ignored) { /* best-effort */ }
        mEngineProcess = null;
        mIsEngineRunning = false;
        mIsEngineStarting = false;
    }

    public void restartEngine(Consumer<CommandResult> callback) {
        mExecutor.execute(() -> {
            stopEngineSync();
            callback.accept(startEngineSync());
        });
    }

    public void getEngineStatus(Consumer<CommandResult> callback) {
        mExecutor.execute(() -> {
            // 启动流程进行中（无论进程是否已拉起）都报 starting，控制台显示「引擎启动中」。
            if (mIsEngineStarting) {
                callback.accept(new CommandResult(true, "starting", "", 0));
                return;
            }
            boolean alive = mIsEngineRunning && mEngineProcess != null && mEngineProcess.isAlive();
            String status = alive ? (checkHealth(mEnginePort) ? "running" : "starting") : "stopped";
            callback.accept(new CommandResult(true, status, "", 0));
        });
    }

    public boolean isUpdateInProgress() { return mUpdateInProgress; }
    public int getEnginePort() { return mEnginePort; }

    public static String readEngineLogTail(int count) {
        java.util.List<String> lines = new java.util.ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new FileReader(CoomiConstants.ENGINE_LOG_PATH))) {
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        } catch (Exception ignored) {
            return "";
        }
        StringBuilder output = new StringBuilder();
        for (int i = Math.max(0, lines.size() - count); i < lines.size(); i++) {
            output.append(lines.get(i)).append('\n');
        }
        return output.toString().trim();
    }

    private static int findFreePort() {
        // 随机高位端口（缩小同设备其它 app 枚举命中的概率）。
        java.util.Random random = new java.util.Random();
        for (int attempt = 0; attempt < 50; attempt++) {
            int port = 20000 + random.nextInt(40000);
            try (java.net.ServerSocket socket = new java.net.ServerSocket(port)) {
                return socket.getLocalPort();
            } catch (Exception ignored) {}
        }
        return CoomiConstants.DEFAULT_ENGINE_PORT;
    }

    /** 生成 128 位十六进制随机令牌（Android 端与 WebView 共享，不落盘不写 JS）。 */
    private static String generateToken() {
        byte[] bytes = new byte[64];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    public String getEngineToken() { return mEngineToken; }

    private boolean checkHealth(int port) {
        try {
            // health 端点已由引擎免认证放行（仅返回最小字段），无需携带令牌。
            HttpURLConnection connection = (HttpURLConnection) new URL(
                "http://127.0.0.1:" + port + CoomiConstants.HEALTH_ENDPOINT).openConnection();
            connection.setConnectTimeout(HEALTH_CHECK_TIMEOUT_MS);
            connection.setReadTimeout(HEALTH_CHECK_TIMEOUT_MS);
            int responseCode = connection.getResponseCode();
            connection.disconnect();
            return responseCode == 200;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }
}
