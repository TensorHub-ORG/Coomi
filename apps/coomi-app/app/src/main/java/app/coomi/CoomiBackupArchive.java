package app.coomi;

import android.content.Context;

import com.termux.shared.termux.TermuxConstants;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

final class CoomiBackupArchive {
    private CoomiBackupArchive() {}

    interface ProgressListener {
        void onProgress(String stage, long processedBytes, long totalBytes);
    }

    static File create(Context context) throws Exception {
        return create(context, null);
    }

    static File create(Context context, ProgressListener listener) throws Exception {
        File home = new File(CoomiConstants.COOMI_CONFIG_DIR);
        File virtualHome = new File(TermuxConstants.TERMUX_HOME_DIR_PATH);
        notifyProgress(listener, "正在扫描备份内容", 0, 0);
        long totalBytes = countDirectoryBytes(home, false, false)
            + countDirectoryBytes(virtualHome, true, true);
        long[] processedBytes = {0};
        notifyProgress(listener, "正在压缩备份", 0, totalBytes);
        File archive = File.createTempFile("coomi-backup-", ".zip", context.getCacheDir());
        boolean complete = false;
        try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(archive))) {
            addDirectory(output, home, "coomi-home", listener, processedBytes, totalBytes);
            addUserData(output, virtualHome, "user-data", true, listener, processedBytes, totalBytes);
            addMcpFiles(output, new File(home, "config/mcp_servers.json"), listener, processedBytes, totalBytes);
            complete = true;
        } finally {
            if (!complete) archive.delete();
        }
        notifyProgress(listener, "正在校验备份", totalBytes, totalBytes);
        verify(archive);
        return archive;
    }

    static void verify(File archive) throws Exception {
        try (ZipFile zip = new ZipFile(archive)) {
            if (!zip.entries().hasMoreElements()) throw new IllegalStateException("备份包为空");
        }
    }

    private static void addDirectory(ZipOutputStream output, File directory, String prefix,
                                     ProgressListener listener, long[] processedBytes, long totalBytes) throws Exception {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            String name = prefix + "/" + child.getName();
            if (child.isDirectory()) addDirectory(output, child, name, listener, processedBytes, totalBytes);
            else addFile(output, name, child, listener, processedBytes, totalBytes);
        }
    }

    private static void addUserData(ZipOutputStream output, File directory, String prefix, boolean root,
                                    ProgressListener listener, long[] processedBytes, long totalBytes) throws Exception {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            String name = child.getName();
            if ((root && ".coomi".equals(name)) || isEnvironmentEntry(name)) continue;
            String entryName = prefix + "/" + name;
            if (child.isDirectory()) addUserData(output, child, entryName, false, listener, processedBytes, totalBytes);
            else addFile(output, entryName, child, listener, processedBytes, totalBytes);
        }
    }

    private static boolean isEnvironmentEntry(String name) {
        String lower = name.toLowerCase(Locale.US);
        return lower.equals(".cache") || lower.equals(".npm") || lower.equals(".pnpm-store")
            || lower.equals(".cargo") || lower.equals(".rustup") || lower.equals(".gradle")
            || lower.equals("node_modules") || lower.equals("venv") || lower.equals(".venv")
            || lower.equals("env") || lower.equals("__pycache__") || lower.equals("tmp")
            || lower.equals(".tmp") || lower.equals(".bash_history") || lower.equals(".zsh_history")
            || lower.equals(".bashrc") || lower.equals(".zshrc") || lower.equals(".profile");
    }

    private static void addMcpFiles(ZipOutputStream output, File config, ProgressListener listener,
                                    long[] processedBytes, long totalBytes) throws Exception {
        JSONObject root = readJson(config);
        JSONObject servers = root == null ? null : root.optJSONObject("servers");
        if (servers == null) return;
        Set<String> candidates = new LinkedHashSet<>();
        for (Iterator<String> names = servers.keys(); names.hasNext();) {
            JSONObject server = servers.optJSONObject(names.next());
            if (server == null) continue;
            candidates.add(server.optString("command", ""));
            JSONArray args = server.optJSONArray("args");
            if (args != null) {
                for (int index = 0; index < args.length(); index++) candidates.add(args.optString(index, ""));
            }
        }
        JSONArray manifest = new JSONArray();
        File termuxHome = new File(TermuxConstants.TERMUX_HOME_DIR_PATH).getCanonicalFile();
        int index = 0;
        for (String raw : candidates) {
            if (raw == null || raw.trim().isEmpty()) continue;
            File source = new File(raw.startsWith("~/") ? new File(termuxHome, raw.substring(2)).getPath() : raw);
            if (!source.exists()) continue;
            source = source.getCanonicalFile();
            if (!isInside(termuxHome, source)) continue;
            // Normal files under Termux HOME are already present in user-data. Packaging them
            // again under mcp-files made large local MCP projects duplicate the backup payload.
            if (isIncludedInUserData(termuxHome, source)) continue;
            String archivePath = "mcp-files/files/" + index++;
            if (source.isDirectory()) addDirectory(output, source, archivePath, listener, processedBytes, totalBytes);
            else addFile(output, archivePath, source, listener, processedBytes, totalBytes);
            JSONObject item = new JSONObject();
            item.put("archive", archivePath);
            item.put("original", source.getAbsolutePath());
            item.put("directory", source.isDirectory());
            manifest.put(item);
        }
        output.putNextEntry(new ZipEntry("mcp-files/manifest.json"));
        output.write(manifest.toString(2).getBytes("UTF-8"));
        output.closeEntry();
    }

    private static boolean isInside(File base, File child) throws Exception {
        String basePath = base.getCanonicalPath();
        String childPath = child.getCanonicalPath();
        return childPath.equals(basePath) || childPath.startsWith(basePath + File.separator);
    }

    private static void addFile(ZipOutputStream output, String name, File source,
                                ProgressListener listener, long[] processedBytes, long totalBytes) throws Exception {
        if (!source.isFile()) return;
        output.putNextEntry(new ZipEntry(name));
        try (InputStream input = new FileInputStream(source)) {
            byte[] buffer = new byte[65536];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
                processedBytes[0] += read;
                notifyProgress(listener, "正在压缩备份", processedBytes[0], totalBytes);
            }
        }
        output.closeEntry();
    }

    private static long countDirectoryBytes(File directory, boolean userData, boolean root) {
        File[] children = directory.listFiles();
        if (children == null) return 0;
        long total = 0;
        for (File child : children) {
            String name = child.getName();
            if (userData && ((root && ".coomi".equals(name)) || isEnvironmentEntry(name))) continue;
            if (child.isDirectory()) total += countDirectoryBytes(child, userData, false);
            else if (child.isFile()) total += Math.max(0, child.length());
        }
        return total;
    }

    private static boolean isIncludedInUserData(File home, File source) throws Exception {
        String relative = home.toPath().relativize(source.toPath()).toString();
        if (relative.isEmpty()) return true;
        String[] parts = relative.split("[\\\\/]");
        if (parts.length == 0 || ".coomi".equals(parts[0])) return false;
        for (String part : parts) if (isEnvironmentEntry(part)) return false;
        return true;
    }

    private static void notifyProgress(ProgressListener listener, String stage, long processed, long total) {
        if (listener != null) listener.onProgress(stage, processed, total);
    }

    private static JSONObject readJson(File file) {
        if (!file.isFile()) return null;
        try (InputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
            return new JSONObject(new String(bytes, 0, offset, "UTF-8"));
        } catch (Exception ignored) {
            return null;
        }
    }
}
