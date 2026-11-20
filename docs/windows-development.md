# Windows development and verification

> [!WARNING]
> **Windows support is not done.** It is still in progress: the Windows build is
> not release-verified, and parts of it may not work. Use macOS on Apple Silicon
> to run Snaglet.

How to build, package and verify the Windows x64 desktop app on your own
machine. Snaglet uses the same Tauri, React, Node and PostgreSQL stack as on macOS.
The Windows job in `.github/workflows/ci.yml` defines the same steps; see
[GitHub Actions workflows](./release-process.md#github-actions-workflows).

## Prerequisites

- Windows 10 version 1903 or newer, x64.
- Node.js 22 or newer and pnpm through Corepack.
- Rust with the MSVC target, from [rustup](https://rustup.rs). The repo pins
  the version.
- Visual Studio 2022 Build Tools with **Desktop development with C++** and a
  Windows SDK. Installing them needs administrator rights.
- The WebView2 runtime. Open a new terminal after installing these so `cargo`
  is on `PATH`.

## Build and verify

From PowerShell at the repo root:

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck:all
pnpm pg:runtime:build --strict
pnpm pg:runtime:verify
pnpm build:desktop-preview
pnpm verify:artifacts --profile desktop-preview
```

- `pg:runtime:build` downloads the pinned PostgreSQL ZIP and pgvector source,
  checks their hashes and compiles pgvector with MSVC. The installed app ships
  this runtime and never compiles or downloads PostgreSQL.
- `build:desktop-preview` writes an unsigned NSIS installer for the current
  user, with its hashes, to `dist/desktop-preview/artifacts`.
- `verify:artifacts` runs the app in a throwaway home and checks the hashes, a
  real WebView2 window, that a doc survives quit and reopen, and recovery after
  the shell is killed.

## Check by hand

The verifier does not cover these. Check them on a Windows machine before you
call a candidate good:

- NSIS install, upgrade over an existing install, and an uninstall that keeps
  data.
- Dropping files into the workspace.
- Signing in to a provider and running a tool.
- Display scaling, clipboard, dialogs and notifications.

Native reminder notifications are macOS only.

To verify an installed production candidate (`pnpm build:desktop`) instead of
the portable copy, install it, then point the verifier at the folder that holds
`desktop.exe`:

```powershell
$env:SNAGLET_WINDOWS_INSTALLED_APP = "$env:LOCALAPPDATA\Snaglet-production-acceptance"
pnpm verify:artifacts --profile desktop-production
Remove-Item Env:SNAGLET_WINDOWS_INSTALLED_APP
```

For a manual first launch, use `pnpm simulate:first-run`: it runs the app in a
throwaway home. Never test against an existing user's workspace.
