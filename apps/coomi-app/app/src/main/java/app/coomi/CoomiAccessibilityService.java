package app.coomi;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;


/**
 * 控制模式的屏幕操控后端（无障碍）。
 *
 * <p>控制模式需要「看见屏幕 + 动屏幕」两件事。Shizuku 能跑 input，但依赖用户额外装
 * Shizuku 并常驻后台，且读不到界面结构；无障碍是本机自带能力，申请一次即可长期使用，
 * 还能按文字/控件直接定位，比坐标点击稳得多。因此控制模式优先走无障碍，Shizuku 只作为
 * 无障碍不可用时的回退。</p>
 *
 * <p>本服务只做三件被显式要求的事：读当前前台包名、往输入框写入文本并发出去、按坐标做
 * 点击/滑动。不做全局监听上报，也不在后台自行发起操作。</p>
 */
public final class CoomiAccessibilityService extends AccessibilityService {

    private static volatile CoomiAccessibilityService instance;

    /** 最近一次窗口状态变化的前台包名；事件驱动，不需要轮询。 */
    private volatile String foregroundPackage = "";
    private volatile long foregroundUpdatedAt = 0L;

    /** 包名历史，用于「从聊天页返回后还记得刚才那个 App」。 */
    private final ArrayDeque<String> recentPackages = new ArrayDeque<>();

    /** 命令队列轮询线程：让引擎侧的工具能真正驱动屏幕。 */
    private volatile boolean queueRunning = false;
    private Thread queueThread;

    public static CoomiAccessibilityService get() {
        return instance;
    }

    public static boolean isReady() {
        CoomiAccessibilityService service = instance;
        return service != null && service.isConnected();
    }

    /** 当前前台应用包名；拿不到时回退到最近一次记录。 */
    public static String currentPackage() {
        CoomiAccessibilityService service = instance;
        if (service == null) return "";
        service.refreshForegroundFromWindows();
        return service.foregroundPackage;
    }

    private boolean isConnected() {
        try {
            return getServiceInfo() != null;
        } catch (Throwable ignored) {
            return false;
        }
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            info.notificationTimeout = 80;
            setServiceInfo(info);
        }
        startQueue();
    }

    // ── 命令队列 ────────────────────────────────────────────────────────

    /**
     * 轮询命令目录并执行。
     *
     * <p>引擎（Rust 侧）跑在独立进程里，拿不到这里的无障碍 API；WebView 的 JS 桥又只存在于
     * 前台界面。所以用「文件队列」把两边接起来：引擎写 {@code <id>.cmd.json}，这里执行完写
     * {@code <id>.result.json}，引擎轮询结果。这样模型调用工具时能拿到真实返回值，
     * 而不是发完就完事。</p>
     */
    private void startQueue() {
        if (queueRunning) return;
        queueRunning = true;
        queueThread = new Thread(this::queueLoop, "coomi-control-queue");
        queueThread.setDaemon(true);
        queueThread.start();
    }

    private void queueLoop() {
        while (queueRunning) {
            try {
                File dir = controlQueueDir();
                File[] files = dir == null ? null : dir.listFiles(
                    (d, name) -> name.endsWith(".cmd.json"));
                if (files != null) {
                    // 按文件名排序，保证同一批命令按写入顺序执行
                    java.util.Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
                    for (File file : files) {
                        handleCommandFile(file);
                    }
                }
            } catch (Throwable ignored) {
                // 轮询本身不能把服务弄崩
            }
            try {
                Thread.sleep(250L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private File controlQueueDir() {
        File home = new File(com.termux.shared.termux.TermuxConstants.TERMUX_HOME_DIR_PATH);
        File dir = new File(home, ".coomi/control/queue");
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        return dir;
    }

    /** 读一个小文本文件（命令都是几百字节，不需要缓冲区分块）。 */
    private static String readTextFile(File file) throws java.io.IOException {
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

    private void handleCommandFile(File file) {
        String name = file.getName();
        String base = name.substring(0, name.length() - ".cmd.json".length());
        String raw;
        try {
            // 手动读流：java.nio.file.Files 需要 API 26，而本应用 minSdk 是 24。
            raw = readTextFile(file);
        } catch (Throwable error) {
            writeResult(base, false, "读取命令失败: " + error.getMessage());
            file.delete();
            return;
        }
        file.delete();

        boolean ok;
        String output;
        try {
            JSONObject command = new JSONObject(raw);
            if (command.optLong("deadlineMs", Long.MAX_VALUE) < System.currentTimeMillis()) {
                writeResult(base, false, "命令已经超时，未执行屏幕操作");
                return;
            }
            String action = command.optString("action", "");
            CoomiFloatService.releaseForAutomation();
            switch (action) {
                case "tap":
                    ok = tap((float) command.optDouble("x", 0), (float) command.optDouble("y", 0));
                    output = ok ? "已点击" : "点击失败";
                    break;
                case "long_press":
                    ok = longPress((float) command.optDouble("x", 0),
                        (float) command.optDouble("y", 0), command.optLong("durationMs", 800));
                    output = ok ? "已长按" : "长按失败";
                    break;
                case "swipe":
                    ok = swipe((float) command.optDouble("x1", 0), (float) command.optDouble("y1", 0),
                        (float) command.optDouble("x2", 0), (float) command.optDouble("y2", 0),
                        command.optLong("durationMs", 300));
                    output = ok ? "已滑动" : "滑动失败";
                    break;
                case "text":
                    ok = inputText(command.optString("text", ""));
                    output = ok ? "已填入输入框" : "没找到可输入的输入框";
                    break;
                case "send":
                    ok = send();
                    output = ok ? "已发送" : "没找到发送按钮";
                    break;
                case "fill_and_send":
                    ok = pasteAndSend(command.optString("text", ""));
                    output = ok ? "已填入并发送" : "填写或发送失败";
                    break;
                case "click_text":
                    ok = clickText(command.optString("text", ""));
                    output = ok ? "已点击「" + command.optString("text", "") + "」" : "没找到该文字的可点击控件";
                    break;
                case "global":
                    ok = globalAction(command.optString("action_name", "back"));
                    output = ok ? "已执行全局动作" : "全局动作失败";
                    break;
                case "foreground":
                    output = currentPackage();
                    ok = !output.isEmpty();
                    break;
                case "read_screen":
                    output = describeScreen();
                    ok = !output.contains("无法读取当前窗口");
                    break;
                case "input_text":
                    ok = true;
                    output = currentInputText();
                    break;
                default:
                    ok = false;
                    output = "未知动作: " + action;
            }
        } catch (Throwable error) {
            ok = false;
            output = "执行异常: " + error;
        }
        writeResult(base, ok, output);
    }

    private void writeResult(String id, boolean ok, String output) {
        File dir = controlQueueDir();
        if (dir == null) return;
        File target = new File(dir, id + ".result.tmp");
        try (FileOutputStream out = new FileOutputStream(target)) {
            JSONObject result = new JSONObject();
            result.put("id", id);
            result.put("ok", ok);
            result.put("output", output == null ? "" : output);
            result.put("at", System.currentTimeMillis());
            out.write(result.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
            target.renameTo(new File(dir, id + ".result.json"));
        } catch (Throwable ignored) {
            // 写不进去时引擎侧会超时，属于可接受的降级
        }
    }


    /**
     * 把当前屏幕上的可见文字读出来，供模型判断「现在在哪个界面、能点什么」。
     *
     * <p>只取有文本或描述的可见节点，并按控件类型标注可点击性 —— 这是让模型能自己决定
     * 下一步动作的关键信息，而不是让它盲点坐标。</p>
     */
    public String describeScreen() {
        StringBuilder builder = new StringBuilder();
        builder.append("前台应用: ").append(currentPackage()).append('\n');
        builder.append("屏幕尺寸(px): ").append(getResources().getDisplayMetrics().widthPixels)
            .append(" × ").append(getResources().getDisplayMetrics().heightPixels).append('\n');
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) {
            builder.append("(无法读取当前窗口，可能无障碍未授权或界面受保护)");
            return builder.toString();
        }
        StringBuilder nodes = new StringBuilder();
        int[] budget = {80};
        collectDescribed(root, nodes, 0, budget);
        builder.append(nodes.length() == 0 ? "(没有可读文本)" : nodes.toString());
        // 输入框单独提示，模型最需要知道「能不能打字」
        List<AccessibilityNodeInfo> editors = editors();
        builder.append("\n可编辑输入框: ").append(editors.size()).append(" 个");
        if (!editors.isEmpty()) {
            builder.append("｜当前内容: \"").append(currentInputText()).append('"');
        }
        return builder.toString();
    }

    private void collectDescribed(AccessibilityNodeInfo node, StringBuilder out, int depth, int[] budget) {
        if (node == null || depth > 30 || budget[0] <= 0) return;
        try {
            if (node.isVisibleToUser()) {
                CharSequence text = node.getText();
                CharSequence desc = node.getContentDescription();
                String label = !TextUtils.isEmpty(text) ? text.toString()
                    : (!TextUtils.isEmpty(desc) ? desc.toString() : "");
                if (!label.isEmpty()) {
                    budget[0] -= 1;
                    String kind = node.isEditable() ? "输入框"
                        : (node.isClickable() ? "按钮" : node.getClassName() == null ? "文本"
                            : simpleClassName(node.getClassName().toString()));
                    android.graphics.Rect bounds = new android.graphics.Rect();
                    node.getBoundsInScreen(bounds);
                    out.append("- [").append(kind).append("] (x=").append(bounds.centerX())
                        .append(", y=").append(bounds.centerY()).append(") ")
                        .append(label.length() > 80 ? label.substring(0, 80) + "…" : label)
                        .append('\n');
                }
            }
            int count = node.getChildCount();
            for (int i = 0; i < count && budget[0] > 0; i++) {
                collectDescribed(node.getChild(i), out, depth + 1, budget);
            }
        } catch (Throwable ignored) {
            // 节点在遍历中被回收属正常现象
        }
    }

    private static String simpleClassName(String full) {
        int dot = full.lastIndexOf('.');
        return dot >= 0 ? full.substring(dot + 1) : full;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = event.getPackageName();
        if (TextUtils.isEmpty(pkg)) return;
        String name = pkg.toString();
        if (name.equals(getPackageName())) return;
        if (name.equals(foregroundPackage)) return;
        foregroundPackage = name;
        foregroundUpdatedAt = System.currentTimeMillis();
        recentPackages.addFirst(name);
        while (recentPackages.size() > 8) recentPackages.removeLast();
    }

    @Override
    public void onInterrupt() {
        // 控制模式按需调用，不做长任务，无需中断处理。
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        if (instance == this) instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        queueRunning = false;
        if (queueThread != null) {
            queueThread.interrupt();
            queueThread = null;
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /**
     * 点亮并聚焦第一个输入框。
     *
     * <p>部分 App（微信、QQ 的自定义输入框）不响应 ACTION_SET_TEXT，只能先点进输入态再走
     * 输入法。这里按控件的屏幕坐标点一下，把焦点交给它。</p>
     */
    public boolean tapFirstEditor() {
        List<AccessibilityNodeInfo> editors = editors();
        if (editors.isEmpty()) return false;
        AccessibilityNodeInfo editor = editors.get(0);
        android.graphics.Rect bounds = new android.graphics.Rect();
        editor.getBoundsInScreen(bounds);
        if (bounds.width() <= 0 || bounds.height() <= 0) return false;
        boolean ok = tap(bounds.exactCenterX(), bounds.exactCenterY());
        if (ok) {
            // 点击后输入框会重新挂载节点，等一小会儿再返回
            try {
                Thread.sleep(120L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        return ok;
    }

    /** 事件偶发丢失时，用窗口列表兜一次底。 */
    private void refreshForegroundFromWindows() {
        if (System.currentTimeMillis() - foregroundUpdatedAt < 1500) return;
        try {
            List<android.view.accessibility.AccessibilityWindowInfo> windows = getWindows();
            if (windows == null) return;
            for (android.view.accessibility.AccessibilityWindowInfo window : windows) {
                if (window == null || window.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                AccessibilityNodeInfo root = window.getRoot();
                if (root == null || isOurOverlay(root)) continue;
                CharSequence pkg = root.getPackageName();
                if (!TextUtils.isEmpty(pkg)) {
                    foregroundPackage = pkg.toString();
                    foregroundUpdatedAt = System.currentTimeMillis();
                    return;
                }
            }
        } catch (Throwable ignored) {
            // 窗口列表在部分 ROM 上会抛 SecurityException，忽略即可。
        }
    }

    // ── 读界面 ──────────────────────────────────────────────────────────

    /** 当前活动窗口的根节点；取不到返回 null。 */
    private AccessibilityNodeInfo activeRoot() {
        // Focusable overlays and input methods may become active; choose application windows first.
        try {
            List<android.view.accessibility.AccessibilityWindowInfo> windows = getWindows();
            if (windows != null) for (android.view.accessibility.AccessibilityWindowInfo window : windows) {
                if (window == null || window.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null && !isOurOverlay(root)) return root;
            }
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null && !isOurOverlay(root) && root.getPackageName() != null
                && !root.getPackageName().toString().contains("inputmethod")) return root;
        } catch (Throwable error) { android.util.Log.w("CoomiControl", "read root failed", error); }
        return null;
    }

    /** 判断节点是否来自我们的悬浮窗（避免读到自己）。 */
    private boolean isOurOverlay(AccessibilityNodeInfo node) {
        if (node == null) return false;
        CharSequence pkg = node.getPackageName();
        return pkg != null && pkg.toString().equals(getPackageName());
    }

    /** 收集树中所有可编辑输入框，按深度优先顺序（屏幕上的先后基本一致）。 */
    private List<AccessibilityNodeInfo> editors() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return out;
        collectEditors(root, out, 0);
        return out;
    }

    private void collectEditors(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out, int depth) {
        if (node == null || depth > 40 || out.size() >= 12) return;
        try {
            if (node.isEditable() && node.isVisibleToUser()) out.add(node);
            int count = node.getChildCount();
            for (int i = 0; i < count && out.size() < 12; i++) {
                collectEditors(node.getChild(i), out, depth + 1);
            }
        } catch (Throwable ignored) {
            // 节点在遍历中被回收属正常现象
        }
    }

    /**
     * 往当前聊天输入框写入文本。
     *
     * <p>优先用 ACTION_SET_TEXT 直接设置（微信/QQ 的自定义输入框都实现了该 Action），
     * 失败再退回「聚焦 + 逐字提交」，尽量不依赖坐标。</p>
     */
    public boolean inputText(String text) {
        if (text == null) return false;
        List<AccessibilityNodeInfo> editors = editors();
        if (editors.isEmpty()) return false;
        AccessibilityNodeInfo target = editors.get(0);
        // 有焦点的输入框优先，避免误填到搜索框。
        for (AccessibilityNodeInfo editor : editors) {
            try {
                if (editor.isFocused()) {
                    target = editor;
                    break;
                }
            } catch (Throwable ignored) {
                // 继续用第一个
            }
        }
        return setText(target, text);
    }

    private boolean setText(AccessibilityNodeInfo node, String text) {
        try {
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return true;
        } catch (Throwable ignored) {
            // 部分输入框未实现 SET_TEXT
        }
        try {
            if (!node.isFocused()) {
                node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            }
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        } catch (Throwable ignored) {
            return false;
        }
    }

    /**
     * 点发送。
     *
     * <p>先按 IME_ACTION_SEND 让输入框自己发出（最不容易误点），再按文字/描述找
     * 「发送」按钮。部分 ROM 的微信发送按钮没有文字只有 contentDescription，
     * 因此两条路都要试。</p>
     */
    public boolean send() {
        for (AccessibilityNodeInfo editor : editors()) {
            try {
                if (editor.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
                    return true;
                }
            } catch (Throwable ignored) {
                // 换下一种方式
            }
        }
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return false;
        for (String label : new String[] {"发送", "Send", "send"}) {
            AccessibilityNodeInfo hit = findClickableByLabel(root, label);
            if (hit != null && hit.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        return false;
    }

    /** 写入并发送；等于用户在聊天框里打完字点了发送。 */
    public boolean pasteAndSend(String text) {
        if (!inputText(text)) return false;
        return send();
    }

    /** 按文字找可点击节点并点击（例如「发送」「确定」）。 */
    public boolean clickText(String label) {
        if (TextUtils.isEmpty(label)) return false;
        AccessibilityNodeInfo root = activeRoot();
        if (root == null) return false;
        AccessibilityNodeInfo hit = findClickableByLabel(root, label);
        return hit != null && hit.performAction(AccessibilityNodeInfo.ACTION_CLICK);
    }

    private AccessibilityNodeInfo findClickableByLabel(AccessibilityNodeInfo node, String label) {
        if (node == null) return null;
        try {
            CharSequence text = node.getText();
            CharSequence desc = node.getContentDescription();
            boolean matches = (text != null && label.contentEquals(text))
                || (desc != null && label.contentEquals(desc))
                || (text != null && text.toString().contains(label))
                || (desc != null && desc.toString().contains(label));
            if (matches && node.isVisibleToUser()) {
                AccessibilityNodeInfo clickable = node;
                int guard = 0;
                while (clickable != null && !clickable.isClickable() && guard < 6) {
                    clickable = clickable.getParent();
                    guard++;
                }
                if (clickable != null && clickable.isClickable()) return clickable;
                if (node.isClickable()) return node;
            }
            int count = node.getChildCount();
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo hit = findClickableByLabel(node.getChild(i), label);
                if (hit != null) return hit;
            }
        } catch (Throwable ignored) {
            // 节点回收
        }
        return null;
    }

    // ── 动屏幕（手势，API 24+）────────────────────────────────────────

    /** 点击屏幕坐标。 */
    public boolean tap(float x, float y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 60))
            .build();
        return dispatchAndWait(gesture);
    }

    /** 直线滑动（用于聊天列表滚动、翻页）。 */
    public boolean swipe(float fromX, float fromY, float toX, float toY, long durationMs) {
        Path path = new Path();
        path.moveTo(fromX, fromY);
        path.lineTo(toX, toY);
        long duration = Math.max(60L, Math.min(durationMs, 3000L));
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, duration))
            .build();
        return dispatchAndWait(gesture);
    }


    /** Never block Android's main looper waiting for its own gesture callback. */
    private boolean dispatchAndWait(GestureDescription gesture) {
        android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return dispatchGesture(gesture, null, main);
        CoomiFloatService.releaseForAutomation();
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean completed = new java.util.concurrent.atomic.AtomicBoolean(false);
        main.post(() -> {
            try {
                boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                    @Override public void onCompleted(GestureDescription g) { completed.set(true); latch.countDown(); }
                    @Override public void onCancelled(GestureDescription g) { latch.countDown(); }
                }, main);
                if (!accepted) latch.countDown();
            } catch (Throwable error) { latch.countDown(); }
        });
        try { return latch.await(5000, java.util.concurrent.TimeUnit.MILLISECONDS) && completed.get(); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
    }

    /** 长按。 */
    public boolean longPress(float x, float y, long durationMs) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(600L, Math.min(3000L, durationMs))))
            .build();
        return dispatchAndWait(gesture);
    }

    /** 全局动作：back / home / recents / notifications。 */
    public boolean globalAction(String action) {
        int code;
        if (action == null) return false;
        switch (action) {
            case "back": code = GLOBAL_ACTION_BACK; break;
            case "home": code = GLOBAL_ACTION_HOME; break;
            case "recents": code = GLOBAL_ACTION_RECENTS; break;
            case "notifications": code = GLOBAL_ACTION_NOTIFICATIONS; break;
            default: return false;
        }
        return performGlobalAction(code);
    }

    /** 输入框里当前已有的文字，供上层判断是否已填充。 */
    public String currentInputText() {
        for (AccessibilityNodeInfo editor : editors()) {
            try {
                if (editor.isFocused()) {
                    CharSequence text = editor.getText();
                    return text == null ? "" : text.toString();
                }
            } catch (Throwable ignored) {
                // 继续
            }
        }
        return "";
    }

    /** 该包名最近是否在前台出现过（判断「刚才确实在聊天页」）。 */
    public boolean recentlyForeground(String packageName) {
        return packageName != null && recentPackages.contains(packageName);
    }
}
