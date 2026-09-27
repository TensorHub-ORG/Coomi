package app.coomi;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.RadioButton;
import android.widget.TextView;

import com.termux.R;

/**
 * 启动首页设置二级页面：选择打开 App 时进入控制台还是对话界面。
 * 路由生效点：CoomiLauncherActivity.checkAndRoute() 与通知栏 PendingIntent。
 */
public class CoomiHomeSettingActivity extends Activity {

    private RadioButton mRadioConsole;
    private RadioButton mRadioChat;
    private TextView mSavedText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        CoomiTheme.applyTheme(this);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_coomi_home_setting);
        CoomiTheme.applyPageSystemBars(this);

        findViewById(R.id.btn_home_back).setOnClickListener(v -> finish());

        mRadioConsole = findViewById(R.id.radio_home_console);
        mRadioChat = findViewById(R.id.radio_home_chat);
        mSavedText = findViewById(R.id.txt_home_saved);

        boolean chatHome = CoomiHomePreference.isChatHome(this);
        mRadioConsole.setChecked(!chatHome);
        mRadioChat.setChecked(chatHome);

        findViewById(R.id.btn_home_console).setOnClickListener(v -> selectRoute("console"));
        findViewById(R.id.btn_home_chat).setOnClickListener(v -> selectRoute("chat"));
    }

    private void selectRoute(String route) {
        boolean chat = "chat".equals(route);
        mRadioConsole.setChecked(!chat);
        mRadioChat.setChecked(chat);
        CoomiHomePreference.setHomeRoute(this, route);
        mSavedText.setVisibility(View.VISIBLE);
    }
}
