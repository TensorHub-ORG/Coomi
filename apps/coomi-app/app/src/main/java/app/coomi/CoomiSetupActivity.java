package app.coomi;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.fragment.app.Fragment;
import androidx.viewpager2.adapter.FragmentStateAdapter;
import androidx.viewpager2.widget.ViewPager2;

import com.termux.R;
import com.termux.shared.logger.Logger;

/**
 * Coomi setup wizard — 2 steps:
 * Step 0: Deploy the native Rust runtime
 * Step 1: Configure API Key + Provider
 */
public class CoomiSetupActivity extends AppCompatActivity {

    private static final String LOG_TAG = "CoomiSetupActivity";

    public static final String EXTRA_START_STEP = "start_step";
    public static final String EXTRA_SETTINGS_MODE = "settings_mode";
    public static final int STEP_COUNT = CoomiConstants.STEP_COUNT;

    private ViewPager2 mViewPager;
    private SetupPagerAdapter mAdapter;
    private View mNavigationBar;
    private Button mBackButton;
    private Button mNextButton;
    private TextView mStepLabel;
    private View[] mStepPills;
    private boolean mSettingsMode;

    public interface StepFragment {
        boolean handleNext();
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        CoomiTheme.applyTheme(this);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_coomi_setup);

        mViewPager = findViewById(R.id.setup_viewpager);
        mNavigationBar = findViewById(R.id.setup_nav_bar);
        mBackButton = findViewById(R.id.btn_setup_back);
        mNextButton = findViewById(R.id.btn_setup_next);
        mStepLabel = findViewById(R.id.setup_step_label);
        mStepPills = new View[]{findViewById(R.id.setup_step_1), findViewById(R.id.setup_step_2)};

        mAdapter = new SetupPagerAdapter(this);
        mViewPager.setAdapter(mAdapter);

        int startStep = getIntent().getIntExtra(EXTRA_START_STEP, CoomiConstants.STEP_DEPLOY);
        mSettingsMode = getIntent().getBooleanExtra(EXTRA_SETTINGS_MODE, false);
        mViewPager.setCurrentItem(startStep, false);

        mViewPager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
            @Override
            public void onPageSelected(int position) {
                updateNavButtons(position);
            }
        });

        mBackButton.setOnClickListener(v -> {
            int cur = mViewPager.getCurrentItem();
            if (mSettingsMode) finish();
            else if (cur > 0) mViewPager.setCurrentItem(cur - 1);
            else finish();
        });

        mNextButton.setOnClickListener(v -> {
            int cur = mViewPager.getCurrentItem();
            Fragment f = getSupportFragmentManager().findFragmentByTag("f" + cur);
            if (f instanceof StepFragment && ((StepFragment) f).handleNext()) {
                return; // Fragment handled it
            }
            if (cur < STEP_COUNT - 1) {
                mViewPager.setCurrentItem(cur + 1);
            } else {
                // All done — go to dashboard
                // 演示包没有真实部署状态可查，走完一次就记下来，下次直接进仪表盘。
                if (CoomiDemo.isEnabled()) CoomiDemo.markOnboarded(this);
                Intent intent = new Intent(this, CoomiDashboardActivity.class);
                startActivity(intent);
                finish();
            }
        });

        updateNavButtons(startStep);
    }

    private void updateNavButtons(int position) {
        mBackButton.setText(mSettingsMode || position == 0 ? R.string.coomi_setup_cancel : R.string.coomi_setup_back);
        mNextButton.setText(position == STEP_COUNT - 1 ? R.string.coomi_setup_finish : R.string.coomi_setup_next);
        if (mStepLabel != null) {
            mStepLabel.setText(getString(R.string.coomi_setup_step_label, position + 1, STEP_COUNT));
        }
        for (int i = 0; i < mStepPills.length; i++) {
            View pill = mStepPills[i];
            if (pill == null) continue;
            pill.setBackgroundResource(i <= position
                ? R.drawable.coomi_step_active
                : R.drawable.coomi_step_idle);
        }
    }

    // ── Pager Adapter ──

    private static class SetupPagerAdapter extends FragmentStateAdapter {

        SetupPagerAdapter(AppCompatActivity a) {
            super(a);
        }

        @Override
        public Fragment createFragment(int position) {
            switch (position) {
                case CoomiConstants.STEP_DEPLOY:
                    return new InstallFragment();
                case CoomiConstants.STEP_AUTH:
                    return new AuthFragment();
                default:
                    return new InstallFragment();
            }
        }

        @Override
        public int getItemCount() {
            return STEP_COUNT;
        }
    }
}
