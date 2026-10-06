package app.coomi;

import android.util.Log;

/**
 * DeepSeek 官方 PoW 求解器。
 *
 * <p>DeepSeek 验证码登录需要 X-DS-Guest-Pow-Response（base64 JSON），其中的 answer
 * 由官方算法 DeepSeekHashV1 计算。我们之前尝试用纯 Rust/Python 复现算法（Keccak-256、
 * SHA3-256、各种前缀/判据）全部被服务端拒（40301 Invalid PoW Response）——说明还有
 * 未知的细节没对上。</p>
 *
 * <p>这里直接引入官方 APK 里的 `librscrypto.so`（仅依赖系统 libdl/libc，可独立加载），
 * 通过 JNI 调用它的 `com.deepseek.crypto.PowCalculator.nativeCalculateDeepSeekHashV1Pow`
 * 求出**必然正确**的 answer，不再靠猜算法。</p>
 */
public final class DeepSeekPowSolver {

    private static final String TAG = "DeepSeekPowSolver";

    static {
        try {
            // System.loadLibrary 会自动到 jniLibs/arm64-v8a 找 librscrypto.so
            System.loadLibrary("rscrypto");
        } catch (UnsatisfiedLinkError error) {
            Log.e(TAG, "加载 librscrypto.so 失败: " + error.getMessage());
        }
    }

    private DeepSeekPowSolver() {}

    /**
     * 计算 DeepSeekHashV1 PoW 答案。
     *
     * @param challenge 服务端下发的 challenge（十六进制字符串）
     * @param salt      服务端下发的 salt（ASCII 字符串）
     * @param difficulty 搜索难度（整数）
     * @return answer，或失败时返回 null
     */
    public static Long solve(String challenge, String salt, long difficulty) {
        try {
            if (challenge == null || salt == null || challenge.isEmpty() || salt.isEmpty()) {
                return null;
            }
            return nativeCalculateDeepSeekHashV1Pow(challenge, salt, difficulty);
        } catch (Throwable error) {
            Log.e(TAG, "PoW 求解异常: " + error);
            return null;
        }
    }

    /** 是否能求解（librscrypto.so 是否加载成功）。 */
    public static boolean available() {
        try {
            // 用一次最小求解探测原生方法是否真的可调
            return solve("a", "a", 1L) != null;
        } catch (Throwable error) {
            return false;
        }
    }

    // JNI 签名 (Ljava/lang/String;Ljava/lang/String;J)J
    private static native long nativeCalculateDeepSeekHashV1Pow(
        String challenge, String salt, long difficulty);
}
