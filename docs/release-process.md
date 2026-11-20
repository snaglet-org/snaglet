# Release process

How a release is checked and built: the local gates, what the GitHub Actions
workflows define, the desktop artifacts, signing and shipping, and the
documentation gate.

## Local gates

These are the release checks. Run them at the root of a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck:all
pnpm test
pnpm build:browser-preview
```

`pnpm verify` runs the build, `typecheck:all`, the package-export and
tool-registry checks, `pnpm test:ui` and `pnpm test` in one go.
Run `pnpm lint` as well.

Also run these when a change touches the database, packaging or UI flows:

```bash
pnpm test:integration
pnpm test:e2e
pnpm test:e2e:app   # after pnpm build:desktop
```

## GitHub Actions workflows

`.github/workflows/` defines two GitHub Actions workflows. Whether they run depends on the
repository's Actions settings, so the local gates above are the checks to run before a pull
request.

`ci.yml` targets pushes and pull requests to `main` and defines these jobs:

- **Source and package contracts** (Ubuntu): `pnpm format:check`,
  `pnpm lint:baseline` (ESLint and Knip may not exceed
  `quality-baseline.json`), `pnpm lint:realtime`, `pnpm lint:docs`,
  `pnpm typecheck:all`, `pnpm test:package-exports`, `pnpm test:tool-registry`,
  `pnpm test:unit`, `pnpm test:integration`, `pnpm test:desktop-ui` and
  `pnpm test:build-profiles`.
- **Browser preview artifact** (Ubuntu): a clean `pnpm build:browser-preview`,
  then `pnpm verify:artifacts --profile browser-preview`.
- **Desktop preview artifact** (macOS 14, Apple Silicon): PostgreSQL runtime
  and fresh-database checks, `pnpm build:desktop-preview`, then
  `pnpm verify:artifacts --profile desktop-preview`.
- **Windows x64 desktop and runtime** (Windows Server 2022): builds the
  PostgreSQL runtime and the desktop preview, runs the unit, integration and
  desktop UI tests and a native embedding check, then
  `pnpm verify:artifacts --profile desktop-preview`.
- **Secret scan**: gitleaks over the full history.

`release.yml` ("Production candidate") starts only by hand. It repeats the
source gates, builds a macOS Apple Silicon candidate with `pnpm build:desktop`,
and checks it with `pnpm verify:artifacts --profile desktop-production`. Its
optional publish job always fails on purpose: the workflow holds no signing
credentials, so signed releases are built and shipped from a Mac that has them.

## Desktop artifacts

| Artifact        | Command                      | Output                              |
| --------------- | ---------------------------- | ----------------------------------- |
| Server bundle   | `pnpm build:server`          | `dist/bundle`                       |
| Browser preview | `pnpm build:browser-preview` | `dist/browser-preview`              |
| Desktop preview | `pnpm build:desktop-preview` | `dist/desktop-preview/artifacts`    |
| Desktop app     | `pnpm build:desktop`         | `dist/desktop-production/artifacts` |

Desktop builds need Rust ([Development environment](./dev-environment.md)).
Before a release build, run `pnpm pg:runtime:build --strict --force` once so
the bundled PostgreSQL runtime carries its license files. Build releases with
the macOS 26 SDK: an older SDK skips the Apple speech-to-text helper, and
`ship-desktop.mjs` refuses a build without it.

Before you ship a desktop build, run `pnpm test:e2e:app`. It launches the app in
a throwaway home and checks health and the Dashboard, then checks that an
existing home upgrades with a backup taken first (skipped while
`0001_init.sql` is the only migration). Then open the app and check by hand:

- A first launch and an existing home both open.
- You can add a model provider, chat with an agent, and create and edit a doc.
- Quitting, even from the splash screen, leaves no `node` or `postgres`
  process; killing the Node sidecar shows the crash dialog, and Restart Snaglet
  recovers.
- Outside links open in the system browser. A trackpad pinch zooms an image,
  and ⌘+ / ⌘− zoom the whole app.

## Schema compatibility

Migrations ship with the code that needs them. A packaged build must open every
earlier released schema, or fail before it changes user data. Before you ship a
migration, run it on a copy of realistic data, check that the pre-migration
backup still works, and check that older builds refuse newer data.

## Signing and shipping

The root `package.json` and `apps/desktop/src-tauri/tauri.conf.json` carry the
version; keep them equal. Tags look like `v1.0.0`, and the ship script refuses
a tag that does not match the built app.

`pnpm build:desktop` makes an unsigned candidate (`releaseEligible: false` in
its manifest): ad-hoc signed, not Developer ID signed or notarized. A copy you
build and open on your own Mac opens normally. A copy downloaded from the
internet is checked by Gatekeeper, which blocks an app that is not notarized.
Windows candidates are unsigned too; see
[Windows development](./windows-development.md).

One-time setup on the Mac that signs:

1. Join the [Apple Developer Program](https://developer.apple.com/programs/).
2. Put a **Developer ID Application** certificate in the login keychain and
   check it with `security find-identity -v -p codesigning`.
3. Store notarization credentials with an
   [app-specific password](https://support.apple.com/102654):

```bash
xcrun notarytool store-credentials snaglet-notary \
  --apple-id <apple-id-email> --team-id <TEAMID> --password <app-specific>
```

Sign after `pnpm build:desktop` and
`pnpm verify:artifacts --profile desktop-production`, never before: the
verifier expects the unsigned candidate. Then ship:

```bash
export SNAGLET_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
node scripts/release/sign-and-notarize.mjs --notary-profile snaglet-notary
node scripts/ship-desktop.mjs --version vX.Y.Z
```

`sign-and-notarize.mjs` signs every binary with the hardened runtime and the
entitlements in `scripts/release/entitlements/`, notarizes, staples, and
rewrites the manifest and checksums for the signed files. `ship-desktop.mjs`
publishes a DMG, a zip and checksums as a GitHub release on the repository named
in `packages/shared/constants/release.json`. It refuses an unsigned build unless
you pass `--allow-unsigned`. To rehearse signing without a certificate, pass
`--identity - --skip-notarize`; the build then stays blocked from shipping. Keep
signing keys outside the repository.

## Documentation gate

Run `pnpm lint:docs` (part of `pnpm lint`). It fails on personal paths,
real-looking ids, placeholders, plan wording, broken links and anchors, docs
missing from [docs/INDEX.md](./INDEX.md), tracked plans or notes, unlinked doc
images, and `pnpm` commands that name no script. The gate only proves that
scripts exist, so before a release also follow the README's Install steps on a
clean checkout. The rules for writing docs are in
[CONTRIBUTING.md](../CONTRIBUTING.md).
