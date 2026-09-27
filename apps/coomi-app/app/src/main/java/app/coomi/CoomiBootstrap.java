package app.coomi;

import android.content.Context;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.termux.shared.logger.Logger;
import com.termux.shared.termux.TermuxConstants;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Coomi APK asset management.
 */
public final class CoomiBootstrap {

    private static final String LOG_TAG = "CoomiBootstrap";

    // Asset paths in APK
    public static final String WEB_ASSET = CoomiConstants.WEB_ASSET;

    // Deployment paths under files dir
    public static final String WEB_DIR_BASENAME = CoomiConstants.WEB_DIR_BASENAME;

    private CoomiBootstrap() {}

    /**
     * Deploy a zip asset to destDir.
     * Returns number of files extracted, or -1 on failure.
     */
    public static int deployZipAsset(Context context, String assetName, File destDir) {
        if (!destDir.exists()) destDir.mkdirs();
        String canonicalDest;
        try {
            canonicalDest = destDir.getCanonicalPath();
        } catch (IOException e) {
            Logger.logError(LOG_TAG, "deployZipAsset: bad dest path: " + e.getMessage());
            return -1;
        }

        int count = 0;
        try (InputStream is = context.getAssets().open(assetName);
             ZipInputStream zis = new ZipInputStream(is)) {
            byte[] buf = new byte[8192];
            ZipEntry ze;
            while ((ze = zis.getNextEntry()) != null) {
                File f = new File(destDir, ze.getName());
                String canonicalFile;
                try {
                    canonicalFile = f.getCanonicalPath();
                } catch (IOException e) {
                    zis.closeEntry();
                    continue;
                }
                if (!canonicalFile.startsWith(canonicalDest)) {
                    zis.closeEntry();
                    continue;
                }
                if (ze.isDirectory()) {
                    f.mkdirs();
                } else {
                    f.getParentFile().mkdirs();
                    try (OutputStream os = new FileOutputStream(f)) {
                        int n;
                        while ((n = zis.read(buf)) != -1) os.write(buf, 0, n);
                    }
                    count++;
                }
                zis.closeEntry();
            }
            Logger.logInfo(LOG_TAG, assetName + ": deployed " + count + " files to " + canonicalDest);
            return count;
        } catch (IOException e) {
            Logger.logError(LOG_TAG, "deployZipAsset " + assetName + " failed: " + e.getMessage());
            return -1;
        }
    }

    /** Check if a file exists and has content. */
    public static boolean assetExists(Context context, String assetPath) {
        try {
            InputStream is = context.getAssets().open(assetPath);
            is.close();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Read app version code + update time for stamping.
     */
    @NonNull
    public static String appStamp(Context context) {
        try {
            android.content.pm.PackageInfo pi = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long code = android.os.Build.VERSION.SDK_INT >= 28
                ? pi.getLongVersionCode() : pi.versionCode;
            return code + "-" + pi.lastUpdateTime;
        } catch (Exception e) {
            return "0";
        }
    }

    /** Delete a file or directory recursively. */
    public static void deleteRecursive(File f) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }
}
