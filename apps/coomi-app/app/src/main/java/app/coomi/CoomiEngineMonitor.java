package app.coomi;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.text.TextUtils;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.termux.R;
import com.termux.shared.logger.Logger;

/**
 * Foreground service that monitors and keeps the Coomi engine alive.
 *
 * - Runs as foreground service with persistent notification
 * - Starts engine if not running
 * - Monitors engine process and restarts if it dies
 * - Handles Android Doze mode with partial wake lock
 */
public class CoomiEngineMonitor extends Service {

    private static final String LOG_TAG = "CoomiEngineMonitor";
    private static final int NOTIFICATION_ID = CoomiConstants.NOTIFICATION_ID;
    private static final int TASK_NOTIFICATION_ID = NOTIFICATION_ID + 1;
    private static final int MONITOR_INTERVAL_MS = 30000; // 30s
    private static final int RESTART_DELAY_MS = 5000;
    private static final int MAX_RESTART_ATTEMPTS = 5;
    private static final long WAKELOCK_TIMEOUT_MS = 15 * 60 * 1000L;
    private static final long WAKELOCK_REACQUIRE_INTERVAL_MS = 10 * 60 * 1000L;

    private Handler mHandler = new Handler(Looper.getMainLooper());
    private Runnable mMonitorRunnable;
    private PowerManager.WakeLock mWakeLock;
    private long mWakeLockLastAcquired = 0;

    private CoomiService mCoomiService;
    private boolean mBound = false;
    private boolean mIsMonitoring = false;
    private int mRestartAttempts = 0;
    private int mUnhealthyChecks = 0;
    private boolean mRestartInFlight = false;
    private String mCurrentStatus = "Starting...";

    /** Task state from the Web bridge: done or running:&lt;count&gt;. */
    private static volatile String sTaskStatus = null;
    private static volatile String sTaskSessionId = "";
    private static volatile boolean sTaskBackground = false;
    private static volatile boolean sTaskNotificationActive = false;
    private static volatile boolean sAppForeground = true;
    /** 当前运行中的 Monitor 实例（静态持有，供任务状态回调即时刷新通知）。 */
    private static volatile CoomiEngineMonitor sInstance = null;

    /** 前端任务状态回调：更新常驻通知的「任务执行中/已完成」文案。 */
    public static void setTaskStatus(String status) {
        setTaskStatus(status, "", false);
    }

    /**
     * Updates task state reported by the Web UI. Extra task notifications are
     * deliberately limited to background work; the foreground service notice
     * remains present solely to keep the engine alive.
     */
    public static void setTaskStatus(String status, String sessionId, boolean background) {
        // 批次二 #23：前端 2 秒轮询会反复上报同一状态；未变化时直接返回，
        // 不重新 notify（每次 notify 都会响铃/震动，这就是“只有一个任务也一直响”的根源）。
        boolean nextBackground = background || !sAppForeground;
        boolean unchanged = status != null && status.equals(sTaskStatus)
            && nextBackground == sTaskBackground
            && (sessionId == null || sessionId.isEmpty() || sessionId.equals(sTaskSessionId));
        if (unchanged) return;
        int previousCount = runningTaskCount(sTaskStatus);
        boolean previousBackground = sTaskBackground;
        sTaskStatus = status;
        if (sessionId != null && !sessionId.isEmpty()) sTaskSessionId = sessionId;
        sTaskBackground = nextBackground;
        CoomiEngineMonitor instance = sInstance;
        if (instance != null) {
            instance.onTaskStateChanged(previousCount, runningTaskCount(status), previousBackground);
        }
    }

    public static void setAppForeground(boolean foreground) {
        sAppForeground = foreground;
        CoomiEngineMonitor instance = sInstance;
        if (instance == null) return;
        if (foreground) {
            sTaskBackground = false;
            NotificationManager nm = (NotificationManager) instance.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(TASK_NOTIFICATION_ID);
            instance.updateStatus(instance.mCurrentStatus);
        } else if (runningTaskCount() > 0) {
            sTaskBackground = true;
            instance.onTaskStateChanged(runningTaskCount(), runningTaskCount(), true);
        }
    }

    private static int runningTaskCount() {
        return runningTaskCount(sTaskStatus);
    }

    /** Used by the chat Activity to decide whether leaving should enter PiP. */
    public static boolean hasRunningTasks() {
        return runningTaskCount() > 0;
    }

    private static int runningTaskCount(String status) {
        if (status == null) return 0;
        if ("running".equals(status)) return 1;
        if (!status.startsWith("running:")) return 0;
        try {
            return Math.max(0, Integer.parseInt(status.substring("running:".length())));
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private ServiceConnection mConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            CoomiService.LocalBinder binder = (CoomiService.LocalBinder) service;
            mCoomiService = binder.getService();
            mBound = true;
            Logger.logInfo(LOG_TAG, "Bound to CoomiService");
            if (!mIsMonitoring) startMonitoring();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            mCoomiService = null;
            mBound = false;
            Logger.logInfo(LOG_TAG, "Disconnected from CoomiService");
            scheduleRebind();
        }
    };

    private void scheduleRebind() {
        mHandler.postDelayed(() -> {
            if (mBound) return;
            try {
                Intent i = new Intent(this, CoomiService.class);
                startService(i);
                bindService(i, mConnection, Context.BIND_AUTO_CREATE);
            } catch (Exception e) {
                Logger.logError(LOG_TAG, "Rebind failed: " + e.getMessage());
                scheduleRebind();
            }
        }, 2000);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        Logger.logInfo(LOG_TAG, "Monitor created");

        Intent intent = new Intent(this, CoomiService.class);
        startService(intent);
        bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
        createNotificationChannel();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            mWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Coomi::EngineMonitor");
            mWakeLock.setReferenceCounted(false);
            updateWakeLockForTask();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Logger.logInfo(LOG_TAG, "Monitor started");
        Notification notification = buildNotification("Coomi 引擎运行中");
        startForeground(NOTIFICATION_ID, notification);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (sInstance == this) sInstance = null;
        Logger.logInfo(LOG_TAG, "Monitor destroyed");
        stopMonitoring();
        mHandler.removeCallbacksAndMessages(null);
        if (mBound) {
            try { unbindService(mConnection); } catch (Exception ignored) {}
            mBound = false;
            mCoomiService = null;
        }
        if (mWakeLock != null && mWakeLock.isHeld()) mWakeLock.release();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 划掉界面只表示 UI detach；前台服务与引擎继续执行后台任务。
        // 只有控制台里的显式停止操作才终止引擎及其子进程。
        Logger.logInfo(LOG_TAG, "Task removed; keeping engine and active tasks running");
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Monitoring ──

    private void startMonitoring() {
        mIsMonitoring = true;
        Logger.logInfo(LOG_TAG, "Starting engine monitoring");
        mMonitorRunnable = new Runnable() {
            @Override
            public void run() {
                reacquireWakeLockIfNeeded();
                checkAndRestartEngine();
                if (mIsMonitoring) mHandler.postDelayed(this, MONITOR_INTERVAL_MS);
            }
        };
        mHandler.post(mMonitorRunnable);
    }

    private void stopMonitoring() {
        mIsMonitoring = false;
        if (mMonitorRunnable != null) mHandler.removeCallbacks(mMonitorRunnable);
    }

    private void checkAndRestartEngine() {
        if (!mBound || mCoomiService == null) {
            scheduleRebind();
            return;
        }
        if (mCoomiService.isUpdateInProgress()) {
            updateStatus("部署中…");
            return;
        }
        if (mRestartInFlight) return;

        mCoomiService.getEngineStatus(result -> {
            if (!result.success) return;
            String status = result.stdout.trim();
            if ("running".equals(status)) {
                mUnhealthyChecks = 0;
                mRestartAttempts = 0;
                updateStatus("运行中");
            } else if ("starting".equals(status)) {
                // `starting` also means the native process is alive but its
                // 2-second HTTP health probe timed out. Model inference and
                // heavy tools can briefly delay that endpoint; restarting at
                // this point aborts an otherwise healthy turn.
                if (runningTaskCount() > 0) {
                    mUnhealthyChecks = 0;
                    updateStatus("忙碌中");
                    return;
                }
                mUnhealthyChecks++;
                if (mUnhealthyChecks < 3) {
                    updateStatus("启动中…");
                    return;
                }
                Logger.logWarn(LOG_TAG, "Engine process stayed unhealthy for "
                    + mUnhealthyChecks + " checks; restarting while idle");
                mUnhealthyChecks = 0;
                updateStatus("重启中…");
                restartEngine();
            } else if ("stopped".equals(status)) {
                mUnhealthyChecks = 0;
                Logger.logInfo(LOG_TAG, "Engine not running, restarting...");
                updateStatus("重启中…");
                restartEngine();
            } else {
                Logger.logWarn(LOG_TAG, "Ignoring unknown engine status: " + status);
            }
        });
    }

    private void restartEngine() {
        if (!mBound || mCoomiService == null) return;
        if (mRestartInFlight) return;
        if (mRestartAttempts >= MAX_RESTART_ATTEMPTS) {
            updateStatus("失败 - 需要手动重启");
            return;
        }

        mRestartAttempts++;
        mRestartInFlight = true;
        Logger.logInfo(LOG_TAG, "Restart attempt " + mRestartAttempts);

        mCoomiService.startEngine(result -> {
            mRestartInFlight = false;
            if (result.success) {
                mRestartAttempts = 0;
                mHandler.postDelayed(() -> updateStatus("运行中"), RESTART_DELAY_MS);
            } else {
                updateStatus("失败 (尝试 " + mRestartAttempts + "/" + MAX_RESTART_ATTEMPTS + ")");
                if (mRestartAttempts < MAX_RESTART_ATTEMPTS) {
                    mHandler.postDelayed(this::restartEngine, RESTART_DELAY_MS);
                }
            }
        });
    }

    // ── Notification ──

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
            CoomiConstants.NOTIFICATION_CHANNEL_ID,
            CoomiConstants.NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        );
        ch.setDescription("Coomi 引擎状态通知");
        nm.createNotificationChannel(ch);
        NotificationChannel taskChannel = new NotificationChannel(
            CoomiConstants.TASK_NOTIFICATION_CHANNEL_ID,
            CoomiConstants.TASK_NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        );
        taskChannel.setDescription("后台或长时间运行任务的完成提醒");
        nm.createNotificationChannel(taskChannel);
    }

    private void updateStatus(String status) {
        mCurrentStatus = status;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification("Coomi: " + status));
    }

    private void onTaskStateChanged(int previousCount, int currentCount, boolean previousBackground) {
        updateWakeLockForTask();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // 批次二 #26：运行状态展示合并进常驻服务通知（1001 已内嵌「N 个任务执行中」），
        // 1002 只承担一件事——后台任务结束时的一次性提醒，不再进入轮询更新循环。
        if (previousCount > 0 && currentCount == 0 && sTaskBackground) {
            nm.notify(TASK_NOTIFICATION_ID, buildTaskNotification("后台任务已结束", false));
            sTaskNotificationActive = false;
        } else if (currentCount > 0 && sTaskNotificationActive) {
            nm.cancel(TASK_NOTIFICATION_ID);
            sTaskNotificationActive = false;
        }
        updateStatus(mCurrentStatus);
    }

    /** 通知点击目标：按「启动首页」设置跳控制台或对话页。只用 NEW_TASK 复用现有
     *  singleTask 实例，不用 CLEAR_TASK 清任务栈（否则会销毁正在跑的对话页导致任务中断）。 */
    private PendingIntent buildContentIntent() {
        return buildContentIntent(false);
    }

    private PendingIntent buildContentIntent(boolean task) {
        Class<?> target = task || CoomiHomePreference.isChatHome(this)
            ? com.termux.app.CoomiActivity.class : CoomiDashboardActivity.class;
        Intent i = new Intent(this, target);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (target == com.termux.app.CoomiActivity.class && !TextUtils.isEmpty(sTaskSessionId)) {
            i.putExtra(com.termux.app.CoomiActivity.EXTRA_SESSION_ID, sTaskSessionId);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        // Keep the task click target independent from the persistent service notice.
        return PendingIntent.getActivity(this, task ? 1 : 0, i, flags);
    }

    private Notification buildNotification(String contentText) {
        // 任务执行状态拼进正文：如「Coomi: 运行中 · 任务执行中」
        int runningTasks = runningTaskCount();
        if (runningTasks > 0 && sTaskBackground) {
            contentText += " · " + runningTasks + " 个任务执行中";
        } else if ("done".equals(sTaskStatus) && sTaskBackground) {
            contentText += " · 任务已完成";
        }
        return new NotificationCompat.Builder(this, CoomiConstants.NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Coomi")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_service_notification)
            .setContentIntent(buildContentIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setShowWhen(false)
            .build();
    }

    private Notification buildTaskNotification(String text, boolean ongoing) {
        return new NotificationCompat.Builder(this, CoomiConstants.TASK_NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Coomi 任务")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_service_notification)
            .setContentIntent(buildContentIntent(true))
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            // 批次二 #23：同一通知的重复更新（如轮询刷新）不再重复响铃。
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setShowWhen(true)
            .build();
    }

    // ── WakeLock ──

    private void acquireWakeLock() {
        if (mWakeLock != null && !mWakeLock.isHeld()) {
            mWakeLock.acquire(WAKELOCK_TIMEOUT_MS);
            mWakeLockLastAcquired = System.currentTimeMillis();
        }
    }

    private void reacquireWakeLockIfNeeded() {
        if (mWakeLock == null) return;
        if (runningTaskCount() == 0) {
            if (mWakeLock.isHeld()) mWakeLock.release();
            return;
        }
        long elapsed = System.currentTimeMillis() - mWakeLockLastAcquired;
        if (elapsed >= WAKELOCK_REACQUIRE_INTERVAL_MS) {
            if (mWakeLock.isHeld()) mWakeLock.release();
            acquireWakeLock();
        }
    }

    private void updateWakeLockForTask() {
        if (mWakeLock == null) return;
        if (runningTaskCount() > 0) acquireWakeLock();
        else if (mWakeLock.isHeld()) mWakeLock.release();
    }
}
