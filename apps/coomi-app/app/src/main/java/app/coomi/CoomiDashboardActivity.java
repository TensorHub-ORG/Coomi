package app.coomi;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Build;
import android.provider.Settings;
import android.net.Uri;
import android.view.View;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import com.termux.BuildConfig;

import androidx.annotation.Nullable;

import com.termux.R;
import com.termux.app.TermuxActivity;
import com.termux.shared.logger.Logger;
import com.termux.shared.termux.TermuxConstants;

/**
 * Coomi Dashboard — main screen after setup.
 *
 * Shows engine status, restart/stop controls, and quick links.
 */
public class CoomiDashboardActivity extends Activity {
    private static final String PREFS_NAME = "coomi_launcher";

    private static final String LOG_TAG = "CoomiDashboardActivity";
    /** coomi TUI 的固定 Termux 会话名（配合 no-shell-with-name 复用会话，批次二 #25）。 */
    private static final String COOMI_TUI_SESSION_NAME = "coomi";
    private static final int STATUS_REFRESH_MS = 5000;

    private View mStatusIndicator;
    private TextView mStatusText;
    private TextView mRuntimeVersionText;
    private View mOpenChatButton;
    private View mAiStudioButton;
    private Button mRestartButton;
    private Button mStopButton;
    private View mOpenTerminalButton;
    private View mOpenTuiButton;
    private View mOpenWebUiButton;
    private View mWebUiButtonContainer;
    private View mCatalogButton;
    private View mWorkflowsButton;
    private View mHooksButton;
    private View mMemoryButton;
    private View mLifeButton;
    private View mFilesButton;
    private View mProvidersButton;
    private View mRuntimeButton;
    private View mCheckUpdateButton;
    private View mCustomIterationButton;
    private TextView mCheckUpdateDesc;
    private View mUpdateDot;
    private View mHomeSettingsButton;
    private View mPermissionSettingsButton;
    private View mStorageSettingsButton;
    private View mAppearanceButton;
    private View mBackupButton;
    private View mMaintenanceButton;
    private View mUsageButton;
    private View mFeedbackButton;
    private String mAppliedThemeMode;
    private String mAppliedAppearanceSignature;

    private CoomiService mCoomiService;
    private boolean mBound = false;
    private boolean mRegistryRefreshRequested;
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
        mAppliedThemeMode = CoomiTheme.getMode(this);
        mAppliedAppearanceSignature = CoomiTheme.appearanceSignature(this);
        setContentView(R.layout.activity_coomi_dashboard);
        CoomiTheme.applyPageSystemBars(this);
        CoomiTheme.applyConsoleBackground(this, findViewById(R.id.coomi_dashboard_root));

        mStatusIndicator = findViewById(R.id.dashboard_status_indicator);
        mStatusText = findViewById(R.id.dashboard_status_text);
        mRuntimeVersionText = findViewById(R.id.dashboard_runtime_version);
        mOpenChatButton = findViewById(R.id.btn_open_chat);
        mAiStudioButton = findViewById(R.id.btn_ai_studio);
        mRestartButton = findViewById(R.id.btn_restart);
        mStopButton = findViewById(R.id.btn_stop);
        mOpenTerminalButton = findViewById(R.id.btn_open_terminal);
        mOpenTuiButton = findViewById(R.id.btn_open_tui);
        mOpenWebUiButton = findViewById(R.id.btn_open_webui);
        mWebUiButtonContainer = findViewById(R.id.webui_button_container);
        mCatalogButton = findViewById(R.id.btn_web_catalog);
        mWorkflowsButton = findViewById(R.id.btn_web_workflows);
        mHooksButton = findViewById(R.id.btn_web_hooks);
        mMemoryButton = findViewById(R.id.btn_web_memory);
        mLifeButton = findViewById(R.id.btn_web_life);
        mFilesButton = findViewById(R.id.btn_web_files);
        mCheckUpdateButton = findViewById(R.id.btn_check_update);
        mCustomIterationButton = findViewById(R.id.btn_custom_iteration);
        mCheckUpdateDesc = findViewById(R.id.txt_check_update_desc);
        mUpdateDot = findViewById(R.id.dot_update);
        mHomeSettingsButton = findViewById(R.id.btn_home_settings);
        mCheckUpdateDesc.setText(getString(R.string.coomi_dash_check_update_desc, BuildConfig.VERSION_NAME));
        checkUpdateSilently();
        mBackupButton = findViewById(R.id.btn_backup_data);
        mMaintenanceButton = findViewById(R.id.btn_maintenance);
        mUsageButton = findViewById(R.id.btn_usage);
        mFeedbackButton = findViewById(R.id.btn_feedback);
        mPermissionSettingsButton = findViewById(R.id.btn_permission_settings);
        mStorageSettingsButton = findViewById(R.id.btn_storage_settings);
        mAppearanceButton = findViewById(R.id.btn_appearance);

        mOpenChatButton.setOnClickListener(v -> openChat());
        mAiStudioButton.setOnClickListener(v -> openCoomiRoute("#/studio"));
        mRestartButton.setOnClickListener(v -> restartEngine());
        mStopButton.setOnClickListener(v -> stopEngine());
        mOpenTuiButton.setOnClickListener(v -> openTui());
        mOpenTerminalButton.setOnClickListener(v -> openTerminal());
        mOpenWebUiButton.setOnClickListener(v -> openWebUi());
        mCatalogButton.setOnClickListener(v -> openCatalog());
        mWorkflowsButton.setOnClickListener(v -> openWorkflows());
        mHooksButton.setOnClickListener(v -> openCoomiRoute("#/hooks"));
        mMemoryButton.setOnClickListener(v -> openCoomiRoute("#/memory"));
        mLifeButton.setOnClickListener(v -> openCoomiRoute("#/life"));
        mFilesButton.setOnClickListener(v -> openFiles());
        mProvidersButton = findViewById(R.id.btn_web_providers);
        mRuntimeButton = findViewById(R.id.btn_web_runtime);
        mProvidersButton.setOnClickListener(v -> openProviders());
        mRuntimeButton.setOnClickListener(v -> openRuntime());
        mCheckUpdateButton.setOnClickListener(v -> checkUpdate());
        mCustomIterationButton.setOnClickListener(v -> openCoomiRoute("#/custom-iteration"));
        mHomeSettingsButton.setOnClickListener(v ->
            startActivity(new Intent(this, CoomiHomeSettingActivity.class)));
        mAppearanceButton.setOnClickListener(v ->
            startActivity(new Intent(this, CoomiAppearanceActivity.class)));
        mBackupButton.setOnClickListener(v ->
            startActivity(new Intent(this, CoomiBackupActivity.class)));
        mMaintenanceButton.setOnClickListener(v -> openCoomiRoute("#/maintenance"));
        mUsageButton.setOnClickListener(v -> openCoomiRoute("#/usage"));
        mFeedbackButton.setOnClickListener(v ->
            startActivity(new Intent(this, CoomiFeedbackActivity.class)));
        View uxProgramButton = findViewById(R.id.btn_ux_program);
        uxProgramButton.setOnClickListener(v -> openCoomiRoute("#/ux-program"));
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

    /** 演示包：引擎和终端都不存在，界面上直说，别让人以为它在跑。 */
    private void applyDemoState() {
        mStatusIndicator.setBackgroundResource(R.drawable.coomi_dot_idle);
        CoomiTheme.applyCustomColors(this, mStatusIndicator);
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
                CoomiTheme.applyCustomColors(this, mStatusIndicator);
                mStatusText.setText(label);
                mRestartButton.setEnabled(!starting);
                mStopButton.setEnabled(running);
                if (mWebUiButtonContainer != null) {
                    mWebUiButtonContainer.setVisibility(running ? View.VISIBLE : View.GONE);
                }
                if (running && !mRegistryRefreshRequested) {
                    mRegistryRefreshRequested = true;
                    mCoomiService.refreshRegistryCache();
                }
            });
        });
    }

    // ── Actions ──

    private void openChat() {
        openCoomiRoute("#/");
    }

    @Override
    protected void onResume() {
        super.onResume();
        mRegistryRefreshRequested = false;
        String currentMode = CoomiTheme.getMode(this);
        String currentAppearance = CoomiTheme.appearanceSignature(this);
        if ((mAppliedThemeMode != null && !mAppliedThemeMode.equals(currentMode))
            || (mAppliedAppearanceSignature != null && !mAppliedAppearanceSignature.equals(currentAppearance))) {
            recreate();
            return;
        }
        CoomiTheme.applyPageSystemBars(this);
        CoomiTheme.applyConsoleBackground(this, findViewById(R.id.coomi_dashboard_root));
    }

    private void openCoomiRoute(String route) {
        Intent intent = new Intent(this, com.termux.app.CoomiActivity.class);
        intent.putExtra(com.termux.app.CoomiActivity.EXTRA_ROUTE, route);
        intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        startActivity(intent);
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
        // 批次七 #12：返回键 = 退到桌面并保持后台运行。引擎、常驻通知与运行中
        // 任务不受影响（引擎本身按常驻设计；旧行为"返回即停引擎退出"会杀掉
        // 后台任务，按反馈调整）。需要彻底退出时从最近任务划掉即可。
        moveTaskToBack(true);
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
        // 1) 先打开终端：确保 TermuxService / 终端会话先就绪
        Intent terminal = new Intent(this, TermuxActivity.class);
        terminal.putExtra(TermuxConstants.TERMUX_PACKAGE_NAME + ".app.TERMUX_DIR", TermuxConstants.TERMUX_HOME_DIR_PATH);
        startActivity(terminal);
        // 2) 稍作延迟等终端会话起来后，再在新会话里执行 `coomi`（无子命令 = 交互式 TUI）。
        //    立即执行的话命令会跑在尚未就绪的 shell 上，导致打开的只是普通终端。
        new Handler(Looper.getMainLooper()).postDelayed(this::launchCoomiTui, 1200);
    }

    private void launchCoomiTui() {
        try {
            Intent intent = new Intent();
            intent.setClassName(this, TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE_NAME);
            intent.setAction(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.ACTION_RUN_COMMAND);
            intent.putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_COMMAND_PATH,
                TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/bin/coomi");
            intent.putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_ARGUMENTS,
                new String[0]);
            intent.putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_WORKDIR,
                TermuxConstants.TERMUX_HOME_DIR_PATH);
            // 批次二 #25：固定会话名 + no-shell-with-name——已有 coomi TUI 会话直接
            // 切换过去，没有才新建。否则每点一次就多一个 Termux 会话，通知栏
            // sessions 计数随之暴涨且只增不减。
            intent.putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_SHELL_NAME,
                COOMI_TUI_SESSION_NAME);
            intent.putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_SHELL_CREATE_MODE,
                "no-shell-with-name");
            // 0 = 切换到该会话并打开终端界面，前台执行命令
            intent.putExtra(TermuxConstants.TERMUX_APP.RUN_COMMAND_SERVICE.EXTRA_SESSION_ACTION,
                String.valueOf(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.VALUE_EXTRA_SESSION_ACTION_SWITCH_TO_NEW_SESSION_AND_OPEN_ACTIVITY));
            startService(intent);
        } catch (Exception e) {
            Logger.logError(LOG_TAG, "Failed to launch Coomi TUI: " + e.getMessage());
        }
    }

    private void openTerminal() {
        if (demoUnavailable()) return;
        // Open Termux shell for debugging. TERMUX_DIR must match the bootstrap's baked-in
        // home path, so it comes from TermuxConstants rather than a literal.
        Intent intent = new Intent(this, TermuxActivity.class);
        intent.putExtra(TermuxConstants.TERMUX_PACKAGE_NAME + ".app.TERMUX_DIR", TermuxConstants.TERMUX_HOME_DIR_PATH);
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
        openCoomiRoute("#/catalog");
    }

    /** 打开应用内自动化工作流页（WebView 直达 #/workflows）。 */
    private void openWorkflows() {
        openCoomiRoute("#/workflows");
    }

    /** 打开应用内文件管理页（WebView 直达 #/files）。 */
    private void openFiles() {
        openCoomiRoute("#/files");
    }

    /** 打开应用内 Provider / API Key 配置页（WebView 直达 #/providers）。 */
    private void openProviders() {
        openCoomiRoute("#/providers");
    }

    /** 打开应用内内置环境页（WebView 直达 #/runtime）。 */
    private void openRuntime() {
        openCoomiRoute("#/runtime");
    }

    /** Collect a proactive suggestion or issue without including conversations or credentials.
     *  主动反馈已迁移至「问题反馈与诊断」二级页（CoomiFeedbackActivity）。 */

    /** 检查更新：进入二级页面（正式/测试通道），页面内发起下载与安装。 */
    private void checkUpdate() {
        openCoomiRoute("#/updates");
    }

    /** 进入控制台时静默检查一次：有新版本则在「检查更新」旁亮红点提示。 */
    private void checkUpdateSilently() {
        UpdateChecker.checkSilent(this, (hasUpdate, version, notes, error) -> {
            if (hasUpdate) {
                mUpdateDot.setVisibility(View.VISIBLE);
                mCheckUpdateDesc.setText("发现新版本 " + version + "，点击更新");
            }
        });
    }

}
