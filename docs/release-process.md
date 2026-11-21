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
export TAURI_SIGNING_PRIVATE_KEY_PATH=<updater-key-file>
read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD && export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
node scripts/ship-desktop.mjs --version vX.Y.Z
```

`sign-and-notarize.mjs` signs every binary with the hardened runtime and the
entitlements in `scripts/release/entitlements/`, notarizes, staples, and
rewrites the manifest and checksums for the signed files. `ship-desktop.mjs`
publishes a DMG, a zip, the in-app update files (see below) and checksums as a
GitHub release on the repository named in
`packages/shared/constants/release.json`. It refuses an unsigned build unless
you pass `--allow-unsigned`, and an un-notarized build ships only with
`--no-updater`: it is never offered as an in-app update. To rehearse signing
without a certificate, pass `--identity - --skip-notarize`; the build then stays
blocked from shipping. A tag with a pre-release suffix, such as `v1.2.0-rc.1`, is
published as a GitHub pre-release, so installed apps never see it as the latest
release.

`--dry-run` does everything except publish. It does not build unless you also
pass `--build`, and it signs the update with the real key unless you pass
`--no-updater`. Keep signing keys outside the repository.

### In-app updates

The desktop app reads `latest.json` from the latest release (the endpoint in
`plugins.updater.endpoints` in `apps/desktop/src-tauri/tauri.conf.json`). The
user starts an update from the update notification or **Settings → Updates**
and confirms with **Install**. The app then downloads the archive that file
names (about 120 MB) and installs it only if the archive's signature matches
`plugins.updater.pubkey`, the update public key in the same file, and the
signature names the archive for the version offered. It keeps a copy of the
previous version beside the app until the new one passes a launch check, and
puts it back if that check fails. Only the production build updates itself:
preview builds carry no key or endpoint, and development runs refuse.

`ship-desktop.mjs` adds three files to every release:

- `Snaglet-vX.Y.Z-macos-arm64.app.tar.gz`: the signed, notarized and stapled
  `Snaglet.app`. The script makes it after signing, because Tauri's own updater
  archive (`createUpdaterArtifacts`, off in `tauri.production.conf.json`) would
  hold the unsigned build.
- `Snaglet-vX.Y.Z-macos-arm64.app.tar.gz.sig`: its signature, made with
  `tauri signer sign`.
- `latest.json`: the version, the archive's download URL and its signature.

The update key is a minisign key pair made with `tauri signer generate`. The
script takes the private key only from the environment, never as an argument:
`TAURI_SIGNING_PRIVATE_KEY_PATH` (or `TAURI_SIGNING_PRIVATE_KEY` holding the key
itself) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for a key without a
password). It never prints or writes the key. Without them it refuses to ship.

Before it publishes, the script checks that the archive holds only what the
updater can unpack (no AppleDouble, sparse or hard-link entries), that it
unpacks to a `Snaglet.app` that passes `codesign --verify --deep --strict`,
`xcrun stapler validate` and Gatekeeper, that the shipped app embeds the public
key, and that the signature names the archive and verifies against the public
key in `tauri.conf.json`. A wrong key fails here instead of on users' Macs.

`--no-updater` ships a release without the three files. Installed copies cannot
update to it: the update notification tells users to download it from the
release page. Use it only when the private key is not available.

If the private key is lost, no installed copy will accept another update signed
by it. Make a new key pair with
`pnpm --filter @snaglet/desktop-shell exec tauri signer generate -w <new-key-file>`,
put the new public key in `tauri.conf.json`, and ship the next release with
`--no-updater`: users install that release by hand once, and it trusts the new
key. Say so in its release notes. Later releases ship normally and install
from inside the app.

## Documentation gate

Run `pnpm lint:docs` (part of `pnpm lint`). It fails on personal paths,
real-looking ids, placeholders, plan wording, broken links and anchors, docs
missing from [docs/INDEX.md](./INDEX.md), tracked plans or notes, unlinked doc
images, and `pnpm` commands that name no script. The gate only proves that
scripts exist, so before a release also follow the README's Install steps on a
clean checkout. The rules for writing docs are in
[CONTRIBUTING.md](../CONTRIBUTING.md).
