# Build system

`build/scripts/orchestrate.ts` is the single owner of build ordering. Profiles are validated before any task runs and do not rely on `NODE_ENV` to select release behavior.

| Command                      | Inputs                                                                 | Outputs                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm clean`                 | Selected profile                                                       | Removes the profile's `dist/<profile>` directory                                          |
| `pnpm build`                 | TypeScript package and server sources                                  | Compiled shared, database, SDK, and server output under `dist`                            |
| `pnpm build:web`             | Desktop UI source and compiled workspace packages                      | Vite assets in `apps/desktop-ui/dist`                                                     |
| `pnpm build:server`          | Server source, web assets, migrations, runtime dependencies            | Standalone server bundle in `dist/bundle`                                                 |
| `pnpm stage:desktop`         | Prebuilt web/server artifacts and pinned Node runtime                  | Tauri resources and sidecar binary                                                        |
| `pnpm test:desktop-stage`    | Prebuilt web/server artifacts                                          | Stages twice, checks the staging manifest is deterministic, then boots the staged sidecar |
| `pnpm build:desktop-preview` | Staged Tauri resources                                                 | Packaged desktop preview                                                                  |
| `pnpm build:desktop`         | Staged Tauri resources                                                 | Production desktop candidate                                                              |
| `pnpm test:build-profiles`   | Build profiles, task graph, desktop bundle rules, and Jest test layout | Validation/test result only                                                               |

The product commands above are the supported entry points; build ordering stays internal to the orchestrator.

## Local verification gate

`pnpm verify` runs `build`, `typecheck:all`, `test:package-exports`,
`test:tool-registry`, `test:ui`, and `test`.
`pnpm lint` adds ESLint, the realtime import boundaries and the documentation gate. CI runs `lint:baseline` for ESLint and Knip, which fails on
any increase over the checked-in baseline (`quality-baseline.json`).

Production desktop builds strip all source maps, use locked Rust dependencies and
the pinned `rust-toolchain.toml`, and emit checksums and provenance. A local build
without Apple credentials is a verifiable candidate only: its manifest records
`releaseEligible: false`, `signed: false`, and `notarized: false`. The release
workflow does not publish it, and `scripts/ship-desktop.mjs` refuses it unless you
pass `--allow-unsigned`.

## GitHub Actions workflows

`.github/workflows/ci.yml` defines jobs on three runner classes. Whether they run
depends on the repository's Actions settings; the checks to run locally before a
pull request are in [CONTRIBUTING.md](../CONTRIBUTING.md#check-your-change).

- Ubuntu: the source job, and a build and smoke test of the browser preview.
- macOS 14 arm64: a build and check of the packaged desktop preview.
- Windows x64: builds of the desktop app and the managed PostgreSQL runtime.

The source job builds the checksum-pinned PostgreSQL runtime, then checks
formatting, the checked-in ESLint/Knip baseline (`quality-baseline.json`; any
increase fails), realtime import boundaries, the documentation gate
(`pnpm lint:docs`), all TypeScript projects, compiled package consumption, the
strict tool registry audit, server/shared unit tests, managed PostgreSQL
integration tests, desktop UI tests, and the build-profile guards. A separate
job runs a gitleaks secret scan.

`.github/workflows/release.yml` runs only when started by hand. It starts from a
frozen install, runs the source gates, builds the macOS arm64 production
candidate, verifies it, and uploads manifests, checksums, provenance and
diagnostics. Its publish job uses the protected `production` environment and
always fails, because the workflow holds no Apple signing or notarization
credentials. No workflow publishes an unsigned candidate.
