# Agent Note: Editable external-source desktop runtime

Status: implemented

English | [中文](2026-08-18-editable-external-source-desktop-runtime.zh.md)

## Problem

A desktop package that embeds one built copy of the Coomi server and workspace turns every agent, plugin, and client change into a new application build. The user cannot inspect or edit the installed runtime as an ordinary Git checkout, and a local customization has no stable base against which another tool can analyze or merge its diff. Shipping the whole workspace also makes the installer own code that the desktop shell does not execute directly.

## Decision

The Windows installer is a lightweight Electron shell with pinned Node and pnpm runtimes. It does not contain a Coomi server payload, `apps/`, `packages/`, or `vendor/`. The shell runs one external Git checkout selected by the user and stores its resolved path, base commit, repository, and branch in `%APPDATA%\Coomi\desktop-runtime.json` with schema version 1.

An existing checkout is accepted only when it carries the root package and lock files plus the source CLI, built Web entry, and `tsx` dependency required for source launch. The setup window can clone the official `coomi-desktop` branch into a user-selected parent directory, install dependencies, and build it with the packaged toolchain. The source CLI launches through `node --import tsx/esm` as required by the [source-launch decision](2026-07-29-coomi-source-launch-tsx-esm.md), and receives an isolated `%APPDATA%\Coomi\home` as `COOMI_HOME`.

The Electron process owns the source server and polling client-package watcher as child process trees. It waits for the loopback server and a ready plugin UI before showing the window. A cold client boot that reports failed plugin activation is retried with a fresh navigation before the setup recovery UI appears; the watcher starts only after a successful client boot, so its first rebuild cannot overlap initial plugin activation.

The tray exposes checkout opening, checkout switching, runtime restart, and source checkpoint creation. A checkpoint records the full diff from the stored base commit, including untracked files, under `%APPDATA%\Coomi\changes` without modifying the checkout's index or working tree. It is an analysis artifact, not an automatic merge or source backup.

## Alternatives considered

**Embed a production workspace payload.** Rejected because it freezes plugin and UI code inside the installer, duplicates the selected source checkout, and requires repackaging for each local iteration.

**Run a globally installed `coomi` command.** Rejected because command resolution and dependency versions would depend on mutable machine state instead of the checkout and pinned launcher selected by the shell.

**Use Electron as the Node runtime.** Rejected because `ELECTRON_RUN_AS_NODE` couples the source process to Electron's runtime behavior. A packaged Node executable makes the source-launch command explicit and lets pnpm use the same pinned engine.

**Start the watcher before loading the client.** Rejected because a repository-wide first rebuild can replace client bundles while the initial Cordis plugin graph is activating. Delaying it preserves live editing after the first stable render without exposing the cold-start race.

## Consequences

Users install the desktop integration once and retain direct ownership of an editable source checkout. Plugin and client changes remain visible to Git and can reload while the app is running; checkpoints provide a stable diff against the recorded base for later analysis or merging.

The selected checkout is executable code and therefore carries the same trust requirement as launching it from a terminal. It consumes its own disk space and must remain structurally prepared. Initial preparation and the first watcher build cost time and CPU, while the installer stays independent of workspace size and source changes. Source updates, conflict resolution, and backup remain explicit user or Git operations rather than hidden desktop behavior.
