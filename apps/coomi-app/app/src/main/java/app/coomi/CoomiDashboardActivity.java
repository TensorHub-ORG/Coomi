package app.coomi;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.net.Uri;
import android.view.View;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;

import com.termux.R;
import com.termux.app.TermuxActivity;
import com.termux.shared.logger.Logger;
import com.termux.shared.termux.TermuxConstants;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Coomi Dashboard — main screen after setup.
 *
 * Shows engine status, restart/stop controls, and quick links.
 */
public class CoomiDashboardActivity extends Activity {

    private static final String LOG_TAG = "CoomiDashboardActivity";
    private static final int STATUS_REFRESH_MS = 5000;

    private View mStatusIndicator;
    private TextView mStatusText;
    private TextView mRuntimeVersionText;
    private View mOpenChatButton;
    private Button mRestartButton;
    private Button mStopButton;
    private View mOpenTerminalButton;
    private View mOpenTuiButton;
    private View mOpenWebUiButton;
    private View mWebUiButtonContainer;
    private View mCatalogButton;
    private View mFilesButton;
    private View mProvidersButton;
    private View mRuntimeButton;
    private View mCheckUpdateButton;
    private View mPermissionSettingsButton;
    private View mStorageSettingsButton;
    private TextView mThemeSystemButton;
    private TextView mThemeLightButton;
    private TextView mThemeDarkButton;
    private View mBackupButton;

    private CoomiService mCoomiService;
    private boolean mBound = false;
    private Handler mHandler = new Handler(Looper.getMainLooper());
    private Runnable mStatusRunnable;

    private ServiceConnection mConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            CoomiService.LocalBinder binder = (CoomiService.LocalBinder) service;
            mCoomiService = binder.getService();
            mBound = true;
            Logger.logDebug(LOG_TAG, "CoomiService bound");
            refreshStatus();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            mCoomiService = null;
            mBound = false;
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        CoomiTheme.applyPageTheme(this);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_coomi_dashboard);

        mStatusIndicator = findViewById(R.id.dashboard_status_indicator);
        mStatusText = findViewById(R.id.dashboard_status_text);
        mRuntimeVersionText = findViewById(R.id.dashboard_runtime_version);
        mOpenChatButton = findViewById(R.id.btn_open_chat);
        mRestartButton = findViewById(R.id.btn_restart);
        mStopButton = findViewById(R.id.btn_stop);
        mOpenTerminalButton = findViewById(R.id.btn_open_terminal);
        mOpenTuiButton = findViewById(R.id.btn_open_tui);
        mOpenWebUiButton = findViewById(R.id.btn_open_webui);
        mWebUiButtonContainer = findViewById(R.id.webui_button_container);
        mCatalogButton = findViewById(R.id.btn_web_catalog);
        mFilesButton = findViewById(R.id.btn_web_files);
        mCheckUpdateButton = findViewById(R.id.btn_check_update);
        mBackupButton = findViewById(R.id.btn_backup_data);
        mPermissionSettingsButton = findViewById(R.id.btn_permission_settings);
        mStorageSettingsButton = findViewById(R.id.btn_storage_settings);
        mThemeSystemButton = findViewById(R.id.btn_theme_system);
        mThemeLightButton = findViewById(R.id.btn_theme_light);
        mThemeDarkButton = findViewById(R.id.btn_theme_dark);

        mThemeSystemButton.setOnClickListener(v -> selectTheme("system"));
        mThemeLightButton.setOnClickListener(v -> selectTheme("light"));
        mThemeDarkButton.setOnClickListener(v -> selectTheme("dark"));
        applyThemeHighlight();

        mOpenChatButton.setOnClickListener(v -> openChat());
        mRestartButton.setOnClickListener(v -> restartEngine());
        mStopButton.setOnClickListener(v -> stopEngine());
        mOpenTuiButton.setOnClickListener(v -> openTui());
        mOpenTerminalButton.setOnClickListener(v -> openTerminal());
        mOpenWebUiButton.setOnClickListener(v -> openWebUi());
        mCatalogButton.setOnClickListener(v -> openCatalog());
        mFilesButton.setOnClickListener(v -> openFiles());
        mProvidersButton = findViewById(R.id.btn_web_providers);
        mRuntimeButton = findViewById(R.id.btn_web_runtime);
        mProvidersButton.setOnClickListener(v -> openProviders());
        mRuntimeButton.setOnClickListener(v -> openRuntime());
        mCheckUpdateButton.setOnClickListener(v -> checkUpdate());
        mBackupButton.setOnClickListener(v -> backupData());
        mPermissionSettingsButton.setOnClickListener(v -> openPermissionSettings());
        mStorageSettingsButton.setOnClickListener(v -> openStorageSettings());

        // Start auto-refresh
        mStatusRunnable = new Runnable() {
            @Override
            public void run() {
                refreshStatus();
                mHandler.postDelayed(this, STATUS_REFRESH_MS);
            }
        };

        if (CoomiDemo.isEnabled()) {
            applyDemoState();
            return;
        }

        mHandler.post(mStatusRunnable);

        mRuntimeVersionText.setText("coomi-rs 2.0.0");
    }

    /** 切换外观档位：持久化后重建 Activity，让主题完整重载。 */
    private void selectTheme(String mode) {
        CoomiTheme.setMode(this, mode);
        recreate();
    }

    /** 高亮当前外观档位（三个分段按钮）。 */
    private void applyThemeHighlight() {
        String mode = CoomiTheme.getMode(this);
        boolean dark = CoomiTheme.isDark(this);
        int selectedBg = R.drawable.coomi_bg_pill_blue;
        int selectedText = R.color.coomi_white;
        int idleBg = dark ? R.color.coomi_night_fill : R.drawable.coomi_bg_fill;
        int idleText = dark ? R.color.coomi_night_text_2 : R.color.coomi_text_2;
        applyThemeButtonStyle(mThemeSystemButton, "system".equals(mode), selectedBg, selectedText, idleBg, idleText);
        applyThemeButtonStyle(mThemeLightButton, "light".equals(mode), selectedBg, selectedText, idleBg, idleText);
        applyThemeButtonStyle(mThemeDarkButton, "dark".equals(mode), selectedBg, selectedText, idleBg, idleText);
    }

    private void applyThemeButtonStyle(TextView button, boolean selected, int selectedBg, int selectedText, int idleBg, int idleText) {
        button.setBackgroundResource(selected ? selectedBg : idleBg);
        button.setTextColor(getColor(selected ? selectedText : idleText));
    }

    /** 演示包：引擎和终端都不存在，界面上直说，别让人以为它在跑。 */
    private void applyDemoState() {
        mStatusIndicator.setBackgroundResource(R.drawable.coomi_dot_idle);
        mStatusText.setText(R.string.coomi_demo_dash_status);
        mRuntimeVersionText.setText(R.string.coomi_demo_dash_runtime);
        mRestartButton.setEnabled(false);
        mStopButton.setEnabled(false);
        if (mWebUiButtonContainer != null) mWebUiButtonContainer.setVisibility(View.GONE);
    }

    @Override
    protected void onStart() {
        super.onStart();
        // 演示包不连服务、不拉引擎守护 —— 它们干的都是真事。
        if (CoomiDemo.isEnabled()) return;
        Intent intent = new Intent(this, CoomiService.class);
        bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
        // Start the engine monitor if not running
        Intent monitorIntent = new Intent(this, CoomiEngineMonitor.class);
        startService(monitorIntent);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (mBound) {
            unbindService(mConnection);
            mBound = false;
        }
        mHandler.removeCallbacks(mStatusRunnable);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        mHandler.removeCallbacksAndMessages(null);
    }

    // ── Status refresh ──

    private void refreshStatus() {
        if (!mBound || mCoomiService == null) return;

        mCoomiService.getEngineStatus(result -> {
            if (!result.success) return;
            runOnUiThread(() -> {
                String status = result.stdout.trim();
                boolean running = status.equals("running");
                boolean starting = status.equals("starting");
                int indicator = running ? R.drawable.coomi_dot_ok
                    : starting ? R.drawable.coomi_dot_warn
                    : R.drawable.coomi_dot_idle;
                int label = running ? R.string.coomi_dash_engine_running
                    : starting ? R.string.coomi_dash_engine_starting
                    : R.string.coomi_dash_engine_stopped;
                mStatusIndicator.setBackgroundResource(indicator);
                mStatusText.setText(label);
                mRestartButton.setEnabled(!starting);
                mStopButton.setEnabled(running);
                if (mWebUiButtonContainer != null) {
                    mWebUiButtonContainer.setVisibility(running ? View.VISIBLE : View.GONE);
                }
            });
        });
    }

    // ── Actions ──

    private void openChat() {
        startActivity(new Intent(this, com.termux.app.CoomiActivity.class));
    }

    private void openPermissionSettings() {
        Intent intent = new Intent(this, CoomiLauncherActivity.class);
        intent.putExtra(CoomiLauncherActivity.EXTRA_SETTINGS_MODE, true);
        startActivity(intent);
    }

    private void openStorageSettings() {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            }
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "无法打开手机存储权限设置", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onBackPressed() {
        // 需求：控制台返回 = 退出 app，且退出后终止所有由 coomi 启动的进程。
        // 先异步停引擎（Rust 侧收到终止信号会清理全部工具子进程），
        // 再停前台保活服务与引擎宿主，最后退出。
        if (mBound && mCoomiService != null) {
            mCoomiService.stopEngine(result -> runOnUiThread(this::shutdownApp));
        } else {
            shutdownApp();
        }
    }

    private void shutdownApp() {
        try {
            stopService(new Intent(this, CoomiEngineMonitor.class));
            stopService(new Intent(this, CoomiService.class));
        } catch (Exception ignored) { /* 服务可能未启动 */ }
        finishAffinity();
    }

    private void restartEngine() {
        if (!mBound || mCoomiService == null) {
            Toast.makeText(this, R.string.coomi_dash_toast_no_service, Toast.LENGTH_SHORT).show();
            return;
        }
        mRestartButton.setEnabled(false);
        mStatusText.setText(R.string.coomi_dash_engine_starting);
        mCoomiService.restartEngine(result -> {
            runOnUiThread(() -> {
                mRestartButton.setEnabled(true);
                if (result.success) {
                    Toast.makeText(this, R.string.coomi_dash_toast_started, Toast.LENGTH_SHORT).show();
                } else {
                    Toast.makeText(this,
                        getString(R.string.coomi_dash_toast_start_failed, result.stderr),
                        Toast.LENGTH_LONG).show();
                }
                refreshStatus();
            });
        });
    }

    private void stopEngine() {
        if (!mBound || mCoomiService == null) return;
        mCoomiService.stopEngine(result -> {
            runOnUiThread(() -> {
                if (result.success) {
                    Toast.makeText(this, R.string.coomi_dash_toast_stopped, Toast.LENGTH_SHORT).show();
                }
                refreshStatus();
            });
        });
    }

    private void openTui() {
        if (demoUnavailable()) return;
        // Open Termux terminal for Coomi TUI
        Intent intent = new Intent(this, TermuxActivity.class);
        startActivity(intent);
        Toast.makeText(this, R.string.coomi_dash_toast_tui_hint, Toast.LENGTH_LONG).show();
    }

    private void openTerminal() {
        if (demoUnavailable()) return;
        // Open Termux shell for debugging. TERMUX_DIR must match the bootstrap's baked-in
        // home path, so it comes from TermuxConstants rather than a literal.
        Intent intent = new Intent(this, TermuxActivity.class);
        intent.putExtra("com.coomi.android.app.TERMUX_DIR", TermuxConstants.TERMUX_HOME_DIR_PATH);
        startActivity(intent);
    }

    /** 演示包里终端后面没有 bootstrap，点进去只会看到一个空壳，直接说明白。 */
    private boolean demoUnavailable() {
        if (!CoomiDemo.isEnabled()) return false;
        Toast.makeText(this, R.string.coomi_demo_dash_unavailable, Toast.LENGTH_SHORT).show();
        return true;
    }

    private void openWebUi() {
        if (!mBound || mCoomiService == null) return;
        int port = mCoomiService.getEnginePort();
        // 与 WebView 一致：携带引擎令牌，浏览器打开后所有 API 才可用。
        String token = mCoomiService.getEngineToken();
        String url = "http://127.0.0.1:" + port + "/?token=" + token;
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(android.net.Uri.parse(url));
        try {
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, R.string.coomi_dash_toast_no_browser, Toast.LENGTH_SHORT).show();
        }
    }

    /** 打开应用内 SKILL / MCP 管理页（WebView 直达 #/catalog）。 */
    private void openCatalog() {
        Intent intent = new Intent(this, com.termux.app.CoomiActivity.class);
        intent.putExtra(com.termux.app.CoomiActivity.EXTRA_ROUTE, "#/catalog");
        startActivity(intent);
    }

    /** 打开应用内文件管理页（WebView 直达 #/files）。 */
    private void openFiles() {
        Intent intent = new Intent(this, com.termux.app.CoomiActivity.class);
        intent.putExtra(com.termux.app.CoomiActivity.EXTRA_ROUTE, "#/files");
        startActivity(intent);
    }

    /** 打开应用内 Provider / API Key 配置页（WebView 直达 #/providers）。 */
    private void openProviders() {
        Intent intent = new Intent(this, com.termux.app.CoomiActivity.class);
        intent.putExtra(com.termux.app.CoomiActivity.EXTRA_ROUTE, "#/providers");
        startActivity(intent);
    }

    /** 打开应用内内置环境页（WebView 直达 #/runtime）。 */
    private void openRuntime() {
        Intent intent = new Intent(this, com.termux.app.CoomiActivity.class);
        intent.putExtra(com.termux.app.CoomiActivity.EXTRA_ROUTE, "#/runtime");
        startActivity(intent);
    }

    /** 软件内检查更新：读取更新源 latest.json，有新版本则下载并安装。 */
    private void checkUpdate() {
        Toast.makeText(this, R.string.coomi_dash_checking, Toast.LENGTH_SHORT).show();
        UpdateChecker.checkAndPrompt(this, () -> refreshStatus());
    }

    // ── 数据备份 ──

    /**
     * 备份：将会话记录全部打包，并把环境配置（MCP / Skill / Provider，密钥打码）
     * 列成清单一起打包，保存到手机公共下载目录。
     */
    private void backupData() {
        Toast.makeText(this, R.string.coomi_dash_backup_starting, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                File home = new File(CoomiConstants.COOMI_CONFIG_DIR);
                File sessionsDir = new File(home, "sessions");
                File configDir = new File(home, "config");
                File skillsDir = new File(home, "skills");

                // 1) 环境配置清单（MCP / Skill / Provider，密钥打码）
                String inventoryText = buildEnvInventory(configDir, skillsDir);
                String inventoryJson = buildEnvInventoryJson(configDir, skillsDir);

                // 2) 打包：sessions/*.json + 两份清单
                File zip = File.createTempFile("coomi-backup-", ".zip", getCacheDir());
                try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zip))) {
                    addSessions(zos, sessionsDir);
                    addTextEntry(zos, "env-inventory.txt", inventoryText);
                    addTextEntry(zos, "env-inventory.json", inventoryJson);
                }

                // 3) 保存到公共下载目录
                String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
                String savedPath = saveToDownloads(zip, "coomi-backup-" + stamp + ".zip");
                runOnUiThread(() -> {
                    if (savedPath != null) {
                        Toast.makeText(this,
                            getString(R.string.coomi_dash_backup_done, savedPath), Toast.LENGTH_LONG).show();
                    } else {
                        Toast.makeText(this,
                            getString(R.string.coomi_dash_backup_failed, "无法写入下载目录，请检查存储权限"),
                            Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this,
                    getString(R.string.coomi_dash_backup_failed, e.getMessage()), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void addSessions(ZipOutputStream zos, File sessionsDir) throws Exception {
        if (!sessionsDir.isDirectory()) return;
        File[] files = sessionsDir.listFiles((d, n) -> n.endsWith(".json"));
        if (files == null) return;
        for (File f : files) {
            if (!f.isFile()) continue;
            zos.putNextEntry(new ZipEntry("sessions/" + f.getName()));
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) >= 0) zos.write(buf, 0, n);
            }
            zos.closeEntry();
        }
    }

    private void addTextEntry(ZipOutputStream zos, String name, String content) throws Exception {
        zos.putNextEntry(new ZipEntry(name));
        byte[] bytes = content.getBytes("UTF-8");
        zos.write(bytes, 0, bytes.length);
        zos.closeEntry();
    }

    /** 人类可读的环境配置清单。 */
    private String buildEnvInventory(File configDir, File skillsDir) {
        StringBuilder sb = new StringBuilder();
        sb.append("Coomi 环境配置备份\n");
        sb.append("生成时间：").append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date())).append('\n');
        sb.append("应用版本：").append(UpdateChecker.currentVersionCode(this)).append("\n\n");

        sb.append("== 已安装 MCP Server ==\n");
        JSONObject mcp = readJsonObject(new File(configDir, "mcp_servers.json"));
        JSONObject servers = mcp == null ? null : mcp.optJSONObject("servers");
        if (servers != null && servers.length() > 0) {
            for (Iterator<String> it = servers.keys(); it.hasNext(); ) {
                String name = it.next();
                JSONObject s = servers.optJSONObject(name);
                sb.append("- ").append(name);
                if (s != null) {
                    sb.append(" | 启用: ").append(s.optBoolean("enabled", true) ? "是" : "否");
                    String cmd = s.optString("command", s.optString("url", ""));
                    if (!cmd.isEmpty()) sb.append(" | 命令/地址: ").append(cmd);
                }
                sb.append('\n');
            }
        } else {
            sb.append("（无）\n");
        }
        sb.append('\n');

        sb.append("== 已安装 Skill ==\n");
        File[] skillDirs = skillsDir.isDirectory() ? skillsDir.listFiles(File::isDirectory) : null;
        if (skillDirs != null && skillDirs.length > 0) {
            for (File s : skillDirs) {
                sb.append("- ").append(s.getName()).append('\n');
                File meta = new File(s, "SKILL.md");
                if (meta.isFile()) {
                    String first = firstNonEmptyLine(meta);
                    if (first != null) sb.append("  简介: ").append(first).append('\n');
                }
            }
        } else {
            sb.append("（无）\n");
        }
        sb.append('\n');

        sb.append("== 已配置 Provider ==\n");
        JSONObject prov = readJsonObject(new File(configDir, "providers.json"));
        JSONObject providers = prov == null ? null : prov.optJSONObject("providers");
        if (providers != null && providers.length() > 0) {
            for (Iterator<String> it = providers.keys(); it.hasNext(); ) {
                String id = it.next();
                JSONObject p = providers.optJSONObject(id);
                if (p == null) continue;
                sb.append("- ").append(id);
                sb.append(" | 模型: ").append(p.optString("model", "?"));
                String key = p.optString("api_key", p.optString("key", ""));
                sb.append(" | Key: ").append(maskKey(key)).append('\n');
            }
        } else {
            sb.append("（无）\n");
        }
        return sb.toString();
    }

    /** 结构化的环境配置清单（MCP / Skill 全量，Provider 密钥打码）。 */
    private String buildEnvInventoryJson(File configDir, File skillsDir) {
        try {
            JSONObject root = new JSONObject();
            root.put("created_at", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(new Date()));
            root.put("app_version", UpdateChecker.currentVersionCode(this));
            JSONObject mcp = readJsonObject(new File(configDir, "mcp_servers.json"));
            root.put("mcp_servers", mcp == null ? new JSONObject() : mcp);

            JSONObject prov = readJsonObject(new File(configDir, "providers.json"));
            JSONObject provDoc = new JSONObject();
            if (prov != null) provDoc.put("active", prov.optString("active", ""));
            JSONObject masked = new JSONObject();
            JSONObject providers = prov == null ? null : prov.optJSONObject("providers");
            if (providers != null) {
                for (Iterator<String> it = providers.keys(); it.hasNext(); ) {
                    String id = it.next();
                    JSONObject p = providers.optJSONObject(id);
                    if (p == null) continue;
                    JSONObject copy = new JSONObject();
                    copy.put("model", p.optString("model", ""));
                    copy.put("api_key", maskKey(p.optString("api_key", p.optString("key", ""))));
                    masked.put(id, copy);
                }
            }
            provDoc.put("providers", masked);
            root.put("providers", provDoc);

            JSONArray skills = new JSONArray();
            File[] skillDirs = skillsDir.isDirectory() ? skillsDir.listFiles(File::isDirectory) : null;
            if (skillDirs != null) {
                for (File s : skillDirs) {
                    JSONObject item = new JSONObject();
                    item.put("name", s.getName());
                    File meta = new File(s, "SKILL.md");
                    String first = meta.isFile() ? firstNonEmptyLine(meta) : null;
                    item.put("summary", first == null ? "" : first);
                    skills.put(item);
                }
            }
            root.put("skills", skills);
            return root.toString(2);
        } catch (Exception e) {
            return "{}";
        }
    }

    private String maskKey(String key) {
        if (key == null || key.isEmpty()) return "（未设置）";
        if (key.length() <= 8) return "****";
        return key.substring(0, 4) + "****" + key.substring(key.length() - 4);
    }

    private JSONObject readJsonObject(File f) {
        if (!f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) >= 0) buffer.write(chunk, 0, n);
            return new JSONObject(new String(buffer.toByteArray(), "UTF-8"));
        } catch (Exception e) {
            return null;
        }
    }

    private String firstNonEmptyLine(File f) {
        try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.FileReader(f))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String t = line.trim();
                if (!t.isEmpty() && !t.startsWith("#")) return t;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 保存到公共下载目录；成功返回可读路径，失败返回 null。 */
    private String saveToDownloads(File src, String displayName) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                // Android 10+：MediaStore 写入 Downloads，无需额外权限。
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/zip");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return null;
                try (OutputStream out = getContentResolver().openOutputStream(uri);
                     InputStream in = new FileInputStream(src)) {
                    copyStream(in, out);
                }
                return "Download/" + displayName;
            }
            // Android 9-：公共下载目录（需要 WRITE_EXTERNAL_STORAGE）。
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) return null;
            File out = new File(dir, displayName);
            try (OutputStream os = new FileOutputStream(out);
                 InputStream in = new FileInputStream(src)) {
                copyStream(in, os);
            }
            return out.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    private static void copyStream(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
    }
}
