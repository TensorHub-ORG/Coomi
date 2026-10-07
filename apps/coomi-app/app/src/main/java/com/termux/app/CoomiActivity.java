package com.termux.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.content.res.Configuration;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import com.termux.BuildConfig;

import app.coomi.CoomiConstants;
import app.coomi.CoomiDemo;
import app.coomi.CoomiEngineMonitor;
import app.coomi.CoomiAccessibilityService;
import app.coomi.CoomiFloatService;
import app.coomi.CoomiService;
import app.coomi.CoomiDashboardActivity;
import app.coomi.CoomiSetupActivity;
import app.coomi.CoomiTheme;
import app.coomi.ShizukuAccessController;
import com.termux.R;
import com.termux.shared.logger.Logger;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Coomi chat screen — hosts the Vue frontend served by coomi-rs.
 *
 * The heavy lifting lives in {@link CoomiService}: it deploys the native executable,
 * starts {@code coomi serve} and reports the port it bound to. This activity
 * only waits for the engine to answer its health endpoint, then points the WebView at it.
 */
public class CoomiActivity extends Activity {

    private static final String LOG_TAG = "CoomiActivity";
    private static final int REQUEST_IMPORT_FILES = 2101;
    private static final int REQUEST_AUTHORIZE_TREE = 2102;
    private static final int REQUEST_EXPORT_FILE = 2103;
    private static final int REQUEST_SAVE_IMAGE = 2104;
    private static final int REQUEST_OVERLAY_PERMISSION = 2105;
    /** 旧系统（API < 29）走 SAF 保存对话框时的待写图片数据。 */
    private byte[] mPendingImageBytes;
    private String mPendingImageName;

    /** Intent extra：直达前端 hash 路由，如 "#/catalog"。 */
    public static final String EXTRA_ROUTE = "coomi.route";
    public static final String EXTRA_PREFILL_DRAFT = "coomi.prefill_draft";
    /** Return to the setup wizard instead of the dashboard when leaving a setup route. */
    public static final String EXTRA_RETURN_TO_SETUP = "coomi.return_to_setup";

    private WebView mWebView;
    private View mSplash;
    private View mSplashSpinner;
    private TextView mLoadingText;
    private TextView mLoadingDetail;
    private Button mRetryButton;

    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private CoomiService mCoomiService;
    private boolean mBound;
    private boolean mStartRequested;
    private boolean mPageLoaded;
    private int mAutomaticRecoveryAttempts;
    private String mPendingExportPath;
    private String mPendingExportName;
    private String mPendingImportRequestId;
    private String mPendingExportRequestId;
    private final Runnable mExportTimeout = () -> {
        if (mPendingExportRequestId == null) return;
        String requestId = mPendingExportRequestId;
        clearPendingExport();
        emitTransferProgress("导出失败：系统导出窗口 30 秒未响应", 0);
        emitFileExported(requestId, null);
    };
    private String mAppliedThemeMode;

    private final ServiceConnection mConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            mCoomiService = ((CoomiService.LocalBinder) service).getService();
            mBound = true;
            ensureEngineRunning();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            mCoomiService = null;
            mBound = false;
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        CoomiTheme.applyWebTheme(this);
        super.onCreate(savedInstanceState);
        mAppliedThemeMode = CoomiTheme.getMode(this);
        setContentView(R.layout.activity_coomi);
        CoomiTheme.applySystemBars(this);
        mWebView = findViewById(R.id.coomi_webview);
        mSplash = findViewById(R.id.coomi_splash);
        mSplashSpinner = findViewById(R.id.coomi_splash_spinner);
        mLoadingText = findViewById(R.id.coomi_loading_text);
        mLoadingDetail = findViewById(R.id.coomi_loading_detail);
        mRetryButton = findViewById(R.id.btn_coomi_retry);
        mRetryButton.setOnClickListener(v -> retryStart());
        configureWebView();

        showLoading(getString(R.string.coomi_starting));

        // 演示包不启动引擎，直接使用 APK 里的前端。
        if (CoomiDemo.isEnabled()) {
            startDemo();
            return;
        }

        // Keep the engine alive while the user is away from the app.
        startService(new Intent(this, CoomiEngineMonitor.class));

        // DeepSeek 验证码登录需要官方 PoW 求解器常驻（与引擎同目录文件队列）。
        try {
            app.coomi.CoomiPowService.start(this);
        } catch (Throwable ignored) {
            // PoW 服务不可用不影响其它功能，验证码登录会退回明确报错。
        }

        Intent intent = new Intent(this, CoomiService.class);
        startService(intent);
        bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        navigateToRoute(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        String currentMode = CoomiTheme.getMode(this);
        if (mAppliedThemeMode == null || !mAppliedThemeMode.equals(currentMode)) {
            mAppliedThemeMode = currentMode;
        }
        applyThemeToWebView();
        CoomiTheme.applySystemBars(this);
    }

    /**
     * 演示模式的「启动」：把 web.zip 解到 filesDir/web，然后加载 https://coomi.local/。
     * 请求全部由 {@link CoomiDemo#serve} 就地应答，不出网、不碰引擎。
     */
    private void startDemo() {
        showLoading(getString(R.string.coomi_demo_loading));
        new Thread(() -> {
            final File dir = CoomiDemo.ensureWebDir(this);
            runOnUiThread(() -> {
                if (mWebView == null) return;
                if (dir == null) {
                    showFailure(getString(R.string.coomi_demo_failed), null);
                    return;
                }
                mPageLoaded = true;
                mWebView.loadUrl(CoomiDemo.START_URL);
            });
        }).start();
    }

    /** Start the engine unless it is already up, then wait for health. */
    private void ensureEngineRunning() {
        if (mStartRequested || mCoomiService == null) return;
        mStartRequested = true;

        mCoomiService.getEngineStatus(status -> {
            if ("running".equals(status.stdout)) {
                onEngineReady(mCoomiService.getEnginePort());
                return;
            }
            showLoading(getString(R.string.coomi_engine_starting));
            mCoomiService.startEngine(result -> {
                if (!result.success) {
                    attemptAutomaticRecovery();
                    return;
                }
                waitForEngine();
            });
        });
    }

    private void attemptAutomaticRecovery() {
        if (mCoomiService != null && mAutomaticRecoveryAttempts < 1) {
            mAutomaticRecoveryAttempts++;
            showLoading(getString(R.string.coomi_engine_starting));
            mCoomiService.restartEngine(result -> {
                if (result.success) waitForEngine();
                else showFailure(getString(R.string.coomi_engine_exited), null);
            });
            return;
        }
        showFailure(getString(R.string.coomi_engine_exited), null);
    }

    /** 失败后允许原地重试，否则用户只能杀进程。 */
    private void retryStart() {
        mStartRequested = false;
        runOnUiThread(() -> {
            mRetryButton.setVisibility(View.GONE);
            mLoadingDetail.setVisibility(View.GONE);
            mSplashSpinner.setVisibility(View.VISIBLE);
        });
        if (CoomiDemo.isEnabled()) {
            startDemo();
            return;
        }
        showLoading(getString(R.string.coomi_engine_starting));
        ensureEngineRunning();
    }

    /** Poll the service until the bridge answers, surfacing log tails as progress. */
    private void waitForEngine() {
        final long deadline = System.currentTimeMillis()
            + CoomiConstants.ENGINE_START_TIMEOUT_SEC * 1000L;

        Runnable poll = new Runnable() {
            @Override
            public void run() {
                if (mCoomiService == null) return;
                mCoomiService.getEngineStatus(status -> {
                    if ("running".equals(status.stdout)) {
                        onEngineReady(mCoomiService.getEnginePort());
                        return;
                    }
                    if ("stopped".equals(status.stdout)) {
                        attemptAutomaticRecovery();
                        return;
                    }
                    if (System.currentTimeMillis() > deadline) {
                        attemptAutomaticRecovery();
                        return;
                    }
                    mHandler.postDelayed(this, 2000);
                });
            }
        };
        mHandler.postDelayed(poll, 1000);
    }

    private void onEngineReady(int port) {
        if (mPageLoaded) return;
        mPageLoaded = true;
        Logger.logInfo(LOG_TAG, "Engine ready on port " + port);
        // 访问令牌：由 Android 侧注入 URL query，前端 JS 读取后用于所有 API/WS 调用。
        String token = mCoomiService != null ? mCoomiService.getEngineToken() : "";
        // 支持从控制台直达特定前端路由（如 SKILL/MCP 管理页 #/catalog）。
        String route = getIntent().getStringExtra(EXTRA_ROUTE);
        String prefill = getIntent().getStringExtra(EXTRA_PREFILL_DRAFT);
        String url = "http://127.0.0.1:" + port + "/?token=" + token
            + (route != null && route.startsWith("#") ? route : "");
        final String target = url;
        runOnUiThread(() -> {
            mWebView.loadUrl(target);
            if (prefill != null && !prefill.isEmpty()) {
                mWebView.postDelayed(() -> mWebView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('coomi:prefill-draft',{detail:{sessionId:window.__coomiSessionId||'',text:" + JSONObject.quote(prefill) + "}}))", null), 800);
            }
        });
    }

    /** Reused singleTask instances switch SPA routes without reloading the WebView. */
    private void navigateToRoute(Intent intent) {
        if (mWebView == null || !mPageLoaded || intent == null) return;
        String route = intent.getStringExtra(EXTRA_ROUTE);
        String prefill = intent.getStringExtra(EXTRA_PREFILL_DRAFT);
        runOnUiThread(() -> {
            if (route != null && route.startsWith("#/")) {
                mWebView.evaluateJavascript("window.location.hash=" + JSONObject.quote(route.substring(1)), null);
            }
            if (prefill != null && !prefill.isEmpty()) {
                mWebView.postDelayed(() -> mWebView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('coomi:prefill-draft',{detail:{text:" + JSONObject.quote(prefill) + "}}))", null), 350);
            }
        });
    }

    private void configureWebView() {
        WebSettings s = mWebView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // The bridge serves everything over loopback HTTP; no local file access needed.
        s.setAllowContentAccess(false);
        s.setAllowFileAccess(false);
        // 调试端口仅在 debug 构建开启：release 构建不经调试端口暴露页面内存中的令牌/密钥。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        mWebView.addJavascriptInterface(new AndroidBridge(), "CoomiAndroid");

        mWebView.setWebViewClient(new WebViewClient() {
            /** 演示包用假域名装本地文件；正式包不拦，让它照常走 loopback。 */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if ("/__coomi_appearance/chat-background".equals(request.getUrl().getPath())) {
                    try {
                        String mimeType = CoomiTheme.backgroundMimeType(
                            CoomiActivity.this, CoomiTheme.SURFACE_CHAT);
                        InputStream background = CoomiTheme.openBackground(
                            CoomiActivity.this, CoomiTheme.SURFACE_CHAT);
                        if (background == null) return null;
                        return new WebResourceResponse(
                            mimeType,
                            null,
                            background);
                    } catch (Exception ignored) {
                        return null;
                    }
                }
                if (!CoomiDemo.isEnabled()) return null;
                return CoomiDemo.serve(CoomiActivity.this, request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 前端已经可见了，整块闪屏一起收掉，避免残留的 spinner 盖在页面上。
                mSplash.setVisibility(View.GONE);
                mWebView.setVisibility(View.VISIBLE);
                // 页面加载完把系统深浅色同步给前端（重新加载会清掉之前注入的属性）。
                applyThemeToWebView();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if ("coomi".equals(request.getUrl().getScheme())
                    && "dashboard".equals(request.getUrl().getHost())) {
                    openDashboard();
                    return true;
                }
                // 外部链接（非本机 loopback）交给系统浏览器，避免远程页面留在 WebView
                // 内继续持有 JS bridge（防跨域调用 openFile/exportFile 等敏感桥方法）。
                String host = request.getUrl().getHost();
                if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) {
                    try {
                        Intent external = new Intent(Intent.ACTION_VIEW, request.getUrl());
                        startActivity(external);
                    } catch (Exception ignored) { /* 无浏览器则留在 WebView */ }
                    return true;
                }
                return false;
            }
        });
    }

    /** 主状态行：一行短文案，顺手清掉上一次失败留下的日志和重试按钮。 */
    private void showLoading(String text) {
        runOnUiThread(() -> {
            if (mLoadingText == null) return;
            mLoadingText.setTextColor(ContextCompat.getColor(mLoadingText.getContext(),
                CoomiTheme.isDark(CoomiActivity.this) ? R.color.coomi_night_text_2 : R.color.coomi_text_2));
            mLoadingText.setText(text);
            mLoadingDetail.setVisibility(View.GONE);
            mRetryButton.setVisibility(View.GONE);
            mSplashSpinner.setVisibility(View.VISIBLE);
        });
    }

    /** 副状态行：等引擎的时候把日志尾巴显出来，让等待有内容可看。 */
    private void showDetail(String detail) {
        runOnUiThread(() -> {
            if (mLoadingDetail == null) return;
            if (TextUtils.isEmpty(detail)) {
                mLoadingDetail.setVisibility(View.GONE);
                return;
            }
            mLoadingDetail.setText(detail.trim());
            mLoadingDetail.setVisibility(View.VISIBLE);
        });
    }

    /** 失败终态：只显示可操作的用户文案，诊断信息留在日志中。 */
    private void showFailure(String message, String detail) {
        runOnUiThread(() -> {
            if (mLoadingText == null) return;
            mLoadingText.setTextColor(ContextCompat.getColor(mLoadingText.getContext(),
                CoomiTheme.isDark(CoomiActivity.this) ? R.color.coomi_night_danger : R.color.coomi_danger));
            mLoadingText.setText(message);
            mSplashSpinner.setVisibility(View.GONE);
            mRetryButton.setVisibility(View.VISIBLE);
            mLoadingDetail.setVisibility(View.GONE);
        });
    }

    private void openDashboard() {
        if (getIntent().getBooleanExtra(EXTRA_RETURN_TO_SETUP, false)) {
            Intent intent = new Intent(this, CoomiSetupActivity.class);
            intent.putExtra(CoomiSetupActivity.EXTRA_START_STEP, CoomiConstants.STEP_AUTH);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
            finish();
            return;
        }
        // Persist the current streamed timeline before covering the WebView. The activity stays
        // alive behind the dashboard, so its websocket and the running agent remain attached.
        evaluateJavascript("window.dispatchEvent(new Event('coomi:flush-persistence'))");
        Intent intent = new Intent(this, CoomiDashboardActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        startActivity(intent);
        // 返回动画与系统设置页（运行权限/手机存储访问）一致：
        // 复刻 framework 的 activity_close_enter / activity_close_exit 源码动画。
        overridePendingTransition(R.anim.coomi_activity_close_enter, R.anim.coomi_activity_close_exit);
    }

    /** 是否深色：按三档主题偏好（system 跟随系统）计算，Web 内容与原生状态栏共用。 */
    private boolean isDark() {
        return CoomiTheme.isDark(this);
    }

    /** 把深浅色写入 <html data-theme>，前端 global.css 据此切换暗色主题。 */
    private void applyThemeToWebView() {
        if (mWebView == null) return;
        String mode = CoomiTheme.getMode(this);
        String webTheme = CoomiTheme.MODE_SYSTEM.equals(mode) ? (isDark() ? "dark" : "light") : mode;
        String appearance = CoomiTheme.appearanceJson(this);
        runOnUiThread(() -> evaluateJavascript(
            "document.documentElement.setAttribute('data-theme','" + webTheme + "');"
                + "window.__coomiApplyAppearance&&window.__coomiApplyAppearance(" + appearance + ")"));
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 系统切换深浅色时实时同步到 Web 内容（configChanges 含 uiMode，Activity 不重建）。
        // 跟随系统档位下状态栏颜色也随之刷新；手动档位不受系统变化影响。
        if (CoomiTheme.MODE_SYSTEM.equals(CoomiTheme.getMode(this))) {
            runOnUiThread(() -> CoomiTheme.applySystemBars(this));
        }
        applyThemeToWebView();
    }

    private final ShizukuAccessController shizukuController = new ShizukuAccessController();
    private volatile String pendingShizukuCommand = null;

    /** 控制模式：用 Shizuku 执行 shell 命令（input 点击/粘贴/发送）。 */
    private String runShizukuCommand(String command) {
        if (command == null || command.isEmpty()) return "";
        try {
            if (shizukuController.getStatus().status != ShizukuAccessController.Status.GRANTED) {
                // 未授权：记住本次命令，请求授权；授权成功后自动重试。
                pendingShizukuCommand = command;
                shizukuController.request(result -> runOnUiThread(() -> {
                    if (result.status == ShizukuAccessController.Status.GRANTED) {
                        Toast.makeText(CoomiActivity.this, "Shizuku 已授权，正在执行", Toast.LENGTH_SHORT).show();
                        String pending = pendingShizukuCommand;
                        pendingShizukuCommand = null;
                        if (pending != null) new Thread(() -> runShizukuCommand(pending)).start();
                    } else {
                        pendingShizukuCommand = null;
                        Toast.makeText(CoomiActivity.this, "Shizuku 未授权：" + result.message, Toast.LENGTH_SHORT).show();
                    }
                }));
                return "waiting_auth";
            }
            // 使用 ShizukuRemoteProcess 执行（Shizuku API 13 提供）
            try {
                rikka.shizuku.ShizukuRemoteProcess proc = rikka.shizuku.Shizuku.newProcess(
                    new String[]{"/system/bin/sh", "-c", command}, null, null);
                if (proc != null) {
                    java.io.BufferedReader reader = new java.io.BufferedReader(
                        new java.io.InputStreamReader(proc.getInputStream()));
                    StringBuilder output = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) output.append(line).append('\n');
                    int code = proc.waitFor();
                    return "exit=" + code + " " + output.toString().trim();
                }
            } catch (Throwable ignored) {
                // 旧 API 或受限环境：走 su 兜底
            }
            // 兜底：su -c
            try {
                Process process = new ProcessBuilder("/system/bin/sh", "-c", "su -c '" + command.replace("'", "'\''") + "'")
                    .redirectErrorStream(true).start();
                java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream()));
                StringBuilder output = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) output.append(line).append('\n');
                process.waitFor();
                return output.toString().trim();
            } catch (Exception error) {
                return "error: " + error.getMessage();
            }
        } catch (Throwable error) {
            return "error: " + error.getMessage();
        }
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public void openDashboard() { runOnUiThread(CoomiActivity.this::openDashboard); }

        /** 前端上报任务状态（running/done），更新通知栏「任务执行中/已完成」。 */
        @JavascriptInterface
        public void updateTaskStatus(String status) {
            CoomiEngineMonitor.setTaskStatus(status);
        }

        /** 报错反馈：返回设备与 App 诊断信息（不含对话内容、不含 API Key）。 */
        @JavascriptInterface
        public String getDiagnostics() {
            return app.coomi.CoomiFeedbackClient.diagnostics(CoomiActivity.this).toString();
        }

        /** 原生上报报错反馈：后台线程 POST，绕过 WebView 跨域/CORS 限制。
         *  完成回调 window.__coomiFeedbackResult(callbackId, {ok, error})。 */
        @JavascriptInterface
        public void sendFeedback(String json, String callbackId) {
            new Thread(() -> {
                String result = postFeedback(json);
                runOnUiThread(() -> mWebView.evaluateJavascript(
                    "window.__coomiFeedbackResult && window.__coomiFeedbackResult("
                        + org.json.JSONObject.quote(callbackId) + ", "
                        + org.json.JSONObject.quote(result) + ")",
                    null));
            }).start();
        }

        private String postFeedback(String json) {
            return app.coomi.CoomiFeedbackClient.post(json);
        }

        /** 当前主题档位（system/light/dark），前端初始化时同步。 */
        @JavascriptInterface
        public String getThemeMode() {
            return CoomiTheme.getMode(CoomiActivity.this);
        }

        @JavascriptInterface
        public String getAppearanceConfig() {
            return CoomiTheme.appearanceJson(CoomiActivity.this);
        }

        /** 前端设置页切换主题档位：持久化 + 刷新 Web 主题与原生状态栏。 */
        @JavascriptInterface
        public void setThemeMode(String mode) {
            if (CoomiTheme.isCustomEnabled(CoomiActivity.this)) return;
            CoomiTheme.setMode(CoomiActivity.this, mode);
            runOnUiThread(() -> {
                mAppliedThemeMode = CoomiTheme.getMode(CoomiActivity.this);
                applyThemeToWebView();
                CoomiTheme.applySystemBars(CoomiActivity.this);
                sendBroadcast(new Intent(CoomiTheme.ACTION_THEME_CHANGED).setPackage(getPackageName()));
            });
        }

        @JavascriptInterface
        public void importFiles() {
            mPendingImportRequestId = null;
            runOnUiThread(CoomiActivity.this::launchImportPicker);
        }

        @JavascriptInterface
        public void importFilesForRequest(String requestId) {
            mPendingImportRequestId = requestId;
            runOnUiThread(CoomiActivity.this::launchImportPicker);
        }

        @JavascriptInterface
        public void authorizeFolder() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(intent, REQUEST_AUTHORIZE_TREE);
            });
        }

        @JavascriptInterface
        public void exportFile(String path, String suggestedName) {
            mPendingExportRequestId = null;
            launchExportPicker(path, suggestedName);
        }

        /** 用系统其它 app 打开文件（图片/文档等），走 FileProvider 授权。 */
        @JavascriptInterface
        public void openFile(String path) {
            runOnUiThread(() -> {
                try {
                    File file = new File(path);
                    if (!file.isFile()) {
                        Toast.makeText(CoomiActivity.this, "文件不存在：" + path, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                        CoomiActivity.this, getPackageName() + ".fileprovider", file);
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(uri, mimeFromName(file.getName()));
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(intent);
                } catch (Exception error) {
                    Toast.makeText(CoomiActivity.this,
                        "无法打开文件：" + error.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        private String mimeFromName(String name) {
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
            String mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (mime != null) return mime;
            switch (ext) {
                case "md": case "markdown": case "txt": case "log": case "sh":
                case "py": case "rs": case "js": case "ts": case "vue": case "json":
                case "toml": case "yaml": case "yml": case "conf": case "ini":
                    return "text/plain";
                case "svg": return "image/svg+xml";
                default: return "application/octet-stream";
            }
        }

        @JavascriptInterface
        public void exportFileForRequest(String requestId, String path, String suggestedName) {
            mPendingExportRequestId = requestId;
            launchExportPicker(path, suggestedName);
        }

        /** 当前安装的 versionCode（检查更新页显示/对比用）。 */
        @JavascriptInterface
        public int getAppVersionCode() {
            return app.coomi.UpdateChecker.currentVersionCode(CoomiActivity.this);
        }

        /** 从 web 检查更新页发起下载并安装（复用更新源的签名校验流程）。 */
        @JavascriptInterface
        public void installApk(String url, String version) {
            app.coomi.UpdateChecker.downloadAndInstall(CoomiActivity.this, url, version);
        }

        /**
         * 保存图片（data URL）到相册或下载目录。
         * Android 10+（API 29+）：MediaStore 免权限直写，弹二选一；
         * 旧系统：走 SAF「另存为」对话框（用户自选位置，免权限）。
         */
        @JavascriptInterface
        public void saveImageData(String dataUrl, String fileName) {
            byte[] bytes = decodeDataUrl(dataUrl);
            if (bytes == null) {
                Toast.makeText(CoomiActivity.this, "图片数据无效", Toast.LENGTH_SHORT).show();
                return;
            }
            final String mime = mimeFromDataUrl(dataUrl);
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 29) {
                    new AlertDialog.Builder(CoomiActivity.this)
                        .setTitle("保存图片")
                        .setItems(new String[]{"保存到相册", "保存到下载目录"}, (dialog, which) -> {
                            new Thread(() -> {
                                boolean ok = saveViaMediaStore(which == 0, bytes, mime, fileName);
                                runOnUiThread(() -> Toast.makeText(
                                    CoomiActivity.this, ok ? "已保存" : "保存失败", Toast.LENGTH_SHORT).show());
                            }).start();
                        })
                        .setNegativeButton("取消", null)
                        .show();
                } else {
                    // 旧系统：SAF 另存为（免存储权限）
                    mPendingImageBytes = bytes;
                    mPendingImageName = TextUtils.isEmpty(fileName) ? "coomi-image.png" : fileName;
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType(mime);
                    intent.putExtra(Intent.EXTRA_TITLE, mPendingImageName);
                    startActivityForResult(intent, REQUEST_SAVE_IMAGE);
                }
            });
        }

        /** 解析 data:image/png;base64,.... → bytes；非法返回 null。 */
        private byte[] decodeDataUrl(String dataUrl) {
            try {
                int comma = dataUrl.indexOf("base64,");
                if (comma < 0) return null;
                return Base64.decode(dataUrl.substring(comma + "base64,".length()), Base64.DEFAULT);
            } catch (Exception e) {
                return null;
            }
        }

        private String mimeFromDataUrl(String dataUrl) {
            try {
                int semi = dataUrl.indexOf(';');
                int colon = dataUrl.indexOf(':');
                if (colon >= 0 && semi > colon) return dataUrl.substring(colon + 1, semi);
            } catch (Exception ignored) { }
            return "image/png";
        }

        /** API 29+：MediaStore 直写相册（Pictures/Coomi）或下载目录（Download/Coomi）。 */
        private boolean saveViaMediaStore(boolean toGallery, byte[] bytes, String mime, String fileName) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    (toGallery ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/Coomi");
                Uri collection = toGallery
                    ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                Uri uri = getContentResolver().insert(collection, values);
                if (uri == null) return false;
                try (java.io.OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) return false;
                    out.write(bytes);
                }
                return true;
            } catch (Exception e) {
                Logger.logError(LOG_TAG, "saveViaMediaStore failed: " + e.getMessage());
                return false;
            }
        }

        private void launchExportPicker(String path, String suggestedName) {
            runOnUiThread(() -> {
                File source = new File(path);
                if (!source.isFile()) {
                    emitTransferProgress("导出失败：文件不存在", 0);
                    if (mPendingExportRequestId != null) {
                        String requestId = mPendingExportRequestId;
                        clearPendingExport();
                        emitFileExported(requestId, null);
                    }
                    return;
                }
                mPendingExportPath = source.getAbsolutePath();
                mPendingExportName = TextUtils.isEmpty(suggestedName) ? source.getName() : suggestedName;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/octet-stream");
                intent.putExtra(Intent.EXTRA_TITLE, mPendingExportName);
                try {
                    startActivityForResult(intent, REQUEST_EXPORT_FILE);
                    if (mPendingExportRequestId != null) {
                        mHandler.removeCallbacks(mExportTimeout);
                        mHandler.postDelayed(mExportTimeout, 30_000L);
                    }
                } catch (Exception error) {
                    String requestId = mPendingExportRequestId;
                    clearPendingExport();
                    emitTransferProgress("导出失败：" + error.getMessage(), 0);
                    emitFileExported(requestId, null);
                }
            });
        }

        @JavascriptInterface
        public boolean getDigitalLifeEnabled() {
            return CoomiTheme.isDigitalLifeEnabled(CoomiActivity.this);
        }

        @JavascriptInterface
        public void setDigitalLifeEnabled(boolean enabled) {
            CoomiTheme.setDigitalLifeEnabled(CoomiActivity.this, enabled);
        }

        /** 控制模式：返回当前前台应用包名（用于待机检测进入微信/QQ 聊天页）。
         *  优先用无障碍服务的事件与窗口信息（免授权、无额外依赖），
         *  无障碍未开启时回退到 ActivityManager。 */
        @JavascriptInterface
        public String controlForegroundApp() {
            String fromAccessibility = CoomiAccessibilityService.currentPackage();
            if (fromAccessibility != null && !fromAccessibility.isEmpty()) return fromAccessibility;
            try {
                android.app.ActivityManager am =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
                if (am != null) {
                    java.util.List<android.app.ActivityManager.RunningTaskInfo> tasks =
                        am.getRunningTasks(1);
                    if (tasks != null && !tasks.isEmpty() && tasks.get(0) != null
                        && tasks.get(0).topActivity != null) {
                        return tasks.get(0).topActivity.getPackageName();
                    }
                }
            } catch (Exception ignored) { }
            return "";
        }

        /** 控制模式：把文本写入当前前台聊天输入框并发送。
         *  无障碍可用时直接按控件定位（不受输入法、布局位置影响）；
         *  否则回退到 Shizuku 的 input 命令。 */
        @JavascriptInterface
        public void controlSendText(String text) {
            if (text == null || text.isEmpty()) return;
            if (CoomiAccessibilityService.isReady()) {
                boolean ok = CoomiAccessibilityService.get().pasteAndSend(text);
                if (ok) {
                    runOnUiThread(() -> Toast.makeText(CoomiActivity.this,
                        "已发送", Toast.LENGTH_SHORT).show());
                    return;
                }
            }
            String result = runShizukuCommand(
                "input text '" + text.replace("'", "") + "' && sleep 0.3 && input keyevent 66");
            runOnUiThread(() -> Toast.makeText(CoomiActivity.this,
                "控制发送：" + (result.isEmpty() ? "等待授权/执行" : result), Toast.LENGTH_SHORT).show());
        }

        // ── 控制模式：权限申请 ──────────────────────────────────────────

        /** 无障碍服务是否已开启（控制模式的主要操控后端）。 */
        @JavascriptInterface
        public boolean isAccessibilityEnabled() {
            return CoomiAccessibilityService.isReady();
        }

        /** 跳到系统无障碍设置页，让用户手动开启（系统不允许 App 自行开启）。 */
        @JavascriptInterface
        public void requestAccessibilityPermission() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
                    Toast.makeText(CoomiActivity.this,
                        "请在「已下载的服务」里开启「控制模式：让 Coomi 替你操作屏幕」",
                        Toast.LENGTH_LONG).show();
                } catch (Exception error) {
                    Toast.makeText(CoomiActivity.this, "无法打开无障碍设置", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** 悬浮层权限（SYSTEM_ALERT_WINDOW）是否已授予。 */
        @JavascriptInterface
        public boolean isOverlayGranted() {
            return canDrawOverlays();
        }

        /** 申请悬浮层权限；低版本 ROM 无此开关时退化为直接可用。 */
        @JavascriptInterface
        public void requestOverlayPermission() {
            runOnUiThread(() -> {
                if (canDrawOverlays()) {
                    Toast.makeText(CoomiActivity.this, "悬浮窗权限已开启", Toast.LENGTH_SHORT).show();
                    return;
                }
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:" + getPackageName()));
                    startActivityForResult(intent, REQUEST_OVERLAY_PERMISSION);
                } catch (Exception error) {
                    Toast.makeText(CoomiActivity.this, "无法打开悬浮窗权限设置", Toast.LENGTH_SHORT).show();
                }
            });
        }

        // ── 控制模式：桌面悬浮层 ────────────────────────────────────────

        @JavascriptInterface
        public void setControlSession(String sessionId, String providerId, String model) {
            CoomiFloatService.setSession(sessionId, providerId, model);
        }

        /** 显示桌面悬浮层（展开态卡片）。 */
        @JavascriptInterface
        public void startControlFloat() {
            if (!canDrawOverlays()) {
                runOnUiThread(() -> Toast.makeText(CoomiActivity.this,
                    "需要先开启悬浮窗权限", Toast.LENGTH_SHORT).show());
                return;
            }
            CoomiFloatService.start(CoomiActivity.this);
        }

        /** 关闭桌面悬浮层。 */
        @JavascriptInterface
        public void stopControlFloat() {
            CoomiFloatService.stop(CoomiActivity.this);
        }

        /** 悬浮层是否在运行。 */
        @JavascriptInterface
        public boolean isControlFloatRunning() {
            return CoomiFloatService.isRunning();
        }

        /** 追加一条到悬浮层的思考区：title 是当前动作，body 是细节。 */
        @JavascriptInterface
        public void pushControlFloat(String title, String body) {
            CoomiFloatService.pushTrace(CoomiActivity.this, title, body);
        }

        /** 只刷新悬浮层顶部的状态行（如「正在思考」「正在调用工具」）。 */
        @JavascriptInterface
        public void pushControlStatus(String status) {
            CoomiFloatService.pushStatus(CoomiActivity.this, status);
        }

        /** 跳转到 QQ 群（捐赠/交流）。Android 里跳群需要走 QQ 的临时会话协议。 */
        @JavascriptInterface
        public void openQQGroup() {
            runOnUiThread(() -> {
                try {
                    // 拉起加群界面：QQ 支持通过 mqqapi 直接唤起加群。
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setData(Uri.parse(
                        "https://qm.qq.com/q/2JVYVRKnBe"));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Throwable error) {
                    Toast.makeText(CoomiActivity.this, "无法打开 QQ，请手动搜索群号 1108467806", Toast.LENGTH_LONG).show();
                }
            });
        }

        /** 收起成小球 / 重新展开。 */
        @JavascriptInterface
        public void setControlFloatCollapsed(boolean collapsed) {
            CoomiFloatService.setCollapsed(CoomiActivity.this, collapsed);
        }

        // ── 控制模式：屏幕操作 ──────────────────────────────────────────

        /** 点击屏幕坐标（无障碍手势）。 */
        @JavascriptInterface
        public boolean controlTap(float x, float y) {
            if (CoomiAccessibilityService.isReady()
                && CoomiAccessibilityService.get().tap(x, y)) {
                return true;
            }
            // 无障碍不可用或手势失败时，退回 Shizuku 的 input tap。
            String result = runShizukuCommand(
                "input tap " + Math.round(x) + " " + Math.round(y));
            return result != null && !result.contains("waiting_auth") && !result.isEmpty();
        }

        /** 滑动（x1,y1 → x2,y2，durationMs 毫秒）。 */
        @JavascriptInterface
        public boolean controlSwipe(float x1, float y1, float x2, float y2, long durationMs) {
            if (CoomiAccessibilityService.isReady()
                && CoomiAccessibilityService.get().swipe(x1, y1, x2, y2, durationMs)) {
                return true;
            }
            String result = runShizukuCommand("input swipe "
                + Math.round(x1) + " " + Math.round(y1) + " "
                + Math.round(x2) + " " + Math.round(y2) + " " + durationMs);
            return result != null && !result.contains("waiting_auth") && !result.isEmpty();
        }

        /** 全局动作：back / home / recents / notifications。 */
        @JavascriptInterface
        public boolean controlGlobalAction(String action) {
            if (!CoomiAccessibilityService.isReady()) return false;
            return CoomiAccessibilityService.get().globalAction(action);
        }

        /** 按文字点击控件（如「发送」「确定」）。 */
        @JavascriptInterface
        public boolean controlClickText(String label) {
            if (!CoomiAccessibilityService.isReady()) return false;
            return CoomiAccessibilityService.get().clickText(label);
        }

        /** 当前输入框里的文字，便于上层判断是否已填充。 */
        @JavascriptInterface
        public String controlCurrentInput() {
            if (!CoomiAccessibilityService.isReady()) return "";
            return CoomiAccessibilityService.get().currentInputText();
        }

    }

    /** 悬浮窗权限检查；Android 6.0 以下没有该限制，视为已授权。 */
    private boolean canDrawOverlays() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.M) return true;
        return android.provider.Settings.canDrawOverlays(this);
    }

    private void launchImportPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, REQUEST_IMPORT_FILES);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // 悬浮窗权限页返回时 data 为 null，必须在下面的空数据分支之前处理。
        if (requestCode == REQUEST_OVERLAY_PERMISSION) {
            final boolean granted = canDrawOverlays();
            runOnUiThread(() -> {
                Toast.makeText(CoomiActivity.this,
                    granted ? "悬浮窗权限已开启，正在显示悬浮层" : "悬浮窗权限未开启",
                    Toast.LENGTH_SHORT).show();
                if (granted) CoomiFloatService.start(CoomiActivity.this);
            });
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            if (requestCode == REQUEST_IMPORT_FILES && mPendingImportRequestId != null) {
                emitFilesImported(new JSONArray(), mPendingImportRequestId);
                mPendingImportRequestId = null;
            } else if (requestCode == REQUEST_EXPORT_FILE && mPendingExportRequestId != null) {
                String requestId = mPendingExportRequestId;
                clearPendingExport();
                emitFileExported(requestId, null);
            }
            return;
        }
        if (requestCode == REQUEST_IMPORT_FILES) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    uris.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            new Thread(() -> importUris(uris), "coomi-file-import").start();
        } else if (requestCode == REQUEST_AUTHORIZE_TREE && data.getData() != null) {
            authorizeTree(data.getData(), data.getFlags());
        } else if (requestCode == REQUEST_EXPORT_FILE && data.getData() != null) {
            mHandler.removeCallbacks(mExportTimeout);
            if (mPendingExportPath == null) return;
            Uri target = data.getData();
            new Thread(() -> exportToUri(target), "coomi-file-export").start();
        } else if (requestCode == REQUEST_SAVE_IMAGE && data.getData() != null) {
            Uri target = data.getData();
            byte[] bytes = mPendingImageBytes;
            mPendingImageBytes = null;
            new Thread(() -> {
                boolean ok = false;
                if (bytes != null) {
                    try (java.io.OutputStream out = getContentResolver().openOutputStream(target)) {
                        if (out != null) { out.write(bytes); ok = true; }
                    } catch (Exception e) {
                        Logger.logError(LOG_TAG, "save image failed: " + e.getMessage());
                    }
                }
                final boolean saved = ok;
                runOnUiThread(() -> Toast.makeText(
                    CoomiActivity.this, saved ? "已保存" : "保存失败", Toast.LENGTH_SHORT).show());
            }, "coomi-image-save").start();
        }
    }

    private void importUris(List<Uri> uris) {
        File inbox = new File(CoomiConstants.COOMI_INBOX);
        if (!inbox.isDirectory() && !inbox.mkdirs()) {
            emitTransferProgress("无法创建 Agent inbox", 0);
            return;
        }
        JSONArray paths = new JSONArray();
        for (int index = 0; index < uris.size(); index++) {
            Uri uri = uris.get(index);
            String name = queryDisplayName(uri);
            File destination = uniqueDestination(inbox, name);
            emitTransferProgress("正在导入 " + name, (index * 100) / Math.max(uris.size(), 1));
            try (InputStream input = getContentResolver().openInputStream(uri);
                 OutputStream output = new FileOutputStream(destination)) {
                if (input == null) throw new IllegalStateException("无法读取所选文件");
                copyStream(input, output);
                // 显式授权 0644/0755，避免个别 ROM/文件系统默认权限导致 Termux/proot 环境读不到。
                try {
                    android.system.Os.chmod(destination.getAbsolutePath(), 0644);
                    android.system.Os.chmod(inbox.getAbsolutePath(), 0755);
                } catch (Exception ignored) { /* 权限提示失败不影响导入 */ }
                rememberOrigin(destination, uri.toString(), name);
                paths.put(destination.getAbsolutePath());
            } catch (Exception error) {
                Logger.logError(LOG_TAG, "File import failed: " + error.getMessage());
                emitTransferProgress("导入失败：" + name, 0);
            }
        }
        emitFilesImported(paths, mPendingImportRequestId);
        mPendingImportRequestId = null;
    }

    private void authorizeTree(Uri uri, int flags) {
        try {
            int persistFlags = flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContentResolver().takePersistableUriPermission(uri, persistFlags);
            String path = treeUriToPath(uri);
            File inbox = new File(CoomiConstants.COOMI_INBOX);
            if (!inbox.isDirectory()) inbox.mkdirs();
            rememberOrigin(new File(path), uri.toString(), "authorized-tree");
            JSONArray paths = new JSONArray();
            paths.put(path);
            emitFilesImported(paths, null);
        } catch (Exception error) {
            Logger.logError(LOG_TAG, "Folder authorization failed: " + error.getMessage());
            emitTransferProgress("目录授权失败", 0);
        }
    }

    private String treeUriToPath(Uri uri) {
        String documentId = DocumentsContract.getTreeDocumentId(uri);
        String[] parts = documentId.split(":", 2);
        String relative = parts.length > 1 ? parts[1] : "";
        String root = parts[0].equalsIgnoreCase("primary") ? "/storage/emulated/0" : "/storage/" + parts[0];
        return relative.isEmpty() ? root : root + "/" + relative;
    }

    private void exportToUri(Uri target) {
        mHandler.removeCallbacks(mExportTimeout);
        File source = new File(mPendingExportPath == null ? "" : mPendingExportPath);
        try (InputStream input = new FileInputStream(source);
             OutputStream output = getContentResolver().openOutputStream(target, "w")) {
            if (output == null) throw new IllegalStateException("无法写入目标文件");
            emitTransferProgress("正在导出 " + source.getName(), 10);
            copyStream(input, output);
            emitTransferProgress("文件已导出", 100);
            emitFileExported(mPendingExportRequestId, source.getAbsolutePath());
        } catch (Exception error) {
            Logger.logError(LOG_TAG, "File export failed: " + error.getMessage());
            emitTransferProgress("导出失败：" + error.getMessage(), 0);
            emitFileExported(mPendingExportRequestId, null);
        } finally {
            clearPendingExport();
        }
    }

    private void clearPendingExport() {
        mHandler.removeCallbacks(mExportTimeout);
        mPendingExportPath = null;
        mPendingExportName = null;
        mPendingExportRequestId = null;
    }

    private static void copyStream(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[128 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        output.flush();
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (!TextUtils.isEmpty(name)) return sanitizeName(name);
            }
        } catch (Exception ignored) {}
        return "file-" + System.currentTimeMillis();
    }

    private static String sanitizeName(String name) {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return safe.isEmpty() ? "file" : safe;
    }

    private static File uniqueDestination(File directory, String name) {
        File candidate = new File(directory, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        int suffix = 2;
        while (candidate.exists()) candidate = new File(directory, stem + "-" + suffix++ + extension);
        return candidate;
    }

    private void rememberOrigin(File local, String uri, String displayName) {
        File index = new File(CoomiConstants.COOMI_INBOX, ".origins.jsonl");
        try (FileWriter writer = new FileWriter(index, true)) {
            JSONObject entry = new JSONObject();
            entry.put("localPath", local.getAbsolutePath());
            entry.put("originalUri", uri);
            entry.put("originalName", displayName);
            entry.put("recordedAt", System.currentTimeMillis());
            writer.write(entry.toString());
            writer.write("\n");
        } catch (Exception error) {
            Logger.logError(LOG_TAG, "Cannot record file origin: " + error.getMessage());
        }
    }

    private void emitTransferProgress(String message, int progress) {
        runOnUiThread(() -> evaluateJavascript("window.dispatchEvent(new CustomEvent('coomi:file-transfer-progress',{detail:{message:"
            + JSONObject.quote(message) + ",progress:" + progress + "}}))"));
    }

    private void emitFilesImported(JSONArray paths, String requestId) {
        String request = requestId == null ? "null" : JSONObject.quote(requestId);
        runOnUiThread(() -> evaluateJavascript("window.dispatchEvent(new CustomEvent('coomi:files-imported',{detail:{paths:"
            + paths.toString() + ",requestId:" + request + "}}))"));
    }

    private void emitFileExported(String requestId, String path) {
        if (requestId == null) return;
        String exportedPath = path == null ? "null" : JSONObject.quote(path);
        runOnUiThread(() -> evaluateJavascript("window.dispatchEvent(new CustomEvent('coomi:file-exported',{detail:{requestId:"
            + JSONObject.quote(requestId) + ",path:" + exportedPath + "}}))"));
    }

    private void evaluateJavascript(String script) {
        if (mWebView != null) mWebView.evaluateJavascript(script, null);
    }

    @Override
    protected void onPause() {
        evaluateJavascript("window.dispatchEvent(new Event('coomi:flush-persistence'))");
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (mWebView == null || !mPageLoaded) {
            openDashboard();
            return;
        }
        mWebView.evaluateJavascript(
            "typeof window.__coomiHandleSystemBack==='function' && window.__coomiHandleSystemBack()",
            value -> {
                if (!"true".equals(value)) openDashboard();
            });
    }

    @Override
    protected void onDestroy() {
        mHandler.removeCallbacksAndMessages(null);
        if (mBound) {
            unbindService(mConnection);
            mBound = false;
        }
        // The engine keeps running under CoomiEngineMonitor; only drop the view.
        if (mWebView != null) {
            mWebView.destroy();
            mWebView = null;
        }
        super.onDestroy();
    }
}
