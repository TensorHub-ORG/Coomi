package app.coomi;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Stages the APK's archives without touching installed runtime versions. */
final class CoomiRuntimeArtifacts {
    private static final long STORAGE_RESERVE = 64L * 1024 * 1024;
    interface AssetSource { InputStream open() throws IOException; }
    // Android's Os.rename supports atomic replacement on API 24; File.renameTo
    // does not promise replacement of an existing destination on every host OS.
    interface AtomicPublisher { void replace(File temporary, File target) throws IOException; }

    static boolean ensure(File target, long size, String sha256, AssetSource asset,
                          AtomicPublisher publisher) throws IOException {
        if (size <= 0 || sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) {
            throw new IOException("invalid bundled runtime artifact metadata");
        }
        File parent = target.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
            throw new IOException("cannot create runtime cache directory");
        }
        File temporary = new File(parent, target.getName() + ".asset.tmp");
        // This temp file is private to APK staging and can remain after process death.
        if (temporary.isFile()) temporary.delete();
        if (matches(target, size, sha256)) return false;

        long usable = parent.getUsableSpace();
        if (usable > 0 && (usable < STORAGE_RESERVE || size > usable - STORAGE_RESERVE)) {
            throw new IOException("insufficient storage for bundled runtime archive " + target.getName()
                + ": need " + size + " bytes plus 64 MiB reserve, usable " + usable
                + "; free storage and restart the app to restore the archive from the APK");
        }
        try {
            MessageDigest digest = digest();
            long total = 0;
            try (InputStream input = asset.open(); FileOutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[128 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (count == 0) continue;
                    total += count;
                    if (total > size) throw new IOException("bundled runtime archive exceeds manifest size");
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (total != size || !hex(digest.digest()).equalsIgnoreCase(sha256)) {
                throw new IOException("bundled runtime archive does not match APK manifest: " + target.getName());
            }
            publisher.replace(temporary, target);
            return true;
        } finally {
            if (temporary.isFile()) temporary.delete();
        }
    }

    private static boolean matches(File target, long size, String sha256) throws IOException {
        if (!target.isFile() || target.length() != size) return false;
        MessageDigest digest = digest();
        try (InputStream input = new FileInputStream(target)) {
            byte[] buffer = new byte[128 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest()).equalsIgnoreCase(sha256);
    }

    private static MessageDigest digest() throws IOException {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException error) { throw new IOException("SHA-256 unavailable", error); }
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(digits[(value & 0xff) >>> 4]).append(digits[value & 0xf]);
        return result.toString();
    }
}
