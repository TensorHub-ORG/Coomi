# Context orbit and auxiliary conversations

**Goal:** Implement the user-approved quarter-ring tools, responsive composer, shared inline tool cards, prompt library, independent child agents, and OpenCode compatibility fixes.

**Architecture:** TopBar owns the context anchor and orbit state. A shared card hosts embedded tool views, PromptLibrary, or AuxiliaryChat. Child agents reuse the normal agent pipeline with independent state and persisted parent metadata.

**Tech Stack:** Vue 3, Pinia, TypeScript, Rust engine, Android Java shell.

**Spec:** User-approved design in conversation, 2026-09-13.

## Constraints
- Preserve pre-existing uncommitted edits to Composer and the four tool views.
- All five composer actions remain on one row and scale with container width.
- Labels are 普通 / 协同.
- Outside clicks close only the active card; only the context close button collapses the ring.
- The ring entry hides in floating mode. Existing usage details remain accessible.
- Cards use context usage surface styling and an upper-right quarter-circle cutout.
- Prompts support built-ins, custom labels/categories, editing, deletion and filling without sending.
- Auxiliary agents keep full tools/approval behavior and continue when their card closes.
- No live paid OpenCode claim without credentials; validate offline request/protocol behavior.

## Execution ledger
- [x] Composer: use ResizeObserver to scale its natural single-row action layout; verify 240–430px widths and enlarged fonts.
- [x] Tool views: embedded prop, contained navigation/overlays, shared restrained visual design; verify full-screen Data back header and scroll bounds.
- [x] Prompt library: local persisted repository with validation tests, shared card/fullscreen editor and native console route; verify fill and reload.
- [x] Orbit: independent open/card states, measured anchor and adaptive radii, four tools, cutout card, outside click and floating state rules; browser verification.
- [x] Auxiliary sessions: persisted parent metadata + isolated client session instances, parent transcript access, nested history; run behavioral regression tests.
- [x] OpenCode: investigate official endpoints/protocol, fix model-aware routing and offline protocol tests.
- [x] Combined validation: TypeScript check, frontend tests/build, applicable Rust tests, browser screenshots and interaction checks; review changes and report remaining validation limits.

Ruling: Keep this existing checkout and its uncommitted user work; use a new feature branch rather than moving partially modified files into another checkout. No merge, push or deployment is included.

## Verification record
- `npm test`: 17 passed, including isolated auxiliary socket/model/approval/question/native transfer behavior and delayed prompt read/write regression.
- `npm run build`: TypeScript + production bundle passed.
- `python apps/web/tests/contextTools.browser.py`: passed 240/280/320/390/430px composer widths, shortened card viewport heights, card outside/X rules, usage slot, prompt create/persist/fill, four tool switches, auxiliary entry, floating visibility and Data header.
- `cargo test -p coomi-ui prompt_library_tests`: 3 passed (atomic persistence, invalid payload, corrupt-file protection).
- Targeted Rust engine parent persistence and all 7 security tests passed; `cargo check -p coomi-ui` passed.
- Provider config 7 tests and provider 22 tests passed, including four local HTTP protocol/auth/tool-result round trips.
- `gradlew.bat :app:compileDebugJavaWithJavac --offline`: passed, including ARM64 release engine, web staging, Android resources and Java compilation.
- Final independent review: no outstanding P0/P1/P2 findings.
- OpenCode authenticated subscription calls and physical-device interaction were not tested. Browser API fixtures were local only.

Screenshots: `apps/web/test-results/context-tools/`. Release source is prepared on `feat/context-orbit-tools`; pre-existing related edits are retained. The test-channel manifest records the published source commit.
