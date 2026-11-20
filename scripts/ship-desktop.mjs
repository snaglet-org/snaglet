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
 *   --dry-run        Do everything except create the GitHub release.
 *
 * What it ships:
 *   - Snaglet-<version>-macos-arm64.dmg  (compressed disk image with /Applications symlink)
 *   - Snaglet-<version>-macos-arm64.zip  (zipped Snaglet.app bundle, ditto-preserved)
 *   - SHA256SUMS                    (checksums of dmg + zip + bundled executables)
 *   - provenance.json               (build provenance from the pipeline)
 *   - artifact-manifest.json        (per-file hashes of the bundle)
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
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { repository: REPO } = JSON.parse(
  readFileSync(new URL('../packages/shared/constants/release.json', import.meta.url), 'utf8')
);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const ARTIFACTS = join(ROOT, 'dist/desktop-production/artifacts');
const STAGE = join(ROOT, 'dist/desktop-production/ship');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, {
    stdio: opts.capture ? 'pipe' : 'inherit',
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
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

// Gatekeeper gate: notarized by default, explicit opt-out for dev shipping
const allowUnsigned = getFlag('--allow-unsigned');
const notarized = manifest.signed === true && manifest.notarized === true;
if (notarized) {
  verifyAppEntitlements(join(ARTIFACTS, 'Snaglet.app'));
  run(`xcrun stapler validate "${join(ARTIFACTS, 'Snaglet.app')}"`, { capture: true });
  run(`spctl --assess --type execute "${join(ARTIFACTS, 'Snaglet.app')}"`, { capture: true });
  console.log('  ✔ Developer ID signed, notarized, stapled, and accepted by Gatekeeper');
} else if (allowUnsigned) {
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

// checksums: dmg + zip + the pipeline's own sums
const zipHash = await sha256(zipPath);
const pipelineSums = readFileSync(join(ARTIFACTS, 'SHA256SUMS'), 'utf8').trimEnd();
const sumsPath = join(STAGE, 'SHA256SUMS');
const dmgLine = dmgPath ? `${await sha256(dmgPath)}  ${dmgName}\n` : '';
writeFileSync(sumsPath, `${dmgLine}${zipHash}  ${zipName}\n${pipelineSums}\n`);
console.log(`\n${dmgLine}${zipHash}  ${zipName}`);

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
  sumsPath,
  join(ARTIFACTS, 'provenance.json'),
  join(ARTIFACTS, 'artifact-manifest.json'),
]
  .map((p) => `"${p}"`)
  .join(' ');

if (dryRun) {
  console.log(`\n[dry-run] Would create release ${version} on ${REPO} with assets:\n  ${assets}`);
  process.exit(0);
}

const notesPath = join(STAGE, 'RELEASE_NOTES.md');
writeFileSync(notesPath, notes);
run(
  `gh release create "${version}" ${assets} --repo ${REPO} --title "Snaglet ${version}" --notes-file "${notesPath}"`
);

console.log(`\n✔ Shipped: https://github.com/${REPO}/releases/tag/${version}`);
