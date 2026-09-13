package app.coomi;

import java.io.IOException;
import java.io.InputStreamReader;
import java.util.concurrent.TimeUnit;

/** Collects the output of short-lived engine setup commands. */
final class CoomiProcessRunner {
    private static final int MAX_OUTPUT_CHARS = 256 * 1024;
    static final class Result {
        final String output;
        final int exitCode;

        Result(String output, int exitCode) {
            this.output = output;
            this.exitCode = exitCode;
        }
    }

    static Result collect(Process process, long timeout, TimeUnit unit) throws Exception {
        StringBuilder output = new StringBuilder();
        Thread drainer = new Thread(() -> {
            try (InputStreamReader reader = new InputStreamReader(process.getInputStream())) {
                char[] buffer = new char[4096];
                int count;
                while ((count = reader.read(buffer)) != -1) {
                    synchronized (output) {
                        output.append(buffer, 0, count);
                        if (output.length() > MAX_OUTPUT_CHARS) {
                            output.delete(0, output.length() - MAX_OUTPUT_CHARS);
                        }
                    }
                }
            } catch (IOException ignored) {
                // Destroying a timed-out process closes its output pipe.
            }
        }, "coomi-command-output");
        // A descendant can inherit stdout and outlive its parent. Never let its
        // open pipe hold the service's single startup executor indefinitely.
        drainer.setDaemon(true);
        drainer.start();
        try {
            boolean exited = process.waitFor(timeout, unit);
            if (!exited) process.destroyForcibly();
            drainer.join(1000);
            synchronized (output) {
                return new Result(output.toString().trim(), exited ? process.exitValue() : -1);
            }
        } catch (InterruptedException error) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw error;
        }
    }
}
