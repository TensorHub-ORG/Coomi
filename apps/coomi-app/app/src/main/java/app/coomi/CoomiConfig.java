package app.coomi;

import android.text.TextUtils;

import com.termux.shared.logger.Logger;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;

/** Reads and writes the native coomi-rs provider registry. */
public final class CoomiConfig {

    private static final String LOG_TAG = "CoomiConfig";
    private static final Object CONFIG_LOCK = new Object();

    private CoomiConfig() {}

    public static JSONObject readConfig() {
        synchronized (CONFIG_LOCK) {
            File file = new File(CoomiConstants.COOMI_PROVIDER_FILE);
            if (!file.isFile()) return emptyDocument();
            try (FileReader reader = new FileReader(file)) {
                StringBuilder json = new StringBuilder();
                char[] buffer = new char[2048];
                int count;
                while ((count = reader.read(buffer)) != -1) json.append(buffer, 0, count);
                return new JSONObject(json.toString());
            } catch (Exception e) {
                Logger.logError(LOG_TAG, "Cannot read providers.json: " + e.getMessage());
                return emptyDocument();
            }
        }
    }

    public static boolean writeConfig(JSONObject document) {
        synchronized (CONFIG_LOCK) {
            File file = new File(CoomiConstants.COOMI_PROVIDER_FILE);
            File parent = file.getParentFile();
            if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) return false;
            try (FileWriter writer = new FileWriter(file)) {
                writer.write(document.toString(2));
                file.setReadable(false, false);
                file.setReadable(true, true);
                file.setWritable(false, false);
                file.setWritable(true, true);
                return true;
            } catch (Exception e) {
                Logger.logError(LOG_TAG, "Cannot write providers.json: " + e.getMessage());
                return false;
            }
        }
    }

    public static boolean setProvider(String providerId, String model) {
        if (TextUtils.isEmpty(providerId) || TextUtils.isEmpty(model)) return false;
        try {
            JSONObject document = readConfig();
            JSONObject providers = document.optJSONObject("providers");
            if (providers == null) {
                providers = new JSONObject();
                document.put("providers", providers);
            }
            JSONObject provider = providers.optJSONObject(providerId);
            if (provider == null) provider = new JSONObject();
            provider.put("type", providerProtocol(providerId));
            provider.put("tool_protocol", providerProtocol(providerId));
            provider.put("display", providerDisplay(providerId));
            String[] declared = model.split(",");
            String selected = declared.length > 0 ? declared[0].trim() : model.trim();
            provider.put("model", TextUtils.isEmpty(selected) ? "default" : selected);
            if (!provider.has("context_window")) provider.put("context_window", 256000);
            JSONArray models = new JSONArray();
            for (String item : declared) {
                String candidate = item.trim();
                if (!TextUtils.isEmpty(candidate)) models.put(candidate);
            }
            if (models.length() > 0) provider.put("models", models);
            if (!provider.has("api_key")) provider.put("api_key", "");
            String resolvedBaseUrl = provider.optString("base_url", "");
            if (TextUtils.isEmpty(resolvedBaseUrl)) resolvedBaseUrl = defaultBaseUrl(providerId);
            if (TextUtils.isEmpty(resolvedBaseUrl)) {
                // 自定义 provider 无默认 base_url 且未显式提供时拒绝保存：
                // coomi 加载 providers.json 会对空 base_url 报 "provider `{id}` has no base_url"。
                Logger.logError(LOG_TAG, "Cannot activate provider " + providerId + ": base_url is empty");
                return false;
            }
            provider.put("base_url", resolvedBaseUrl);
            providers.put(providerId, provider);
            document.put("active", providerId);
            return writeConfig(document);
        } catch (JSONException e) {
            Logger.logError(LOG_TAG, "Cannot update provider: " + e.getMessage());
            return false;
        }
    }

    public static boolean setApiKey(String providerId, String apiKey) {
        return setApiKey(providerId, apiKey, null);
    }

    public static boolean setApiKey(String providerId, String apiKey, String baseUrl) {
        if (TextUtils.isEmpty(providerId) || TextUtils.isEmpty(apiKey)) return false;
        try {
            JSONObject document = readConfig();
            JSONObject providers = document.optJSONObject("providers");
            if (providers == null) {
                providers = new JSONObject();
                document.put("providers", providers);
            }
            JSONObject provider = providers.optJSONObject(providerId);
            if (provider == null) {
                provider = new JSONObject();
                provider.put("type", providerProtocol(providerId));
                provider.put("tool_protocol", providerProtocol(providerId));
                provider.put("display", providerDisplay(providerId));
                provider.put("model", "default");
            }
            provider.put("api_key", apiKey.trim());
            String resolvedBaseUrl = TextUtils.isEmpty(baseUrl) ? defaultBaseUrl(providerId) : baseUrl.trim();
            if (TextUtils.isEmpty(resolvedBaseUrl)) {
                // 自定义 provider 无默认 base_url 且未显式提供时拒绝保存（同 setProvider）
                Logger.logError(LOG_TAG, "Cannot save api key for " + providerId + ": base_url is empty");
                return false;
            }
            provider.put("base_url", resolvedBaseUrl);
            providers.put(providerId, provider);
            if (TextUtils.isEmpty(document.optString("active"))) document.put("active", providerId);
            return writeConfig(document);
        } catch (JSONException e) {
            Logger.logError(LOG_TAG, "Cannot update API key: " + e.getMessage());
            return false;
        }
    }

    public static String getApiKey(String providerId) {
        JSONObject provider = readConfig().optJSONObject("providers");
        provider = provider != null ? provider.optJSONObject(providerId) : null;
        return provider == null ? "" : provider.optString("api_key", "").trim();
    }

    public static boolean hasApiKey(String providerId) {
        return !TextUtils.isEmpty(getApiKey(providerId));
    }

    public static int getContextWindow(String providerId) {
        JSONObject providers = readConfig().optJSONObject("providers");
        JSONObject provider = providers == null ? null : providers.optJSONObject(providerId);
        return provider == null ? 256000 : provider.optInt("context_window", 256000);
    }

    public static boolean setContextWindow(String providerId, int contextWindow) {
        if (TextUtils.isEmpty(providerId)
            || (contextWindow != 128000 && contextWindow != 256000 && contextWindow != 512000)) {
            return false;
        }
        try {
            JSONObject document = readConfig();
            JSONObject providers = document.optJSONObject("providers");
            if (providers == null) return false;
            JSONObject provider = providers.optJSONObject(providerId);
            if (provider == null) return false;
            provider.put("context_window", contextWindow);
            providers.put(providerId, provider);
            return writeConfig(document);
        } catch (JSONException e) {
            Logger.logError(LOG_TAG, "Cannot update context window: " + e.getMessage());
            return false;
        }
    }

    public static boolean isConfigured() {
        JSONObject document = readConfig();
        String active = document.optString("active", "");
        JSONObject providers = document.optJSONObject("providers");
        JSONObject provider = providers == null ? null : providers.optJSONObject(active);
        return provider != null
            && !TextUtils.isEmpty(provider.optString("model"))
            && !TextUtils.isEmpty(provider.optString("base_url"))
            && !TextUtils.isEmpty(provider.optString("api_key"));
    }

    public static boolean isDeployComplete() {
        return CoomiService.isDeployComplete();
    }

    private static JSONObject emptyDocument() {
        JSONObject document = new JSONObject();
        try {
            document.put("active", "");
            document.put("providers", new JSONObject());
        } catch (JSONException ignored) {}
        return document;
    }

    private static String providerProtocol(String providerId) {
        switch (providerId) {
            case "anthropic": return "anthropic_messages";
            case "google":
            case "gemini": return "gemini_native";
            case "openai": return "openai_responses";
            default: return "openai_compatible";
        }
    }

    private static String providerDisplay(String providerId) {
        switch (providerId) {
            case "anthropic": return "Anthropic";
            case "google":
            case "gemini": return "Google Gemini";
            case "openai": return "OpenAI";
            case "deepseek": return "DeepSeek";
            case "zhipu": return "智谱";
            case "minimax": return "Minimax";
            default: return providerId;
        }
    }

    private static String defaultBaseUrl(String providerId) {
        switch (providerId) {
            case "anthropic": return "https://api.anthropic.com/v1";
            case "google":
            case "gemini": return "https://generativelanguage.googleapis.com/v1beta";
            case "openai": return "https://api.openai.com/v1";
            case "deepseek": return "https://api.deepseek.com/v1";
            case "zhipu": return "https://open.bigmodel.cn/api/paas/v4";
            case "minimax": return "https://api.minimaxi.com/v1";
            default: return "";
        }
    }
}
