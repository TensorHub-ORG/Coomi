package app.coomi;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public class CoomiServiceStartupTest {
    @Test public void migratingLegacyShellProfilePreservesUserCommands() throws Exception {
        File profile = File.createTempFile("coomi-profile", ".sh");
        try {
            Files.write(profile.toPath(), ("# Created by Coomi Android\nexport CUSTOM_TOOL_HOME=/my/tools\n")
                .getBytes(StandardCharsets.UTF_8));
            Method write = CoomiService.class.getDeclaredMethod("writeShellBlock", File.class, String.class);
            write.setAccessible(true);
            write.invoke(new CoomiService(), profile, "export COOMI_HOME=\"$HOME/.coomi\"\n");
            String migrated = new String(Files.readAllBytes(profile.toPath()), StandardCharsets.UTF_8);
            assertTrue("upgrades must retain user additions to old generated profiles",
                migrated.contains("export CUSTOM_TOOL_HOME=/my/tools"));
        } finally { profile.delete(); }
    }

    @Test public void restartedEngineGetsInstallerEvenWhilePreviousWorkerIsExiting() throws Exception {
        CoomiService service = new CoomiService();
        CountDownLatch release = new CountDownLatch(1);
        Thread previous = new Thread(() -> {
            try { release.await(); } catch (InterruptedException ignored) { }
        });
        previous.start();
        Process exited = new ProcessBuilder(new File(System.getProperty("java.home"), "bin/java").getAbsolutePath(),
            "-version").redirectErrorStream(true).start();
        exited.waitFor();
        Field worker = CoomiService.class.getDeclaredField("mRuntimeInstallThread");
        worker.setAccessible(true);
        worker.set(service, previous);
        Method start = CoomiService.class.getDeclaredMethod("startBundledRuntimeInstallWhenReady",
            Process.class, int.class, String.class);
        start.setAccessible(true);
        try {
            start.invoke(service, exited, 12345, "test-token");
            assertNotSame("old worker must not suppress a new engine's installer", previous, worker.get(service));
        } finally {
            release.countDown();
            previous.join(1000);
            Thread current = (Thread) worker.get(service);
            if (current != null) { current.interrupt(); current.join(1000); }
        }
    }
}
