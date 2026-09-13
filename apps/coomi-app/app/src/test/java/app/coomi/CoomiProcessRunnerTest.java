package app.coomi;

import org.junit.Test;
import java.io.File;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class CoomiProcessRunnerTest {
    private Process child(String mode) throws Exception {
        String executable = new File(System.getProperty("java.home"), "bin/java").getAbsolutePath();
        String classes = new File(Child.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getAbsolutePath();
        return new ProcessBuilder(executable, "-cp", classes,
            Child.class.getName(), mode).redirectErrorStream(true).start();
    }

    @Test public void timeoutAppliesWhileCommandKeepsStdoutOpen() throws Exception {
        Process process = child("hang");
        try {
            long start = System.nanoTime();
            CoomiProcessRunner.Result result = CoomiProcessRunner.collect(process, 300, TimeUnit.MILLISECONDS);
            assertEquals(-1, result.exitCode);
            assertTrue("timeout must include stdout reads", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2500);
            assertTrue("timed out child must terminate", process.waitFor(2, TimeUnit.SECONDS));
        } finally { process.destroyForcibly(); }
    }

    @Test public void drainsOutputWithoutBlockingChildOnFullPipe() throws Exception {
        Process process = child("output");
        try {
            CoomiProcessRunner.Result result = CoomiProcessRunner.collect(process, 10, TimeUnit.SECONDS);
            assertEquals(7, result.exitCode);
            assertTrue(result.output.endsWith("finished"));
        } finally { process.destroyForcibly(); }
    }

    public static class Child {
        public static void main(String[] args) throws Exception {
            if ("hang".equals(args[0])) { Thread.sleep(4000); return; }
            for (int i = 0; i < 20000; i++) System.out.println("output that fills a process pipe");
            System.out.println("finished");
            System.exit(7);
        }
    }
}
