package app.coomi;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * DeepSeek PoW 求解服务（官方 librscrypto.so）。
 *
 * <p>DeepSeek 验证码登录的 X-DS-Guest-Pow-Response 需要一个由官方算法 DeepSeekHashV1
 * 计算的 answer。Rust 引擎复现不出这个算法（Keccak/SHA3 各种判据都被服务端拒绝），
 * 但官方 APK 里的 librscrypto.so 是必然正确的。这里做一个常驻轮询器：引擎把 challenge
 * 写进 `~/.coomi/control/pow/<id>.cmd.json`，本服务调官方库求解，把 answer 写回
 * `<id>.result.json`，引擎读回后构造 PoW 头。</p>
 *
 * <p>与无障碍命令队列同一模式，只是这里算的是本地数值，不需要无障碍权限。</p>
 */
public final class CoomiPowService {

    private static final String TAG = "CoomiPowService";
    private static final long POLL_MS = 200L;

    private static volatile CoomiPowService instance;
    private volatile boolean running = false;
    private Thread thread;

    public static void start(Context context) {
        if (instance == null) {
            synchronized (CoomiPowService.class) {
                if (instance == null) instance = new CoomiPowService();
            }
        }
        instance.begin(context);
    }

    public static void stop() {
        CoomiPowService current = instance;
        if (current != null) current.end();
    }

    private void begin(Context context) {
        if (running) return;
        running = true;
        thread = new Thread(() -> loop(context.getApplicationContext()), "coomi-pow");
        thread.setDaemon(true);
        thread.start();
        Log.i(TAG, "DeepSeek PoW 求解服务已启动（官方 librscrypto.so）");
    }

    private void end() {
        running = false;
        if (thread != null) {
            thread.interrupt();
            thread = null;
        }
    }

    private void loop(Context context) {
        while (running) {
            try {
                File dir = queueDir(context);
                File[] commands = dir == null ? null : dir.listFiles(
                    (d, name) -> name.endsWith(".cmd.json"));
                if (commands != null) {
                    java.util.Arrays.sort(commands, (a, b) -> a.getName().compareTo(b.getName()));
                    for (File command : commands) {
                        handle(command);
                    }
                }
            } catch (Throwable ignored) {
                // 轮询本身不能把服务弄崩
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private File queueDir(Context context) {
        File home = context.getFilesDir();
        // 引擎的 --home 是 <files>/home/.coomi，这里对齐到同一个目录。
        File filesHome = new File(home, "home");
        File coomi = new File(filesHome, ".coomi");
        File dir = new File(coomi, "control/pow");
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        return dir;
    }

    private void handle(File command) {
        String name = command.getName();
        String base = name.substring(0, name.length() - ".cmd.json".length());
        String raw;
        try {
            raw = readText(command);
        } catch (Throwable error) {
            writeResult(command.getParentFile(), base, false, 0, "读取命令失败: " + error.getMessage());
            command.delete();
            return;
        }
        command.delete();

        long answer = 0;
        boolean ok = false;
        String error = null;
        try {
            JSONObject request = new JSONObject(raw);
            String challenge = request.optString("challenge", "");
            String salt = request.optString("salt", "");
            long difficulty = request.optLong("difficulty", 0L);
            if (challenge.isEmpty() || salt.isEmpty() || difficulty <= 0) {
                error = "challenge/salt/difficulty 缺失或非法";
            } else {
                Long solved = DeepSeekPowSolver.solve(challenge, salt, difficulty);
                if (solved != null && solved >= 0) {
                    answer = solved;
                    ok = true;
                } else {
                    error = "官方求解器返回 null（librscrypto.so 加载失败或求解异常）";
                }
            }
        } catch (Throwable throwable) {
            error = "解析命令异常: " + throwable;
        }
        writeResult(command.getParentFile(), base, ok, answer, error);
    }

    private void writeResult(File dir, String id, boolean ok, long answer, String error) {
        File target = new File(dir, id + ".result.json");
        try (FileOutputStream out = new FileOutputStream(target)) {
            JSONObject result = new JSONObject();
            result.put("id", id);
            result.put("ok", ok);
            result.put("answer", answer);
            if (error != null) result.put("error", error);
            result.put("at", System.currentTimeMillis());
            out.write(result.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Throwable ignored) {
            // 写不进去时引擎侧会超时，属于可接受的降级
        }
    }

    private static String readText(File file) throws java.io.IOException {
        try (java.io.InputStream input = new java.io.FileInputStream(file)) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = input.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
            }
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
