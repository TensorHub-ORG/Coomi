package app.coomi;

import android.content.Context;
import android.os.Build;

import com.termux.BuildConfig;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

/** Shared native client for sending feedback without WebView CORS restrictions. */
public final class CoomiFeedbackClient {

    private static final String ENDPOINT = "https://updates.septemc.com/coomi/feedback/api";
    private static final int TIMEOUT_MS = 10_000;

    private CoomiFeedbackClient() {}

    public static JSONObject diagnostics(Context context) {
        JSONObject info = new JSONObject();
        try {
            info.put("version_name", BuildConfig.VERSION_NAME);
            info.put("version_code", BuildConfig.VERSION_CODE);
            info.put("package_name", context.getPackageName());
            info.put("device_model", Build.MODEL);
            info.put("manufacturer", Build.MANUFACTURER);
            info.put("os", "Android");
            info.put("android_version", Build.VERSION.RELEASE);
            info.put("sdk_int", Build.VERSION.SDK_INT);
        } catch (Exception ignored) {}
        return info;
    }

    /** Returns a JSON result containing at least an {@code ok} boolean. */
    public static String post(String json) {
        return post(json, Collections.emptyList());
    }

    public static final class Attachment {
        public final String name;
        public final String mimeType;
        public final byte[] data;

        public Attachment(String name, String mimeType, byte[] data) {
            this.name = name;
            this.mimeType = mimeType;
            this.data = data;
        }
    }

    /** Sends JSON alone or a multipart form when screenshots are attached. */
    public static String post(String json, List<Attachment> attachments) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            String boundary = "----CoomiFeedback" + System.currentTimeMillis();
            boolean multipart = attachments != null && !attachments.isEmpty();
            connection.setRequestProperty(
                "Content-Type",
                multipart ? "multipart/form-data; boundary=" + boundary : "application/json; charset=utf-8"
            );
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                if (!multipart) {
                    output.write(json.getBytes(StandardCharsets.UTF_8));
                } else {
                    writePart(output, boundary, "payload", null, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
                    int total = 0;
                    for (Attachment attachment : attachments) {
                        if (attachment.data.length > 2 * 1024 * 1024) throw new IllegalArgumentException("image exceeds 2 MB");
                        total += attachment.data.length;
                        if (total > 6 * 1024 * 1024) throw new IllegalArgumentException("attachments exceed 6 MB");
                        writePart(output, boundary, "images", attachment.name, attachment.mimeType, attachment.data);
                    }
                    output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                }
            }

            int code = connection.getResponseCode();
            InputStream response = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            StringBuilder body = new StringBuilder();
            if (response != null) {
                try (InputStream input = response) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) >= 0) {
                        body.append(new String(buffer, 0, count, StandardCharsets.UTF_8));
                    }
                }
            }

            JSONObject result = new JSONObject();
            result.put("ok", code >= 200 && code < 300);
            if (code < 200 || code >= 300) result.put("error", "HTTP " + code);
            result.put("detail", body.toString());
            return result.toString();
        } catch (Exception error) {
            JSONObject result = new JSONObject();
            try {
                result.put("ok", false);
                result.put("error", error.getClass().getSimpleName() + ": " + error.getMessage());
            } catch (Exception ignored) {}
            return result.toString();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void writePart(OutputStream output, String boundary, String field, String fileName, String mimeType, byte[] data) throws Exception {
        StringBuilder header = new StringBuilder("--").append(boundary).append("\r\n")
            .append("Content-Disposition: form-data; name=\"").append(field).append("\"");
        if (fileName != null) header.append("; filename=\"").append(fileName.replace("\"", "")).append("\"");
        header.append("\r\nContent-Type: ").append(mimeType).append("\r\n\r\n");
        output.write(header.toString().getBytes(StandardCharsets.UTF_8));
        output.write(data);
        output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }
}
