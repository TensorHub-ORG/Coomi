# Agent Note: Desktop presentation and running status

Status: implemented

English | [中文](2026-08-17-desktop-presentation-and-running-status.zh.md)

## Problem

The Windows shell inherited a native title bar whose left edge repeated the product icon and name above the application's own brand header. Its fixed dark color changed when the window lost focus and did not follow the Web theme. Replacing that label with an entirely empty drag strip left the brand row duplicated below useful title-bar space. The packaged and in-app icons also exposed a white square around the mark, so the mark appeared less integrated than neighboring transparent icons.

The conversation used one generic English activity label throughout every running turn. This label provided no Coomi identity and made long waits look static even though the elapsed clock continued to advance.

## Decision

The Windows BrowserWindow uses Electron's hidden title-bar style with a 38px native window-controls overlay. The preload reserves the same 38px in document layout and paints the region from the Web theme tokens, with a bottom divider separating it from the workspace. The sidebar's existing wordmark and collapse control move into the left side of that region, whose remaining surface stays draggable; the buttons opt out of dragging, and Windows continues to own minimize, maximize, and close on the right. The expanded row uses the Coomi mark with a compact display-font label and a separate collapse control. The collapsed row keeps only the mark as its click target and does not reveal another glyph or tooltip on hover. The row follows sidebar width and collapse transitions, so the title bar and column retain one shared alignment. The preload reads the computed body background and foreground after each theme presentation update and sends those two CSS colors over one private IPC channel. When an aria-modal dialog is present, it sends the dialog mask color so the native controls area and Web title region share the modal treatment. The main process accepts values only from the current window, validates their CSS color syntax, and updates the overlay without introducing an active/inactive color pair.

The desktop PNG and ICO resources, Web favicon, and in-app raster use a transparent outer canvas while retaining the white regions enclosed by the Coomi mark. The ICO contains the standard Windows application sizes derived from the same source image, so shortcuts, installer chrome, and rendered brand surfaces share one mark and scale consistently.

During a running turn, ChatView chooses one of the product-owned Chinese Coomi activity messages at mount and changes to a different random message every four seconds. Immediate repeats are excluded. The status remains a polite live region, and the existing elapsed clock remains anchored to durable `turn/start` time and appears after 15 seconds. Message selection is presentation-only and is neither logged nor restored because it never reaches the model and does not describe session state.

## Verification

The ChatView component suite pins an initial random choice, advances the rotation timer, and proves the next message differs while the existing clock and tool-row behavior remain intact. Web interaction scenarios locate the product-owned status during a live turn. Desktop verification launches the packaged application on Windows and inspects the shortcut icon, title-bar spacing, native controls, focus behavior, and light/dark theme colors.

## Alternatives considered

**Build a fully custom frameless title bar.** Rejected because it would duplicate Windows caption-button behavior, keyboard and accessibility semantics, snapping integration, and hover states only to remove the left-side label. Electron's overlay already preserves those operating-system behaviors.

**Keep one fixed title-bar color.** Rejected because the application supports light, dark, system, and registered themes. A separate desktop palette would drift from the rendered Web background.

**Localize one replacement for the running label.** Rejected because it would restore Coomi naming but preserve the static long-wait presentation the requested message set is intended to change.

**Persist the chosen message in the Session log.** Rejected because the message is transient presentation text, carries no session fact, and never reaches the model. Persistence would make random UI decoration part of replay compatibility.

## Consequences

The desktop window presents its application brand and sidebar control in the otherwise useful title-bar area, separates that area from workspace content, retains native Windows controls, follows the selected theme and modal state, and uses brand images without an opaque outer square. Running turns visibly remain active and use Coomi-specific copy while preserving elapsed-time accuracy and accessibility semantics.

The preload now owns a small desktop-only layout and IPC responsibility. Third-party themes must resolve their body background and foreground to a CSS color syntax accepted by the desktop validator; unsupported values leave the last valid title-bar colors in place. Random activity wording intentionally differs across mounts and is not replay evidence.
