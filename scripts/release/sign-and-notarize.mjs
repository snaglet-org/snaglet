#!/usr/bin/env node
/**
 * sign-and-notarize.mjs — Developer ID signing + Apple notarization for the
 * packaged desktop bundle, run after `pnpm build:desktop` (+ verify) and
 * before `scripts/ship-desktop.mjs`.
 *
 * The build pipeline deliberately produces an ad-hoc-sealed, releaseEligible:false
 * candidate (see build/scripts/package-desktop.ts). This script upgrades that
 * candidate in place:
 *
 *   1. Re-signs every nested Mach-O inside-out with the Developer ID identity,
 *      hardened runtime, and a secure timestamp. The Node sidecar gets the JIT
 *      entitlements it needs to boot under the hardened runtime.
 *   2. Signs the .app bundle itself and verifies the whole seal.
 *   3. Submits a zip to Apple notarization (notarytool) and staples the ticket.
 *   4. Rewrites artifact-manifest.json / SHA256SUMS / provenance.json so the
 *      manifest describes the signed bytes and flips signed / notarized /
 *      releaseEligible to the truth. ship-desktop.mjs refuses stale manifests,
 *      so skipping this step can never ship mismatched hashes.
 *
 * One-time setup (see docs/release-process.md for the full walkthrough):
 *   - Apple Developer Program membership.
 *   - A "Developer ID Application" certificate in the login keychain.
 *   - xcrun notarytool store-credentials snaglet-notary \
 *       --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific>
 *
 * Usage:
 *   node scripts/release/sign-and-notarize.mjs \
 *     [--identity "Developer ID Application: Name (TEAMID)"] \
 *     [--notary-profile snaglet-notary] [--skip-notarize] [--app <path>]
 *
 * Env fallbacks: SNAGLET_SIGNING_IDENTITY, SNAGLET_NOTARY_PROFILE.
 * `--identity -` (ad-hoc) is accepted for pipeline rehearsal only: it exercises
 * the exact hardened-runtime + entitlements signing path without a certificate,
 * and the rewritten manifest stays signed:false / releaseEligible:false.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { verifyAppEntitlements } from './contracts.mjs';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function run(file, args, opts = {}) {
  console.log(`$ ${file} ${args.join(' ')}`);
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: opts.capture ? 'pipe' : 'inherit',
    ...opts,
  });
}

function capture(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// arguments
const args = process.argv.slice(2);
const getOpt = (name) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : undefined;
};
const skipNotarize = args.includes('--skip-notarize');
const identity = getOpt('--identity') ?? process.env.SNAGLET_SIGNING_IDENTITY;
const notaryProfile = getOpt('--notary-profile') ?? process.env.SNAGLET_NOTARY_PROFILE;
const app = resolve(getOpt('--app') ?? join(ROOT, 'dist/desktop-production/artifacts/Snaglet.app'));
const artifacts = resolve(app, '..');
const appEntitlements = join(ROOT, 'scripts/release/entitlements/snaglet-app.entitlements.plist');
const entitlements = join(ROOT, 'scripts/release/entitlements/snaglet-node.entitlements.plist');
const pgEntitlements = join(ROOT, 'scripts/release/entitlements/pg.entitlements.plist');

if (process.platform !== 'darwin') fail('Signing requires macOS.');
if (!identity) {
  fail(
    'A signing identity is required: --identity "Developer ID Application: …" or SNAGLET_SIGNING_IDENTITY.\n' +
      'List available identities with: security find-identity -v -p codesigning'
  );
}
if (!skipNotarize && !notaryProfile) {
  fail(
    'Notarization needs --notary-profile (or SNAGLET_NOTARY_PROFILE), a keychain profile created with\n' +
      '  xcrun notarytool store-credentials snaglet-notary --apple-id … --team-id … --password …\n' +
      'Pass --skip-notarize to sign without submitting to Apple (not releasable).'
  );
}
if (!existsSync(app)) fail(`Bundle not found: ${app}\nRun pnpm build:desktop first.`);
const manifestPath = join(artifacts, 'artifact-manifest.json');
if (!existsSync(manifestPath)) fail(`Missing ${manifestPath} next to the bundle.`);
if (!existsSync(entitlements)) fail(`Missing entitlements file: ${entitlements}`);
if (!existsSync(appEntitlements)) fail(`Missing entitlements file: ${appEntitlements}`);
if (!existsSync(pgEntitlements)) fail(`Missing entitlements file: ${pgEntitlements}`);
const adhoc = identity === '-';
if (adhoc) {
  console.log(
    '\n⚠ Ad-hoc rehearsal mode (--identity -): signing runs, but the manifest stays releaseEligible:false.'
  );
}

// enumerate Mach-O files, deepest first
function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(absolute) : [absolute];
    });
}

function isMachO(file) {
  const description = capture('/usr/bin/file', ['-b', file]);
  return description.status === 0 && description.stdout.includes('Mach-O');
}

const allFiles = walkFiles(app);
const mainExecutable = join(app, 'Contents/MacOS/desktop');
const nestedMachO = allFiles
  .filter((file) => file !== mainExecutable && isMachO(file))
  // Deepest paths first, so anything nested is sealed before its container.
  .sort((left, right) => right.split(sep).length - left.split(sep).length);

console.log(
  `\nSigning ${nestedMachO.length} nested Mach-O files + bundle with identity: ${identity}`
);

// sign nested binaries, then the bundle
// --timestamp needs Apple's timestamp service and a real identity; ad-hoc
// rehearsal signs without it.
const timestampFlags = adhoc ? [] : ['--timestamp'];

function sign(target, extraFlags = []) {
  run(
    'codesign',
    [
      '--force',
      '--options',
      'runtime',
      ...timestampFlags,
      ...extraFlags,
      '--sign',
      identity,
      target,
    ],
    {
      capture: true,
    }
  );
}

for (const file of nestedMachO) {
  const isNodeSidecar = file.endsWith('/Contents/MacOS/snaglet-node');
  // PostgreSQL executables dlopen bundled dylibs (libpq, pgvector, encodings);
  // library validation SIGABRTs those loads — see pg.entitlements.plist.
  const isPgExecutable = file.includes('/Contents/Resources/pg/bin/');
  sign(
    file,
    isNodeSidecar
      ? ['--entitlements', entitlements]
      : isPgExecutable
        ? ['--entitlements', pgEntitlements]
        : []
  );
}
// The bundle sign covers the main executable and re-seals Contents/Resources.
sign(app, ['--entitlements', appEntitlements]);

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
verifyAppEntitlements(app);

const details = capture('codesign', ['-dvv', app]).stderr;
const teamMatch = details.match(/^TeamIdentifier=(.+)$/m);
const teamIdentifier = teamMatch && teamMatch[1] !== 'not set' ? teamMatch[1] : null;
const signed = teamIdentifier !== null;
if (!adhoc && !signed)
  fail('Signing succeeded but no TeamIdentifier is present — not a Developer ID signature.');
console.log(`\n✔ bundle signed (${signed ? `team ${teamIdentifier}` : 'ad-hoc rehearsal'})`);

// notarize + staple
let notarized = false;
if (!skipNotarize) {
  const scratch = mkdtempSync(join(tmpdir(), 'snaglet-notarize-'));
  const submission = join(scratch, 'Snaglet-notarize.zip');
  try {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, submission]);
    console.log('\nSubmitting to Apple notarization (this typically takes a few minutes)…');
    const output = run(
      'xcrun',
      ['notarytool', 'submit', submission, '--keychain-profile', notaryProfile, '--wait'],
      { capture: true }
    );
    console.log(output);
    if (!/status:\s*Accepted/.test(output)) {
      const id = output.match(/id:\s*([0-9a-f-]+)/)?.[1];
      fail(
        `Notarization was not accepted.${id ? `\nInspect the log with: xcrun notarytool log ${id} --keychain-profile ${notaryProfile}` : ''}`
      );
    }
    run('xcrun', ['stapler', 'staple', app]);
    run('xcrun', ['stapler', 'validate', app]);
    const assessment = capture('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    if (assessment.status !== 0) {
      fail(
        `Gatekeeper still rejects the stapled bundle:\n${assessment.stderr || assessment.stdout}`
      );
    }
    notarized = true;
    console.log('\n✔ notarized, stapled, and accepted by Gatekeeper');
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
} else {
  console.log(
    '\n⚠ --skip-notarize: bundle is signed but NOT notarized. Gatekeeper will block downloads.'
  );
}

// rewrite the manifest to describe the signed bytes
// Signing and stapling rewrote binaries and added the notarization ticket, so
// every hash in artifact-manifest.json is now stale. Recompute with the same
// walk order the packager uses, and flip the release flags to the truth.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const files = walkFiles(app).map((file) => ({
  path: relative(artifacts, file).split(sep).join('/'),
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  size: statSync(file).size,
}));
const executableSha256 = createHash('sha256').update(readFileSync(mainExecutable)).digest('hex');
manifest.files = files;
manifest.executableSha256 = executableSha256;
manifest.executableSize = statSync(mainExecutable).size;
manifest.totalBytes = files.reduce((total, file) => total + file.size, 0);
manifest.signed = signed;
manifest.notarized = notarized;
manifest.releaseEligible = signed && notarized;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(artifacts, 'SHA256SUMS'),
  files.map((file) => `${file.sha256}  ${file.path}\n`).join('')
);

const provenancePath = join(artifacts, 'provenance.json');
if (existsSync(provenancePath)) {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  provenance.releaseEligible = manifest.releaseEligible;
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}

console.log(
  `\n✔ manifest rewritten: signed=${manifest.signed} notarized=${manifest.notarized} releaseEligible=${manifest.releaseEligible}`
);
if (manifest.releaseEligible) {
  console.log('Ready to publish: node scripts/ship-desktop.mjs --version vX.Y.Z');
} else {
  console.log('Not release-eligible; ship-desktop.mjs will refuse without --allow-unsigned.');
}
