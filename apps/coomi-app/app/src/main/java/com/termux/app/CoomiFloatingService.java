package com.termux.app;

import android.app.AppOpsManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Display;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

import app.coomi.CoomiFloatingWindow;
import com.termux.R;

/** Keeps only the window and session alive; engine lifetime remains independent. */
public final class CoomiFloatingService extends Service {
    private static final String CHANNEL = "coomi_floating_chat";
    private static final int NOTIFICATION_ID = 1042;
    private static CoomiFloatingService sInstance;
    private CoomiChatSession mSession;
    private CoomiFloatingWindow mWindow;
    private boolean mReleased;
    private AppOpsManager mAppOps;
    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private final AppOpsManager.OnOpChangedListener mPermissionListener = (op, packageName) ->
        mHandler.post(() -> {
            if (!mReleased && Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this))
                returnToFullscreen();
        });

    @Override public void onCreate() {
        super.onCreate();
        sInstance = this;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (mReleased) { stopSelf(); return START_NOT_STICKY; }
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, "悬浮聊天", NotificationManager.IMPORTANCE_LOW));
            Intent fullscreen = new Intent(this, CoomiActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            PendingIntent content = PendingIntent.getActivity(this, 1042, fullscreen,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startForeground(NOTIFICATION_ID, new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_service_notification)
                .setContentTitle("Coomi 悬浮聊天")
                .setContentText("点击返回全屏聊天")
                .setContentIntent(content).setOngoing(true).setSilent(true).build());
            if (mWindow != null) return START_NOT_STICKY;
            mSession = CoomiChatSession.peek();
            if (mSession == null || !mSession.isLoaded()) { stopSelf(); return START_NOT_STICKY; }
            if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
                returnToFullscreen();
                return START_NOT_STICKY;
            }
            Context windowContext = this;
            if (Build.VERSION.SDK_INT >= 30) {
                Display display = ((DisplayManager) getSystemService(DISPLAY_SERVICE))
                    .getDisplay(Display.DEFAULT_DISPLAY);
                windowContext = createDisplayContext(display)
                    .createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null);
            }
            mSession.flush();
            mSession.detachWebView();
            mSession.useWindowContext(windowContext);
            mWindow = new CoomiFloatingWindow(windowContext, mSession.webView(),
                this::returnToFullscreen, this::closeWindow);
            mWindow.show();
            mSession.setFloating(true);
            mSession.moveActivityToBackground();
            if (Build.VERSION.SDK_INT >= 23) {
                mAppOps = (AppOpsManager) getSystemService(APP_OPS_SERVICE);
                mAppOps.startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW,
                    getPackageName(), mPermissionListener);
            }
        } catch (RuntimeException error) {
            Toast.makeText(this, "悬浮窗无法显示，已返回全屏：" + error.getMessage(), Toast.LENGTH_LONG).show();
            returnToFullscreen();
        }
        return START_NOT_STICKY;
    }

    public static void releaseForFullscreen() {
        CoomiFloatingService service = sInstance;
        if (service != null) service.releaseWindow();
    }

    static void setRequestVisible(boolean requestVisible) {
        CoomiFloatingService service = sInstance;
        if (service == null || service.mWindow == null || service.mReleased) return;
        try { service.mWindow.setVisible(!requestVisible); }
        catch (RuntimeException error) { service.returnToFullscreen(); }
    }

    private void returnToFullscreen() {
        if (mReleased) return;
        CoomiChatSession session = mSession != null ? mSession : CoomiChatSession.peek();
        releaseWindow();
        if (session != null) {
            try { session.restoreFullscreen(); }
            catch (RuntimeException error) {
                Toast.makeText(this, "请从应用或通知返回聊天", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void closeWindow() {
        if (mReleased) return;
        // A revoked permission is a window failure, not an explicit destructive close.
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            returnToFullscreen();
            return;
        }
        CoomiChatSession session = mSession;
        releaseWindow();
        if (session != null) session.closeFloating();
    }

    private void releaseWindow() {
        if (mReleased) return;
        mReleased = true;
        if (mAppOps != null) mAppOps.stopWatchingMode(mPermissionListener);
        mHandler.removeCallbacksAndMessages(null);
        if (mWindow != null) {
            try { mWindow.dismiss(); } catch (RuntimeException ignored) { }
            mWindow = null;
        }
        if (mSession != null) {
            mSession.detachWebView();
            mSession.useWindowContext(getApplicationContext());
            mSession.setFloating(false);
        }
        if (sInstance == this) sInstance = null;
        stopForeground(true);
        stopSelf();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (mSession != null) mSession.resume();
        if (mWindow != null) {
            try { mWindow.onConfigurationChanged(); }
            catch (RuntimeException error) { returnToFullscreen(); }
        }
    }

    @Override public void onDestroy() {
        if (!mReleased) returnToFullscreen();
        mSession = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
