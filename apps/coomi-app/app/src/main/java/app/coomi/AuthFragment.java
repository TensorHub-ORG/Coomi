package app.coomi;

import android.os.Bundle;
import android.text.TextUtils;
import android.text.method.PasswordTransformationMethod;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.RadioGroup;
import android.widget.Spinner;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.StringRes;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;

import com.termux.R;
import com.termux.shared.logger.Logger;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Step 1: Choose AI provider + enter API Key.
 */
public class AuthFragment extends Fragment implements CoomiSetupActivity.StepFragment {

    private static final String LOG_TAG = "AuthFragment";

    private RadioGroup mProviderGroup;
    private EditText mApiKeyInput;
    private EditText mModelInput;
    private EditText mBaseUrlInput;
    private Spinner mContextWindowInput;
    private View mCustomFields;
    private Button mVerifyButton;
    private Button mDiscoverButton;
    private TextView mStatusText;
    private ImageButton mToggleKeyButton;

    private boolean mKeyVisible = false;
    private String mSelectedProvider = "deepseek";

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        View v = inflater.inflate(R.layout.fragment_coomi_auth, container, false);

        mProviderGroup = v.findViewById(R.id.auth_provider_group);
        mApiKeyInput = v.findViewById(R.id.auth_api_key);
        mModelInput = v.findViewById(R.id.auth_model);
        mBaseUrlInput = v.findViewById(R.id.auth_base_url);
        mContextWindowInput = v.findViewById(R.id.auth_context_window);
        mCustomFields = v.findViewById(R.id.auth_custom_fields);
        mVerifyButton = v.findViewById(R.id.btn_verify_key);
        mDiscoverButton = v.findViewById(R.id.btn_discover_models);
        mStatusText = v.findViewById(R.id.auth_status);
        mToggleKeyButton = v.findViewById(R.id.btn_toggle_key);

        mProviderGroup.setOnCheckedChangeListener((group, checkedId) -> {
            if (checkedId == R.id.provider_deepseek) {
                mSelectedProvider = "deepseek";
                mCustomFields.setVisibility(View.GONE);
                mModelInput.setText("deepseek-chat");
            } else if (checkedId == R.id.provider_zhipu) {
                mSelectedProvider = "zhipu";
                mCustomFields.setVisibility(View.GONE);
                mModelInput.setText("glm-4.5");
            } else if (checkedId == R.id.provider_minimax) {
                mSelectedProvider = "minimax";
                mCustomFields.setVisibility(View.GONE);
                mModelInput.setText("MiniMax-M2.7");
            } else if (checkedId == R.id.provider_openai) {
                mSelectedProvider = "openai";
                mCustomFields.setVisibility(View.GONE);
                mModelInput.setText("gpt-4o");
            } else if (checkedId == R.id.provider_anthropic) {
                mSelectedProvider = "anthropic";
                mCustomFields.setVisibility(View.GONE);
                mModelInput.setText("claude-sonnet-4-5");
            } else if (checkedId == R.id.provider_gemini) {
                mSelectedProvider = "google";
                mCustomFields.setVisibility(View.GONE);
                mModelInput.setText("gemini-2.0-flash");
            } else if (checkedId == R.id.provider_custom) {
                mSelectedProvider = "custom";
                mCustomFields.setVisibility(View.VISIBLE);
                mModelInput.setText("");
            }
        });

        mVerifyButton.setOnClickListener(v2 -> verifyAndSave());
        mDiscoverButton.setOnClickListener(v2 -> discoverModels());
        mToggleKeyButton.setOnClickListener(v2 -> toggleKeyVisibility());
        mContextWindowInput.setSelection(1);

        // XML 里默认勾选 DeepSeek，但 setOnCheckedChangeListener 不会为初始态回调，
        // 所以这里补上默认模型名，避免模型框空着。
        if (TextUtils.isEmpty(mModelInput.getText())) {
            mModelInput.setText("deepseek-chat");
        }

        // 演示包：不需要凭据，也不往配置里写任何东西。
        if (CoomiDemo.isEnabled()) {
            mApiKeyInput.setHint(R.string.coomi_demo_auth_hint);
            mVerifyButton.setText(R.string.coomi_demo_auth_button);
            setStatus(R.string.coomi_demo_auth_status, R.color.coomi_text_2);
        }

        return v;
    }

    private void discoverModels() {
        String key = mApiKeyInput.getText().toString().trim();
        if (TextUtils.isEmpty(key)) key = CoomiConfig.getApiKey(mSelectedProvider);
        if (TextUtils.isEmpty(key)) {
            setStatus(R.string.coomi_auth_need_key, R.color.coomi_danger);
            return;
        }
        final String apiKey = key;
        String customBase = mBaseUrlInput.getText().toString().trim();
        final String base = TextUtils.isEmpty(customBase) ? defaultBaseUrl(mSelectedProvider) : customBase;
        if (TextUtils.isEmpty(base)) {
            setStatus(R.string.coomi_auth_need_base_url, R.color.coomi_danger);
            return;
        }
        mDiscoverButton.setEnabled(false);
        setStatus(R.string.coomi_auth_discovering, R.color.coomi_text_2);
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                String endpoint = base.replaceAll("/+$", "") + "/models";
                if ("google".equals(mSelectedProvider)) endpoint += "?key=" + apiKey;
                connection = (HttpURLConnection) new URL(endpoint).openConnection();
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept", "application/json");
                if ("anthropic".equals(mSelectedProvider)) {
                    connection.setRequestProperty("x-api-key", apiKey);
                    connection.setRequestProperty("anthropic-version", "2023-06-01");
                } else if (!"google".equals(mSelectedProvider)) {
                    connection.setRequestProperty("Authorization", "Bearer " + apiKey);
                }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
                BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
                StringBuilder body = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
                JSONObject response = new JSONObject(body.toString());
                JSONArray entries = response.optJSONArray("data");
                if (entries == null) entries = response.optJSONArray("models");
                if (entries == null || entries.length() == 0) throw new IllegalStateException("未返回可用模型");
                StringBuilder models = new StringBuilder();
                for (int i = 0; i < entries.length(); i++) {
                    JSONObject entry = entries.optJSONObject(i);
                    if (entry == null) continue;
                    String model = entry.optString("id", entry.optString("name", ""));
                    if (model.startsWith("models/")) model = model.substring(7);
                    if (TextUtils.isEmpty(model)) continue;
                    if (models.length() > 0) models.append(", ");
                    models.append(model);
                }
                final String result = models.toString();
                if (TextUtils.isEmpty(result)) throw new IllegalStateException("未返回可用模型");
                requireActivity().runOnUiThread(() -> {
                    mModelInput.setText(result);
                    setStatus(R.string.coomi_auth_discovered, R.color.coomi_ok);
                });
            } catch (Exception error) {
                Logger.logError(LOG_TAG, "Model discovery failed: " + error.getMessage());
                if (getActivity() != null) requireActivity().runOnUiThread(() -> {
                    mStatusText.setTextColor(ContextCompat.getColor(requireContext(), R.color.coomi_danger));
                    mStatusText.setText(getString(R.string.coomi_auth_discover_failed, error.getMessage()));
                });
            } finally {
                if (connection != null) connection.disconnect();
                if (getActivity() != null) requireActivity().runOnUiThread(() -> mDiscoverButton.setEnabled(true));
            }
        }, "coomi-model-discovery").start();
    }

    private static String defaultBaseUrl(String providerId) {
        switch (providerId) {
            case "anthropic": return "https://api.anthropic.com/v1";
            case "google": return "https://generativelanguage.googleapis.com/v1beta";
            case "openai": return "https://api.openai.com/v1";
            case "deepseek": return "https://api.deepseek.com/v1";
            case "zhipu": return "https://open.bigmodel.cn/api/paas/v4";
            case "minimax": return "https://api.minimaxi.com/v1";
            default: return "";
        }
    }

    private void toggleKeyVisibility() {
        mKeyVisible = !mKeyVisible;
        mApiKeyInput.setTransformationMethod(
            mKeyVisible ? null : PasswordTransformationMethod.getInstance());
        mToggleKeyButton.setImageResource(
            mKeyVisible ? R.drawable.coomi_ic_eye_off : R.drawable.coomi_ic_eye);
        mToggleKeyButton.setColorFilter(ContextCompat.getColor(mToggleKeyButton.getContext(),
            mKeyVisible ? themeColor(R.color.coomi_blue) : themeColor(R.color.coomi_text_3)));
        mApiKeyInput.setSelection(mApiKeyInput.getText().length());
    }

    /** 浅色资源色 -> 当前主题（暗色时换夜间色板）。 */
    private int themeColor(int lightRes) {
        if (!CoomiTheme.isDark(requireActivity())) {
            return lightRes;
        }
        if (lightRes == R.color.coomi_text_2) return R.color.coomi_night_text_2;
        if (lightRes == R.color.coomi_text_3) return R.color.coomi_night_text_3;
        if (lightRes == R.color.coomi_blue) return R.color.coomi_night_blue;
        if (lightRes == R.color.coomi_ok) return R.color.coomi_night_ok;
        if (lightRes == R.color.coomi_danger) return R.color.coomi_night_danger;
        return lightRes;
    }

    /** 状态文案不再靠 (v) / (x) 符号，改用颜色表达。 */
    private void setStatus(@StringRes int textRes, int colorRes) {
        mStatusText.setTextColor(ContextCompat.getColor(mStatusText.getContext(), themeColor(colorRes)));
        mStatusText.setText(textRes);
    }

    private void verifyAndSave() {
        // 演示包不落盘：这里写进去的 key 谁也不会用，还得管它的安全。
        if (CoomiDemo.isEnabled()) {
            setStatus(R.string.coomi_demo_auth_status, R.color.coomi_text_2);
            return;
        }

        String apiKey = mApiKeyInput.getText().toString().trim();
        if (TextUtils.isEmpty(apiKey)) {
            setStatus(R.string.coomi_auth_need_key, R.color.coomi_danger);
            return;
        }

        String model = mModelInput.getText().toString().trim();
        if (TextUtils.isEmpty(model)) {
            model = "default";
        }

        String baseUrl = mBaseUrlInput.getText().toString().trim();

        // 自定义 provider 没有默认 base_url，必须显式填写，否则保存会产生
        // coomi 无法加载的配置（"provider `custom` has no base_url"）。
        if (TextUtils.isEmpty(baseUrl) && TextUtils.isEmpty(defaultBaseUrl(mSelectedProvider))) {
            setStatus(R.string.coomi_auth_need_base_url, R.color.coomi_danger);
            return;
        }

        setStatus(R.string.coomi_auth_saving, R.color.coomi_text_2);

        // Save provider + model to config
        boolean configOk = CoomiConfig.setProvider(mSelectedProvider, model);
        if (configOk) {
            int[] windows = {128000, 256000, 512000};
            int selected = Math.max(0, Math.min(mContextWindowInput.getSelectedItemPosition(), windows.length - 1));
            configOk = CoomiConfig.setContextWindow(mSelectedProvider, windows[selected]);
        }

        // Save API key
        boolean keyOk;
        if (!TextUtils.isEmpty(baseUrl)) {
            keyOk = CoomiConfig.setApiKey(mSelectedProvider, apiKey, baseUrl);
        } else {
            keyOk = CoomiConfig.setApiKey(mSelectedProvider, apiKey);
        }

        if (configOk && keyOk) {
            setStatus(R.string.coomi_auth_saved, R.color.coomi_ok);
            Logger.logInfo(LOG_TAG, "Auth saved: " + mSelectedProvider + "/" + model);
        } else {
            setStatus(R.string.coomi_auth_save_failed, R.color.coomi_danger);
        }
    }

    @Override
    public boolean handleNext() {
        // 演示包无条件放行：没有 key 也能「完成」。
        if (CoomiDemo.isEnabled()) return false;
        // Ensure at least API key was entered
        if (CoomiConfig.hasApiKey(mSelectedProvider) || !TextUtils.isEmpty(mApiKeyInput.getText())) {
            // Save if not already saved
            if (!CoomiConfig.hasApiKey(mSelectedProvider)) {
                verifyAndSave();
            }
            return false; // let activity advance
        }
        setStatus(R.string.coomi_auth_need_key, R.color.coomi_danger);
        return true; // block
    }
}
