package app.coomi;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class CoomiAutoBackupTest {
    @Test
    public void intervalIsRestrictedToSupportedValues() {
        assertEquals(6, CoomiAutoBackup.normalizeInterval(6));
        assertEquals(12, CoomiAutoBackup.normalizeInterval(12));
        assertEquals(24, CoomiAutoBackup.normalizeInterval(7));
        assertEquals(168, CoomiAutoBackup.normalizeInterval(168));
    }
}
