package app.coomi;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.documentfile.provider.DocumentFile;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.Data;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

public final class CoomiAutoBackupWorker extends Worker {
    public CoomiAutoBackupWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences preferences = CoomiAutoBackup.preferences(context);
        if (!getInputData().getBoolean("force", false)
            && !preferences.getBoolean(CoomiAutoBackup.KEY_ENABLED, false)) return Result.success();
        Uri directoryUri = CoomiAutoBackup.directoryUri(context);
        if (directoryUri == null) return failure("未选择自动备份目录", true);
        if (!CoomiAutoBackup.OPERATION_LOCK.tryLock()) return Result.retry();

        File archive = null;
        DocumentFile partial = null;
        try {
            preferences.edit().putString(CoomiAutoBackup.KEY_LAST_ERROR, "").apply();
            reportProgress(preferences, "正在准备自动备份", 0);
            DocumentFile directory = DocumentFile.fromTreeUri(context, directoryUri);
            if (directory == null || !directory.isDirectory() || !directory.canWrite()) {
                return failure("备份目录授权已失效，请重新选择", true);
            }
            final int[] lastArchivePercent = {-1};
            final String[] lastArchiveStage = {""};
            archive = CoomiBackupArchive.create(context, (stage, processed, total) -> {
                int percent = total > 0 ? (int) Math.min(90, processed * 90 / total) : 0;
                if (percent != lastArchivePercent[0] || !stage.equals(lastArchiveStage[0])) {
                    lastArchivePercent[0] = percent;
                    lastArchiveStage[0] = stage;
                    reportProgress(preferences, stage, percent);
                }
            });
            final long archiveSize = archive.length();
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            String finalName = "coomi-backup-" + stamp + ".zip";
            partial = directory.createFile("application/octet-stream", finalName + ".partial");
            if (partial == null) throw new IllegalStateException("无法在目标目录创建临时文件");
            long copiedBytes;
            try (InputStream input = new FileInputStream(archive);
                 OutputStream output = context.getContentResolver().openOutputStream(partial.getUri(), "w")) {
                if (output == null) throw new IllegalStateException("无法写入目标目录");
                copiedBytes = copy(input, output, archiveSize, copied -> {
                    int percent = archiveSize > 0
                        ? 90 + (int) Math.min(9, copied * 9 / archiveSize) : 90;
                    reportProgress(preferences, "正在写入自动备份目录", percent);
                });
            }
            if (copiedBytes != archiveSize) {
                throw new IllegalStateException("写入后的备份大小不一致");
            }
            if (!partial.renameTo(finalName)) throw new IllegalStateException("目标目录不支持原子完成备份");
            partial = null;
            rotate(directory, preferences.getInt(CoomiAutoBackup.KEY_KEEP_COUNT, CoomiAutoBackup.DEFAULT_KEEP_COUNT));
            int interval = CoomiAutoBackup.normalizeInterval(
                preferences.getInt(CoomiAutoBackup.KEY_INTERVAL_HOURS, CoomiAutoBackup.DEFAULT_INTERVAL_HOURS));
            preferences.edit()
                .putLong(CoomiAutoBackup.KEY_LAST_SUCCESS, System.currentTimeMillis())
                .putLong(CoomiAutoBackup.KEY_LAST_SIZE, archiveSize)
                .putString(CoomiAutoBackup.KEY_LAST_ERROR, "")
                .putLong(CoomiAutoBackup.KEY_NEXT_RUN,
                    System.currentTimeMillis() + TimeUnit.HOURS.toMillis(interval))
                .putString(CoomiAutoBackup.KEY_PROGRESS_STAGE, "自动备份完成")
                .putInt(CoomiAutoBackup.KEY_PROGRESS_PERCENT, 100)
                .putBoolean(CoomiAutoBackup.KEY_PROGRESS_RUNNING, false)
                .apply();
            return Result.success();
        } catch (SecurityException error) {
            return failure("备份目录授权已失效，请重新选择", true);
        } catch (Exception error) {
            return failure(safeMessage(error), false);
        } finally {
            if (partial != null) partial.delete();
            if (archive != null) archive.delete();
            CoomiAutoBackup.OPERATION_LOCK.unlock();
        }
    }

    private Result failure(String message, boolean disable) {
        Context context = getApplicationContext();
        if (disable) {
            CoomiAutoBackup.disableForRevokedDirectory(context, message);
            CoomiAutoBackup.preferences(context).edit()
                .putString(CoomiAutoBackup.KEY_PROGRESS_STAGE, "自动备份失败：" + message)
                .putBoolean(CoomiAutoBackup.KEY_PROGRESS_RUNNING, false)
                .apply();
        }
        else CoomiAutoBackup.preferences(context).edit()
            .putString(CoomiAutoBackup.KEY_LAST_ERROR, message)
            .putString(CoomiAutoBackup.KEY_PROGRESS_STAGE, "自动备份失败：" + message)
            .putBoolean(CoomiAutoBackup.KEY_PROGRESS_RUNNING, false)
            .apply();
        return Result.failure();
    }

    private static void rotate(DocumentFile directory, int requestedKeep) {
        int keep = Math.max(1, Math.min(30, requestedKeep));
        List<DocumentFile> backups = new ArrayList<>();
        DocumentFile[] files = directory.listFiles();
        if (files == null) return;
        for (DocumentFile file : files) {
            String name = file.getName();
            if (file.isFile() && name != null && name.startsWith("coomi-backup-") && name.endsWith(".zip")) {
                backups.add(file);
            }
        }
        backups.sort(Comparator.comparingLong(DocumentFile::lastModified).reversed());
        for (int index = keep; index < backups.size(); index++) backups.get(index).delete();
    }

    private void reportProgress(SharedPreferences preferences, String stage, int percent) {
        int normalized = Math.max(0, Math.min(100, percent));
        preferences.edit()
            .putString(CoomiAutoBackup.KEY_PROGRESS_STAGE, stage)
            .putInt(CoomiAutoBackup.KEY_PROGRESS_PERCENT, normalized)
            .putBoolean(CoomiAutoBackup.KEY_PROGRESS_RUNNING, true)
            .apply();
        setProgressAsync(new Data.Builder()
            .putString("stage", stage)
            .putInt("percent", normalized)
            .build());
    }

    private interface CopyProgress {
        void onBytesCopied(long copied);
    }

    private static long copy(InputStream input, OutputStream output, long total, CopyProgress progress) throws Exception {
        byte[] buffer = new byte[65536];
        int read;
        long copied = 0;
        int lastPercent = -1;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
            copied += read;
            int percent = total > 0 ? (int) Math.min(100, copied * 100 / total) : 0;
            if (percent != lastPercent) {
                lastPercent = percent;
                progress.onBytesCopied(copied);
            }
        }
        output.flush();
        return copied;
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return error.getClass().getSimpleName();
        return message.length() > 240 ? message.substring(0, 240) : message;
    }
}
