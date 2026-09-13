package app.coomi;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import static org.junit.Assert.*;

public class CoomiRuntimeArtifactsTest {
    // SHA-256("abc"), an independent known digest fixture.
    private static final String SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    private static final byte[] ARCHIVE = "abc".getBytes(StandardCharsets.UTF_8);
    @Rule public TemporaryFolder directory = new TemporaryFolder();

    private File cache(String content) throws Exception {
        File file = new File(directory.getRoot(), "rootfs.tar.gz");
        Files.write(file.toPath(), content.getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private boolean ensure(File target, long size, String sha, CoomiRuntimeArtifacts.AssetSource source) throws IOException {
        return CoomiRuntimeArtifacts.ensure(target, size, sha, source, (temporary, destination) ->
            Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING));
    }

    @Test public void repairsTruncatedCacheFromBundledAsset() throws Exception {
        File target = cache("a");
        assertTrue(ensure(target, 3, SHA, () -> new ByteArrayInputStream(ARCHIVE)));
        assertArrayEquals(ARCHIVE, Files.readAllBytes(target.toPath()));
    }

    @Test public void repairsSameSizeCorruptionFromBundledAsset() throws Exception {
        File target = cache("abd");
        assertTrue(ensure(target, 3, SHA, () -> new ByteArrayInputStream(ARCHIVE)));
        assertArrayEquals(ARCHIVE, Files.readAllBytes(target.toPath()));
    }

    @Test public void validCacheSurvivesAppUpgradeWithoutOpeningAsset() throws Exception {
        File target = cache("abc");
        File oldStamp = new File(directory.getRoot(), ".bundled-app-stamp");
        Files.write(oldStamp.toPath(), "previous-apk-version".getBytes(StandardCharsets.UTF_8));
        assertFalse(ensure(target, 3, SHA, () -> { throw new IOException("must reuse verified cache"); }));
        assertArrayEquals(ARCHIVE, Files.readAllBytes(target.toPath()));
    }

    @Test public void badBundledAssetCannotReplaceExistingArchiveAndLeavesNoPartialFile() throws Exception {
        File target = cache("old");
        try {
            ensure(target, 3, SHA, () -> new ByteArrayInputStream("bad".getBytes(StandardCharsets.UTF_8)));
            fail("bundled archive must match the signed manifest");
        } catch (IOException expected) { }
        assertArrayEquals("old".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(target.toPath()));
        assertFalse(new File(directory.getRoot(), target.getName() + ".asset.tmp").exists());
    }

    @Test public void insufficientSpacePreservesExistingCacheWithoutOpeningAsset() throws Exception {
        File target = cache("old");
        try {
            ensure(target, Long.MAX_VALUE, SHA, () -> { throw new IOException("unexpected asset read"); });
            fail("copy must fail before opening an archive that cannot fit");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("storage"));
        }
        assertArrayEquals("old".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(target.toPath()));
    }
}
