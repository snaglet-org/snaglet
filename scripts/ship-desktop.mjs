#!/usr/bin/env node
/**
 * ship-desktop.mjs — package the built desktop app and publish it as a
 * GitHub Release on the release repository named in
 * packages/shared/constants/release.json.
 *
 * Usage:
 *   node scripts/ship-desktop.mjs --version v0.1.0 [--build] [--notes "..."] [--dry-run]
 *
 * Flags:
 *   --version <tag>  Required. Release tag, e.g. v0.1.0.
 *   --build          Run `pnpm build:desktop` + artifact verification first.
 *                    Without it, ships the existing dist/desktop-production output.
 *   --notes <text>   Release notes body (defaults to a generated summary).
 *   --no-dmg         Skip DMG creation (ship the zip only).
 *   --allow-unsigned Ship a build that is not Developer-ID-signed + notarized.
 *                    Public shipping requires notarization by default because
 *                    Gatekeeper rejects ad-hoc bundles outright ("damaged").
 *                    Sign first: node scripts/release/sign-and-notarize.mjs
 *                    Needs --no-updater: an un-notarized build is never
 *                    offered as an in-app update.
 *   --no-updater     Ship without the in-app update files. Installed copies
 *                    cannot update to this release; users download it by hand.
 *   --rotate-update-key
 *                    Publish update files although the published latest.json
 *                    was signed with another key (installed copies will refuse
 *                    this update). Without it, a key change stops the release.
 *   --skip-key-continuity-check
 *                    Do not read the published latest.json to compare keys
 *                    (for when GitHub cannot be reached).
 *   --dry-run        Do everything except create the GitHub release. It does
 *                    not build (pass --build for that), and it signs the update
 *                    with the real key unless --no-updater is passed.
 *
 * A tag with a pre-release suffix (v1.2.0-rc.1) is published as a GitHub
 * pre-release, so it never becomes the "latest" release installed apps read,
 * and it ships without update files.
 *
 * What it ships:
 *   - Snaglet-<version>-macos-arm64.dmg  (compressed disk image with /Applications symlink)
 *   - Snaglet-<version>-macos-arm64.zip  (zipped Snaglet.app bundle, ditto-preserved)
 *   - Snaglet-<version>-macos-arm64.app.tar.gz      (the in-app update, made from
 *     the signed, stapled Snaglet.app)
 *   - Snaglet-<version>-macos-arm64.app.tar.gz.sig  (its minisign signature)
 *   - latest.json                   (what installed apps read to find the update)
 *   - SHA256SUMS                    (checksums of dmg + zip + update + bundled files)
 *   - provenance.json               (build provenance from the pipeline)
 *   - artifact-manifest.json        (per-file hashes of the bundle)
 *
 * The update signing key reaches `tauri signer sign` only through the
 * environment: TAURI_SIGNING_PRIVATE_KEY_PATH (or TAURI_SIGNING_PRIVATE_KEY)
 * and TAURI_SIGNING_PRIVATE_KEY_PASSWORD. This script never reads, prints or
 * stores it. Its public half is plugins.updater.pubkey in tauri.conf.json.
 *
 * Requirements: gh CLI authenticated as a user with push access to REPO.
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  assertReleaseNativeHelpers,
  assertReleaseVersion,
  renderReleaseNotes,
  verifyAppEntitlements,
} from './release/contracts.mjs';
import {
  UPDATER_TAR_ENV,
  UPDATER_TARGET,
  assertUpdaterArchiveLayout,
  buildUpdaterManifest,
  publicKeyId,
  readTarEntries,
  signedFileName,
  updateKeyChange,
  updaterArchiveName,
  updaterSigningProblem,
  updaterTarCreateArgs,
  verifyUpdaterSignature,
} from './release/updater.mjs';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { repository: REPO } = JSON.parse(
  readFileSync(new URL('../packages/shared/constants/release.json', import.meta.url), 'utf8')
);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ARTIFACTS = join(ROOT, 'dist/desktop-production/artifacts');
const STAGE = join(ROOT, 'dist/desktop-production/ship');
const TAURI_CONFIG = join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
const TAURI_CLI = join(ROOT, 'apps/desktop/node_modules/.bin/tauri');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, {
    stdio: opts.capture ? 'pipe' : 'inherit',
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
  });
}

/** Like `run`, without a shell, so paths need no quoting. */
function runFile(file, fileArgs, opts = {}) {
  console.log(`\n$ ${file} ${fileArgs.join(' ')}`);
  return execFileSync(file, fileArgs, {
    stdio: opts.capture ? 'pipe' : 'inherit',
    cwd: ROOT,
    encoding: 'utf8',
    ...(opts.env ? { env: opts.env } : {}),
  });
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// parse args
const args = process.argv.slice(2);
const getFlag = (name) => args.includes(name);
const getOpt = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const version = getOpt('--version');
if (!version || !/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  fail('A semver tag is required, e.g. --version v0.1.0');
}
const dryRun = getFlag('--dry-run');
// GitHub's "latest" release never points at a pre-release, so installed apps
// and the server's release check never offer one.
const prerelease = version.includes('-');

// updater signing: refuse before any long step when the key is missing.
// Installed apps only update to full releases, so a pre-release never gets
// update files.
const withUpdater = !getFlag('--no-updater') && !prerelease;
const NO_UPDATER_WARNING = prerelease
  ? '\nPre-release tag: shipping without in-app update files. Installed apps only update to full releases.'
  : '\n⚠ --no-updater: this release has no in-app update files (latest.json, the signed archive).\n' +
    '  Installed copies of Snaglet CANNOT update themselves to it: they still show the update\n' +
    '  notice, but Install fails, says the release may not offer an in-app update, and offers\n' +
    '  the release page. Every user must download it by hand.';
const updaterPubkey = JSON.parse(readFileSync(TAURI_CONFIG, 'utf8')).plugins?.updater?.pubkey;
if (withUpdater) {
  const problem = updaterSigningProblem(process.env);
  if (problem) {
    fail(
      `${problem}\n` +
        'The update signing key is read only from the environment (see docs/release-process.md).\n' +
        'To ship a release that users must install by hand instead, pass --no-updater.'
    );
  }
  if (
    !process.env.TAURI_SIGNING_PRIVATE_KEY &&
    !existsSync(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)
  ) {
    fail('TAURI_SIGNING_PRIVATE_KEY_PATH does not name an existing file.');
  }
  if (!updaterPubkey) fail(`${TAURI_CONFIG} has no plugins.updater.pubkey to verify against.`);
  if (!existsSync(TAURI_CLI)) fail(`Tauri CLI not found at ${TAURI_CLI}. Run pnpm install.`);
  if (getFlag('--skip-key-continuity-check')) {
    console.log(
      '\n⚠ --skip-key-continuity-check: not comparing the update key with the published one.'
    );
  } else {
    await checkKeyContinuity();
  }
} else {
  console.log(NO_UPDATER_WARNING);
}

/**
 * Installed copies trust the key that signed the update they last read. Read
 * the published latest.json and stop when this release's key differs, unless
 * the change is deliberate (--rotate-update-key).
 */
async function checkKeyContinuity() {
  const url = `https://github.com/${REPO}/releases/latest/download/latest.json`;
  const retry = 'Check the network and try again, or pass --skip-key-continuity-check.';
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    fail(
      `Could not read the published latest.json to compare update keys (${error.message}).\n${retry}`
    );
  }
  if (response.status === 404) {
    console.log(
      '\nNo published latest.json: this is the first release with in-app updates (or the latest\n' +
        'release shipped without them), so there is no earlier update key to compare.'
    );
    return;
  }
  if (!response.ok) {
    fail(`Reading the published latest.json failed with status ${response.status}.\n${retry}`);
  }
  let change;
  try {
    change = updateKeyChange(await response.json(), updaterPubkey);
  } catch (error) {
    fail(`The published latest.json could not be read (${error.message}).\n${retry}`);
  }
  if (change === null) {
    console.log(`  ✔ update key ${publicKeyId(updaterPubkey)} matches the published latest.json`);
    return;
  }
  if (getFlag('--rotate-update-key')) {
    console.log(`\n⚠ --rotate-update-key: ${change}`);
    return;
  }
  fail(
    `${change}\n` +
      'If the key was lost or replaced on purpose, see "If the private key is lost" in\n' +
      'docs/release-process.md: ship with --no-updater, or pass --rotate-update-key.'
  );
}

// optionally build
if (getFlag('--build')) {
  run('pnpm build:server');
  run('pnpm build:desktop');
  run('pnpm verify:artifacts --profile desktop-production');
}

// validate artifacts exist
for (const required of ['Snaglet.app', 'SHA256SUMS', 'provenance.json', 'artifact-manifest.json']) {
  if (!existsSync(join(ARTIFACTS, required))) {
    fail(`Missing ${required} in ${ARTIFACTS}. Run with --build or run pnpm build:desktop first.`);
  }
}

const provenance = JSON.parse(readFileSync(join(ARTIFACTS, 'provenance.json'), 'utf8'));
const sourceVersion = JSON.parse(
  readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
).version;
const bundleVersion = execFileSync(
  '/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleShortVersionString', join(ARTIFACTS, 'Snaglet.app/Contents/Info.plist')],
  { encoding: 'utf8' }
).trim();
assertReleaseVersion(version, sourceVersion, bundleVersion);
try {
  assertReleaseNativeHelpers(
    JSON.parse(
      readFileSync(
        join(ARTIFACTS, 'Snaglet.app/Contents/Resources/server/native/helpers.json'),
        'utf8'
      )
    )
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
console.log(
  `\nShipping ${version} from source ${provenance.sourceIdentifier ?? 'unknown'} (profile: ${provenance.profile})`
);

// refuse to ship a bundle whose signature does not validate
// A bundle that fails this check reaches the user as "Snaglet is damaged and can't
// be opened", whose only button is Move to Trash — an unrecoverable first
// impression. The packager seals the bundle; this is the gate that makes sure
// an unsealed one can never become a release.
function verifySignature(app, label) {
  try {
    run(`codesign --verify --deep --strict "${app}"`, { capture: true });
    console.log(`  ✔ signature valid: ${label}`);
  } catch (err) {
    fail(
      `Code signature is not valid on ${label}.\n` +
        `macOS shows an unsealed bundle as "Snaglet is damaged and can't be opened".\n` +
        `Rebuild with pnpm build:desktop (the packager seals the bundle).\n${err.stderr ?? err.message ?? ''}`
    );
  }
}
verifySignature(join(ARTIFACTS, 'Snaglet.app'), 'dist artifact Snaglet.app');

// the manifest must describe the exact bytes being shipped
// Signing rewrites every binary; sign-and-notarize.mjs rewrites the manifest to
// match. If the executable hash disagrees, someone signed (or rebuilt) without
// regenerating the manifest — shipping it would publish provably wrong hashes.
const manifest = JSON.parse(readFileSync(join(ARTIFACTS, 'artifact-manifest.json'), 'utf8'));
const actualExecutableSha = await sha256(join(ARTIFACTS, manifest.executable));
if (actualExecutableSha !== manifest.executableSha256) {
  fail(
    'artifact-manifest.json does not match the bundle being shipped.\n' +
      'If you signed the bundle, sign-and-notarize.mjs rewrites the manifest — rerun it.\n' +
      'Otherwise rebuild with pnpm build:desktop.'
  );
}

// The shipped shell checks the NEXT update with the key it embeds; a stale
// build would leave its users unable to update again.
if (updaterPubkey && !readFileSync(join(ARTIFACTS, manifest.executable)).includes(updaterPubkey)) {
  fail(
    'Snaglet.app does not embed the updater public key from tauri.conf.json, so copies installed\n' +
      'from this release could not verify their next update. Rebuild with pnpm build:desktop.'
  );
}

// Gatekeeper gate: notarized by default, explicit opt-out for dev shipping
const allowUnsigned = getFlag('--allow-unsigned');
const notarized = manifest.signed === true && manifest.notarized === true;
if (notarized) {
  verifyAppEntitlements(join(ARTIFACTS, 'Snaglet.app'));
  run(`xcrun stapler validate "${join(ARTIFACTS, 'Snaglet.app')}"`, { capture: true });
  run(`spctl --assess --type execute "${join(ARTIFACTS, 'Snaglet.app')}"`, { capture: true });
  console.log('  ✔ Developer ID signed, notarized, stapled, and accepted by Gatekeeper');
} else if (allowUnsigned) {
  // Installed apps would swap themselves for this build without Gatekeeper
  // ever asking, so it may only ship as a manual download.
  if (withUpdater) {
    fail(
      'An un-notarized build must never be offered as an in-app update.\n' +
        'Pass --no-updater with --allow-unsigned, or sign and notarize first.'
    );
  }
  console.log(
    '\n⚠ Shipping WITHOUT notarization (--allow-unsigned).\n' +
      '  Every user will hit the Gatekeeper "Open Anyway" flow described in the release notes.'
  );
} else {
  fail(
    'This bundle is not Developer-ID-signed and notarized (manifest signed/notarized are false).\n' +
      'Gatekeeper rejects it outright, so public shipping is blocked by default.\n' +
      '  Sign first : node scripts/release/sign-and-notarize.mjs\n' +
      '  Override   : --allow-unsigned (users get the "Open Anyway" first-launch flow)'
  );
}

// stage: zip the bundle with ditto (preserves resource forks / permissions)
mkdirSync(STAGE, { recursive: true });
const zipName = `Snaglet-${version}-macos-arm64.zip`;
const zipPath = join(STAGE, zipName);
run(`ditto -c -k --sequesterRsrc --keepParent "${join(ARTIFACTS, 'Snaglet.app')}" "${zipPath}"`);

// DMG: staging dir with app + /Applications symlink, then compressed UDZO image
let dmgPath;
let dmgName;
if (!getFlag('--no-dmg')) {
  dmgName = `Snaglet-${version}-macos-arm64.dmg`;
  dmgPath = join(STAGE, dmgName);
  const dmgRoot = join(STAGE, 'dmg-root');
  run(`rm -rf "${dmgRoot}" "${dmgPath}" && mkdir -p "${dmgRoot}"`);
  run(`ditto "${join(ARTIFACTS, 'Snaglet.app')}" "${join(dmgRoot, 'Snaglet.app')}"`);
  run(`ln -s /Applications "${join(dmgRoot, 'Applications')}"`);
  // The volume has to answer the questions every first-time user hits:
  // install it (don't run it in place), and — for unsigned builds only — how to
  // clear the unnotarized-app block on first launch.
  const readMe = notarized ? 'Read Me First (signed).txt' : 'Read Me First.txt';
  run(`cp "${join(ROOT, 'scripts/release/dmg', readMe)}" "${join(dmgRoot, 'Read Me First.txt')}"`);
  run(
    `hdiutil create -volname "Snaglet ${version}" -srcfolder "${dmgRoot}" -ov -format UDZO "${dmgPath}"`
  );
  run(`hdiutil verify "${dmgPath}"`);
  run(`rm -rf "${dmgRoot}"`);

  // Verify the app as the user receives it: inside the mounted image, after
  // ditto + hdiutil have had their chance to drop the seal.
  const mountPoint = join(STAGE, 'verify-mount');
  run(`rm -rf "${mountPoint}" && mkdir -p "${mountPoint}"`);
  let problem;
  try {
    run(`hdiutil attach "${dmgPath}" -nobrowse -readonly -mountpoint "${mountPoint}"`);
    const missing = ['Snaglet.app', 'Applications', 'Read Me First.txt'].filter(
      (entry) => !existsSync(join(mountPoint, entry))
    );
    if (missing.length) problem = `DMG volume is missing: ${missing.join(', ')}`;
    else {
      run(`codesign --verify --deep --strict "${join(mountPoint, 'Snaglet.app')}"`, {
        capture: true,
      });
      console.log(
        '  ✔ mounted volume: Snaglet.app signature valid, Applications symlink and read-me present'
      );
    }
  } catch (err) {
    problem = `Snaglet.app inside the mounted DMG failed verification.\n${err.stderr ?? err.message ?? ''}`;
  } finally {
    // Always unmount: leaving a stray volume behind on failure hides the error.
    run(`hdiutil detach "${mountPoint}" -force || true`);
    run(`rm -rf "${mountPoint}"`);
  }
  if (problem) fail(problem);
}

// in-app update: archive the signed, stapled app, check it, sign it, describe it
let updater;
if (withUpdater) updater = await stageUpdater();

async function stageUpdater() {
  const archiveName = updaterArchiveName(version);
  const archivePath = join(STAGE, archiveName);
  const signaturePath = `${archivePath}.sig`;
  const latestPath = join(STAGE, 'latest.json');
  rmSync(archivePath, { force: true });
  rmSync(signaturePath, { force: true });
  rmSync(latestPath, { force: true });

  // tauri-plugin-updater strips the first path component and unpacks the rest
  // with the `tar` crate, so archive the bundle itself with the flags that
  // avoid what that crate cannot unpack (scripts/release/updater.mjs).
  runFile('tar', updaterTarCreateArgs(archivePath, ARTIFACTS), {
    env: { ...process.env, ...UPDATER_TAR_ENV },
  });
  try {
    assertUpdaterArchiveLayout(await readTarEntries(archivePath));
  } catch (error) {
    fail(`The update archive would not install cleanly: ${error.message}`);
  }

  // The app as an updated user will run it: unpacked from the archive. Only a
  // notarized build gets this far (see the Gatekeeper gate above).
  const unpacked = mkdtempSync(join(tmpdir(), 'snaglet-updater-verify-'));
  // fail() exits at once, so the temp dir is removed before reporting.
  let problem = null;
  try {
    runFile('tar', ['-xzf', archivePath, '-C', unpacked]);
    const app = join(unpacked, 'Snaglet.app');
    runFile('codesign', ['--verify', '--deep', '--strict', app], { capture: true });
    runFile('xcrun', ['stapler', 'validate', app], { capture: true });
    runFile('spctl', ['--assess', '--type', 'execute', app], { capture: true });
  } catch (error) {
    problem = `Snaglet.app unpacked from the update archive failed verification.\n${error.stderr ?? error.message ?? ''}`;
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
  if (problem) fail(problem);
  console.log(
    '  ✔ update archive unpacks to a Snaglet.app that is signed, stapled, and accepted by Gatekeeper'
  );

  // The key comes from the environment; never echo the signer's output as-is.
  const secrets = [
    process.env.TAURI_SIGNING_PRIVATE_KEY,
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  ].filter(Boolean);
  const redact = (text) =>
    secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text ?? ''));
  console.log(`\n$ tauri signer sign ${archivePath}`);
  try {
    execFileSync(TAURI_CLI, ['signer', 'sign', archivePath], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    fail(`tauri signer sign failed:\n${redact(error.stderr || error.stdout || error.message)}`);
  }
  if (!existsSync(signaturePath)) fail(`tauri signer sign wrote no ${signaturePath}`);
  const signature = readFileSync(signaturePath, 'utf8').trim();
  // The app refuses an archive whose signed file name is not the one for the
  // version it is offered, so an older signed archive cannot pose as newer.
  if (signedFileName(signature) !== archiveName) {
    fail(`The update signature names ${signedFileName(signature)}, not ${archiveName}.`);
  }

  const latest = buildUpdaterManifest({
    tag: version,
    repository: REPO,
    archiveName,
    signature,
    notes: `Snaglet ${version}. Release notes: https://github.com/${REPO}/releases/tag/${version}`,
    pubDate: new Date(),
  });
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);

  // Verify as the installed app will: the signature latest.json carries, over
  // the archive bytes, with the key installed apps trust.
  const published = JSON.parse(readFileSync(latestPath, 'utf8')).platforms[UPDATER_TARGET];
  try {
    await verifyUpdaterSignature(archivePath, published.signature, updaterPubkey);
  } catch (error) {
    fail(`The update signature does not verify against tauri.conf.json: ${error.message}`);
  }
  console.log(`  ✔ update signature verifies against the updater key in tauri.conf.json`);
  console.log(`  ✔ latest.json → ${published.url}`);
  return { archiveName, archivePath, signaturePath, latestPath };
}

// checksums: dmg + zip + update archive + the pipeline's own sums
const zipHash = await sha256(zipPath);
const pipelineSums = readFileSync(join(ARTIFACTS, 'SHA256SUMS'), 'utf8').trimEnd();
const sumsPath = join(STAGE, 'SHA256SUMS');
const dmgLine = dmgPath ? `${await sha256(dmgPath)}  ${dmgName}\n` : '';
const updaterLine = updater ? `${await sha256(updater.archivePath)}  ${updater.archiveName}\n` : '';
writeFileSync(sumsPath, `${dmgLine}${zipHash}  ${zipName}\n${updaterLine}${pipelineSums}\n`);
console.log(`\n${dmgLine}${zipHash}  ${zipName}\n${updaterLine}`);

// release notes
// The download page is where the Gatekeeper question gets asked, so it is where
// it has to be answered. Signed + notarized builds get the clean install copy;
// unsigned builds get the "Open Anyway" walkthrough. --notes still overrides.
const commit = provenance.sourceIdentifier ?? '';
const notesTemplate = notarized ? 'release-notes-signed.md' : 'release-notes.md';
let notes = getOpt('--notes');
if (notes === undefined) {
  try {
    notes = renderReleaseNotes(readFileSync(join(ROOT, 'scripts/release', notesTemplate), 'utf8'), {
      VERSION: version,
      RELEASE_REPOSITORY: REPO,
      SOURCE_REPOSITORY: REPO,
      COMMIT_SHORT: commit.slice(0, 9),
      COMMIT: commit,
    });
  } catch (err) {
    fail(`${notesTemplate}: ${err.message}`);
  }
}

// publish
const assets = [
  ...(dmgPath ? [dmgPath] : []),
  zipPath,
  ...(updater ? [updater.archivePath, updater.signaturePath, updater.latestPath] : []),
  sumsPath,
  join(ARTIFACTS, 'provenance.json'),
  join(ARTIFACTS, 'artifact-manifest.json'),
]
  .map((p) => `"${p}"`)
  .join(' ');

const prereleaseFlag = prerelease ? ' --prerelease' : '';
if (dryRun) {
  console.log(
    `\n[dry-run] Would create ${prerelease ? 'pre-release' : 'release'} ${version} on ${REPO} with assets:\n  ${assets}`
  );
  if (!updater) console.log(NO_UPDATER_WARNING);
  process.exit(0);
}

const notesPath = join(STAGE, 'RELEASE_NOTES.md');
writeFileSync(notesPath, notes);
run(
  `gh release create "${version}" ${assets} --repo ${REPO} --title "Snaglet ${version}" --notes-file "${notesPath}"${prereleaseFlag}`
);

console.log(`\n✔ Shipped: https://github.com/${REPO}/releases/tag/${version}`);
if (!updater) console.log(NO_UPDATER_WARNING);
