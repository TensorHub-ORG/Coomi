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
 * 读取 updates.septemc.com/coomi/android/latest.json，与当前 versionCode 比较，
 * 有新版则提示并下载 APK（DownloadManager → 私有 files 目录），完成后经
 * FileProvider 唤起系统安装器。
 */
public final class UpdateChecker {

    private static final String UPDATE_URL =
        "https://updates.septemc.com/coomi/android/latest.json";
    private static final String TAG = "UpdateChecker";

    public interface Callback {
        void onResult(boolean hasUpdate, String version, String notes, String error);
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

    /** 异步检查更新（网络在主线程外）。 */
    public static void check(final Context context, final Callback callback) {
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
                    String file = json.optString("file", "");
                    String apkUrl = UPDATE_URL.substring(0, UPDATE_URL.lastIndexOf('/')) + "/" + file;
                    int current = currentVersionCode(context);
                    boolean hasUpdate = remoteCode > current;
                    if (hasUpdate) {
                        downloadAndInstall(context, apkUrl, version);
                    }
                    callback.onResult(hasUpdate, version, notes, null);
                }
            } catch (Exception e) {
                callback.onResult(false, null, null, "检查失败：" + e.getMessage());
            }
        }).start();
    }

    private static void downloadAndInstall(Context context, String apkUrl, String version) {
        // 远端 version 拼入文件名前做净化，防路径穿越。
        String safeVersion = version.replaceAll("[^A-Za-z0-9._-]", "_");
        File dir = new File(context.getFilesDir(), "downloads");
        if (!dir.isDirectory()) dir.mkdirs();
        File target = new File(dir, "coomi-update-" + safeVersion + ".apk");
        if (target.isFile()) target.delete();

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(apkUrl));
        request.setTitle("Coomi " + version);
        request.setDescription("正在下载更新包…");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationUri(Uri.fromFile(target));
        request.setMimeType("application/vnd.android.package-archive");

        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        final long downloadId = dm.enqueue(request);

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
            new android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
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
        check(context, (hasUpdate, version, notes, error) -> {
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
