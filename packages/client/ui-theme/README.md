# @coomi/coomi-client-ui-theme

English | [中文](README.zh.md)

Theme plugin: ThemeRuntime over the --coomi-* token base stylesheets (static scale + alias semantic layers). The service owns the live theme preference (`light`/`dark`/`system`), resolves `system` through `prefers-color-scheme`, and publishes immutable `ThemeSnapshot`s on the `theme/change` event; it never touches the DOM — ui-layout's presenter applies the resolved snapshot (`html { color-scheme }`, `body[data-coomi-dark-theme]`, and inline alias tokens). A loopback browser provides the service immediately with `system`, then loads `ui-theme.preference` in the background and writes each built-in selection through the Host settings API, whose local provider stores it in `$COOMI_HOME/settings.yaml` by default; pushed settings changes and reconnects refetch it, rapid selections are serialized in gesture order with namespace revisions, and a rejected latest write reloads the durable value. A remote browser cannot access the privileged settings API, so its selection remains process-local. Third-party registered theme ids remain an in-process extension and do not cross the built-in settings schema; removing one never overwrites the last durable built-in preference. The [Host-backed preferences decision](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) owns the persistence boundary.

When the host composition includes an HTTP server, the host half injects a synchronous bootstrap immediately after the opening `<body>` tag. Each index response embeds the registered Host setting for `ui-theme.preference`, or `system` when no settings provider is present; the browser resolves `system` from the OS scheme, then sets `color-scheme` and `body[data-coomi-dark-theme]` before the shell loading page renders. Compositions without an HTTP server remain unaffected, and ThemeRuntime and ui-layout remain authoritative for client state and subsequent DOM updates after the plugin tree activates.

`src/styles/` holds five sheets, all imported by the web shell's `base.css`: `base.css`, `design-platform.css`, `scrollbar.css`, `gradient-shadow-text.css`, and `shiki.css`. `scrollbar.css` is the sole consumer of the `--coomi-alias-scrollbar-*` tokens and must follow `design-platform.css`, which declares them.

Scrollbar rebinding contract: `scrollbar.css` binds `--coomi-scrollbar-thumb` and `--coomi-scrollbar-thumb-hover` on `body` to the l1 (base-surface) tokens, and both rendering paths read that pair. An elevated surface (menu, popover, dialog) sets `--coomi-scrollbar-thumb: var(--coomi-alias-scrollbar-bg-l2)` and `--coomi-scrollbar-thumb-hover: var(--coomi-alias-scrollbar-hover-l2)` on its own container; one rebind retints whichever path the engine took. The pair's other legal target is `transparent`, which draws no thumb at all — [ui-sidebar](../ui-sidebar/README.md) rebinds its column that way while the pointer is elsewhere. A rebind to the l1 pair is not a rebind; it restates the base-surface default. `--coomi-scrollbar-width` mirrors the WebKit bar's layout width for surfaces that align themselves beside a space-consuming bar — [ui-conversation](../ui-conversation/README.md) reads it for the overlay composer seat's `right` offset — and the scrollbar-styles spec pairs it with the mirrored rule and the consumer.

The two paths are mutually exclusive by construction. `scrollbar-width`/`scrollbar-color` sit inside `@supports not selector(::-webkit-scrollbar)` because a non-`auto` value of either makes Chromium and Safari discard every `::-webkit-scrollbar*` rule for that element, `::-webkit-scrollbar-thumb:hover` included — declaring both unconditionally leaves `--coomi-scrollbar-thumb-hover` with no rendering anywhere. Firefox therefore takes the standard properties and WebKit-based engines take the pseudo-elements, so the hover token only ever renders through the pseudo-element path. Reasoning and the measured computed values: [the scrollbar Agent Note](../../../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md).

## Model Experience

None, as the theme service manages a browser preference; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The token sheets are the sole color authority** — values absent from cssdesign (for example the design's #4176E6 tab blue) are deliberately not appended; the nearest semantic token wins. Design-owner-approved additions are the exception and enter as a static step plus a semantic alias in the same change (`--coomi-static-blue-900` / `--coomi-alias-label-primary-bluish`).
