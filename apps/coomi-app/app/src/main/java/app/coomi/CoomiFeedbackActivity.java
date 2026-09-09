package app.coomi;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.RadioGroup;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import com.termux.R;
import com.termux.shared.termux.TermuxConstants;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 问题反馈与诊断二级页面。
 * 分区：主动反馈提交（原仪表盘弹窗表单迁移至此）、反馈设置（总开关/含对话开关）、
 * 反馈记录（Outbox pending/sent、重发、清空）、诊断信息（环境快照 + 引擎日志查看/分享）、
 * 经验库（本机沉淀的 Agent 经验条目，引擎 experience 模块写入 ~/.coomi/experience/）。
 */
public class CoomiFeedbackActivity extends Activity {

    private static final int REQUEST_FEEDBACK_IMAGES = 8204;
    private static final String EXPERIENCE_DIR = TermuxConstants.TERMUX_HOME_DIR_PATH + "/.coomi/experience";
    private static final String EXPERIENCE_FILE = EXPERIENCE_DIR + "/lessons.jsonl";

    private final ArrayList<Uri> mFeedbackImageUris = new ArrayList<>();
    private TextView mFeedbackImageCount;
    private TextView mPendingText;
    private TextView mSentText;
    private TextView mEnvText;
    private TextView mExperienceText;
    private Button mSubmitButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        CoomiTheme.applyPageTheme(this);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_coomi_feedback);
        CoomiTheme.applyPageSystemBars(this);
        CoomiTheme.applyConsoleBackground(this, findViewById(android.R.id.content));

        findViewById(R.id.btn_feedback_back).setOnClickListener(v -> finish());

        // ── 主动反馈表单 ──
        mSubmitButton = findViewById(R.id.btn_feedback_submit);
        mFeedbackImageCount = findViewById(R.id.feedback_image_count);
        findViewById(R.id.feedback_add_images).setOnClickListener(v -> openFeedbackImagePicker());
        mSubmitButton.setOnClickListener(v -> submitManualFeedback());

        // ── 反馈设置 ──
        Switch master = findViewById(R.id.switch_feedback_master);
        Switch conversation = findViewById(R.id.switch_feedback_conversation);
        Switch experience = findViewById(R.id.switch_feedback_experience);
        master.setChecked(FeedbackManager.isMasterEnabled(this));
        conversation.setChecked(FeedbackManager.isIncludeConversationEnabled(this));
        experience.setChecked(readExperienceEnabled());
        master.setOnCheckedChangeListener((button, checked) -> FeedbackManager.setMasterEnabled(this, checked));
        conversation.setOnCheckedChangeListener((button, checked) -> FeedbackManager.setIncludeConversationEnabled(this, checked));
        // 经验沉淀开关由引擎侧读取（~/.coomi/config/experience.json），这里直接写同一文件。
        experience.setOnCheckedChangeListener((button, checked) -> writeExperienceEnabled(checked));

        // ── 反馈记录 ──
        mPendingText = findViewById(R.id.txt_feedback_pending);
        mSentText = findViewById(R.id.txt_feedback_sent);
        findViewById(R.id.btn_feedback_retry).setOnClickListener(v -> {
            int sent = FeedbackManager.retryAll(this);
            Toast.makeText(this, sent > 0
                ? getString(R.string.coomi_feedback_done) + "（" + sent + "）"
                : getString(R.string.coomi_feedback_no_records), Toast.LENGTH_SHORT).show();
            refreshRecords();
        });
        findViewById(R.id.btn_feedback_clear).setOnClickListener(v -> new AlertDialog.Builder(this)
            .setTitle(R.string.coomi_feedback_clear_records)
            .setMessage("将删除本机保存的待发送与已发送反馈记录（不影响已发送到服务器的部分）。")
            .setPositiveButton(R.string.coomi_feedback_clear_records, (dialog, which) -> {
                FeedbackManager.clearAll(this);
                Toast.makeText(this, R.string.coomi_feedback_cleared, Toast.LENGTH_SHORT).show();
                refreshRecords();
            })
            .setNegativeButton(R.string.coomi_feedback_cancel, null)
            .show());

        // ── 诊断信息 ──
        mEnvText = findViewById(R.id.txt_feedback_env);
        findViewById(R.id.btn_feedback_view_log).setOnClickListener(v -> showEngineLogDialog());
        findViewById(R.id.btn_feedback_share_log).setOnClickListener(v -> shareEngineLog());

        // ── 经验库 ──
        mExperienceText = findViewById(R.id.txt_experience_summary);
        findViewById(R.id.btn_experience_view).setOnClickListener(v -> showExperienceDialog());
        findViewById(R.id.btn_experience_clear).setOnClickListener(v -> new AlertDialog.Builder(this)
            .setTitle(R.string.coomi_experience_clear)
            .setMessage("将删除本机沉淀的全部经验条目。清空后 Agent 需要重新试错积累。")
            .setPositiveButton(R.string.coomi_experience_clear, (dialog, which) -> {
                new File(EXPERIENCE_FILE).delete();
                Toast.makeText(this, R.string.coomi_feedback_cleared, Toast.LENGTH_SHORT).show();
                refreshExperience();
            })
            .setNegativeButton(R.string.coomi_feedback_cancel, null)
            .show());
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshRecords();
        refreshEnvironment();
        refreshExperience();
    }

    // ── 主动反馈提交（自仪表盘弹窗迁移，走统一 FeedbackManager 管道） ──

    private void submitManualFeedback() {
        EditText messageInput = findViewById(R.id.feedback_message);
        EditText contactInput = findViewById(R.id.feedback_contact);
        RadioGroup typeInput = findViewById(R.id.feedback_type);
        String message = messageInput.getText().toString().trim();
        if (message.isEmpty()) {
            messageInput.setError(getString(R.string.coomi_feedback_message_required));
            messageInput.requestFocus();
            return;
        }
        String kind = typeInput.getCheckedRadioButtonId() == R.id.feedback_type_issue
            ? "issue" : "suggestion";
        mSubmitButton.setEnabled(false);
        mSubmitButton.setText(R.string.coomi_feedback_sending);
        final String contact = contactInput.getText().toString().trim();
        new Thread(() -> {
            List<CoomiFeedbackClient.Attachment> attachments = new ArrayList<>();
            boolean imagesFailed = false;
            try {
                for (int index = 0; index < mFeedbackImageUris.size() && index < 3; index++) {
                    attachments.add(new CoomiFeedbackClient.Attachment(
                        "feedback-" + (index + 1) + ".jpg", "image/jpeg",
                        compressFeedbackImage(mFeedbackImageUris.get(index))));
                }
            } catch (Exception error) {
                imagesFailed = true;
            }
            JSONObject payload = FeedbackManager.basePayload("manual");
            String status = "";
            try {
                payload.put("type", kind);
                payload.put("message", message);
                payload.put("contact", contact);
                payload.put("reasoning_statistics", readReasoningStatistics());
                payload.put("source", "android_diagnostics_page");
            } catch (Exception ignored) {}
            String result = FeedbackManager.submit(this, payload, attachments);
            boolean ok = false;
            try {
                JSONObject parsed = new JSONObject(result);
                ok = parsed.optBoolean("ok", false);
                status = parsed.optString("status");
            } catch (Exception ignored) {}
            final boolean submitted = ok;
            final boolean imagesBroken = imagesFailed;
            final boolean queued = "queued".equals(status);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                mSubmitButton.setEnabled(true);
                mSubmitButton.setText(R.string.coomi_feedback_submit);
                if (submitted) {
                    Toast.makeText(this, queued
                        ? R.string.coomi_feedback_queued : R.string.coomi_feedback_sent,
                        Toast.LENGTH_LONG).show();
                    if (imagesBroken) {
                        Toast.makeText(this, R.string.coomi_feedback_images_failed, Toast.LENGTH_SHORT).show();
                    }
                    messageInput.setText("");
                    contactInput.setText("");
                    mFeedbackImageUris.clear();
                    mFeedbackImageCount.setText(R.string.coomi_feedback_no_images);
                    refreshRecords();
                } else {
                    Toast.makeText(this, R.string.coomi_feedback_failed, Toast.LENGTH_LONG).show();
                }
            });
        }, "coomi-feedback-manual").start();
    }

    private void openFeedbackImagePicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, REQUEST_FEEDBACK_IMAGES);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FEEDBACK_IMAGES || resultCode != RESULT_OK || data == null) return;
        mFeedbackImageUris.clear();
        if (data.getClipData() != null) {
            int count = Math.min(3, data.getClipData().getItemCount());
            for (int index = 0; index < count; index++) {
                mFeedbackImageUris.add(data.getClipData().getItemAt(index).getUri());
            }
        } else if (data.getData() != null) {
            mFeedbackImageUris.add(data.getData());
        }
        if (mFeedbackImageCount != null) {
            mFeedbackImageCount.setText(getString(R.string.coomi_feedback_image_count, mFeedbackImageUris.size()));
        }
    }

    private byte[] compressFeedbackImage(Uri uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            BitmapFactory.decodeStream(input, null, bounds);
        }
        int sample = 1;
        while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > 2400) sample *= 2;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        Bitmap bitmap;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            bitmap = BitmapFactory.decodeStream(input, null, options);
        }
        if (bitmap == null) throw new IllegalArgumentException("unsupported image");
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        float scale = Math.min(1f, 1600f / Math.max(width, height));
        Bitmap resized = scale < 1f
            ? Bitmap.createScaledBitmap(bitmap, Math.round(width * scale), Math.round(height * scale), true)
            : bitmap;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int quality = 80;
        do {
            output.reset();
            resized.compress(Bitmap.CompressFormat.JPEG, quality, output);
            quality -= 10;
        } while (output.size() > 2 * 1024 * 1024 && quality >= 40);
        if (resized != bitmap) resized.recycle();
        bitmap.recycle();
        if (output.size() > 2 * 1024 * 1024) throw new IllegalArgumentException("image exceeds 2 MB");
        return output.toByteArray();
    }

    private JSONObject readReasoningStatistics() {
        File file = new File(TermuxConstants.TERMUX_HOME_DIR_PATH, ".coomi/usage/summary.json");
        try {
            if (!file.isFile()) return new JSONObject();
            byte[] bytes = readFileBytes(file);
            JSONObject document = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            JSONObject totals = document.optJSONObject("efforts");
            return totals == null ? document : totals;
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    // ── 反馈记录 ──

    private void refreshRecords() {
        int pending = FeedbackManager.pendingCount(this);
        JSONArray sent = FeedbackManager.listRecords(this, false);
        mPendingText.setText(pending > 0
            ? getString(R.string.coomi_feedback_pending_count, pending)
            : getString(R.string.coomi_feedback_no_records));
        mSentText.setText(sent.length() > 0
            ? getString(R.string.coomi_feedback_records_done, sent.length()) : "");
    }

    // ── 诊断信息 ──

    private void refreshEnvironment() {
        try {
            JSONObject environment = new JSONObject();
            environment.put("version", com.termux.BuildConfig.VERSION_NAME
                + " (" + com.termux.BuildConfig.VERSION_CODE + ")");
            File marker = new File(CoomiConstants.INSTALL_MARKER_PATH);
            environment.put("engine_deployed", marker.isFile());
            environment.put("runtime_v2", new File(CoomiConstants.RUNTIME_V2_ROOTFS_PATH).isFile()
                ? "ready" : "not ready");
            environment.put("storage_free_mb", getFilesDir().getUsableSpace() / (1024 * 1024));
            environment.put("pending_feedback", FeedbackManager.pendingCount(this));
            StringBuilder builder = new StringBuilder();
            builder.append("version: ").append(environment.opt("version")).append('\n')
                .append("engine_deployed: ").append(environment.opt("engine_deployed")).append('\n')
                .append("runtime_v2: ").append(environment.opt("runtime_v2")).append('\n')
                .append("storage_free_mb: ").append(environment.opt("storage_free_mb")).append('\n')
                .append("pending_feedback: ").append(environment.opt("pending_feedback"));
            mEnvText.setText(builder.toString());
        } catch (Exception ignored) {
            mEnvText.setText("");
        }
    }

    private void showEngineLogDialog() {
        new Thread(() -> {
            final String tail = FeedbackManager.engineLogTail();
            final String content = tail.isEmpty() ? "（暂无引擎日志）" : tail;
            runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle(R.string.coomi_feedback_view_log)
                .setMessage(content.length() > 4000 ? content.substring(content.length() - 4000) : content)
                .setPositiveButton(R.string.coomi_backup_ok, null)
                .show());
        }, "coomi-feedback-log").start();
    }

    private void shareEngineLog() {
        new Thread(() -> {
            String tail = FeedbackManager.engineLogTail();
            if (tail.isEmpty()) {
                runOnUiThread(() -> Toast.makeText(this,
                    "暂无引擎日志", Toast.LENGTH_SHORT).show());
                return;
            }
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/plain");
            intent.putExtra(Intent.EXTRA_SUBJECT, "Coomi 引擎日志");
            intent.putExtra(Intent.EXTRA_TEXT, tail.length() > 8000 ? tail.substring(tail.length() - 8000) : tail);
            try {
                startActivity(Intent.createChooser(intent, getString(R.string.coomi_feedback_share_log)));
            } catch (Exception ignored) {
            }
        }, "coomi-feedback-log").start();
    }

    // ── 经验库（引擎 experience 模块写入 ~/.coomi/experience/lessons.jsonl） ──

    private static final String EXPERIENCE_ENABLED_FILE =
        TermuxConstants.TERMUX_HOME_DIR_PATH + "/.coomi/config/experience.json";

    private boolean readExperienceEnabled() {
        try {
            File file = new File(EXPERIENCE_ENABLED_FILE);
            if (!file.isFile()) return true; // 默认开
            JSONObject document = new JSONObject(new String(readFileBytes(file), StandardCharsets.UTF_8));
            return document.optBoolean("enabled", true);
        } catch (Exception ignored) {
            return true;
        }
    }

    private void writeExperienceEnabled(boolean enabled) {
        try {
            File file = new File(EXPERIENCE_ENABLED_FILE);
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return;
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(new JSONObject()
                    .put("enabled", enabled).toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
        }
    }

    private void refreshExperience() {
        new Thread(() -> {
            final JSONArray lessons = readExperience();
            runOnUiThread(() -> {
                if (lessons.length() == 0) {
                    mExperienceText.setText(R.string.coomi_experience_empty);
                } else {
                    mExperienceText.setText(getString(R.string.coomi_experience_count, lessons.length()));
                }
            });
        }, "coomi-experience-read").start();
    }

    private JSONArray readExperience() {
        JSONArray lessons = new JSONArray();
        try {
            File file = new File(EXPERIENCE_FILE);
            if (!file.isFile()) return lessons;
            byte[] bytes = readFileBytes(file);
            for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
                line = line.trim();
                if (line.isEmpty()) continue;
                try {
                    lessons.put(new JSONObject(line));
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        return lessons;
    }

    private void showExperienceDialog() {
        new Thread(() -> {
            JSONArray lessons = readExperience();
            StringBuilder builder = new StringBuilder();
            for (int index = 0; index < lessons.length(); index++) {
                JSONObject lesson = lessons.optJSONObject(index);
                if (lesson == null) continue;
                builder.append('[').append(lesson.optString("category", "通用")).append("] ")
                    .append(lesson.optString("symptom", "")).append('\n')
                    .append("→ ").append(lesson.optString("resolution", "")).append("\n\n");
            }
            final String content = builder.length() == 0
                ? getString(R.string.coomi_experience_empty) : builder.toString();
            runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle(R.string.coomi_feedback_sec_experience)
                .setMessage(content.length() > 4000 ? content.substring(0, 4000) + "…" : content)
                .setPositiveButton(R.string.coomi_backup_ok, null)
                .show());
        }, "coomi-experience-read").start();
    }

    // ── 工具 ──

    private static byte[] readFileBytes(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }
}
