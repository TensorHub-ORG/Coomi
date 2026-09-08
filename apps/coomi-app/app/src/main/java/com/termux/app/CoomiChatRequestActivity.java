package com.termux.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** Supplies a real window token and result owner without retaining a chat Activity. */
public final class CoomiChatRequestActivity extends Activity {
    private static int sActive;
    private CoomiChatSession mSession;
    private boolean mDelivered;

    static boolean isActive() { return sActive > 0; }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        sActive++;
        mSession = CoomiChatSession.peek();
        if (mSession == null) { finish(); return; }
        CoomiFloatingService.setRequestVisible(true);
        mSession.runRequest(this, state != null);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        mDelivered = true;
        if (mSession != null) mSession.onActivityResult(request, result, data);
        finish();
    }

    @Override protected void onDestroy() {
        sActive--;
        if (mSession != null) mSession.releaseRequest(this, isChangingConfigurations(), mDelivered);
        if (!isChangingConfigurations()) CoomiFloatingService.setRequestVisible(false);
        super.onDestroy();
    }
}
