import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  macosSdkMajor,
  NATIVE_HELPERS,
  nativeHelperExecutablePath,
  stageNativeHelperEntry,
  stageNativeHelpers,
} from '../../apps/server/scripts/lib/nativeHelpers.mjs';
import {
  assertNativeHelpers,
  assertPackagedFsevents,
  BEST_EFFORT_NATIVE_HELPERS,
  describeSdkSkippedHelpers,
  KNOWN_NATIVE_HELPERS,
  parseNativeHelpersManifest,
  REQUIRED_NATIVE_HELPERS,
} from '../../build/scripts/native-helpers';

type Helper = (typeof NATIVE_HELPERS)[number];

interface FakeIo {
  platform: string;
  desktopProfile: boolean;
  profile: string;
  arch: string;
  sdkVersion: string | null;
  built: string[];
  copied: string[];
  logs: string[];
  failBuild: Set<string>;
  present: Set<string>;
}

function io(overrides: Partial<FakeIo> = {}) {
  const state: FakeIo = {
    platform: 'darwin',
    desktopProfile: true,
    profile: 'desktop-production',
    arch: 'arm64',
    sdkVersion: '26.2',
    built: [],
    copied: [],
    logs: [],
    failBuild: new Set(),
    present: new Set(),
    ...overrides,
  };
  return {
    state,
    platform: state.platform,
    desktopProfile: state.desktopProfile,
    profile: state.profile,
    arch: state.arch,
    sdkVersion: state.sdkVersion,
    build: (helper: Helper) => {
      state.built.push(helper.name);
      if (state.failBuild.has(helper.name)) throw new Error(`swiftc failed for ${helper.name}`);
      state.present.add(nativeHelperExecutablePath(helper));
    },
    exists: (relative: string) => state.present.has(relative),
    copy: (relative: string) => {
      state.copied.push(relative);
    },
    log: (message: string) => {
      state.logs.push(message);
    },
  };
}

const helper = (name: string): Helper => {
  const found = NATIVE_HELPERS.find((entry) => entry.name === name);
  assert.ok(found, `unknown helper ${name}`);
  return found;
};

test('the bundle policy table and the verifier binding describe the same helper set', () => {
  const fromBundle = Object.fromEntries(
    NATIVE_HELPERS.map((entry) => [
      entry.name,
      {
        policy: entry.policy,
        executable: nativeHelperExecutablePath(entry),
        ...(entry.minimumSdk === undefined ? {} : { minimumSdk: entry.minimumSdk }),
      },
    ])
  );
  assert.deepEqual(fromBundle, KNOWN_NATIVE_HELPERS);
  assert.equal(KNOWN_NATIVE_HELPERS['apple-stt']?.minimumSdk, 26);
  assert.deepEqual([...REQUIRED_NATIVE_HELPERS], ['apple-stt', 'apple-tts', 'nlp-helper']);
  assert.deepEqual([...BEST_EFFORT_NATIVE_HELPERS], ['apple-chat', 'cursor-overlay']);
});

test('desktop profile builds and stages every helper on a clean worktree', () => {
  const fake = io();
  const manifest = stageNativeHelpers(fake);
  assert.deepEqual(fake.state.built, [
    'apple-stt',
    'apple-tts',
    'nlp-helper',
    'apple-chat',
    'cursor-overlay',
  ]);
  assert.deepEqual(fake.state.copied, NATIVE_HELPERS.map(nativeHelperExecutablePath));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, 'darwin-arm64');
  assert.equal(manifest.macosSdk, '26.2');
  for (const entry of Object.values(manifest.helpers)) assert.equal(entry.status, 'bundled');
  // The manifest the bundle writes is exactly what the verifier accepts.
  assertNativeHelpers(manifest, '/bundle', KNOWN_NATIVE_HELPERS, (absolute) =>
    fake.state.present.has(absolute.replace('/bundle/', ''))
  );
});

test('a failed best-effort build never stages a stale binary from an earlier build', () => {
  const stale = nativeHelperExecutablePath(helper('apple-chat'));
  const fake = io({ failBuild: new Set(['apple-chat']), present: new Set([stale]) });
  const entry = stageNativeHelperEntry(helper('apple-chat'), fake);
  assert.deepEqual(entry, {
    policy: 'best-effort',
    executable: stale,
    status: 'skipped',
    reason: 'buildFailed',
  });
  assert.deepEqual(fake.state.copied, []);
  assert.ok(fake.state.logs.some((line) => line.includes('build failed (best-effort)')));
});

test('a failed required build fails the desktop bundle even with a stale binary present', () => {
  const stale = nativeHelperExecutablePath(helper('nlp-helper'));
  const fake = io({ failBuild: new Set(['nlp-helper']), present: new Set([stale]) });
  assert.throws(() => stageNativeHelperEntry(helper('nlp-helper'), fake), /swiftc failed/);
  assert.deepEqual(fake.state.copied, []);
});

test('a required helper whose build produced no binary fails the desktop bundle', () => {
  const fake = io();
  fake.build = (h: Helper) => {
    fake.state.built.push(h.name);
  };
  assert.throws(
    () => stageNativeHelperEntry(helper('apple-stt'), fake),
    /desktop bundle requires native\/apple-stt\/bin\/snaglet-apple-stt/
  );
});

test('API-only bundles never compile: they stage what exists and record the rest', () => {
  const stt = nativeHelperExecutablePath(helper('apple-stt'));
  const fake = io({ desktopProfile: false, profile: 'api', present: new Set([stt]) });
  const manifest = stageNativeHelpers(fake);
  assert.deepEqual(fake.state.built, []);
  assert.deepEqual(fake.state.copied, [stt]);
  assert.equal(manifest.helpers['apple-stt'].status, 'bundled');
  assert.deepEqual(manifest.helpers['nlp-helper'], {
    policy: 'required',
    executable: 'native/nlp-helper/bin/snaglet-nlp-helper',
    status: 'skipped',
    reason: 'notBuilt',
  });
});

test('non-darwin builds record every helper as skipped without touching the toolchain', () => {
  const fake = io({
    platform: 'linux',
    desktopProfile: true,
    profile: 'desktop-preview',
    arch: 'x64',
  });
  const manifest = stageNativeHelpers(fake);
  assert.deepEqual(fake.state.built, []);
  for (const entry of Object.values(manifest.helpers)) {
    assert.equal(entry.status, 'skipped');
    assert.equal(entry.reason, 'nonDarwin');
  }
});

test('an SDK older than a helper needs skips that helper, even a required one, without building it', () => {
  const fake = io({ sdkVersion: '15.4' });
  const manifest = stageNativeHelpers(fake);
  assert.deepEqual(fake.state.built, ['apple-tts', 'nlp-helper', 'apple-chat', 'cursor-overlay']);
  assert.equal(manifest.macosSdk, '15.4');
  assert.deepEqual(manifest.helpers['apple-stt'], {
    policy: 'required',
    executable: 'native/apple-stt/bin/snaglet-apple-stt',
    status: 'skipped',
    reason: 'sdkTooOld',
  });
  assert.ok(
    fake.state.logs.some((line) =>
      /apple-stt needs the macOS 26 SDK and this build uses the macOS 15\.4 SDK — not built \(server falls back to local STT\)/.test(
        line
      )
    )
  );
  // The bundle's own manifest passes verification with apple-stt absent.
  const parsed = assertNativeHelpers(manifest, '/bundle', KNOWN_NATIVE_HELPERS, (absolute) =>
    fake.state.present.has(absolute.replace('/bundle/', ''))
  );
  assert.deepEqual(describeSdkSkippedHelpers(parsed), [
    'apple-stt is not bundled: built with the macOS 15.4 SDK, it needs the macOS 26 SDK',
  ]);
});

test('a stale binary is never staged for a helper the SDK cannot build', () => {
  const stale = nativeHelperExecutablePath(helper('apple-stt'));
  const fake = io({ sdkVersion: '15.4', present: new Set([stale]) });
  assert.equal(stageNativeHelperEntry(helper('apple-stt'), fake).reason, 'sdkTooOld');
  assert.deepEqual(fake.state.copied, []);
});

test('a compile error on an SDK that has the APIs still fails the desktop bundle', () => {
  for (const sdkVersion of ['26.0', '26.5', '27.0']) {
    const fake = io({ sdkVersion, failBuild: new Set(['apple-stt']) });
    assert.throws(() => stageNativeHelpers(fake), /swiftc failed for apple-stt/, sdkVersion);
    assert.deepEqual(fake.state.built, ['apple-stt']);
  }
});

test('an unreadable SDK version builds every helper and never turns a failure into a skip', () => {
  const fake = io({ sdkVersion: null, failBuild: new Set(['apple-stt']) });
  assert.throws(() => stageNativeHelpers(fake), /swiftc failed for apple-stt/);
  const clean = io({ sdkVersion: null });
  const manifest = stageNativeHelpers(clean);
  assert.equal(manifest.macosSdk, null);
  assert.equal(manifest.helpers['apple-stt'].status, 'bundled');
});

test('macosSdkMajor reads the major version of an SDK version string', () => {
  assert.equal(macosSdkMajor('15.4'), 15);
  assert.equal(macosSdkMajor('26'), 26);
  assert.equal(macosSdkMajor(' 26.5.1\n'), 26);
  assert.equal(macosSdkMajor(''), null);
  assert.equal(macosSdkMajor(null), null);
  assert.equal(macosSdkMajor('MacOSX15.sdk'), null);
});

function bundledManifest(overrides: Record<string, Partial<Record<string, unknown>>> = {}) {
  const helpers: Record<string, Record<string, unknown>> = {};
  for (const [name, known] of Object.entries(KNOWN_NATIVE_HELPERS)) {
    helpers[name] = { policy: known.policy, executable: known.executable, status: 'bundled' };
  }
  for (const [name, patch] of Object.entries(overrides)) {
    if (patch === null) delete helpers[name];
    else helpers[name] = { ...helpers[name], ...patch };
  }
  return { schemaVersion: 1, profile: 'desktop-production', platform: 'darwin-arm64', helpers };
}

const allPresent = () => true;
const nonePresent = () => false;

test('verifier accepts a manifest whose bundled helpers are all present', () => {
  const parsed = assertNativeHelpers(
    bundledManifest(),
    '/bundle',
    KNOWN_NATIVE_HELPERS,
    allPresent
  );
  assert.equal(Object.keys(parsed.helpers).length, 5);
});

test('verifier accepts a skipped best-effort helper whose binary is absent', () => {
  const manifest = bundledManifest({ 'apple-chat': { status: 'skipped', reason: 'buildFailed' } });
  const chat = KNOWN_NATIVE_HELPERS['apple-chat'].executable;
  assertNativeHelpers(
    manifest,
    '/bundle',
    KNOWN_NATIVE_HELPERS,
    (absolute) => !absolute.endsWith(chat)
  );
});

test('verifier rejects an omitted best-effort helper', () => {
  const manifest = bundledManifest();
  delete manifest.helpers['apple-chat'];
  assert.throws(
    () => assertNativeHelpers(manifest, '/bundle', KNOWN_NATIVE_HELPERS, allPresent),
    /not recorded in the manifest: apple-chat/
  );
});

test("verifier rejects an entry bound to another helper's executable", () => {
  const manifest = bundledManifest({
    'nlp-helper': { executable: KNOWN_NATIVE_HELPERS['apple-stt'].executable },
  });
  assert.throws(
    () => assertNativeHelpers(manifest, '/bundle', KNOWN_NATIVE_HELPERS, allPresent),
    /nlp-helper is bound to native\/apple-stt\/bin\/snaglet-apple-stt/
  );
});

test('verifier rejects a policy downgrade and an unknown helper', () => {
  assert.throws(
    () =>
      assertNativeHelpers(
        bundledManifest({ 'nlp-helper': { policy: 'best-effort' } }),
        '/bundle',
        KNOWN_NATIVE_HELPERS,
        allPresent
      ),
    /recorded as best-effort; expected required/
  );
  const extra = bundledManifest();
  extra.helpers['mystery-helper'] = {
    policy: 'best-effort',
    executable: 'native/mystery-helper/bin/snaglet-mystery',
    status: 'skipped',
  };
  assert.throws(
    () => assertNativeHelpers(extra, '/bundle', KNOWN_NATIVE_HELPERS, allPresent),
    /unknown helper: mystery-helper/
  );
});

test('verifier rejects a required helper recorded as skipped', () => {
  assert.throws(
    () =>
      assertNativeHelpers(
        bundledManifest({ 'apple-tts': { status: 'skipped', reason: 'buildFailed' } }),
        '/bundle',
        KNOWN_NATIVE_HELPERS,
        nonePresent
      ),
    /Required native helper is missing from the bundle: apple-tts \(buildFailed\)/
  );
});

test('verifier accepts a required helper skipped for an old SDK only when the recorded SDK bears it out', () => {
  const stt = KNOWN_NATIVE_HELPERS['apple-stt']?.executable ?? '';
  const sttAbsent = (absolute: string) => !absolute.endsWith(stt);
  const skipped = (macosSdk: unknown) => ({
    ...bundledManifest({ 'apple-stt': { status: 'skipped', reason: 'sdkTooOld' } }),
    macosSdk,
  });
  assert.doesNotThrow(() =>
    assertNativeHelpers(skipped('15.4'), '/bundle', KNOWN_NATIVE_HELPERS, sttAbsent)
  );
  // The claim is false on an SDK that has the APIs, or with no SDK recorded.
  assert.throws(
    () => assertNativeHelpers(skipped('26.5'), '/bundle', KNOWN_NATIVE_HELPERS, sttAbsent),
    /Required native helper is missing from the bundle: apple-stt \(sdkTooOld, macOS SDK 26\.5\)/
  );
  assert.throws(
    () => assertNativeHelpers(skipped(null), '/bundle', KNOWN_NATIVE_HELPERS, sttAbsent),
    /missing from the bundle: apple-stt \(sdkTooOld, macOS SDK unknown\)/
  );
  // A helper with no SDK minimum cannot be skipped for an old SDK.
  const tts = KNOWN_NATIVE_HELPERS['apple-tts']?.executable ?? '';
  assert.throws(
    () =>
      assertNativeHelpers(
        {
          ...bundledManifest({ 'apple-tts': { status: 'skipped', reason: 'sdkTooOld' } }),
          macosSdk: '15.4',
        },
        '/bundle',
        KNOWN_NATIVE_HELPERS,
        (absolute) => !absolute.endsWith(tts)
      ),
    /missing from the bundle: apple-tts \(sdkTooOld, macOS SDK 15\.4\)/
  );
  assert.deepEqual(
    describeSdkSkippedHelpers(parseNativeHelpersManifest(bundledManifest())),
    [],
    'a fully bundled manifest reports no skipped helper'
  );
});

test('verifier rejects manifest/file disagreement in both directions', () => {
  assert.throws(
    () => assertNativeHelpers(bundledManifest(), '/bundle', KNOWN_NATIVE_HELPERS, nonePresent),
    /recorded as bundled is missing/
  );
  assert.throws(
    () =>
      assertNativeHelpers(
        bundledManifest({ 'apple-chat': { status: 'skipped', reason: 'notBuilt' } }),
        '/bundle',
        KNOWN_NATIVE_HELPERS,
        allPresent
      ),
    /recorded as skipped is present/
  );
});

test('manifest parser rejects malformed shapes', () => {
  assert.throws(() => parseNativeHelpersManifest(null), /not an object/);
  assert.throws(
    () => parseNativeHelpersManifest({ ...bundledManifest(), schemaVersion: 2 }),
    /schemaVersion/
  );
  assert.throws(
    () =>
      parseNativeHelpersManifest(
        bundledManifest({ 'apple-stt': { executable: '../../etc/passwd' } })
      ),
    /invalid executable path/
  );
  assert.throws(
    () => parseNativeHelpersManifest(bundledManifest({ 'apple-stt': { status: 'maybe' } })),
    /invalid status/
  );
  for (const macosSdk of ['MacOSX15.sdk', 15, '']) {
    assert.throws(
      () => parseNativeHelpersManifest({ ...bundledManifest(), macosSdk }),
      /invalid macosSdk/
    );
  }
  assert.equal(parseNativeHelpersManifest(bundledManifest()).macosSdk, null);
});

test(
  'apple-stt/build.sh stops before compiling on an SDK without SpeechAnalyzer',
  { skip: process.platform !== 'darwin' },
  () => {
    // A scratch copy of the helper sources, so a build never writes into the
    // checkout. Fake xcrun and swiftc stand in for an older SDK's toolchain.
    const root = mkdtempSync(path.join(tmpdir(), 'snaglet-apple-stt-sdk-'));
    try {
      const native = path.join(root, 'native');
      mkdirSync(path.join(native, 'apple-stt'), { recursive: true });
      for (const file of ['macos-sdk.sh', 'apple-stt/build.sh', 'apple-stt/stt.swift']) {
        copyFileSync(path.join('apps/server/native', file), path.join(native, file));
      }
      const bin = path.join(root, 'bin');
      mkdirSync(bin);
      const marker = path.join(root, 'swiftc-ran');
      for (const [name, body] of [
        ['xcrun', 'printf "%s\\n" "$SNAGLET_TEST_SDK_VERSION"'],
        ['swiftc', `touch "${marker}"`],
      ]) {
        writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
      }
      const build = (version: string) =>
        spawnSync('bash', [path.join(native, 'apple-stt', 'build.sh')], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SDKROOT: path.join(root, 'MacOSX.sdk'),
            SNAGLET_TEST_SDK_VERSION: version,
          },
          encoding: 'utf8',
        });

      const old = build('15.4');
      assert.equal(old.status, 1);
      assert.match(
        old.stderr,
        /the macOS 15\.4 SDK has no SpeechAnalyzer; this helper needs the macOS 26 SDK/
      );
      assert.equal(existsSync(marker), false, 'swiftc must not run on an older SDK');

      const current = build('26.2');
      assert.equal(current.status, 0, current.stderr);
      assert.equal(existsSync(marker), true, 'swiftc runs on the macOS 26 SDK');

      // The script's minimum and the bundle policy table must agree.
      const script = readFileSync(path.join(native, 'apple-stt', 'build.sh'), 'utf8');
      assert.equal(
        Number(/^minimum_sdk=(\d+)$/m.exec(script)?.[1]),
        helper('apple-stt').minimumSdk
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test('assertPackagedFsevents fails a macOS bundle without fsevents.node and ignores other platforms', () => {
  assert.throws(() => assertPackagedFsevents('/bundle', 'darwin', () => false), /missing fsevents/);
  assert.doesNotThrow(() =>
    assertPackagedFsevents('/bundle', 'darwin', (p) => p.endsWith('fsevents/fsevents.node'))
  );
  assert.doesNotThrow(() => assertPackagedFsevents('/bundle', 'linux', () => false));
  assert.doesNotThrow(() => assertPackagedFsevents('/bundle', 'win32', () => false));
});
