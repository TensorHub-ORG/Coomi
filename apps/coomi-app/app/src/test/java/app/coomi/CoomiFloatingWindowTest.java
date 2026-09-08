package app.coomi;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class CoomiFloatingWindowTest {
    @Test
    public void panelWidthKeepsGestureSpaceWhilePositionCanReachEdges() {
        assertEquals(952, CoomiFloatingWindow.constrainPanelWidth(1000, 240, 1000, 24));
        assertEquals(0, CoomiFloatingWindow.constrainPanelX(0, 952, 1000));
        assertEquals(48, CoomiFloatingWindow.constrainPanelX(100, 952, 1000));
    }
}
