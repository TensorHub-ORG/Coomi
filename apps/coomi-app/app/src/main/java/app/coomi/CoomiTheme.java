package app.coomi;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.view.View;
import android.view.Window;

import androidx.annotation.NonNull;

import com.termux.R;

/**
 * 三档主题（跟随系统 / 明亮 / 夜间）的统一入口。
 *
 * 档位存 SharedPreferences（键 {@link #PREF_THEME_MODE}），前端设置页经
 * CoomiAndroid JS 桥与 Dashboard 原生设置共用同一份偏好。
 *
 * 必须在 Activity 的 {@code super.onCreate} 之前调用 {@link #applyTheme}，
 * 否则窗口背景 / 状态栏会在主题切换后闪一下旧色。
 */
public final class CoomiTheme {

    /** 主题档位：system 跟随系统、light 明亮、dark 夜间。 */
    public static final String MODE_SYSTEM = "system";
    public static final String MODE_LIGHT = "light";
    public static final String MODE_DARK = "dark";

    public static final String PREF_THEME_MODE = "coomi.themeMode";
    private static final String PREF_NAME = "coomi_settings";

    private CoomiTheme() {}

    /** 当前档位，非法值一律回落 system。 */
    @NonNull
    public static String getMode(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        String mode = prefs.getString(PREF_THEME_MODE, MODE_SYSTEM);
        if (!MODE_SYSTEM.equals(mode) && !MODE_LIGHT.equals(mode) && !MODE_DARK.equals(mode)) {
            return MODE_SYSTEM;
        }
        return mode;
    }

    /** 保存档位并立即应用系统栏颜色（Activity 已创建后的运行时切换）。 */
    public static void setMode(Context context, String mode) {
        if (!MODE_SYSTEM.equals(mode) && !MODE_LIGHT.equals(mode) && !MODE_DARK.equals(mode)) {
            return;
        }
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit().putString(PREF_THEME_MODE, mode).apply();
    }

    /** 按档位 + 系统深浅色计算最终是否深色。 */
    public static boolean isDark(Context context) {
        String mode = getMode(context);
        if (MODE_DARK.equals(mode)) return true;
        if (MODE_LIGHT.equals(mode)) return false;
        int night = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * 常规页面（Launcher / Setup）：夜间用 Theme.Coomi.Night，否则 Theme.Coomi。
     * 必须在 {@code super.onCreate} 之前调用。
     */
    public static void applyTheme(Activity activity) {
        activity.setTheme(isDark(activity) ? R.style.Theme_Coomi_Night : R.style.Theme_Coomi);
    }

    /** 页面底色为灰的变体（Dashboard 等）：对应 Theme.Coomi.Page / Theme.Coomi.Night.Page。 */
    public static void applyPageTheme(Activity activity) {
        activity.setTheme(isDark(activity)
            ? R.style.Theme_Coomi_Night_Page
            : R.style.Theme_Coomi_Page);
    }

    /** WebView 宿主闪屏变体：对应 Theme.Coomi.Web / Theme.Coomi.Night.Web。 */
    public static void applyWebTheme(Activity activity) {
        activity.setTheme(isDark(activity)
            ? R.style.Theme_Coomi_Night_Web
            : R.style.Theme_Coomi_Web);
    }

    /**
     * Activity 已创建后的运行时系统栏刷新（setThemeMode 切换档位时调用）。
     * 状态栏颜色与图标跟随 isDark；导航栏也一并处理。
     */
    public static void applySystemBars(Activity activity) {
        boolean dark = isDark(activity);
        Window window = activity.getWindow();
        window.setStatusBarColor(dark ? Color.parseColor("#121316") : activity.getColor(R.color.coomi_white));
        window.setNavigationBarColor(dark ? Color.parseColor("#121316") : activity.getColor(R.color.coomi_white));
        View decor = window.getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (dark) {
            decor.setSystemUiVisibility(flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        } else {
            decor.setSystemUiVisibility(flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }
}
