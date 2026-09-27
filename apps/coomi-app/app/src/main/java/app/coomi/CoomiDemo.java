package app.coomi;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import com.termux.BuildConfig;
import com.termux.shared.logger.Logger;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.Locale;

/**
 * 演示包（demo 构建类型）的开关和离线前端。
 *
 * 演示包不启动原生引擎，而是把 assets/web.zip 解到 filesDir/web，再用 shouldInterceptRequest
 * 把一个假域名（https://coomi.local）指到那个目录 —— 页面拿到的是 https 源，
 * localStorage 和 secure context 都正常，但一个字节都不会出手机。
 *
 * 前端那边看到 ?demo=1 就切到 DemoTransport（脚本化假事件），所以整条链路里
 * 没有引擎，也不需要 API Key。
 */
public final class CoomiDemo {

    private static final String LOG_TAG = "CoomiDemo";

    private static final String PREFS = "coomi_demo";
    private static final String PREF_ONBOARDED = "onboarded";

    /** 只在拦截器里存在的域名：不解析、不出网。 */
    public static final String HOST = "coomi.local";
    /** autoplay 默认开着，一进来就自己播一轮瀑布流；授权/提问还是等人点。 */
    public static final String START_URL = "https://" + HOST + "/index.html?demo=1";

    private CoomiDemo() {}

    /** 只有 demo 构建类型是 true，正式包里这整条分支都是死代码。 */
    public static boolean isEnabled() {
        return BuildConfig.COOMI_DEMO;
    }

    // ── 引导状态：演示包没有真实部署状态可查，自己记一个 ──

    public static boolean isOnboarded(Context c) {
        return prefs(c).getBoolean(PREF_ONBOARDED, false);
    }

    public static void markOnboarded(Context c) {
        prefs(c).edit().putBoolean(PREF_ONBOARDED, true).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── 离线前端 ──

    /** web.zip → filesDir/web，缺 index.html 才解。返回目录，失败返回 null。 */
    public static File ensureWebDir(Context c) {
        File dir = webDir(c);
        File index = new File(dir, "index.html");
        if (index.isFile() && index.length() > 0) return dir;

        if (!CoomiBootstrap.assetExists(c, CoomiConstants.WEB_ASSET)) {
            Logger.logError(LOG_TAG, "web.zip missing from assets");
            return null;
        }
        CoomiBootstrap.deleteRecursive(dir);
        int n = CoomiBootstrap.deployZipAsset(c, CoomiConstants.WEB_ASSET, dir);
        if (n < 0 || !index.isFile()) {
            Logger.logError(LOG_TAG, "web.zip deploy failed (" + n + " files)");
            return null;
        }
        Logger.logInfo(LOG_TAG, "demo web assets ready: " + n + " files");
        return dir;
    }

    private static File webDir(Context c) {
        return new File(c.getFilesDir(), CoomiConstants.WEB_DIR_BASENAME);
    }

    /**
     * 把 https://coomi.local/... 映射到 filesDir/web 下的文件。
     *
     * 非本域名返回 null（交回 WebView 默认处理）；本域名下找不到就 404 ——
     * 宁可 404 也不要放出去联网。前端的 /api 请求就落在这条上，store 自己有兜底。
     */
    public static WebResourceResponse serve(Context c, Uri uri) {
        if (uri == null || !HOST.equalsIgnoreCase(uri.getHost())) return null;

        String path = uri.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";

        File dir = webDir(c);
        File f = new File(dir, path);
        try {
            String base = dir.getCanonicalPath();
            String target = f.getCanonicalPath();
            // 目录穿越防线：../ 拼出来的路径一律拒掉。
            if (!target.equals(base) && !target.startsWith(base + File.separator)) return notFound();
        } catch (IOException e) {
            return notFound();
        }
        if (!f.isFile()) return notFound();

        try {
            InputStream is = new FileInputStream(f);
            return new WebResourceResponse(mimeOf(f.getName()), "utf-8", 200, "OK",
                Collections.singletonMap("Cache-Control", "no-store"), is);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    /** WebView 对 mime 很挑：js 报成 text/plain 就直接不执行了。 */
    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json") || n.endsWith(".map")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".ttf")) return "font/ttf";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }
}
