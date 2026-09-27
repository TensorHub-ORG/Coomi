package app.coomi;

import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;

import rikka.shizuku.Shizuku;

/**
 * Owns the optional Shizuku binder and permission lifecycle.
 *
 * <p>Shizuku may be missing, stopped, or not authorized for this package.
 * Every state is therefore read from the current binder and permission
 * status instead of being persisted as a local boolean.</p>
 */
public final class ShizukuAccessController {

    private static final int REQUEST_CODE = 2301;

    public enum Status {
        GRANTED,
        REQUESTABLE,
        DENIED,
        NOT_RUNNING,
        UNAVAILABLE,
        ERROR
    }

    public static final class Result {
        public final Status status;
        public final String message;

        private Result(Status status, String message) {
            this.status = status;
            this.message = message == null ? "" : message;
        }

        static Result of(Status status) {
            return new Result(status, "");
        }

        static Result error(Throwable error) {
            return new Result(Status.ERROR,
                error == null || error.getMessage() == null
                    ? "Shizuku unavailable" : error.getMessage());
        }
    }

    public interface Callback {
        void onComplete(Result result);
    }

    public interface StateListener {
        void onStateChanged(Result result);
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private Callback pendingCallback;
    private StateListener stateListener;
    private boolean requestInFlight;
    private boolean closed;
    private Throwable initializationError;

    private final Shizuku.OnBinderReceivedListener binderReceivedListener =
        () -> dispatchStateChanged();

    private final Shizuku.OnBinderDeadListener binderDeadListener =
        () -> {
            completePending(Result.of(Status.NOT_RUNNING));
            dispatchStateChanged();
        };

    private final Shizuku.OnRequestPermissionResultListener permissionResultListener =
        (requestCode, grantResult) -> {
            if (requestCode != REQUEST_CODE) return;
            Result result = grantResult == PackageManager.PERMISSION_GRANTED
                ? getStatus() : Result.of(Status.DENIED);
            completePending(result);
            dispatchStateChanged();
        };

    public ShizukuAccessController() {
        try {
            Shizuku.addBinderReceivedListenerSticky(binderReceivedListener);
            Shizuku.addBinderDeadListener(binderDeadListener);
            Shizuku.addRequestPermissionResultListener(permissionResultListener);
        } catch (Throwable error) {
            synchronized (lock) {
                initializationError = error;
            }
        }
    }

    /** Returns the current binder and permission state without requesting anything. */
    public Result getStatus() {
        synchronized (lock) {
            if (initializationError != null) return Result.error(initializationError);
            if (closed) return Result.of(Status.UNAVAILABLE);
        }
        try {
            if (Shizuku.isPreV11()) return Result.of(Status.UNAVAILABLE);
            if (!Shizuku.pingBinder()) return Result.of(Status.NOT_RUNNING);
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                return Result.of(Status.GRANTED);
            }
            if (Shizuku.shouldShowRequestPermissionRationale()) {
                return Result.of(Status.DENIED);
            }
            return Result.of(Status.REQUESTABLE);
        } catch (Throwable error) {
            return Result.error(error);
        }
    }

    /** Requests Shizuku authorization when the server is available. */
    public void request(Callback callback) {
        synchronized (lock) {
            if (closed) {
                postCallback(callback, Result.of(Status.UNAVAILABLE));
                return;
            }
            if (initializationError != null) {
                postCallback(callback, Result.error(initializationError));
                return;
            }
            if (requestInFlight) return;
        }

        Result current = getStatus();
        if (current.status != Status.REQUESTABLE) {
            postCallback(callback, current);
            return;
        }

        synchronized (lock) {
            if (closed || requestInFlight) return;
            pendingCallback = callback;
            requestInFlight = true;
        }
        try {
            Shizuku.requestPermission(REQUEST_CODE);
        } catch (Throwable error) {
            completePending(Result.error(error));
        }
    }

    public void setStateListener(StateListener listener) {
        synchronized (lock) {
            stateListener = listener;
        }
    }

    /** Unregisters listeners when the host Activity is destroyed. */
    public void close() {
        synchronized (lock) {
            if (closed) return;
            closed = true;
            pendingCallback = null;
            stateListener = null;
            requestInFlight = false;
        }
        try {
            Shizuku.removeBinderReceivedListener(binderReceivedListener);
            Shizuku.removeBinderDeadListener(binderDeadListener);
            Shizuku.removeRequestPermissionResultListener(permissionResultListener);
        } catch (Throwable ignored) {
            // The host Activity is being torn down.
        }
    }

    private void completePending(Result result) {
        Callback callback;
        synchronized (lock) {
            callback = pendingCallback;
            pendingCallback = null;
            requestInFlight = false;
        }
        postCallback(callback, result);
    }

    private void postCallback(Callback callback, Result result) {
        if (callback == null) return;
        mainHandler.post(() -> {
            synchronized (lock) {
                if (closed) return;
            }
            callback.onComplete(result);
        });
    }

    private void dispatchStateChanged() {
        StateListener listener;
        synchronized (lock) {
            listener = stateListener;
            if (closed || listener == null) return;
        }
        mainHandler.post(() -> {
            synchronized (lock) {
                if (closed || stateListener != listener) return;
            }
            listener.onStateChanged(getStatus());
        });
    }
}
