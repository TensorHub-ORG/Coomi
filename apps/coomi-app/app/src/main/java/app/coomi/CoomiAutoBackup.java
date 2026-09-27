package app.coomi;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.Data;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

final class CoomiAutoBackup {
    static final String PREFS = "coomi_auto_backup";
    static final String KEY_ENABLED = "enabled";
    static final String KEY_DIRECTORY = "directory";
    static final String KEY_INTERVAL_HOURS = "interval_hours";
    static final String KEY_KEEP_COUNT = "keep_count";
    static final String KEY_CHARGING = "charging";
    static final String KEY_WIFI = "wifi";
    static final String KEY_LAST_SUCCESS = "last_success";
    static final String KEY_LAST_SIZE = "last_size";
    static final String KEY_LAST_ERROR = "last_error";
    static final String KEY_NEXT_RUN = "next_run";
    static final String KEY_PROGRESS_STAGE = "progress_stage";
    static final String KEY_PROGRESS_PERCENT = "progress_percent";
    static final String KEY_PROGRESS_RUNNING = "progress_running";
    static final int DEFAULT_INTERVAL_HOURS = 24;
    static final int DEFAULT_KEEP_COUNT = 7;
    static final int[] INTERVAL_HOURS = {6, 12, 24, 72, 168};
    static final ReentrantLock OPERATION_LOCK = new ReentrantLock();

    private static final String UNIQUE_PERIODIC = "coomi-auto-backup";
    private static final String UNIQUE_IMMEDIATE = "coomi-auto-backup-now";

    private CoomiAutoBackup() {}

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void schedule(Context context) {
        SharedPreferences preferences = preferences(context);
        WorkManager manager = WorkManager.getInstance(context);
        if (!preferences.getBoolean(KEY_ENABLED, false)
            || preferences.getString(KEY_DIRECTORY, "").isEmpty()) {
            manager.cancelUniqueWork(UNIQUE_PERIODIC);
            preferences.edit().putLong(KEY_NEXT_RUN, 0).apply();
            return;
        }
        int hours = normalizeInterval(preferences.getInt(KEY_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS));
        Constraints constraints = new Constraints.Builder()
            .setRequiresCharging(preferences.getBoolean(KEY_CHARGING, false))
            .setRequiredNetworkType(preferences.getBoolean(KEY_WIFI, false)
                ? NetworkType.UNMETERED : NetworkType.NOT_REQUIRED)
            .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
            CoomiAutoBackupWorker.class, hours, TimeUnit.HOURS)
            .setConstraints(constraints)
            .addTag(UNIQUE_PERIODIC)
            .build();
        manager.enqueueUniquePeriodicWork(UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request);
        preferences.edit().putLong(KEY_NEXT_RUN,
            System.currentTimeMillis() + TimeUnit.HOURS.toMillis(hours)).apply();
    }

    static void runNow(Context context) {
        preferences(context).edit()
            .putString(KEY_LAST_ERROR, "")
            .putString(KEY_PROGRESS_STAGE, "等待开始自动备份")
            .putInt(KEY_PROGRESS_PERCENT, 0)
            .putBoolean(KEY_PROGRESS_RUNNING, true)
            .apply();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(CoomiAutoBackupWorker.class)
            .setInputData(new Data.Builder().putBoolean("force", true).build())
            .addTag(UNIQUE_IMMEDIATE)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_IMMEDIATE, ExistingWorkPolicy.KEEP, request);
    }

    static void disableForRevokedDirectory(Context context, String message) {
        preferences(context).edit()
            .putBoolean(KEY_ENABLED, false)
            .putLong(KEY_NEXT_RUN, 0)
            .putString(KEY_LAST_ERROR, message)
            .apply();
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_PERIODIC);
    }

    static int normalizeInterval(int value) {
        for (int candidate : INTERVAL_HOURS) if (candidate == value) return value;
        return DEFAULT_INTERVAL_HOURS;
    }

    static Uri directoryUri(Context context) {
        String value = preferences(context).getString(KEY_DIRECTORY, "");
        return value.isEmpty() ? null : Uri.parse(value);
    }
}
