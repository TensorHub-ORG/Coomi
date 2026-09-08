package app.coomi;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.LinearGradient;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

/** WindowManager surface only. The chat owner, not this view, owns the WebView lifetime. */
public final class CoomiFloatingWindow {
    private final Context context;
    private final WebView webView;
    private final Runnable onClose;
    private final WindowManager manager;
    private final SharedPreferences preferences;
    private final Surface surface;
    private final LinearLayout panel;
    private final Icon ball;
    private final WindowManager.LayoutParams params;
    private final Rect window = new Rect();
    private final Rect available = new Rect();
    private final Rect visibleFrame = new Rect();
    private int ballX;
    private int ballY;
    private boolean minimized;
    private boolean attached;
    private boolean visible = true;
    private boolean focused;
    private boolean updateFailed;
    private int keyboardTop = Integer.MAX_VALUE;
    private final int slop;

    public CoomiFloatingWindow(Context context, WebView webView, Runnable onFullscreen, Runnable onClose) {
        this.context = context;
        this.webView = webView;
        this.onClose = onClose;
        manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        preferences = context.getSharedPreferences("coomi_floating_window", Context.MODE_PRIVATE);
        slop = ViewConfiguration.get(context).getScaledTouchSlop();
        params = new WindowManager.LayoutParams(1, 1,
            Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        if (Build.VERSION.SDK_INT >= 28) {
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER;
        }
        surface = new Surface(context);
        panel = new LinearLayout(context);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(6), dp(6), dp(6), dp(6));
        boolean dark = CoomiTheme.isDark(context);
        GradientDrawable background = new GradientDrawable();
        background.setColor(dark ? 0xff202127 : 0xfff7f8fc);
        background.setCornerRadius(dp(18));
        background.setStroke(dp(1), dark ? 0xff55596a : 0xffc5c9db);
        panel.setBackground(background);
        panel.setClipToOutline(true);
        LinearLayout toolbar = new LinearLayout(context);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setOnTouchListener(new MoveGesture(false));
        toolbar.addView(button(1, "返回全屏", onFullscreen));
        toolbar.addView(button(2, "缩成悬浮球", this::minimize));
        View grip = new View(context);
        grip.setContentDescription("拖动悬浮窗");
        grip.setOnTouchListener(new MoveGesture(false));
        toolbar.addView(grip, new LinearLayout.LayoutParams(0, dp(34), 1));
        toolbar.addView(button(4, "关闭悬浮窗", onClose));
        panel.addView(toolbar, new LinearLayout.LayoutParams(-1, dp(34)));
        surface.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        ball = new Icon(context, 5);
        ball.setContentDescription("恢复聊天小窗，拖动可移动");
        ball.setOnClickListener(v -> expand());
        ball.setOnTouchListener(new MoveGesture(true));
        surface.addView(ball, new FrameLayout.LayoutParams(-1, -1));
        ball.setVisibility(View.GONE);
        updateBounds();
        int width = preferences.getInt("width", Math.min(dp(380), available.width()));
        int height = preferences.getInt("height", Math.min(dp(520), available.height()));
        int x = preferences.getInt("x", Math.max(0, (available.width() - width) / 2));
        int y = preferences.getInt("y", Math.max(0, (available.height() - height) / 3));
        window.set(x, y, x + width, y + height);
        ballX = preferences.getInt("ball_x", 0);
        ballY = preferences.getInt("ball_y", dp(160));
        surface.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            if (!attached || minimized || !visible) return;
            surface.getWindowVisibleDisplayFrame(visibleFrame);
            // Legacy adjustResize and modern IME both report the unobscured display frame.
            int heightLeft = visibleFrame.height();
            int top = focused && heightLeft > 0 && available.height() - heightLeft > dp(100)
                ? heightLeft : Integer.MAX_VALUE;
            if (keyboardTop != top) {
                keyboardTop = top;
                applyGeometry();
            }
        });
    }

    private View button(int kind, String description, Runnable action) {
        Icon icon = new Icon(context, kind);
        icon.setContentDescription(description);
        icon.setFocusable(true);
        icon.setLayoutParams(new LinearLayout.LayoutParams(dp(34), dp(34)));
        icon.setOnClickListener(v -> action.run());
        if (Build.VERSION.SDK_INT >= 26) icon.setTooltipText(description);
        return icon;
    }

    public void show() {
        if (attached) { setVisible(true); return; }
        if (webView.getParent() != null) ((ViewGroup) webView.getParent()).removeView(webView);
        panel.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        applyGeometry();
        try {
            manager.addView(surface, params);
            attached = true;
        } catch (RuntimeException error) {
            panel.removeView(webView);
            throw error;
        }
    }

    public void minimize() {
        if (minimized) return;
        saveGeometry();
        releaseFocus();
        minimized = true;
        panel.setVisibility(View.GONE);
        ball.setVisibility(View.VISIBLE);
        applyGeometry();
    }

    public void expand() {
        minimized = false;
        panel.setVisibility(View.VISIBLE);
        ball.setVisibility(View.GONE);
        applyGeometry();
    }

    public boolean isMinimized() { return minimized; }

    public void setVisible(boolean value) {
        visible = value;
        if (!value) releaseFocus();
        surface.setVisibility(value ? View.VISIBLE : View.GONE);
    }

    public void dismiss() {
        saveGeometry();
        boolean wasAttached = attached;
        attached = false;
        releaseFocus();
        if (wasAttached) {
            try {
                manager.removeViewImmediate(surface);
            } catch (IllegalArgumentException error) {
                android.util.Log.w("CoomiFloatingWindow", "Overlay already removed", error);
            }
        }
        panel.removeView(webView);
    }

    public void onConfigurationChanged() {
        keyboardTop = Integer.MAX_VALUE;
        updateBounds();
        applyGeometry();
        saveGeometry();
    }


    private void updateBounds() {
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
        manager.getDefaultDisplay().getMetrics(metrics);
        available.set(0, 0, metrics.widthPixels, metrics.heightPixels);
        // Overlay coordinates begin below the status bar unless FLAG_LAYOUT_IN_SCREEN is set.
        int status = context.getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (status != 0) available.bottom -= context.getResources().getDimensionPixelSize(status);
    }

    private void applyGeometry() {
        int screenWidth = Math.max(1, available.width());
        int screenHeight = Math.max(1, available.height());
        int edgeInset = Math.min(dp(24), (screenWidth - 1) / 2);
        int width = constrainPanelWidth(window.width(), dp(240), screenWidth, edgeInset);
        int height = clamp(window.height(), Math.min(dp(260), screenHeight), screenHeight);
        int x = constrainPanelX(window.left, width, screenWidth);
        int y = clamp(window.top, 0, screenHeight - height);
        window.set(x, y, x + width, y + height);
        if (minimized) {
            params.width = params.height = Math.min(dp(56), Math.min(screenWidth, screenHeight));
            ballX = clamp(ballX, 0, screenWidth - params.width);
            ballY = clamp(ballY, 0, screenHeight - params.height);
            params.x = ballX;
            params.y = ballY;
        } else {
            int usableHeight = Math.min(screenHeight, keyboardTop);
            params.width = width;
            params.height = Math.min(height, usableHeight);
            params.x = x;
            params.y = Math.min(y, Math.max(0, usableHeight - params.height));
        }
        updateLayout();
    }

    private void updateLayout() {
        if (!attached || updateFailed) return;
        try {
            manager.updateViewLayout(surface, params);
        } catch (RuntimeException error) {
            updateFailed = true;
            android.util.Log.w("CoomiFloatingWindow", "Overlay became unavailable", error);
            surface.post(onClose);
        }
    }

    private void takeFocus() {
        if (focused || minimized || !visible) return;
        focused = true;
        params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        updateLayout();
    }

    private void releaseFocus() {
        InputMethodManager input = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
        input.hideSoftInputFromWindow(surface.getWindowToken(), 0);
        webView.clearFocus();
        focused = false;
        keyboardTop = Integer.MAX_VALUE;
        params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        applyGeometry();
    }

    private void saveGeometry() {
        preferences.edit().putInt("x", window.left).putInt("y", window.top)
            .putInt("width", window.width()).putInt("height", window.height())
            .putInt("ball_x", ballX).putInt("ball_y", ballY).apply();
    }

    private static int clamp(int value, int min, int max) { return Math.max(min, Math.min(value, max)); }

    static int constrainPanelWidth(int requested, int minimum, int screenWidth, int edgeInset) {
        int maximum = Math.max(1, screenWidth - edgeInset * 2);
        return clamp(requested, Math.min(minimum, maximum), maximum);
    }

    static int constrainPanelX(int requested, int width, int screenWidth) {
        return clamp(requested, 0, Math.max(0, screenWidth - width));
    }
    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    private final class MoveGesture implements View.OnTouchListener {
        private final boolean movingBall;
        private float downX, downY;
        private int startX, startY;
        private boolean dragged;
        MoveGesture(boolean movingBall) { this.movingBall = movingBall; }
        @Override public boolean onTouch(View v, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getRawX(); downY = event.getRawY();
                    startX = movingBall ? ballX : window.left;
                    startY = movingBall ? ballY : window.top;
                    dragged = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    int dx = Math.round(event.getRawX() - downX);
                    int dy = Math.round(event.getRawY() - downY);
                    dragged |= Math.hypot(dx, dy) > slop;
                    if (!dragged) return true;
                    if (movingBall) { ballX = startX + dx; ballY = startY + dy; }
                    else window.offsetTo(startX + dx, startY + dy);
                    applyGeometry();
                    return true;
                case MotionEvent.ACTION_UP:
                    saveGeometry();
                    if (!dragged) v.performClick();
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    saveGeometry();
                    return true;
                default: return false;
            }
        }
    }

    private final class Surface extends FrameLayout {
        private int edges;
        private float downX, downY;
        private final Rect start = new Rect();
        Surface(Context context) { super(context); }
        @Override public boolean dispatchTouchEvent(MotionEvent event) {
            if (event.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                releaseFocus();
                return false;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN && !minimized) takeFocus();
            return super.dispatchTouchEvent(event);
        }
        @Override public boolean onInterceptTouchEvent(MotionEvent event) {
            if (minimized) return false;
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                int border = dp(8);
                edges = (event.getX() < border ? 1 : 0) | (event.getX() > getWidth() - border ? 2 : 0)
                    | (event.getY() < border ? 4 : 0) | (event.getY() > getHeight() - border ? 8 : 0);
                downX = event.getRawX(); downY = event.getRawY();
                start.set(params.x, params.y, params.x + params.width, params.y + params.height);
            }
            return edges != 0;
        }
        @Override public boolean onTouchEvent(MotionEvent event) {
            if (edges == 0) return super.onTouchEvent(event);
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
                int dx = Math.round(event.getRawX() - downX), dy = Math.round(event.getRawY() - downY);
                int minW = Math.min(dp(280), start.width()), minH = Math.min(dp(320), start.height());
                window.set(start);
                if ((edges & 1) != 0) window.left = clamp(start.left + dx, 0, start.right - minW);
                if ((edges & 2) != 0) window.right = clamp(start.right + dx, start.left + minW, available.width());
                if ((edges & 4) != 0) window.top = clamp(start.top + dy, 0, start.bottom - minH);
                if ((edges & 8) != 0) window.bottom = clamp(start.bottom + dy, start.top + minH, available.height());
                applyGeometry();
            } else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                edges = 0;
                saveGeometry();
            }
            return true;
        }
        @Override public boolean dispatchKeyEvent(KeyEvent event) {
            if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                if (keyboardTop != Integer.MAX_VALUE) releaseFocus();
                else minimize();
                return true;
            }
            return super.dispatchKeyEvent(event);
        }
    }

    private final class Icon extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int kind;
        private final Shader gradient = new LinearGradient(-20, -20, 20, 20,
            0xff45c9ef, 0xff9564df, Shader.TileMode.CLAMP);
        private final int color = CoomiTheme.isDark(context) ? Color.WHITE : 0xff343a51;
        Icon(Context context, int kind) { super(context); this.kind = kind; setClickable(true); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            canvas.save();
            canvas.translate(getWidth() / 2f, getHeight() / 2f);
            float unit = context.getResources().getDisplayMetrics().density;
            canvas.scale(unit, unit);
            paint.setColor(color);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(1.8f);
            paint.setStrokeCap(Paint.Cap.ROUND);
            switch (kind) {
                case 1:
                    for (int i = 0; i < 4; i++) {
                        canvas.drawLine(-9, -3, -9, -9, paint); canvas.drawLine(-9, -9, -3, -9, paint);
                        canvas.rotate(90);
                    }
                    break;
                case 2:
                    canvas.drawLine(-8, -3, 0, 5, paint); canvas.drawLine(0, 5, 8, -3, paint);
                    break;
                case 3:
                    canvas.drawLine(-10, 0, 0, -9, paint); canvas.drawLine(0, -9, 10, 0, paint);
                    canvas.drawLine(-7, -2, -7, 9, paint); canvas.drawLine(-7, 9, 7, 9, paint);
                    canvas.drawLine(7, 9, 7, -2, paint); canvas.drawRect(-2, 3, 2, 9, paint);
                    break;
                case 4:
                    canvas.drawLine(-7, -7, 7, 7, paint); canvas.drawLine(-7, 7, 7, -7, paint);
                    break;
                case 5:
                    paint.setStyle(Paint.Style.FILL);
                    paint.setShader(gradient);
                    canvas.drawCircle(0, 0, 25, paint);
                    paint.setShader(null);
                    paint.setColor(Color.WHITE);
                    paint.setStyle(Paint.Style.STROKE);
                    canvas.drawRoundRect(-12, -9, 12, 8, 6, 6, paint);
                    canvas.drawLine(-6, 8, -9, 13, paint);
                    canvas.drawLine(-9, 13, 1, 8, paint);
                    paint.setStyle(Paint.Style.FILL);
                    canvas.drawCircle(-5, -1, 1.5f, paint); canvas.drawCircle(5, -1, 1.5f, paint);
                    break;
                default: break;
            }
            canvas.restore();
        }
    }
}
