package app.coomi;

import android.os.SystemClock;
import org.json.JSONObject;
import rikka.shizuku.Shizuku;
import rikka.shizuku.ShizukuRemoteProcess;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Engine-owned file transport for user-authorized Android shell. No Accessibility dependency. */
public final class ShizukuShellBridge implements AutoCloseable {
    private final File dir = new File(CoomiConstants.COOMI_CONFIG_DIR, "control/shizuku");
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService readers = Executors.newCachedThreadPool();
    private volatile boolean running = true;
    private final Thread poller;
    private static final int MAX_OUTPUT = 1024 * 1024;
    private static final class Job {
        ShizukuRemoteProcess process;
        final StringBuilder stdout = new StringBuilder(), stderr = new StringBuilder();
        long started, limitMs;
        volatile boolean done, truncated;
        volatile int exitCode = -1;
        int outOffset, errOffset;
    }
    public ShizukuShellBridge() {
        dir.mkdirs();
        poller = new Thread(this::poll, "coomi-shizuku-bridge");
        poller.setDaemon(true); poller.start();
    }
    private void poll() {
        while (running) {
            try {
                File[] files = dir.listFiles((d, n) -> n.endsWith(".cmd.json"));
                if (files != null) {
                    Arrays.sort(files, Comparator.comparing(File::getName));
                    for (File f : files) consume(f);
                }
                for (Map.Entry<String, Job> entry : jobs.entrySet()) {
                    Job job = entry.getValue();
                    if (!job.done && SystemClock.elapsedRealtime() - job.started > job.limitMs) {
                        job.process.destroy(); job.exitCode = 124; job.done = true;
                        synchronized (job.stderr) { job.stderr.append("\nShizuku command timed out"); }
                    }
                    if (job.done && SystemClock.elapsedRealtime() - job.started > job.limitMs + 60_000) jobs.remove(entry.getKey());
                }
                Thread.sleep(100);
            } catch (InterruptedException e) { return; }
            catch (Throwable e) { android.util.Log.w("ShizukuShell", "queue error", e); }
        }
    }
    private static boolean available() {
        try { return Shizuku.pingBinder() && Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED; }
        catch (Throwable e) { return false; }
    }
    private void consume(File file) {
        String requestId = file.getName().replace(".cmd.json", "");
        JSONObject result;
        try {
            if (file.length() > MAX_OUTPUT) throw new IOException("command exceeds limit");
            byte[] bytes;
            try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] b = new byte[4096]; int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
                bytes = out.toByteArray();
            }
            JSONObject cmd = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            file.delete();
            long deadline = cmd.optLong("deadlineMs", 0);
            if (deadline > 0 && System.currentTimeMillis() > deadline) throw new IOException("request expired (not executed)");
            String action = cmd.optString("action", "exec");
            String id = cmd.optString("session_id", "");
            if (action.equals("exec")) {
                if (!available()) throw new IOException("Shizuku 未授权或服务未运行，请先在控制台授权；不需要无障碍权限");
                if (jobs.size() >= 8) throw new IOException("Shizuku process limit reached");
                String command = cmd.optString("command", "");
                if (command.trim().isEmpty()) throw new IOException("command is empty");
                Job job = new Job();
                job.started = SystemClock.elapsedRealtime();
                job.limitMs = Math.max(1000, Math.min(cmd.optLong("timeout_ms", 300000), 1800000));
                job.process = Shizuku.newProcess(new String[]{"/system/bin/sh", "-c", command},
                    new String[]{"PATH=/system/bin:/system/xbin", "HOME=/data/local/tmp", "TMPDIR=/data/local/tmp"}, "/data/local/tmp");
                id = UUID.randomUUID().toString(); jobs.put(id, job);
                Future<?> out = readers.submit(() -> drain(job.process.getInputStream(), job.stdout, job));
                Future<?> err = readers.submit(() -> drain(job.process.getErrorStream(), job.stderr, job));
                readers.submit(() -> {
                    try {
                        int exit = job.process.waitFor(); out.get(3, TimeUnit.SECONDS); err.get(3, TimeUnit.SECONDS);
                        if (!job.done) job.exitCode = exit;
                    } catch (Throwable e) { synchronized (job.stderr) { job.stderr.append("\n").append(e.getClass().getSimpleName()); } }
                    finally { job.done = true; }
                });
                result = snapshot(id, job);
            } else {
                Job job = jobs.get(id);
                if (job == null) throw new IOException("unknown Shizuku process session");
                switch (action) {
                    case "write":
                        if (job.done) throw new IOException("process has exited");
                        if (cmd.has("input")) {
                            job.process.getOutputStream().write(cmd.optString("input").getBytes(StandardCharsets.UTF_8));
                            job.process.getOutputStream().flush();
                        }
                        if (cmd.optBoolean("close_stdin", false)) job.process.getOutputStream().close();
                        break;
                    case "terminate": job.process.destroy(); job.exitCode = 137; job.done = true; break;
                    case "wait": break;
                    default: throw new IOException("unknown Shizuku action");
                }
                result = snapshot(id, job);
                if (job.done) jobs.remove(id);
            }
        } catch (Throwable e) {
            result = new JSONObject();
            try { result.put("ok", false).put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()); } catch (Exception ignored) { }
            file.delete();
        }
        try {
            File temp = new File(dir, requestId + ".result.tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) { out.write(result.toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
            if (!temp.renameTo(new File(dir, requestId + ".result.json"))) temp.delete();
        } catch (IOException e) { android.util.Log.w("ShizukuShell", "result write failed", e); }
    }
    private JSONObject snapshot(String id, Job job) throws Exception {
        JSONObject value = new JSONObject().put("ok", true).put("session_id", id)
            .put("running", !job.done).put("exitCode", job.done ? job.exitCode : JSONObject.NULL).put("truncated", job.truncated);
        synchronized (job.stdout) { value.put("stdout", job.stdout.substring(job.outOffset)); job.outOffset = job.stdout.length(); }
        synchronized (job.stderr) { value.put("stderr", job.stderr.substring(job.errOffset)); job.errOffset = job.stderr.length(); }
        return value;
    }
    private void drain(InputStream stream, StringBuilder buffer, Job job) {
        try (Reader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
            char[] chunk = new char[4096]; int count;
            while ((count = reader.read(chunk)) != -1) {
                synchronized (buffer) {
                    int keep = Math.min(count, MAX_OUTPUT - buffer.length());
                    if (keep > 0) buffer.append(chunk, 0, keep);
                    if (keep < count) job.truncated = true;
                }
            }
        } catch (IOException ignored) { }
    }
    @Override public void close() {
        running = false; poller.interrupt();
        for (Job job : jobs.values()) try { job.process.destroy(); } catch (Throwable ignored) { }
        jobs.clear(); readers.shutdownNow();
    }
}
