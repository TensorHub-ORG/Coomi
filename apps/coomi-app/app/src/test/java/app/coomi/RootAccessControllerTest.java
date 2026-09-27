package app.coomi;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class RootAccessControllerTest {

    @Test
    public void recognizesUidZeroFromIdOutput() {
        assertTrue(RootAccessController.hasRootIdentity(
            "uid=0(root) gid=0(root) groups=0(root)"));
    }

    @Test
    public void rejectsShellIdentity() {
        assertFalse(RootAccessController.hasRootIdentity(
            "uid=2000(shell) gid=2000(shell) groups=2000(shell)"));
    }

    @Test
    public void rejectsNullOrUnrelatedOutput() {
        assertFalse(RootAccessController.hasRootIdentity(null));
        assertFalse(RootAccessController.hasRootIdentity("permission denied"));
    }

    @Test
    public void findsExecutableFromPath() throws IOException {
        File directory = Files.createTempDirectory("coomi-root-path").toFile();
        File executable = new File(directory, "su");
        assertTrue(executable.createNewFile());
        assertTrue(executable.setExecutable(true));

        assertTrue(RootAccessController.findExecutableOnPath(
            directory.getAbsolutePath(), "su").equals(executable));
    }

    @Test
    public void ignoresMissingPathExecutable() {
        assertTrue(RootAccessController.findExecutableOnPath(null, "su") == null);
        assertTrue(RootAccessController.findExecutableOnPath("", "su") == null);
    }
}
