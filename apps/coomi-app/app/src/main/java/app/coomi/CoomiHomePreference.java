package app.coomi;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 应用内偏好：启动首页路由等。
 *
 * homeRoute: "console"（控制台，默认）| "chat"（对话界面）
 */
public final class CoomiHomePreference {

    private static final String PREFS_NAME = "coomi_settings";
    private static final String KEY_HOME_ROUTE = "home_route";
    private static final String ROUTE_CONSOLE = "console";
    private static final String ROUTE_CHAT = "chat";

    private CoomiHomePreference() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static String getHomeRoute(Context context) {
        return prefs(context).getString(KEY_HOME_ROUTE, ROUTE_CONSOLE);
    }

    public static boolean isChatHome(Context context) {
        return ROUTE_CHAT.equals(getHomeRoute(context));
    }

    public static void setHomeRoute(Context context, String route) {
        prefs(context).edit().putString(KEY_HOME_ROUTE, route).apply();
    }
}
