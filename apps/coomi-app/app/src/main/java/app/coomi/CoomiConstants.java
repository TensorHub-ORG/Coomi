package app.coomi;

import com.termux.BuildConfig;
import com.termux.shared.termux.TermuxConstants;

public final class CoomiConstants {

    private CoomiConstants() {}

    // Coomi config directory ~/.coomi/
    public static final String COOMI_CONFIG_DIR = TermuxConstants.TERMUX_HOME_DIR_PATH + "/.coomi";
    public static final String COOMI_PROVIDER_FILE = COOMI_CONFIG_DIR + "/config/providers.json";

    // Engine
    public static final int DEFAULT_ENGINE_PORT = BuildConfig.COOMI_DEFAULT_ENGINE_PORT;
    public static final String HEALTH_ENDPOINT = "/api/runtime/health";
    public static final int ENGINE_HEALTH_TIMEOUT_MS = 2000;
    public static final int ENGINE_START_TIMEOUT_SEC = 180;

    /** Candidate ports tried in order when the default is taken. */
    public static final int[] PORT_CANDIDATES = BuildConfig.COOMI_DEV_BUILD
        ? new int[]{18765, 18766, 18767, 8765, 8766}
        : new int[]{8765, 8766, 8767, 18765, 18766};

    /** Marker written to $HOME once install.sh completed successfully. */
    public static final String INSTALL_MARKER_PATH = TermuxConstants.TERMUX_HOME_DIR_PATH + "/.coomi_deployed";
    /** Engine stdout/stderr log, tailed by the launcher UI for progress. */
    public static final String ENGINE_LOG_PATH = TermuxConstants.TERMUX_HOME_DIR_PATH + "/coomi.log";

    // Notification
    public static final String NOTIFICATION_CHANNEL_ID = "coomi_engine";
    public static final String NOTIFICATION_CHANNEL_NAME = "Coomi Engine";
    /** User-visible updates for background and long-running tasks. */
    public static final String TASK_NOTIFICATION_CHANNEL_ID = "coomi_tasks";
    public static final String TASK_NOTIFICATION_CHANNEL_NAME = "Coomi Tasks";
    public static final int NOTIFICATION_ID = 1001;

    // Bootstrap / Rust runtime
    public static final String WEB_ASSET = "web.zip";
    public static final String WEB_DIR_BASENAME = "web";
    public static final String RUNTIME_V2_MANIFEST_ASSET = "runtime-v2-manifest.json";
    public static final String RUNTIME_V2_MANIFEST_PATH = COOMI_CONFIG_DIR + "/config/runtime-v2-manifest.json";
    public static final String RUNTIME_V2_HOST_ASSET = "runtime-v2/proot-host-arm64.tgz";
    public static final String RUNTIME_V2_ROOTFS_ASSET = "runtime-v2/ubuntu-noble-arm64.tgz";
    public static final String RUNTIME_V2_DOWNLOAD_DIR = COOMI_CONFIG_DIR + "/runtime-v2/downloads";
    public static final String RUNTIME_V2_HOST_PATH = RUNTIME_V2_DOWNLOAD_DIR + "/proot-host-arm64.tar.gz";
    public static final String RUNTIME_V2_ROOTFS_PATH = RUNTIME_V2_DOWNLOAD_DIR + "/ubuntu-rootfs-arm64.tar.gz";
    public static final String NATIVE_BINARY_NAME = "libcoomi.so";
    public static final String COOMI_SHARED_ROOT = TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/share/coomi";
    public static final String COOMI_OFFLINE_ROOT = COOMI_SHARED_ROOT + "/offline";

    // Workspace
    public static final String COOMI_WORKSPACE = TermuxConstants.TERMUX_HOME_DIR_PATH + "/coomi";
    public static final String COOMI_INBOX = COOMI_WORKSPACE + "/inbox";

    // Steps
    public static final int STEP_DEPLOY = 0;
    public static final int STEP_AUTH = 1;
    public static final int STEP_COUNT = 2;
}
