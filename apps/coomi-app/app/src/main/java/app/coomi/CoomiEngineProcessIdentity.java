package app.coomi;

import java.io.File;

/** Pure parsing helpers: a directory substring is never proof of process ownership. */
final class CoomiEngineProcessIdentity {
    static boolean matches(String[] args, String configHome) {
        if (args.length < 6) return false;
        String binary = new File(args[0]).getName();
        if (!binary.equals("libcoomi.so") && !binary.equals("coomi")) return false;
        boolean serve = false;
        String home = null;
        for (int i = 1; i < args.length; i++) {
            if (args[i].equals("serve")) serve = true;
            if (args[i].equals("--home") && i + 1 < args.length) home = args[++i];
        }
        if (!serve || home == null) return false;
        try { return new File(home).getCanonicalPath().equals(new File(configHome).getCanonicalPath()); }
        catch (java.io.IOException invalid) { return false; }
    }

    static String startTime(String stat) {
        int end = stat.lastIndexOf(')');
        if (end < 0) return "";
        String[] fields = stat.substring(end + 1).trim().split("\\s+");
        // Fields after comm start at field 3; starttime is field 22.
        return fields.length > 19 ? fields[19] : "";
    }

    private CoomiEngineProcessIdentity() {}
}
