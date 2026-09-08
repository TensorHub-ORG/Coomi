package com.termux.app;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import app.coomi.CoomiEngineMonitor;
import app.coomi.CoomiTheme;
import com.termux.R;

/** Fullscreen host; the session, not this Activity, owns the chat WebView. */
public class CoomiActivity extends Activity {
    public static final String EXTRA_ROUTE = "coomi.route";
    public static final String EXTRA_SESSION_ID = "coomi.session_id";
    public static final String EXTRA_PREFILL_DRAFT = "coomi.prefill_draft";
    public static final String EXTRA_RETURN_TO_SETUP = "coomi.return_to_setup";
    private static final int REQUEST_OVERLAY = 2105;
    private CoomiChatSession mSession;
    private boolean mWaitingForPermission;
    private boolean mOpeningFloating;

    @Override protected void onCreate(Bundle state) {
        CoomiTheme.applyWebTheme(this);
        super.onCreate(state);
        setContentView(R.layout.activity_coomi);
        CoomiTheme.applySystemBars(this);
        mWaitingForPermission = state != null && state.getBoolean("waitingOverlay");
        findViewById(R.id.btn_coomi_retry).setOnClickListener(v -> mSession.retryStart());
        attachSession();
    }

    public void attachSession() {
        CoomiFloatingService.releaseForFullscreen();
        mSession = CoomiChatSession.get(this);
        mSession.attach(this, (ViewGroup) findViewById(R.id.coomi_webview), getIntent());
        getIntent().removeExtra(EXTRA_ROUTE);
        getIntent().removeExtra(EXTRA_SESSION_ID);
        getIntent().removeExtra(EXTRA_PREFILL_DRAFT);
    }

    void showSessionState(String message, boolean failed, boolean loaded) {
        findViewById(R.id.coomi_splash).setVisibility(loaded ? View.GONE : View.VISIBLE);
        findViewById(R.id.coomi_splash_spinner).setVisibility(failed ? View.GONE : View.VISIBLE);
        findViewById(R.id.btn_coomi_retry).setVisibility(failed ? View.VISIBLE : View.GONE);
        findViewById(R.id.coomi_loading_detail).setVisibility(View.GONE);
        TextView text = findViewById(R.id.coomi_loading_text);
        if (message != null) text.setText(message);
        text.setTextColor(ContextCompat.getColor(this, CoomiTheme.isDark(this)
            ? (failed ? R.color.coomi_night_danger : R.color.coomi_night_text_2)
            : (failed ? R.color.coomi_danger : R.color.coomi_text_2)));
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        attachSession();
    }

    @Override protected void onResume() {
        super.onResume();
        mOpeningFloating = false;
        if (mSession != CoomiChatSession.peek() || mSession.isFloating() || !mSession.hasActivity()) attachSession();
        mSession.resume();
        CoomiTheme.applySystemBars(this);
        CoomiEngineMonitor.setAppForeground(true);
    }

    public void openFloatingWindow() {
        if (mOpeningFloating || mWaitingForPermission || mSession.isFloating()) return;
        if (!mSession.isLoaded()) {
            Toast.makeText(this, "请等待聊天加载完成", Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode()) {
            Toast.makeText(this, "请先退出画中画再打开悬浮窗", Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            mWaitingForPermission = true;
            try {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName())), REQUEST_OVERLAY);
            } catch (RuntimeException error) {
                mWaitingForPermission = false;
                Toast.makeText(this, "无法打开悬浮窗权限设置", Toast.LENGTH_LONG).show();
            }
            return;
        }
        startFloating();
    }

    private void startFloating() {
        mOpeningFloating = true;
        try {
            ContextCompat.startForegroundService(this, new Intent(this, CoomiFloatingService.class));
        } catch (RuntimeException error) {
            mOpeningFloating = false;
            Toast.makeText(this, "无法打开悬浮窗：" + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != REQUEST_OVERLAY || !mWaitingForPermission) return;
        mWaitingForPermission = false;
        if (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)) startFloating();
        else Toast.makeText(this, "未授予悬浮窗权限，继续使用全屏聊天", Toast.LENGTH_SHORT).show();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean("waitingOverlay", mWaitingForPermission);
        super.onSaveInstanceState(state);
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        CoomiTheme.applySystemBars(this);
        if (mSession != null) mSession.resume();
    }

    @Override protected void onPause() {
        if (mSession != null) mSession.flush();
        CoomiEngineMonitor.setAppForeground(false);
        super.onPause();
    }

    @Override public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (!mWaitingForPermission && !mOpeningFloating && mSession != null && !mSession.isFloating()
            && !mSession.hasPendingRequest() && !CoomiChatRequestActivity.isActive() && Build.VERSION.SDK_INT >= 24
            && CoomiEngineMonitor.hasRunningTasks() && !isInPictureInPictureMode()) {
            try { enterPictureInPictureMode(); } catch (RuntimeException ignored) { }
        }
    }

    @Override public void onBackPressed() {
        if (mSession != null) mSession.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (mSession != null) mSession.detach(this, isChangingConfigurations());
        mSession = null;
        super.onDestroy();
    }
}
