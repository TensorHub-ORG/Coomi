package app.coomi;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 控制模式的桌面悬浮层。
 *
 * <p>三件事：</p>
 * <ol>
 *   <li><b>输入框就在悬浮窗里</b>。控制模式的目标是操作别的 App，让用户为了打一句话
 *       先切回 Coomi 再切回去，是很别扭的。展开态会临时申请焦点（输入法才能弹出来），
 *       收起成小球时立刻放弃焦点，避免挡住目标 App 的输入。</li>
 *   <li><b>思考过程持续可见</b>。模型的推理片段与工具调用由
 *       {@link #pushTrace} 追加进滚动区，切到微信/QQ 之后也能看到它进度到哪了。</li>
 *   <li><b>常驻但很轻</b>。只占屏幕顶部一条，其余区域全部留给目标 App。</li>
 * </ol>
 *
 * <p>用前台服务承载：控制模式一次可能持续几分钟，普通后台服务会被系统回收。</p>
 */
public final class CoomiFloatService extends Service {

    private static final String CHANNEL_ID = "coomi_control_float";
    private static final int NOTIFICATION_ID = 4201;

    public static final String ACTION_START = "app.coomi.float.START";
    public static final String ACTION_STOP = "app.coomi.float.STOP";
    public static final String ACTION_TRACE = "app.coomi.float.TRACE";
    public static final String ACTION_COLLAPSE = "app.coomi.float.COLLAPSE";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    /** 思考区最多保留多少行，避免长时间运行把内存堆满。 */
    private static final int MAX_TRACE_LINES = 40;

    private static volatile CoomiFloatService instance;

    private WindowManager windowManager;
    private FrameLayout root;
    private LinearLayout card;
    private TextView titleView;
    private TextView statusView;
    private TextView ballView;
    private ScrollView traceScroll;
    private LinearLayout traceBox;
    private EditText input;
    private WindowManager.LayoutParams params;

    private boolean collapsed = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final StringBuilder traceBuffer = new StringBuilder();

    private int lastX = -1;
    private int lastY = -1;
    private int touchStartX;
    private int touchStartY;
    private float touchDownRawX;
    private float touchDownRawY;
    private boolean dragging;

    public static boolean isRunning() {
        return instance != null;
    }

    /** 追加一条思考/工具记录；服务没起就忽略（控制模式没开时不需要）。 */
    public static void pushTrace(Context context, String title, String body) {
        if (context == null || instance == null) return;
        context.startService(new Intent(context, CoomiFloatService.class)
            .setAction(ACTION_TRACE)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_BODY, body));
    }

    /** 只更新顶部状态文字，不动思考区。 */
    public static void pushStatus(Context context, String status) {
        pushTrace(context, status, null);
    }

    public static void setCollapsed(Context context, boolean value) {
        if (context == null) return;
        context.startService(new Intent(context, CoomiFloatService.class)
            .setAction(ACTION_COLLAPSE)
            .putExtra("collapsed", value));
    }

    public static void start(Context context) {
        if (context == null) return;
        context.startService(new Intent(context, CoomiFloatService.class).setAction(ACTION_START));
    }

    public static void stop(Context context) {
        if (context == null) return;
        context.stopService(new Intent(context, CoomiFloatService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        startForegroundSafely();
        handler.post(this::buildOverlay);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TRACE.equals(action)) {
            final String title = intent.getStringExtra(EXTRA_TITLE);
            final String body = intent.getStringExtra(EXTRA_BODY);
            handler.post(() -> appendTrace(title, body));
            return START_STICKY;
        }
        if (ACTION_COLLAPSE.equals(action)) {
            final boolean value = intent.getBooleanExtra("collapsed", true);
            handler.post(() -> setCollapsedInternal(value));
            return START_STICKY;
        }
        handler.post(() -> {
            if (root != null && root.getParent() == null) attach();
            setCollapsedInternal(collapsed);
        });
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        handler.removeCallbacksAndMessages(null);
        detach();
        super.onDestroy();
    }

    // ── 构建 ──────────────────────────────────────────────────────────

    private void startForegroundSafely() {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
                NotificationChannel channel = new NotificationChannel(
                    // app.coomi 包要写全 R 的包名：短名 R 只在 com.termux 命名空间下可见
                    CHANNEL_ID, getString(com.termux.R.string.coomi_float_channel_name),
                    NotificationManager.IMPORTANCE_MIN);
                channel.setShowBadge(false);
                manager.createNotificationChannel(channel);
            }
            Intent open = new Intent(this, CoomiLauncherActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(this, 0, open, pendingFlags);
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
            builder.setContentTitle("控制模式运行中")
                .setContentText("悬浮层正在显示任务进度")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .setContentIntent(pending);
            startForeground(NOTIFICATION_ID, builder.build());
        } catch (Throwable ignored) {
            // 通知不可用不影响悬浮层；部分 ROM 会拦截前台服务。
        }
    }

    private int dp(float value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private GradientDrawable rounded(int color, int radiusDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private void buildOverlay() {
        if (root != null) return;
        root = new FrameLayout(this);

        card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(9), dp(12), dp(10));
        card.setBackground(rounded(0xF21A1D24, 16, 0x33FFFFFF));
        card.setElevation(dp(8));

        // ── 顶栏：状态 + 收起 ──
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView dotView = new TextView(this);
        dotView.setText("●");
        dotView.setTextColor(0xFF4C7CF7);
        dotView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f);
        header.addView(dotView);

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams titleBoxParams =
            new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        titleBoxParams.leftMargin = dp(6);
        titleBox.setLayoutParams(titleBoxParams);

        titleView = new TextView(this);
        titleView.setText("控制模式");
        titleView.setTextColor(0xFFF2F4F8);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        titleBox.addView(titleView);

        statusView = new TextView(this);
        statusView.setText("就绪");
        statusView.setTextColor(0xFF8FA3C8);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10.5f);
        statusView.setSingleLine(true);
        statusView.setEllipsize(TextUtils.TruncateAt.END);
        titleBox.addView(statusView);

        header.addView(titleBox);

        TextView collapse = new TextView(this);
        collapse.setText("收起");
        collapse.setTextColor(0xFF7FA8FF);
        collapse.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        collapse.setPadding(dp(10), dp(4), 0, dp(4));
        collapse.setOnClickListener(v -> setCollapsedInternal(true));
        header.addView(collapse);
        card.addView(header);

        // ── 思考过程：滚动区，持续追加 ──
        traceScroll = new ScrollView(this);
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(84));
        scrollParams.topMargin = dp(7);
        traceScroll.setLayoutParams(scrollParams);
        traceScroll.setBackground(rounded(0x33FFFFFF, 10, 0));
        traceScroll.setPadding(dp(8), dp(7), dp(8), dp(7));

        traceBox = new LinearLayout(this);
        traceBox.setOrientation(LinearLayout.VERTICAL);
        traceScroll.addView(traceBox);
        card.addView(traceScroll);

        // ── 输入框：就在悬浮窗里，不用切回应用 ──
        LinearLayout inputRow = new LinearLayout(this);
        inputRow.setOrientation(LinearLayout.HORIZONTAL);
        inputRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams inputRowParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        inputRowParams.topMargin = dp(8);
        inputRow.setLayoutParams(inputRowParams);

        input = new EditText(this);
        input.setHint("输入要发送的内容…");
        input.setHintTextColor(0xFF6E7A90);
        input.setTextColor(0xFFF2F4F8);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_SEND);
        input.setBackground(rounded(0xFF252A34, 10, 0x33FFFFFF));
        input.setPadding(dp(10), dp(7), dp(10), dp(7));
        LinearLayout.LayoutParams inputParams =
            new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        input.setLayoutParams(inputParams);
        input.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER;
            if (actionId == EditorInfo.IME_ACTION_SEND || enter) {
                submitInput();
                return true;
            }
            return false;
        });
        inputRow.addView(input);

        Button send = new Button(this);
        send.setText("填入并发送");
        send.setAllCaps(false);
        send.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        send.setTextColor(Color.WHITE);
        send.setBackground(rounded(0xFF2F6BD8, 10, 0));
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, dp(36));
        sendParams.leftMargin = dp(7);
        send.setLayoutParams(sendParams);
        send.setPadding(dp(12), 0, dp(12), 0);
        send.setOnClickListener(v -> submitInput());
        inputRow.addView(send);
        card.addView(inputRow);

        // ── 快捷操作：切到别的 App 后仍能一键返回/回桌面 ──
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams actionsParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        actionsParams.topMargin = dp(7);
        actions.setLayoutParams(actionsParams);
        actions.addView(quickAction("返回", () -> runGlobal("back")));
        actions.addView(quickAction("桌面", () -> runGlobal("home")));
        actions.addView(quickAction("最近", () -> runGlobal("recents")));
        actions.addView(quickAction("只填入", this::fillOnly));
        card.addView(actions);

        root.addView(card);

        ballView = new TextView(this);
        ballView.setText("控");
        ballView.setGravity(Gravity.CENTER);
        ballView.setTextColor(Color.WHITE);
        ballView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        ballView.setBackground(rounded(0xF21A1D24, 24, 0x44FFFFFF));
        ballView.setElevation(dp(8));
        ballView.setLayoutParams(new FrameLayout.LayoutParams(dp(46), dp(46)));
        ballView.setOnClickListener(v -> setCollapsedInternal(false));
        root.addView(ballView);

        ballView.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    dragging = false;
                    touchDownRawX = event.getRawX();
                    touchDownRawY = event.getRawY();
                    touchStartX = params.x;
                    touchStartY = params.y;
                    return false;
                case MotionEvent.ACTION_MOVE: {
                    float dx = event.getRawX() - touchDownRawX;
                    float dy = event.getRawY() - touchDownRawY;
                    if (!dragging && Math.hypot(dx, dy) < dp(6)) return false;
                    dragging = true;
                    params.x = Math.max(0, touchStartX + (int) dx);
                    params.y = Math.max(0, touchStartY + (int) dy);
                    lastX = params.x;
                    lastY = params.y;
                    updateParams();
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (dragging) { dragging = false; return true; }
                    return false;
                default:
                    return false;
            }
        });

        // 拖动整张卡片：展开态也要能挪开，不然会盖住目标 App 的标题栏。
        header.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        dragging = false;
                        touchDownRawX = event.getRawX();
                        touchDownRawY = event.getRawY();
                        touchStartX = params.x;
                        touchStartY = params.y;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        float dx = event.getRawX() - touchDownRawX;
                        float dy = event.getRawY() - touchDownRawY;
                        if (!dragging && Math.hypot(dx, dy) < dp(6)) return true;
                        dragging = true;
                        params.x = Math.max(0, touchStartX + (int) dx);
                        params.y = Math.max(0, touchStartY + (int) dy);
                        lastX = params.x;
                        lastY = params.y;
                        updateParams();
                        return true;
                    }
                    default:
                        return false;
                }
            }
        });

        attach();
        setCollapsedInternal(collapsed);
        appendTrace("控制模式已启动", "悬浮窗可以拖动；点击「收起」变成小球。");
    }

    private TextView quickAction(String label, Runnable action) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setTextColor(0xFFAFC4E8);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        view.setGravity(Gravity.CENTER);
        view.setBackground(rounded(0x2EFFFFFF, 9, 0));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(32), 1f);
        params.rightMargin = dp(6);
        view.setLayoutParams(params);
        view.setOnClickListener(v -> action.run());
        return view;
    }

    // ── 输入与操作 ────────────────────────────────────────────────────

    private void submitInput() {
        if (input == null) return;
        String text = input.getText() == null ? "" : input.getText().toString().trim();
        if (text.isEmpty()) {
            appendTrace(null, "输入为空，先写点内容");
            return;
        }
        input.setText("");
        fillAndSend(text);
    }

    private void fillOnly() {
        if (input == null) return;
        String text = input.getText() == null ? "" : input.getText().toString().trim();
        if (text.isEmpty()) {
            appendTrace(null, "输入为空，先写点内容");
            return;
        }
        input.setText("");
        if (!CoomiAccessibilityService.isReady()) {
            appendTrace(null, "无障碍未开启，无法操作屏幕");
            return;
        }
        boolean ok = CoomiAccessibilityService.get().inputText(text);
        appendTrace(null, ok ? "已填入输入框（未发送）" : "没找到可输入的输入框");
    }

    private void fillAndSend(String text) {
        if (!CoomiAccessibilityService.isReady()) {
            appendTrace(null, "无障碍未开启，无法操作屏幕。请回到应用点「开启无障碍」。");
            toast("无障碍未开启");
            return;
        }
        CoomiAccessibilityService service = CoomiAccessibilityService.get();
        boolean filled = service.inputText(text);
        if (!filled && !service.tapFirstEditor()) {
            appendTrace(null, "没找到输入框。请先手动点一下聊天输入框再发送。");
            toast("没找到输入框");
            return;
        }
        if (filled) {
            // 部分输入框 SET_TEXT 之后需要一小段时间让发送按钮变可用。
            handler.postDelayed(() -> {
                boolean sent = service.send();
                appendTrace(null, sent ? "已发送" : "已填入，但没找到发送按钮");
                if (!sent) toast("没找到发送按钮");
            }, 220);
        } else {
            appendTrace(null, "已聚焦输入框，请在目标应用里手动输入");
        }
    }

    private void runGlobal(String action) {
        if (!CoomiAccessibilityService.isReady()) {
            appendTrace(null, "无障碍未开启，无法执行「" + action + "」");
            return;
        }
        boolean ok = CoomiAccessibilityService.get().globalAction(action);
        appendTrace(null, ok ? "已执行：" + action : "执行失败：" + action);
    }

    private void toast(String message) {
        handler.post(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    // ── 窗口 ──────────────────────────────────────────────────────────

    private void attach() {
        if (root == null) return;
        if (params == null) {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
            params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
            params.gravity = Gravity.TOP | Gravity.START;
            params.x = lastX >= 0 ? lastX : dp(10);
            params.y = lastY >= 0 ? lastY : dp(40);
        }
        try {
            if (root.getParent() == null) windowManager.addView(root, params);
        } catch (Throwable ignored) {
            // 权限被回收或窗口被拒：静默失败，控制模式其余能力仍可用。
        }
    }

    private void updateParams() {
        if (root == null || params == null) return;
        try {
            if (root.getParent() != null) windowManager.updateViewLayout(root, params);
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    private void detach() {
        if (root == null) return;
        try {
            if (root.getParent() != null) windowManager.removeView(root);
        } catch (Throwable ignored) {
            // 忽略
        }
        root = null;
        params = null;
    }

    /**
     * 展开 / 收起。
     *
     * <p>展开时必须去掉 FLAG_NOT_FOCUSABLE，否则输入框拿不到焦点、输入法弹不出来 ——
     * 这正是「悬浮窗里打不了字」的原因。收起成小球后立刻加回该标志，把焦点还给目标 App。</p>
     */
    private void setCollapsedInternal(boolean value) {
        collapsed = value;
        if (card == null || ballView == null) return;

        card.setVisibility(value ? View.GONE : View.VISIBLE);
        ballView.setVisibility(value ? View.VISIBLE : View.GONE);

        if (params != null) {
            if (value) {
                params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                hideKeyboard();
            } else {
                params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                // ALT_FOCUSABLE_IM 让输入法可以正常作用于悬浮窗内的输入框。
                params.flags |= WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM;
            }
            // 展开态固定宽度：太宽会盖住目标 App 的内容，太窄输入框没法用。
            params.width = value
                ? WindowManager.LayoutParams.WRAP_CONTENT
                : Math.min(dp(300), getResources().getDisplayMetrics().widthPixels - dp(28));
            updateParams();
        }
        if (!value && input != null) {
            input.setVisibility(View.VISIBLE);
            // 展开时主动把焦点交给输入框并唤起输入法：
            // 悬浮球本身不是输入框，光去掉 NOT_FOCUSABLE 并不会自动弹输入法。
            input.requestFocus();
            handler.postDelayed(() -> showKeyboard(input), 120);
            // 部分 ROM 在悬浮窗刚变焦时输入法抢焦点失败，延迟再试一次。
            handler.postDelayed(() -> {
                if (!collapsed && input != null && input.isFocused()) {
                    showKeyboard(input);
                }
            }, 420);
        }
    }

    private void hideKeyboard() {
        try {
            InputMethodManager manager =
                (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (manager != null && input != null) {
                manager.hideSoftInputFromWindow(input.getWindowToken(), 0);
            }
        } catch (Throwable ignored) {
            // 忽略
        }
    }

    private void showKeyboard(View target) {
        if (!collapsed && target != null) {
            try {
                InputMethodManager manager =
                    (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (manager != null) {
                    manager.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT);
                }
            } catch (Throwable ignored) {
                // 输入法唤起失败不影响悬浮窗其余功能
            }
        }
    }

    // ── 思考过程 ──────────────────────────────────────────────────────

    private void appendTrace(String title, String body) {
        if (traceBox == null) return;

        // 顶栏状态：只取一句，保持醒目不刷屏
        if (title != null && !title.isEmpty() && statusView != null) {
            statusView.setText(title);
            if (titleView != null && titleView.getText().length() == 0) titleView.setText("控制模式");
        }

        String line = body != null && !body.isEmpty()
            ? (title != null && !title.isEmpty() ? title + "：" + body : body)
            : title;
        if (TextUtils.isEmpty(line)) return;

        TextView row = new TextView(this);
        row.setText("· " + line);
        row.setTextColor(0xFFC2CDE0);
        row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        row.setLineSpacing(dp(1), 1f);
        traceBox.addView(row);

        // 只保留最近若干条，长时间运行不会把内存堆满
        while (traceBox.getChildCount() > MAX_TRACE_LINES) {
            traceBox.removeViewAt(0);
        }
        traceScroll.post(() -> traceScroll.fullScroll(View.FOCUS_DOWN));
    }
}
