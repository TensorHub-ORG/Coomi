# Coomi Desktop

English | [中文](README.zh.md)

Coomi Desktop is a lightweight Electron shell for an editable Coomi source checkout. The installer provides the desktop integration and a pinned Node/pnpm toolchain; agent code, plugins, and Web UI remain ordinary files outside the installation directory.

## Runtime layout

- `src/main.cjs` owns the window, tray, source-process lifecycle, first-run setup, and source checkpoints.
- `src/runtime-source.cjs` validates and prepares a Git checkout, launches Git operations, and writes diff checkpoints.
- `src/client-boot.cjs` keeps the window hidden until the plugin UI is ready and classifies recoverable cold-start failures.
- `src/preload.cjs` exposes the narrow setup/source APIs and synchronizes the Windows title-bar overlay with the Web theme.
- `resources/` contains generated application icons; `electron-builder.yml` defines the Windows NSIS package.

The selected checkout runs `apps/cli/src/bin.ts` through its own `tsx` ESM hook. Coomi data is stored under `%APPDATA%\Coomi\home`, while the checkout remains wherever the user selected. The shell starts the polling Web-package watcher after the client is ready, so edits to client plugins rebuild and reload without repackaging the desktop application.

## Development

Prepare the checkout once:

```powershell
pnpm install
pnpm run build
cd desktop
npm install
```

Start the shell from source:

```powershell
cd desktop
npm start
```

On first launch, select a prepared Coomi checkout or choose an empty parent directory for the official `coomi-desktop` branch. The setup window can install dependencies and build a selected checkout with the bundled toolchain. Tray actions open or switch the checkout, restart the source runtime, and save a checkpoint under `%APPDATA%\Coomi\changes`.

## Branding

[`../assets/coomi-desktop.png`](../assets/coomi-desktop.png) is the single transparent-background brand source. Run `npm run sync:brand` from `desktop/` after changing it; the command regenerates the application PNG sizes, the multi-size Windows ICO, and the inline Web mark. The command is idempotent and must run before packaging.

## Packaging

```powershell
cd desktop
npm run sync:brand
npm test
npm run dist
```

The installer is written to `desktop/release/Coomi-Setup-<version>.exe`. It contains only the shell files, generated resources, and the pinned Node/pnpm runtime; it does not contain a server payload or a copy of `apps/`, `packages/`, or `vendor/`. See [BUILD.md](BUILD.md) for the Windows release checks.
