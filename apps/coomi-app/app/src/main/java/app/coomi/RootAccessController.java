package app.coomi;

import android.os.Handler;
import android.os.Looper;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.File;

/**
 * Performs an explicit, short-lived Root capability check.
 *
 * <p>There is no Android runtime permission API for Root. A Root manager grants
 * access when the app starts {@code su -c id}; the returned identity is the
 * source of truth. This class deliberately does not keep a Root shell alive or
 * execute any caller-provided command.</p>
 */
public final class RootAccessController {

    private static final long TIMEOUT_MILLIS = 10_000L;
    private static final long FAILURE_COOLDOWN_MILLIS = 30_000L;
    private static final String[] SU_CANDIDATES = {
        "/system_ext/bin/su",
        "/system/bin/su",
        "/system/xbin/su",
        "/sbin/su"
    };

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private Process activeProcess;
    private boolean checking;
    private static volatile Result cachedGranted;
    private static volatile Result cachedFailure;
    private static volatile long failureCooldownUntil;
    private static volatile String resolvedCandidate;

    public enum Status {
        GRANTED,
        DENIED,
        UNAVAILABLE,
        TIMEOUT,
        ERROR
    }

    public static final class Result {
        public final Status status;
        public final int exitCode;
        public final String output;

        private Result(Status status, int exitCode, String output) {
            this.status = status;
            this.exitCode = exitCode;
            this.output = output == null ? "" : output;
        }

        static Result granted(int exitCode, String output) {
            return new Result(Status.GRANTED, exitCode, output);
        }

        static Result failed(Status status, int exitCode, String output) {
            return new Result(status, exitCode, output);
        }
    }

    public interface Callback {
        void onComplete(Result result);
    }

    /** Starts one user-requested check. A second check is ignored while active. */
    public void check(Callback callback) {
        Result granted = cachedGranted;
        if (granted != null) {
            if (callback != null) mainHandler.post(() -> callback.onComplete(granted));
            return;
        }
        if (System.currentTimeMillis() < failureCooldownUntil && cachedFailure != null) {
            Result failure = cachedFailure;
            if (callback != null) mainHandler.post(() -> callback.onComplete(failure));
            return;
        }
        synchronized (lock) {
            if (checking) return;
            checking = true;
        }

        Thread worker = new Thread(() -> {
            Result result = runCheck();
            if (result.status == Status.GRANTED) {
                cachedGranted = result;
                cachedFailure = null;
                failureCooldownUntil = 0L;
            } else if (result.status == Status.DENIED || result.status == Status.TIMEOUT) {
                cachedFailure = result;
                failureCooldownUntil = System.currentTimeMillis() + FAILURE_COOLDOWN_MILLIS;
            }
            mainHandler.post(() -> {
                synchronized (lock) {
                    checking = false;
                }
                if (callback != null) callback.onComplete(result);
            });
        }, "coomi-root-check");
        worker.start();
    }

    /** Cancels the active check when the host Activity is destroyed. */
    public void cancel() {
        Process process;
        synchronized (lock) {
            process = activeProcess;
            activeProcess = null;
            checking = false;
        }
        if (process != null) process.destroy();
    }

    static boolean hasRootIdentity(String output) {
        if (output == null) return false;
        return output.matches("(?s).*\\buid=0(?:\\D|$).*");
    }

    private Result runCheck() {
        String su = resolveCandidate();
        CandidateResult candidate = runCandidate(su);
        return candidate == null
            ? Result.failed(Status.UNAVAILABLE, -1, "Unable to start Root shell")
            : candidate.result;
    }

    /** Selects one canonical candidate without invoking su or opening an authorization dialog. */
    private static String resolveCandidate() {
        String cached = resolvedCandidate;
        if (cached != null) return cached;
        for (String candidate : SU_CANDIDATES) {
            if (!candidate.startsWith("/")) continue;
            File file = new File(candidate);
            if (file.isFile() && file.canExecute()) {
                try {
                    resolvedCandidate = file.getCanonicalPath();
                } catch (IOException ignored) {
                    resolvedCandidate = file.getAbsolutePath();
                }
                return resolvedCandidate;
            }
        }
        resolvedCandidate = "su";
        return resolvedCandidate;
    }

    static File findExecutableOnPath(String path, String executable) {
        if (path == null || path.isEmpty() || executable == null || executable.isEmpty()) {
            return null;
        }
        for (String directory : path.split(File.pathSeparator)) {
            if (directory.isEmpty()) continue;
            File candidate = new File(directory, executable);
            if (candidate.isFile() && candidate.canExecute()) return candidate;
        }
        return null;
    }

    /** Runs one fixed su candidate and returns null only when the shell itself cannot start. */
    private CandidateResult runCandidate(String su) {
        Process process = null;
        StringBuilder output = new StringBuilder();
        Thread reader = null;
        int exitCode = -1;
        try {
            // Some Android builds deny a direct exec transition from an app's
            // SELinux domain to the su symlink. Launching it through the system
            // shell preserves the normal Root-manager authorization flow.
            process = new ProcessBuilder("/system/bin/sh", "-c", su + " -c id")
                .redirectErrorStream(true)
                .start();
            synchronized (lock) {
                activeProcess = process;
            }

            Process finalProcess = process;
            reader = new Thread(() -> readOutput(finalProcess, output), "coomi-root-output");
            reader.start();

            long deadline = System.currentTimeMillis() + TIMEOUT_MILLIS;
            while (System.currentTimeMillis() < deadline) {
                try {
                    exitCode = process.exitValue();
                    break;
                } catch (IllegalThreadStateException stillRunning) {
                    try {
                        Thread.sleep(50L);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        process.destroy();
                        return new CandidateResult(
                            Result.failed(Status.ERROR, -1, "Root check interrupted"));
                    }
                }
            }

            if (exitCode == -1) {
                process.destroy();
                joinReader(reader, 500L);
                return new CandidateResult(Result.failed(Status.TIMEOUT, -1, output.toString()));
            }

            joinReader(reader, 500L);
            String text = output.toString().trim();
            if (exitCode == 0 && hasRootIdentity(text)) {
                return new CandidateResult(Result.granted(exitCode, text));
            }
            if (exitCode != 0 && containsDenial(text)) {
                return new CandidateResult(Result.failed(Status.DENIED, exitCode, text));
            }
            return new CandidateResult(Result.failed(Status.UNAVAILABLE, exitCode, text));
        } catch (IOException startError) {
            return null;
        } catch (Throwable error) {
            return new CandidateResult(Result.failed(Status.ERROR, exitCode, error.getMessage()));
        } finally {
            if (reader != null && reader.isAlive()) reader.interrupt();
            if (process != null) process.destroy();
            synchronized (lock) {
                if (activeProcess == process) activeProcess = null;
            }
        }
    }

    private static final class CandidateResult {
        final Result result;

        CandidateResult(Result result) {
            this.result = result;
        }
    }

    private static void readOutput(Process process, StringBuilder output) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (output.length() > 0) output.append('\n');
                output.append(line);
            }
        } catch (IOException ignored) {
            // The process may be intentionally destroyed after a timeout.
        }
    }

    private static void joinReader(Thread reader, long timeoutMillis) {
        if (reader == null) return;
        try {
            reader.join(timeoutMillis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static boolean containsDenial(String output) {
        String lower = output == null ? "" : output.toLowerCase();
        return lower.contains("denied")
            || lower.contains("拒绝")
            || lower.contains("permission")
            || lower.contains("not allowed");
    }
}
