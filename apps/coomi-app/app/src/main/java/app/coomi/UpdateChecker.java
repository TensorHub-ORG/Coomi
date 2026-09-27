package app.coomi;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONObject;

/**
 * 软件内检查更新（第三批 6）：
 * 读取 api.monai.ccwu.cc/coomi/latest.json，与当前 versionCode 比较，
 * 有新版则提示并下载 APK（DownloadManager → 私有 files 目录），完成后经
 * FileProvider 唤起系统安装器。
 */
public final class UpdateChecker {

    private static final String UPDATE_URL =
        "https://api.monai.ccwu.cc/coomi/latest.json";
    private static final String TAG = "UpdateChecker";

    public interface Callback {
        void onResult(boolean hasUpdate, String version, String notes, String error);
    }

    public interface DetailCallback {
        void onResult(UpdateInfo info, String error);
    }

    public static final class UpdateInfo {
        public final int versionCode;
        public final String version;
        public final String notes;
        public final String apkUrl;
        public final String publishedAt;
        public final long size;

        UpdateInfo(int versionCode, String version, String notes, String apkUrl,
                   String publishedAt, long size) {
            this.versionCode = versionCode;
            this.version = version;
            this.notes = notes;
            this.apkUrl = apkUrl;
            this.publishedAt = publishedAt;
            this.size = size;
        }

        public boolean hasUpdate(Context context) {
            return versionCode > currentVersionCode(context);
        }
    }

    private UpdateChecker() {}

    public static int currentVersionCode(Context context) {
        try {
            return context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0).versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    /** 静默检查：只查询是否有新版本（用于「检查更新」红点提示），不自动下载。 */
    public static void checkSilent(final Context context, final Callback callback) {
        checkDetails(context, (info, error) -> callback.onResult(
            info != null && info.hasUpdate(context),
            info == null ? null : info.version,
            info == null ? null : info.notes,
            error));
    }

    /** 获取完整更新信息。启动弹窗和手动更新共用同一份严格解析结果。 */
    public static void checkDetails(final Context context, final DetailCallback callback) {
        new Thread(() -> {
            try {
                URL url = new URL(UPDATE_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("User-Agent", "Coomi-Android/" + currentVersionCode(context));
                int code = conn.getResponseCode();
                if (code != 200) {
                    callback.onResult(null, "更新源返回 HTTP " + code);
                    return;
                }
                try (InputStream in = conn.getInputStream()) {
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) >= 0) buffer.write(chunk, 0, n);
                    JSONObject json = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
                    int remoteCode = json.optInt("versionCode", 0);
                    String version = json.optString("version", "");
                    String notes = json.optString("notes", "");
                    if (remoteCode <= 0 || version.trim().isEmpty()) {
                        callback.onResult(null, "更新信息缺少版本号");
                        return;
                    }
                    String file = json.optString("url", json.optString("file", ""));
                    String apkUrl = file.startsWith("https://") || file.startsWith("http://")
                        ? file
                        : UPDATE_URL.substring(0, UPDATE_URL.lastIndexOf('/')) + "/" + file;
                    callback.onResult(new UpdateInfo(
                        remoteCode,
                        version.trim(),
                        notes,
                        apkUrl,
                        json.optString("publishedAt", json.optString("date", "")),
                        json.optLong("size", 0L)
                    ), null);
                }
            } catch (Exception e) {
                callback.onResult(null, "检查失败：" + e.getMessage());
            }
        }).start();
    }

    /** 异步检查更新（网络在主线程外）。autoInstall=true 时发现新版自动下载安装。 */
    public static void check(final Context context, final boolean autoInstall, final Callback callback) {
        new Thread(() -> {
            try {
                URL url = new URL(UPDATE_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("User-Agent", "Coomi-Android/" + currentVersionCode(context));
                int code = conn.getResponseCode();
                if (code != 200) {
                    callback.onResult(false, null, null, "更新源返回 HTTP " + code);
                    return;
                }
                try (InputStream in = conn.getInputStream()) {
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) >= 0) buffer.write(chunk, 0, n);
                    JSONObject json = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
                    int remoteCode = json.optInt("versionCode", 0);
                    String version = json.optString("version", "");
                    String notes = json.optString("notes", "");
                    String file = json.optString("url", json.optString("file", ""));
                    String apkUrl = file.startsWith("https://") || file.startsWith("http://")
                        ? file
                        : UPDATE_URL.substring(0, UPDATE_URL.lastIndexOf('/')) + "/" + file;
                    int current = currentVersionCode(context);
                    boolean hasUpdate = remoteCode > current;
                    if (hasUpdate && autoInstall) {
                        downloadAndInstall(context, apkUrl, version);
                    }
                    callback.onResult(hasUpdate, version, notes, null);
                }
            } catch (Exception e) {
                callback.onResult(false, null, null, "检查失败：" + e.getMessage());
            }
        }).start();
    }

    // 输入的远端 url 只作为文件名来源；实际下载始终限定在受信任更新站，避免
    // 被篡改的元数据把 DownloadManager 引向任意主机。
    private static String trustedApkUrl(String raw) {
        try {
            URL root = new URL(UPDATE_URL);
            URL candidate = new URL(root, raw == null ? "" : raw.trim());
            if (!root.getProtocol().equalsIgnoreCase(candidate.getProtocol())
                || !root.getHost().equalsIgnoreCase(candidate.getHost())) {
                return "";
            }
            return candidate.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    public static void downloadAndInstall(Context context, String apkUrl, String version) {
        apkUrl = trustedApkUrl(apkUrl);
        if (apkUrl.isEmpty()) {
            Toast.makeText(context, "更新地址不受信任，已取消下载", Toast.LENGTH_LONG).show();
            return;
        }
        // 远端 version 拼入文件名前做净化，防路径穿越。
        String safeVersion = version.replaceAll("[^A-Za-z0-9._-]", "_");
        String fileName = "coomi-update-" + safeVersion + ".apk";

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(apkUrl));
        request.setTitle("Comax " + version);
        request.setDescription("正在下载更新包…");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setMimeType("application/vnd.android.package-archive");
        // 下载目标必须放在系统 DownloadManager 服务可写的目录：
        // App 私有目录（files/downloads）会被它以 "Unsupported path" 拒绝（Android 10+）。
        // 用 App 专属外部目录 Android/data/<pkg>/files/Download/。
        File target;
        File externalDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (externalDir != null) {
            request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName);
            target = new File(externalDir, fileName);
        } else {
            File dir = new File(context.getFilesDir(), "downloads");
            if (!dir.isDirectory()) dir.mkdirs();
            request.setDestinationUri(Uri.fromFile(new File(dir, fileName)));
            target = new File(dir, fileName);
        }
        if (target.isFile()) target.delete();

        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        final long downloadId;
        try {
            downloadId = dm.enqueue(request);
        } catch (Exception e) {
            Toast.makeText(context, "发起更新下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }

        // 下载完成后触发安装
        DownloadManager manager = dm;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;
                ctx.unregisterReceiver(this);
                File downloaded = new File(target.getAbsolutePath());
                try {
                    Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id));
                    int status = -1;
                    if (cursor != null && cursor.moveToFirst()) {
                        int col = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                        if (col >= 0) status = cursor.getInt(col);
                        cursor.close();
                    }
                    if (status != DownloadManager.STATUS_SUCCESSFUL || !downloaded.isFile()) {
                        Toast.makeText(ctx, "更新包下载失败", Toast.LENGTH_LONG).show();
                        return;
                    }
                    // 安装前校验签名与当前安装一致，防止更新源被篡改。
                    if (!signatureMatches(ctx, downloaded)) {
                        Toast.makeText(ctx, "更新包签名校验失败，已取消安装", Toast.LENGTH_LONG).show();
                        return;
                    }
                    Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", downloaded);
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(uri, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(install);
                } catch (Exception e) {
                    Toast.makeText(ctx, "无法打开安装器：" + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        };
        context.registerReceiver(receiver,
            new android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? Context.RECEIVER_NOT_EXPORTED : 0);
    }

    /** 校验下载的 APK 签名证书与当前安装一致（防 MITM/被篡改的更新包）。
     *  API 28+ 读 v2/v3 证书（getSigningInfo），低版本回退 v1（GET_SIGNATURES）。
     *  之前只用 GET_SIGNATURES，而 AGP 8 默认关闭 v1 签名，导致校验恒失败、永远拒装。 */
    private static boolean signatureMatches(Context context, File apk) {
        try {
            PackageManager pm = context.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
            PackageInfo current = pm.getPackageInfo(context.getPackageName(), flags);
            PackageInfo remote = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            if (current == null || remote == null) return false;
            Signature[] cur = signaturesOf(current);
            Signature[] rem = signaturesOf(remote);
            if (cur == null || rem == null || cur.length == 0 || rem.length == 0) return false;
            return cur[0].toCharsString().equals(rem[0].toCharsString());
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressLint("NewApi")
    private static Signature[] signaturesOf(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            return info.signingInfo.getApkContentsSigners();
        }
        return info.signatures;
    }

    /** 供 Dashboard 使用：弹结果对话框。 */
    public static void checkAndPrompt(Context context, Runnable after) {
        check(context, true, (hasUpdate, version, notes, error) -> {
            ((android.app.Activity) context).runOnUiThread(() -> {
                if (error != null) {
                    Toast.makeText(context, error, Toast.LENGTH_LONG).show();
                } else if (!hasUpdate) {
                    Toast.makeText(context, "已是最新版本（" + version + "）", Toast.LENGTH_SHORT).show();
                } else {
                    new AlertDialog.Builder(context)
                        .setTitle("发现新版本 " + version)
                        .setMessage(notes == null || notes.isEmpty()
                            ? "正在后台下载更新包，完成后自动弹出安装。"
                            : notes + "\n\n正在后台下载更新包，完成后自动弹出安装。")
                        .setPositiveButton("知道了", null)
                        .show();
                }
                if (after != null) after.run();
            });
        });
    }
}
