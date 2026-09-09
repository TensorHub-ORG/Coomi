package app.coomi;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import com.termux.shared.termux.TermuxConstants;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * 统一反馈管理入口：所有反馈（崩溃/启动失败/运行时错误/工具失败/性能/手动）
 * 都经由这里脱敏、补齐环境上下文、经 Outbox 队列上传。
 *
 * 数据 schema 见 docs/feedback-server-upgrade.md（coomi-feedback/2）：
 * 旧字段全部保留，新增字段均为增量，服务端新旧结构都能接收。
 *
 * Outbox：files/feedback/outbox/&lt;feedback_id&gt;/（payload.json + 附件）。
 * 发送成功移入 sent/（保留最近 20 条供用户查看），失败留在 outbox 等待下次 flush。
 */
public final class FeedbackManager {

    private static final String TAG = "FeedbackManager";
    private static final String PREFS_NAME = "coomi_feedback";
    private static final String KEY_MASTER_ENABLED = "master_enabled";
    private static final String KEY_INCLUDE_CONVERSATION = "include_conversation";
    private static final int MAX_SENT_RECORDS = 20;
    private static final int ENGINE_LOG_TAIL_BYTES = 64 * 1024;

    /** 防止多处同时 flush 造成同一记录重复上传。 */
    private static final AtomicBoolean sFlushing = new AtomicBoolean(false);

    private FeedbackManager() {}

    // ── 设置 ──

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** 反馈总开关（默认开）。关闭后：崩溃只写本地不外发，自动检测通道静默，手动反馈不可用。 */
    public static boolean isMasterEnabled(Context context) {
        return prefs(context).getBoolean(KEY_MASTER_ENABLED, true);
    }

    public static void setMasterEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_MASTER_ENABLED, enabled).apply();
    }

    /** 反馈是否附带最近对话内容（默认开）。关闭后 feedback 上下文不含对话摘要。 */
    public static boolean isIncludeConversationEnabled(Context context) {
        return prefs(context).getBoolean(KEY_INCLUDE_CONVERSATION, true);
    }

    public static void setIncludeConversationEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_INCLUDE_CONVERSATION, enabled).apply();
    }

    // ── 统一提交 ──

    /**
     * 提交一条反馈：脱敏终检 → 补齐环境上下文 → 立即上传；失败自动入 Outbox。
     * 返回结果 JSON：{ok, status: "sent"|"queued", error?}。
     * 网络类失败一律返回 ok=true + status=queued（记录已在队列，启动时会补传），
     * 只有总开关关闭才返回 ok=false。
     */
    public static String submit(Context context, JSONObject payload) {
        return submit(context, payload, Collections.emptyList());
    }

    public static String submit(Context context, JSONObject payload, List<CoomiFeedbackClient.Attachment> attachments) {
        JSONObject result = new JSONObject();
        try {
            if (!isMasterEnabled(context)) {
                result.put("ok", false);
                result.put("error", "feedback_disabled");
                return result.toString();
            }
            enrich(context, payload);
            maskPayload(payload);
            // 「反馈附带最近对话」开关关闭：上传前剥掉对话摘要（工具轨迹保留）。
            if (!isIncludeConversationEnabled(context)) {
                JSONObject feedbackContext = payload.optJSONObject("context");
                if (feedbackContext != null) feedbackContext.remove("conversation_excerpt");
            }
            String id = payload.optString("feedback_id", UUID.randomUUID().toString());
            File record = writeRecord(outboxDir(context), id, payload, attachments);
            if (record == null) {
                result.put("ok", false);
                result.put("error", "write_failed");
                return result.toString();
            }
            // 立即尝试上传一次；失败留在 outbox，等启动/引擎就绪时补传。
            boolean sent = uploadRecord(context, record, false);
            if (sent) moveToSent(context, record);
            result.put("ok", true);
            result.put("feedback_id", id);
            result.put("status", sent ? "sent" : "queued");
            return result.toString();
        } catch (Exception error) {
            try {
                result.put("ok", false);
                result.put("error", String.valueOf(error.getMessage()));
            } catch (Exception ignored) {}
            return result.toString();
        }
    }

    /**
     * 崩溃专用：同步落盘（进程随时会死），再尽力即时上传。
     * 不检查总开关以外的任何条件；总开关关闭时只写本地不外发。
     */
    public static void recordCrash(Context context, String threadName, String stack) {
        try {
            JSONObject payload = basePayload("crash");
            JSONObject error = new JSONObject();
            error.put("title", "Uncaught exception in " + threadName);
            error.put("message", firstLine(stack));
            error.put("stack", stack);
            payload.put("error", error);
            enrich(context, payload);
            maskPayload(payload);
            String id = payload.optString("feedback_id");
            File record = writeRecord(outboxDir(context), id, payload, Collections.emptyList());
            if (record == null) return;
            if (!isMasterEnabled(context)) return;
            uploadRecord(context, record, true);
        } catch (Throwable ignored) {
            // 崩溃路径里不允许再抛
        }
    }

    /**
     * native 侧直接入队的运行时异常（引擎启动失败/监控重启/运行时安装失败等）。
     * 这些场景用户可能正可交互：入队后由「问题反馈与诊断」页的待反馈记录提示授权，
     * 弹窗场景（前端 reportError）走 {@link #submit} 立即上传。
     */
    public static String enqueueNativeError(Context context, String channel, String title,
                                            String message, String detail) {
        try {
            if (!isMasterEnabled(context)) return "{\"ok\":false,\"error\":\"feedback_disabled\"}";
            // 去重：同类错误（channel + message 相同）已存在 pending 记录时不重复入队，
            // 防止监控反复重启失败期间刷出几十条记录。
            File[] existing = outboxDir(context).listFiles();
            if (existing != null) {
                for (File record : existing) {
                    try {
                        JSONObject old = new JSONObject(new String(
                            readFile(new File(record, "payload.json")), StandardCharsets.UTF_8));
                        if (channel.equals(old.optString("channel"))
                            && message != null && message.equals(
                                old.optJSONObject("error") == null ? "" : old.optJSONObject("error").optString("message"))) {
                            return "{\"ok\":true,\"status\":\"dedup\"}";
                        }
                    } catch (Exception ignored) {
                    }
                }
            }
            JSONObject payload = basePayload(channel);
            JSONObject error = new JSONObject();
            error.put("title", title);
            error.put("message", message == null ? "" : message);
            error.put("detail", detail == null ? "" : detail);
            payload.put("error", error);
            enrich(context, payload);
            maskPayload(payload);
            writeRecord(outboxDir(context), payload.optString("feedback_id"), payload, Collections.emptyList());
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("feedback_id", payload.optString("feedback_id"));
            result.put("status", "queued");
            return result.toString();
        } catch (Exception error) {
            return "{\"ok\":false,\"error\":\"enqueue_failed\"}";
        }
    }

    /** 补齐统一上下文：设备诊断、引擎日志尾、环境快照。已存在的字段不覆盖。 */
    private static void enrich(Context context, JSONObject payload) {
        try {
            if (!payload.has("app")) {
                JSONObject app = new JSONObject();
                app.put("version_name", com.termux.BuildConfig.VERSION_NAME);
                app.put("version_code", com.termux.BuildConfig.VERSION_CODE);
                app.put("package_name", context.getPackageName());
                payload.put("app", app);
            }
            if (!payload.has("device")) payload.put("device", CoomiFeedbackClient.diagnostics(context));
            if (!payload.has("environment")) payload.put("environment", collectEnvironment(context));
            JSONObject ctx = payload.optJSONObject("context");
            if (ctx == null) { ctx = new JSONObject(); payload.put("context", ctx); }
            if (!ctx.has("engine_log_tail")) {
                ctx.put("engine_log_tail", maskText(engineLogTail()));
            }
            if (!payload.has("schema")) payload.put("schema", "coomi-feedback/2");
            if (!payload.has("time")) payload.put("time", isoUtcNow());
            if (!payload.has("feedback_id")) payload.put("feedback_id", UUID.randomUUID().toString());
        } catch (Exception ignored) {
        }
    }

    private static JSONObject collectEnvironment(Context context) {
        JSONObject environment = new JSONObject();
        try {
            environment.put("engine_version", engineVersion());
            File files = context.getFilesDir();
            environment.put("storage_free_bytes", files.getUsableSpace());
            environment.put("storage_total_bytes", files.getTotalSpace());
            environment.put("abi", Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0
                ? Build.SUPPORTED_ABIS[0] : Build.CPU_ABI);
            File runtimeRootfs = new File(CoomiConstants.RUNTIME_V2_ROOTFS_PATH);
            environment.put("runtime_v2_rootfs_ready", runtimeRootfs.isFile());
            File bootstrap = new File(TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/bin/bash");
            environment.put("bootstrap_ready", bootstrap.isFile() && bootstrap.canExecute());
        } catch (Exception ignored) {}
        return environment;
    }

    private static String engineVersion() {
        try {
            File marker = new File(CoomiConstants.INSTALL_MARKER_PATH);
            if (!marker.isFile()) return "";
            try (InputStream input = new FileInputStream(marker)) {
                byte[] buffer = new byte[256];
                int count = input.read(buffer);
                String text = count > 0 ? new String(buffer, 0, count, StandardCharsets.UTF_8) : "";
                int newline = text.indexOf('\n');
                return (newline >= 0 ? text.substring(0, newline) : text).trim();
            }
        } catch (Exception ignored) {
            return "";
        }
    }

    /** 引擎日志尾部（coomi.log 末尾 ~64KB），用于还原启动失败/运行异常现场。 */
    public static String engineLogTail() {
        File log = new File(CoomiConstants.ENGINE_LOG_PATH);
        if (!log.isFile()) return "";
        try {
            long size = log.length();
            long skip = Math.max(0, size - ENGINE_LOG_TAIL_BYTES);
            try (InputStream input = new FileInputStream(log)) {
                long skipped = input.skip(skip);
                while (skipped < skip) {
                    long more = input.skip(skip - skipped);
                    if (more <= 0) break;
                    skipped += more;
                }
                java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                return output.toString("UTF-8");
            }
        } catch (Exception ignored) {
            return "";
        }
    }

    // ── 脱敏终检（最后一道防线：只打码密码/密钥/个人联系方式，其余保留原文） ──

    private static final Pattern PATTERN_API_KEY = Pattern.compile("\\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}");
    private static final Pattern PATTERN_BEARER = Pattern.compile("(?i)bearer\\s+[A-Za-z0-9._~+/=-]{8,}");
    private static final Pattern PATTERN_SECRET_KV = Pattern.compile(
        "(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\\s*[:=]\\s*[\"']?[^\\s\"',}&]+");
    private static final Pattern PATTERN_EMAIL = Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");
    private static final Pattern PATTERN_PHONE_CN = Pattern.compile("(?<!\\d)1[3-9]\\d{9}(?!\\d)");

    /** 文本打码：密钥形态、键值对形态的密码、邮箱、手机号。 */
    public static String maskText(String text) {
        if (text == null || text.isEmpty()) return text;
        String masked = PATTERN_BEARER.matcher(text).replaceAll("Bearer ***");
        masked = PATTERN_API_KEY.matcher(masked).replaceAll("$1-***");
        masked = PATTERN_SECRET_KV.matcher(masked).replaceAll("$1=***");
        masked = PATTERN_EMAIL.matcher(masked).replaceAll("***@***");
        masked = PATTERN_PHONE_CN.matcher(masked).replaceAll("1**********");
        return masked;
    }

    /** JSON 深度打码：敏感字段名整值替换，字符串值走 maskText。 */
    public static void maskPayload(JSONObject payload) {
        try {
            maskValue(payload, null);
        } catch (Exception ignored) {
        }
    }

    private static void maskValue(Object node, String key) {
        if (node instanceof JSONObject) {
            JSONObject object = (JSONObject) node;
            for (String name : keyList(object)) {
                Object value = object.opt(name);
                try {
                    if (isSecretKey(name) && value instanceof String) {
                        object.put(name, "***");
                    } else if (value instanceof String) {
                        object.put(name, maskText((String) value));
                    } else {
                        maskValue(value, name);
                    }
                } catch (Exception ignored) {
                }
            }
        } else if (node instanceof JSONArray) {
            JSONArray array = (JSONArray) node;
            for (int index = 0; index < array.length(); index++) {
                Object value = array.opt(index);
                try {
                    if (value instanceof String) {
                        array.put(index, maskText((String) value));
                    } else {
                        maskValue(value, key);
                    }
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static List<String> keyList(JSONObject object) {
        List<String> names = new ArrayList<>();
        JSONArray keys = object.names();
        if (keys != null) {
            for (int index = 0; index < keys.length(); index++) {
                names.add(keys.optString(index));
            }
        }
        return names;
    }

    private static boolean isSecretKey(String key) {
        String lower = key == null ? "" : key.toLowerCase();
        return lower.contains("password") || lower.contains("passwd") || lower.contains("secret")
            || lower.contains("token") || lower.contains("authorization")
            || lower.contains("api_key") || lower.contains("apikey")
            || lower.contains("credential") || lower.equals("contact") || lower.equals("key");
    }

    // ── Outbox ──

    private static File feedbackRoot(Context context) {
        File root = new File(context.getApplicationContext().getFilesDir(), "feedback");
        if (!root.isDirectory()) root.mkdirs();
        return root;
    }

    private static File outboxDir(Context context) {
        File dir = new File(feedbackRoot(context), "outbox");
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    private static File sentDir(Context context) {
        File dir = new File(feedbackRoot(context), "sent");
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    /** 写入一条记录目录（payload.json + 附件文件），返回目录；失败返回 null。 */
    private static File writeRecord(File parent, String id, JSONObject payload,
                                    List<CoomiFeedbackClient.Attachment> attachments) {
        try {
            File record = new File(parent, id);
            if (!record.isDirectory() && !record.mkdirs()) return null;
            writeFile(new File(record, "payload.json"), payload.toString().getBytes(StandardCharsets.UTF_8));
            if (attachments != null) {
                for (CoomiFeedbackClient.Attachment attachment : attachments) {
                    writeFile(new File(record, attachment.name), attachment.data);
                }
            }
            return record;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void writeFile(File target, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(bytes);
            output.flush();
        }
    }

    private static byte[] readFile(File file) throws Exception {
        try (InputStream input = new FileInputStream(file);
             java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    /**
     * 上传一条记录。crash=true 时用尽力而为模式（进程正在死，能发多少发多少）。
     * 返回是否发送成功；不删除任何文件。
     */
    private static boolean uploadRecord(Context context, File record, boolean crashBestEffort) {
        try {
            File payloadFile = new File(record, "payload.json");
            if (!payloadFile.isFile()) return true; // 空损坏记录视为已处理
            JSONObject payload = new JSONObject(new String(readFile(payloadFile), StandardCharsets.UTF_8));
            List<CoomiFeedbackClient.Attachment> attachments = new ArrayList<>();
            File[] children = record.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (child.getName().equals("payload.json")) continue;
                    attachments.add(new CoomiFeedbackClient.Attachment(
                        child.getName(), guessMime(child.getName()), readFile(child)));
                }
            }
            String result = CoomiFeedbackClient.post(payload.toString(), attachments);
            return new JSONObject(result).optBoolean("ok", false);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String guessMime(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".json")) return "text/plain";
        return "application/octet-stream";
    }

    private static void moveToSent(Context context, File record) {
        try {
            File target = new File(sentDir(context), record.getName());
            File[] children = record.listFiles();
            if (children != null) {
                target.mkdirs();
                for (File child : children) {
                    byte[] bytes = readFile(child);
                    writeFile(new File(target, child.getName()), bytes);
                }
            }
            deleteRecursive(record);
            pruneSent(context);
        } catch (Exception ignored) {
        }
    }

    /** 发送目录只保留最近 {@value MAX_SENT_RECORDS} 条。 */
    private static void pruneSent(Context context) {
        try {
            File[] records = sentDir(context).listFiles();
            if (records == null) return;
            List<File> dirs = new ArrayList<>(Arrays.asList(records));
            Collections.sort(dirs, new Comparator<File>() {
                @Override public int compare(File a, File b) { return b.getName().compareTo(a.getName()); }
            });
            for (int index = MAX_SENT_RECORDS; index < dirs.size(); index++) {
                deleteRecursive(dirs.get(index));
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * flush Outbox：逐条上传 pending 记录。App 启动 / 引擎启动成功 / 手动重发时调用。
     * 返回本次成功条数。
     */
    public static int flushOutbox(Context context) {
        if (!sFlushing.compareAndSet(false, true)) return 0;
        try {
            if (!isMasterEnabled(context)) return 0;
            int sent = 0;
            File[] records = outboxDir(context).listFiles();
            if (records != null) {
                for (File record : records) {
                    if (!record.isDirectory()) continue;
                    if (uploadRecord(context, record, false)) {
                        moveToSent(context, record);
                        sent++;
                    }
                }
            }
            return sent;
        } finally {
            sFlushing.set(false);
        }
    }

    public static int pendingCount(Context context) {
        File[] records = outboxDir(context).listFiles();
        int count = 0;
        if (records != null) {
            for (File record : records) if (record.isDirectory()) count++;
        }
        return count;
    }

    /** 列出记录（outbox=1 或 sent=0），供「问题反馈与诊断」页展示。返回 [{id, channel, title, time, status}]。 */
    public static JSONArray listRecords(Context context, boolean outbox) {
        JSONArray list = new JSONArray();
        try {
            File[] records = (outbox ? outboxDir(context) : sentDir(context)).listFiles();
            if (records != null) {
                List<File> dirs = new ArrayList<>(Arrays.asList(records));
                Collections.sort(dirs, new Comparator<File>() {
                    @Override public int compare(File a, File b) { return b.getName().compareTo(a.getName()); }
                });
                for (File record : dirs) {
                    if (!record.isDirectory()) continue;
                    JSONObject item = new JSONObject();
                    item.put("id", record.getName());
                    item.put("status", outbox ? "pending" : "sent");
                    try {
                        JSONObject payload = new JSONObject(new String(
                            readFile(new File(record, "payload.json")), StandardCharsets.UTF_8));
                        item.put("channel", payload.optString("channel"));
                        item.put("time", payload.optString("time"));
                        JSONObject error = payload.optJSONObject("error");
                        String title = payload.optString("message");
                        if (error != null) title = error.optString("title", title);
                        item.put("title", title);
                    } catch (Exception ignored) {
                        item.put("channel", "unknown");
                        item.put("title", "");
                        item.put("time", "");
                    }
                    list.put(item);
                }
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    /** 重发 Outbox 全部（手动触发，忽略总开关？不——总开关关闭时仍不可外发）。 */
    public static int retryAll(Context context) {
        return flushOutbox(context);
    }

    /** 清空 pending + sent（用户在设置页主动执行）。 */
    public static void clearAll(Context context) {
        try {
            deleteRecursive(outboxDir(context));
            deleteRecursive(sentDir(context));
            outboxDir(context).mkdirs();
            sentDir(context).mkdirs();
        } catch (Exception ignored) {
        }
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursive(child);
        }
        file.delete();
    }

    // ── Payload 构造 ──

    /** v2 统一 payload 骨架。 */
    public static JSONObject basePayload(String channel) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("schema", "coomi-feedback/2");
            payload.put("feedback_id", UUID.randomUUID().toString());
            payload.put("time", isoUtcNow());
            payload.put("channel", channel);
        } catch (Exception ignored) {}
        return payload;
    }

    private static String firstLine(String text) {
        if (text == null) return "";
        int newline = text.indexOf('\n');
        return newline >= 0 ? text.substring(0, newline) : text;
    }

    private static String isoUtcNow() {
        java.text.SimpleDateFormat format =
            new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }
}
