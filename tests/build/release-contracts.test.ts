import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  APP_DEVICE_ENTITLEMENTS,
  assertAppEntitlements,
  assertReleaseNativeHelpers,
  assertReleaseVersion,
  renderReleaseNotes,
  verifyAppEntitlements,
} from '../../scripts/release/contracts.mjs';

test('a release must bundle every required native helper, whatever the build skipped', () => {
  const helpers = {
    'apple-stt': { policy: 'required', status: 'bundled' },
    'apple-chat': { policy: 'best-effort', status: 'skipped', reason: 'buildFailed' },
  };
  assert.doesNotThrow(() => assertReleaseNativeHelpers({ macosSdk: '26.2', helpers }));
  assert.throws(
    () =>
      assertReleaseNativeHelpers({
        macosSdk: '15.4',
        helpers: {
          ...helpers,
          'apple-stt': { policy: 'required', status: 'skipped', reason: 'sdkTooOld' },
        },
      }),
    /missing required native helpers: apple-stt \(sdkTooOld\)\. It was built with the macOS 15\.4 SDK/
  );
});

test('release tag, source, and actual bundle version must agree', () => {
  assert.doesNotThrow(() => assertReleaseVersion('v2.3.4', '2.3.4', '2.3.4'));
  assert.doesNotThrow(() => assertReleaseVersion('v2.3.4-rc.1', '2.3.4-rc.1', '2.3.4-rc.1'));
  assert.throws(() => assertReleaseVersion('v2.3.5', '2.3.4', '2.3.4'), /version mismatch/);
  assert.throws(() => assertReleaseVersion('v2.3.4', '2.3.4', '2.3.3'), /version mismatch/);
});

test('camera and audio permissions must be true in the final app signature', () => {
  const complete = Object.fromEntries(APP_DEVICE_ENTITLEMENTS.map((key) => [key, true]));
  assert.doesNotThrow(() => assertAppEntitlements(complete));
  for (const key of APP_DEVICE_ENTITLEMENTS) {
    assert.throws(
      () => assertAppEntitlements({ ...complete, [key]: false }),
      /required entitlement/
    );
    assert.throws(
      () => assertAppEntitlements({ ...complete, [key]: 'true' }),
      /required entitlement/
    );
  }
  assert.throws(() => assertAppEntitlements({}), /required entitlement/);
});

test('release notes fill every placeholder, or name the ones left', () => {
  assert.equal(
    renderReleaseNotes('{{COMMIT_SHORT}} of {{COMMIT}} in {{SOURCE_REPOSITORY}}', {
      COMMIT: 'abcdef0123456789',
      COMMIT_SHORT: 'abcdef012',
      SOURCE_REPOSITORY: 'owner/repo',
    }),
    'abcdef012 of abcdef0123456789 in owner/repo'
  );
  assert.throws(
    () => renderReleaseNotes('{{VERSION}} {{COMMMIT}} {{OTHER}} {{OTHER}}', { VERSION: 'v1.0.0' }),
    /unfilled placeholders: \{\{COMMMIT\}\}, \{\{OTHER\}\}$/
  );
});

test('both release-notes templates render with the values ship-desktop supplies', () => {
  const values = {
    VERSION: 'v1.2.3',
    RELEASE_REPOSITORY: 'owner/releases',
    SOURCE_REPOSITORY: 'owner/source',
    COMMIT_SHORT: 'abcdef012',
    COMMIT: 'abcdef0123456789',
  };
  for (const name of ['release-notes.md', 'release-notes-signed.md']) {
    const notes = renderReleaseNotes(readFileSync(`scripts/release/${name}`, 'utf8'), values);
    assert.match(notes, /https:\/\/github\.com\/owner\/source\/commit\/abcdef0123456789/, name);
  }
});

test('release.json names the repository as owner/repo', () => {
  const release = JSON.parse(readFileSync('packages/shared/constants/release.json', 'utf8'));
  assert.deepEqual(Object.keys(release), ['repository']);
  assert.match(release.repository, /^[\w.-]+\/[\w.-]+$/);
});

test('Tauri updater endpoint matches the distribution configuration', () => {
  const release = JSON.parse(readFileSync('packages/shared/constants/release.json', 'utf8'));
  const config = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(
    config.plugins.updater.endpoints[0],
    `https://github.com/${release.repository}/releases/latest/download/latest.json`
  );
});

test(
  'entitlement verifier reads a real hardened-runtime signature',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'snaglet-signature-test-'));
    try {
      const binary = path.join(root, 'probe');
      // Sign only a disposable copy; no compiler or hardware access is needed.
      copyFileSync('/usr/bin/true', binary);
      execFileSync('codesign', ['--force', '--options', 'runtime', '--sign', '-', binary], {
        stdio: 'pipe',
      });
      assert.throws(() => verifyAppEntitlements(binary));
      execFileSync(
        'codesign',
        [
          '--force',
          '--options',
          'runtime',
          '--entitlements',
          path.resolve('scripts/release/entitlements/snaglet-app.entitlements.plist'),
          '--sign',
          '-',
          binary,
        ],
        { stdio: 'pipe' }
      );
      assert.doesNotThrow(() => verifyAppEntitlements(binary));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
