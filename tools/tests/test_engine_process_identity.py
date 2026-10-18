"""Run the actual Java process identity parser without Android/device dependencies."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'apps/coomi-app/app/src/main/java/app/coomi/CoomiEngineProcessIdentity.java'


def test_process_identity():
    main = r'''
package app.coomi;
public class IdentityTest {
    static void check(boolean condition) { if (!condition) throw new AssertionError(); }
    public static void main(String[] args) {
        String home = new java.io.File("coomi-test-home").getAbsolutePath();
        check(CoomiEngineProcessIdentity.matches(new String[]{"/old/apk/lib/arm64/libcoomi.so", "--home", home, "--cwd", "/project", "serve", "--port", "42"}, home));
        check(!CoomiEngineProcessIdentity.matches(new String[]{"/bin/sh", "-c", "libcoomi.so", "--home", home, "serve"}, home));
        check(!CoomiEngineProcessIdentity.matches(new String[]{"/runtime-v2/proot", "--home", home, "--cwd", "/project", "serve"}, home));
        check(!CoomiEngineProcessIdentity.matches(new String[]{"/app/libcoomi.so", "--home", home + "-dev", "serve", "--port", "42"}, home));
        check(!CoomiEngineProcessIdentity.matches(new String[]{"/app/libcoomi.so", "--home", home, "--version", "--port", "42"}, home));
        String[] fields = new String[20]; java.util.Arrays.fill(fields, "0"); fields[19] = "12345";
        check(CoomiEngineProcessIdentity.startTime("123 (engine ) name) " + String.join(" ", fields)).equals("12345"));
        check(CoomiEngineProcessIdentity.startTime("invalid").isEmpty());
    }
}
'''
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / 'IdentityTest.java'
        path.write_text(main, encoding='utf-8')
        subprocess.run(['javac', '-encoding', 'UTF-8', '-d', temp, str(SOURCE), str(path)], check=True)
        subprocess.run(['java', '-cp', temp, 'app.coomi.IdentityTest'], check=True)


if __name__ == '__main__':
    test_process_identity()
    print('Java engine ownership and PID starttime checks passed')
