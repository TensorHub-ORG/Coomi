package app.coomi;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.text.method.ScrollingMovementMethod;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;

import com.termux.R;
import com.termux.app.TermuxInstaller;

import java.io.File;

/** Setup step that installs the Termux base, coomi-rs binary and Vue frontend. */
public class InstallFragment extends Fragment implements CoomiSetupActivity.StepFragment {

    private static final int PHASE_IDLE = 0;
    private static final int PHASE_RUNNING = 1;
    private static final int PHASE_DONE = 2;
    private static final int PHASE_BASE = 0;
    private static final int PHASE_RUNTIME = 1;
    private static final int PHASE_ENGINE = 2;

    private final View[][] mPhaseViews = new View[3][3];
    private final int[] mPhaseTitleRes = {
        R.string.coomi_install_phase_base,
        R.string.coomi_install_phase_runtime,
        R.string.coomi_install_phase_engine,
    };

    private TextView mStepStatus;
    private TextView mProgressText;
    private View mRetryContainer;
    private View mProgressContainer;
    private TextView mErrorDetail;
    private ProgressBar mStatusSpinner;
    private ImageView mStatusCheck;
    private CoomiService mCoomiService;
    private boolean mBound;
    private boolean mDeployStarted;
    private int mCurrentPhase = PHASE_BASE;

    private final ServiceConnection mConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            mCoomiService = ((CoomiService.LocalBinder) service).getService();
            mBound = true;
            if (!mDeployStarted) startDeploy();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            mCoomiService = null;
            mBound = false;
        }
    };

    @Nullable
    @Override
    public View onCreateView(
        @NonNull LayoutInflater inflater,
        @Nullable ViewGroup container,
        @Nullable Bundle savedInstanceState
    ) {
        View view = inflater.inflate(R.layout.fragment_coomi_install, container, false);
        mStepStatus = view.findViewById(R.id.install_step_status);
        mProgressText = view.findViewById(R.id.install_progress_text);
        mRetryContainer = view.findViewById(R.id.install_retry_container);
        mProgressContainer = view.findViewById(R.id.install_progress_container);
        mErrorDetail = view.findViewById(R.id.install_error_detail);
        mStatusSpinner = view.findViewById(R.id.install_status_spinner);
        mStatusCheck = view.findViewById(R.id.install_status_check);

        mPhaseViews[PHASE_BASE] = phaseViews(view, R.id.install_p1_ring, R.id.install_p1_spinner, R.id.install_p1_check);
        mPhaseViews[PHASE_RUNTIME] = phaseViews(view, R.id.install_p2_ring, R.id.install_p2_spinner, R.id.install_p2_check);
        mPhaseViews[PHASE_ENGINE] = phaseViews(view, R.id.install_p3_ring, R.id.install_p3_spinner, R.id.install_p3_check);

        view.findViewById(R.id.btn_install_retry).setOnClickListener(ignored -> {
            if (CoomiDemo.isEnabled()) {
                showDemoSkipped();
                return;
            }
            mDeployStarted = false;
            resetProgressUi();
            startDeploy();
        });
        if (CoomiDemo.isEnabled()) showDemoSkipped();
        return view;
    }

    private static View[] phaseViews(View root, int ring, int spinner, int check) {
        return new View[]{root.findViewById(ring), root.findViewById(spinner), root.findViewById(check)};
    }

    @Override
    public void onStart() {
        super.onStart();
        if (CoomiDemo.isEnabled()) return;
        Intent intent = new Intent(requireContext(), CoomiService.class);
        requireContext().startService(intent);
        requireContext().bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
    }

    @Override
    public void onStop() {
        if (mBound) {
            requireContext().unbindService(mConnection);
            mBound = false;
        }
        super.onStop();
    }

    private void startDeploy() {
        if (mDeployStarted || !mBound) return;
        mDeployStarted = true;
        Activity activity = getActivity();
        if (activity == null) return;
        enterPhase(PHASE_BASE);
        if (!CoomiService.isBootstrapInstalled()) {
            mProgressText.setText(R.string.coomi_install_phase_base_desc);
            TermuxInstaller.setupBootstrapIfNeeded(activity, this::deployRuntime);
        } else {
            deployRuntime();
        }
    }

    private void deployRuntime() {
        Activity activity = getActivity();
        if (activity == null) return;
        new Thread(() -> {
            try {
                File webDir = new File(activity.getFilesDir(), CoomiConstants.WEB_DIR_BASENAME);
                CoomiBootstrap.deleteRecursive(webDir);
                int extracted = CoomiBootstrap.deployZipAsset(
                    activity, CoomiConstants.WEB_ASSET, webDir);
                if (extracted < 1 || !new File(webDir, "index.html").isFile()) {
                    throw new IllegalStateException("web.zip 部署失败");
                }
                activity.runOnUiThread(() -> {
                    enterPhase(PHASE_RUNTIME);
                    mProgressText.setText("部署 coomi-rs ARM64 二进制");
                });
                mCoomiService.deployCoomi(new CoomiService.ProgressCallback() {
                    @Override
                    public void onStep(String message) {
                        activity.runOnUiThread(() -> {
                            if (message.contains("校验") || message.startsWith("coomi ")) {
                                enterPhase(PHASE_ENGINE);
                            }
                            mProgressText.setText(message);
                        });
                    }

                    @Override
                    public void onError(String error) {
                        activity.runOnUiThread(() -> showError(error));
                    }

                    @Override
                    public void onComplete() {
                        activity.runOnUiThread(InstallFragment.this::showDone);
                    }
                });
            } catch (Exception e) {
                activity.runOnUiThread(() -> showError(e.getMessage()));
            }
        }, "coomi-native-deploy").start();
    }

    private void setPhase(int phase, int state) {
        View[] views = mPhaseViews[phase];
        views[0].setVisibility(state == PHASE_IDLE ? View.VISIBLE : View.GONE);
        views[1].setVisibility(state == PHASE_RUNNING ? View.VISIBLE : View.GONE);
        views[2].setVisibility(state == PHASE_DONE ? View.VISIBLE : View.GONE);
    }

    private void enterPhase(int phase) {
        mCurrentPhase = phase;
        for (int i = 0; i < mPhaseViews.length; i++) {
            setPhase(i, i < phase ? PHASE_DONE : (i == phase ? PHASE_RUNNING : PHASE_IDLE));
        }
        mStepStatus.setText(getString(
            R.string.coomi_install_running, getString(mPhaseTitleRes[phase])));
    }

    private void resetProgressUi() {
        mRetryContainer.setVisibility(View.GONE);
        mErrorDetail.setVisibility(View.GONE);
        mProgressContainer.setVisibility(View.VISIBLE);
        mStatusSpinner.setVisibility(View.VISIBLE);
        mStatusCheck.setVisibility(View.GONE);
        mStepStatus.setTextColor(ContextCompat.getColor(requireContext(), R.color.coomi_blue));
        mStepStatus.setText(R.string.coomi_install_waiting);
        mProgressText.setText("");
        enterPhase(PHASE_BASE);
    }

    private void showDone() {
        for (int i = 0; i < mPhaseViews.length; i++) setPhase(i, PHASE_DONE);
        mStatusSpinner.setVisibility(View.GONE);
        mStatusCheck.setVisibility(View.VISIBLE);
        mStepStatus.setTextColor(ContextCompat.getColor(requireContext(),
            CoomiTheme.isDark(requireActivity()) ? R.color.coomi_night_ok : R.color.coomi_ok));
        mStepStatus.setText(R.string.coomi_install_done_title);
        mProgressText.setText(R.string.coomi_install_done_desc);
    }

    private void showError(String message) {
        setPhase(mCurrentPhase, PHASE_IDLE);
        mProgressContainer.setVisibility(View.GONE);
        mRetryContainer.setVisibility(View.VISIBLE);
        mErrorDetail.setText(message == null ? getString(R.string.coomi_install_unknown_error) : message);
        mErrorDetail.setVisibility(View.VISIBLE);
        mErrorDetail.setMovementMethod(new ScrollingMovementMethod());
    }

    private void showDemoSkipped() {
        for (int i = 0; i < mPhaseViews.length; i++) setPhase(i, PHASE_DONE);
        mRetryContainer.setVisibility(View.GONE);
        mErrorDetail.setVisibility(View.GONE);
        mProgressContainer.setVisibility(View.VISIBLE);
        mStatusSpinner.setVisibility(View.GONE);
        mStatusCheck.setVisibility(View.VISIBLE);
        mStepStatus.setTextColor(ContextCompat.getColor(requireContext(),
            CoomiTheme.isDark(requireActivity()) ? R.color.coomi_night_ok : R.color.coomi_ok));
        mStepStatus.setText(R.string.coomi_demo_install_title);
        mProgressText.setText(R.string.coomi_demo_install_desc);
    }

    @Override
    public boolean handleNext() {
        return !CoomiDemo.isEnabled() && !CoomiService.isDeployComplete();
    }
}
