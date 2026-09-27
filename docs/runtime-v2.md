# Runtime V2 assets

Runtime V2 keeps the Coomi engine in the Android native process and runs only
shell/package workloads inside a PRoot Debian guest. The APK does not contain
the Debian rootfs. The runtime downloads two SHA-256 and size-verified archives
described by `runtime-v2-manifest.json`.

## Pinned inputs

- PRoot: `termux/proot` commit `61681c6481197e3c0cec6726075053adb740f235`
- Termux package recipes: commit `d4623496c2285fa3d583db42646b661513d0d8cc`
- Termux builder image: digest `sha256:374fedda8d2ce7a8ab499735d39329301c4f2f18ea4411b3cf7c93d4668768ab`
- Debian: bookworm ARM64 at snapshot `20260803T000000Z`

The PRoot build statically links `libtalloc` and `libandroid-shmem`. The build
fails if either library remains in the ELF dynamic dependency table. The guest
contains apt/dpkg, CA certificates, Git, Node, Python 3.11, aiohttp, numpy, and
English/Chinese UTF-8 locales.

## Release

Run the `Runtime V2 assets` workflow with the final immutable release-asset URL
prefix. Publish all three files from its `runtime-v2-release-assets` artifact
without renaming them. Place the generated manifest at
`~/.coomi/config/runtime-v2-manifest.json` during staged rollout. Coomi verifies
the manifest schema and both archive hashes before replacing an installed
runtime; the prior version remains available for rollback.

Removing Runtime V2 deletes installed version directories but retains the
migrated home/workspace tree. Rollback only swaps the active and previous
version pointers and never copies the old Termux `usr` or dpkg database.
