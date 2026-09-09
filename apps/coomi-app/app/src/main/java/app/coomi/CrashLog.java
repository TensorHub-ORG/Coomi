package app.coomi;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 崩溃采集：Java 未捕获异常 → crash.log（含线程栈与设备信息）；
 * 启动时与崩溃时各快照一次 logcat 尾部 → logcat_boot.log / logcat_crash.log，
 * 用于定位不触发 Java 回调的原生崩溃（如老机/鸿蒙上的打开即闪退）。
 *
 * 日志同时写入内部 files/logs 与外部 /sdcard/Android/data/&lt;包名&gt;/files/logs 镜像——
 * 启动即崩溃（UI 都进不去）时，外部副本仍可被 adb 直接提取：
 *   adb pull /sdcard/Android/data/com.coomi.android/files/logs/
 */
public final class CrashLog {

    private static final String TAG = "CrashLog";
    private static final int MAX_LOGCAT_BYTES = 1024 * 1024;
    private static volatile boolean sInstalled = false;

    private CrashLog() {
    }

    public static synchronized void install(Context context) {
        if (sInstalled) return;
        sInstalled = true;
        final Context appContext = context.getApplicationContext();
        dumpLogcat(appContext, "logcat_boot.log");
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            try {
                writeCrash(appContext, thread, throwable);
                dumpLogcat(appContext, "logcat_crash.log");
            } catch (Throwable ignored) {
                // 采集中不允许再次抛出
            }
            if (previous != null) {
                previous.uncaughtException(thread, throwable);
            }
        });
        Log.i(TAG, "CrashLog installed");
    }

    private static void writeCrash(Context context, Thread thread, Throwable throwable) {
        try {
            StringWriter stack = new StringWriter();
            throwable.printStackTrace(new PrintWriter(stack));
            String stackText = stack.toString();
            StringBuilder builder = new StringBuilder();
            builder.append("==== Coomi Crash ").append(stamp()).append(" ====\n");
            builder.append("thread: ").append(thread.getName())
                    .append(" (id=").append(thread.getId()).append(")\n");
            builder.append("device: ").append(Build.MANUFACTURER).append(' ')
                    .append(Build.MODEL).append(" / Android ")
                    .append(Build.VERSION.RELEASE)
                    .append(" (sdk ").append(Build.VERSION.SDK_INT)
                    .append(", abi ").append(Build.CPU_ABI).append(")\n");
            builder.append("build: ").append(Build.VERSION.RELEASE).append('\n');
            builder.append(stackText);
            builder.append('\n');
            File log = new File(logsDir(context), "crash.log");
            FileWriter writer = new FileWriter(log, true);
            writer.write(builder.toString());
            writer.close();
            mirrorAppend(context, "crash.log", builder.toString());
            Log.e(TAG, "crash written to " + log.getAbsolutePath());
            // 崩溃自动反馈：同步写入 Outbox（进程随时会死），随后尽力即时上传；
            // 未发出的记录在下次启动时由 Application 自动补传——覆盖
            // 「第一次崩溃太快、第二次启动必须提交」的要求。
            FeedbackManager.recordCrash(context, thread.getName(), stackText);
        } catch (Throwable ignored) {
        }
    }

    private static void dumpLogcat(Context context, String name) {
        try {
            Process process = Runtime.getRuntime().exec(
                    new String[]{"logcat", "-d", "-t", "400", "-v", "threadtime"});
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()), 8192)) {
                String line;
                int total = 0;
                StringBuilder buffer = new StringBuilder(8192);
                while ((line = reader.readLine()) != null) {
                    buffer.append(line).append('\n');
                    total += line.length() + 1;
                    if (total >= MAX_LOGCAT_BYTES) break;
                }
                byte[] bytes = buffer.toString().getBytes("UTF-8");
                writeBytes(new File(logsDir(context), name), bytes, false);
                mirrorWrite(context, name, bytes);
            }
        } catch (Throwable ignored) {
            // 部分 ROM 禁止应用读取 logcat，忽略即可
        }
    }

    /** 内部目录：应用私有 files/logs。 */
    private static File logsDir(Context context) {
        File dir = new File(context.getApplicationContext().getFilesDir(), "logs");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            return context.getApplicationContext().getFilesDir();
        }
        return dir;
    }

    /** 外部镜像目录：/sdcard/Android/data/<包名>/files/logs，adb / 文件管理器可读。 */
    private static File externalLogsDir(Context context) {
        try {
            File dir = context.getApplicationContext().getExternalFilesDir("logs");
            if (dir == null) return null;
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            return dir;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static void mirrorAppend(Context context, String name, String content) {
        try {
            File dir = externalLogsDir(context);
            if (dir == null) return;
            writeBytes(new File(dir, name), content.getBytes("UTF-8"), true);
        } catch (Throwable ignored) {
        }
    }

    private static void mirrorWrite(Context context, String name, byte[] bytes) {
        try {
            File dir = externalLogsDir(context);
            if (dir == null) return;
            writeBytes(new File(dir, name), bytes, false);
        } catch (Throwable ignored) {
        }
    }

    private static void writeBytes(File target, byte[] bytes, boolean append) throws java.io.IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        try (FileOutputStream output = new FileOutputStream(target, append)) {
            output.write(bytes);
            output.flush();
        }
    }

    private static String stamp() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
                .format(new Date());
    }
}
