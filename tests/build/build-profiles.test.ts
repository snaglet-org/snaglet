import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProfileSchema, resolveBuildProfile, viteSourcemapOption } from '../../build/profiles';
import { taskPlan } from '../../build/scripts/orchestrate';
import { parseMachOMinimumMacOSVersion } from '../../build/scripts/macos-deployment-target';
import { sourceMapPolicyForbids } from '../../build/scripts/staged-path-policy.mjs';
import { POSTGRES_MINIMUM_MACOS_VERSION } from '../../packages/db/runtime/postgres/version';
import { signServerFsevents } from '../../apps/desktop/scripts/lib/signServerFsevents.mjs';
import { stageFsevents } from '../../apps/server/scripts/lib/stageFsevents.mjs';
import { nsisExecutableSha256 } from '../../build/scripts/windows-executable';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopStager = readFileSync(
  path.join(repoRoot, 'apps/desktop/scripts/stage-sidecar.mjs'),
  'utf8'
);
const serverBundler = readFileSync(path.join(repoRoot, 'apps/server/scripts/bundle.mjs'), 'utf8');
const desktopShell = readFileSync(
  path.join(repoRoot, 'apps/desktop/src-tauri/src/main.rs'),
  'utf8'
);
const desktopSidecar = readFileSync(
  path.join(repoRoot, 'apps/desktop/src-tauri/src/sidecar.rs'),
  'utf8'
);
interface TauriConfigOverlay {
  identifier?: string;
  plugins?: { updater?: { endpoints: string[]; pubkey: string } };
  bundle: { createUpdaterArtifacts?: boolean; macOS: { minimumSystemVersion: string } };
}
const readTauriConfig = (name: string) =>
  JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/desktop/src-tauri', name), 'utf8')
  ) as TauriConfigOverlay;
const desktopTauriConfig = readTauriConfig('tauri.conf.json');

/** RFC 7396 JSON merge patch, which `tauri build --config <file>` applies. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base;
}

/** The config a desktop profile is built with: the base plus its overlay. */
const builtConfig = (overlay: string) =>
  mergePatch(desktopTauriConfig, readTauriConfig(overlay)) as TauriConfigOverlay;
const appleSidecarBuildScripts = ['apple-chat', 'apple-stt', 'apple-tts'].map((name) =>
  readFileSync(path.join(repoRoot, 'apps/server/native', name, 'build.sh'), 'utf8')
);

for (const name of ['browser-preview', 'desktop-preview', 'desktop-production'] as const) {
  test(`${name} is valid and isolated`, () => {
    const profile = resolveBuildProfile(name);
    assert.equal(profile.name, name);
    assert.match(profile.outputDirectory, new RegExp(`${name}$`));
  });
}

test('contradictory production configuration fails validation', () => {
  const production = resolveBuildProfile('desktop-production');
  assert.throws(() => buildProfileSchema.parse({ ...production, signing: 'not-required' }));
});

test('production forbids shipped source maps', () => {
  const production = resolveBuildProfile('desktop-production');
  assert.equal(production.sourceMaps, 'none');
  const productionConfig = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/desktop/src-tauri/tauri.production.conf.json'), 'utf8')
  ) as { build: { frontendDist: string } };
  // Embedded web assets must use the same map-free tree as the staged server.
  assert.equal(productionConfig.build.frontendDist, 'resources/server/static/web');
});

test('NSIS executable hash accounts for only the Tauri bundle marker patch', () => {
  const portable = Buffer.from(
    'prefix:__TAURI_BUNDLE_TYPE_VAR_NSS:__TAURI_BUNDLE_TYPE_VAR_UNK:suffix'
  );
  const installed = Buffer.from(
    'prefix:__TAURI_BUNDLE_TYPE_VAR_NSS:__TAURI_BUNDLE_TYPE_VAR_NSS:suffix'
  );
  const expected = createHash('sha256').update(installed).digest('hex');
  assert.equal(nsisExecutableSha256(portable), expected);
  assert.equal(portable.includes('__TAURI_BUNDLE_TYPE_VAR_UNK'), true);
  const changed = Buffer.concat([Buffer.from('changed:'), portable]);
  assert.notEqual(nsisExecutableSha256(changed), expected);
  assert.throws(() => nsisExecutableSha256(installed), /exactly one/);
  assert.throws(() => nsisExecutableSha256(Buffer.concat([portable, portable])), /exactly one/);
});

test('desktop profiles pin the Apple silicon minimum macOS version', () => {
  assert.equal(resolveBuildProfile('browser-preview').minimumMacOSVersion, null);
  assert.equal(resolveBuildProfile('desktop-preview').minimumMacOSVersion, '14.0');
  assert.equal(resolveBuildProfile('desktop-production').minimumMacOSVersion, '14.0');
  assert.equal(POSTGRES_MINIMUM_MACOS_VERSION, '14.0');
  assert.equal(desktopTauriConfig.bundle.macOS.minimumSystemVersion, '14.0');
  for (const script of appleSidecarBuildScripts) {
    assert.match(script, /MACOSX_DEPLOYMENT_TARGET:-14\.0/);
    assert.match(script, /-target "\$target"/);
  }
});

test('Mach-O deployment target parser supports modern and legacy load commands', () => {
  assert.equal(
    parseMachOMinimumMacOSVersion(
      `Load command 1\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform MACOS\n    minos 11.0\n      sdk 26.2\n`
    ),
    '11.0'
  );
  assert.equal(
    parseMachOMinimumMacOSVersion(
      `Load command 1\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version 10.15\n      sdk 11.0\n`
    ),
    '10.15'
  );
});

test('staged source-map guard rejects .map files under a none profile', () => {
  // A 'none' profile must reject any staged .map file.
  const production = resolveBuildProfile('desktop-production');
  assert.equal(production.sourceMaps, 'none');
  assert.equal(sourceMapPolicyForbids(production.sourceMaps, 'assets/index-abc.js.map'), true);
  assert.equal(sourceMapPolicyForbids(production.sourceMaps, 'assets/index-abc.js'), false);

  // 'hidden'/'public' profiles are permitted to stage maps, so the guard stays quiet.
  const preview = resolveBuildProfile('desktop-preview');
  assert.equal(preview.sourceMaps, 'hidden');
  assert.equal(sourceMapPolicyForbids(preview.sourceMaps, 'assets/index-abc.js.map'), false);
  assert.equal(sourceMapPolicyForbids('public', 'assets/index-abc.js.map'), false);
});

test("each profile's source-map policy sets Vite's build.sourcemap", () => {
  // A profile that ships no maps never generates them, which keeps the desktop
  // UI build within an 8 GB Mac's memory.
  const option = (name: string) => viteSourcemapOption(resolveBuildProfile(name).sourceMaps);
  assert.equal(option('desktop-production'), false);
  assert.equal(option('desktop-preview'), 'hidden');
  assert.equal(option('browser-preview'), true);
  const viteConfig = readFileSync(path.join(repoRoot, 'apps/desktop-ui/vite.config.ts'), 'utf8');
  assert.match(
    viteConfig,
    /viteSourcemapOption\(resolveBuildProfile\(buildProfile\)\.sourceMaps\)/
  );
  assert.match(viteConfig, /^\s+sourcemap,$/m);
});

test('the desktop UI build sets its own heap limit and keeps the caller NODE_OPTIONS', () => {
  const desktopUi = JSON.parse(
    readFileSync(path.join(repoRoot, 'apps/desktop-ui/package.json'), 'utf8')
  ) as { scripts: Record<string, string> };
  // The caller's NODE_OPTIONS comes last, so its own --max-old-space-size wins.
  assert.match(
    desktopUi.scripts.build ?? '',
    /cross-env NODE_OPTIONS="--max-old-space-size=4096 \$NODE_OPTIONS" vite build$/
  );
  // The orchestrated build runs that same script, so both paths get the limit.
  const orchestrator = readFileSync(path.join(repoRoot, 'build/scripts/orchestrate.ts'), 'utf8');
  assert.match(orchestrator, /web: \['pnpm', '--filter', '@snaglet\/desktop-ui', 'build'\]/);
});

test('unknown profiles fail before orchestration', () => {
  assert.throws(() => resolveBuildProfile('unknown'), /Unknown build profile/);
});

test('desktop packaging has one dependency-ordered plan', () => {
  assert.deepEqual(taskPlan('package-desktop'), [
    'clean',
    'packages',
    'web',
    'server',
    'stage-desktop',
    'package-desktop',
  ]);
});

test('desktop staging consumes prebuilt artifacts without compiling', () => {
  assert.deepEqual(taskPlan('stage-desktop'), ['stage-desktop']);
});

test('server bundle records its native helper set and production verification re-reads it', () => {
  // The shipped helper set is decided by the policy module, never by whatever
  // binaries a release machine happened to have compiled earlier.
  assert.match(serverBundler, /import \{ stageNativeHelpers \} from '\.\/lib\/nativeHelpers\.mjs'/);
  assert.match(serverBundler, /native\/helpers\.json/);
  assert.doesNotMatch(serverBundler, /apple-chat sidecar not built/);
  const productionVerifier = readFileSync(
    path.join(repoRoot, 'build/scripts/verify-desktop-production.ts'),
    'utf8'
  );
  assert.match(productionVerifier, /'server',\s*'native',\s*'helpers\.json'/);
  assert.match(productionVerifier, /assertNativeHelpers\(/);
  const appSmoke = readFileSync(path.join(repoRoot, 'build/scripts/smoke-packaged-app.ts'), 'utf8');
  assert.match(appSmoke, /assertNativeHelpers\(/);
  assert.match(appSmoke, /assertNoRunningApp\(/);
  assert.doesNotMatch(appSmoke, /osascript|open -a|LaunchServices\(/);
});

test('stageFsevents stages on macOS, fails the build without it, skips elsewhere', () => {
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const staged: string[] = [];
  const ok = (name: string) => {
    staged.push(name);
    return new Set([name]);
  };
  assert.deepEqual(
    [...(stageFsevents({ platform: 'darwin', stagePackageTree: ok, log }) ?? [])],
    ['fsevents']
  );
  assert.deepEqual(staged, ['fsevents']);
  assert.throws(
    () => stageFsevents({ platform: 'darwin', stagePackageTree: () => new Set(), log }),
    /requires fsevents/
  );
  staged.length = 0;
  assert.equal(stageFsevents({ platform: 'linux', stagePackageTree: ok, log }), null);
  assert.equal(stageFsevents({ platform: 'win32', stagePackageTree: ok, log }), null);
  assert.deepEqual(staged, []);
  assert.ok(logs.some((line) => line.includes('skipping fsevents (macOS-only)')));
});

test('signServerFsevents signs fsevents.node like the other native files and fails when absent', () => {
  const calls: Array<[string, string[]]> = [];
  const run = (command: string, args: string[]) => calls.push([command, args]);
  const addon = path.join('/server', 'node_modules', 'fsevents', 'fsevents.node');

  const adhoc = signServerFsevents('/server', {
    platform: 'darwin',
    env: {},
    run,
    isFile: () => true,
  });
  assert.deepEqual(adhoc, { addon, identity: 'adhoc' });
  assert.deepEqual(calls[0], [
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', addon],
  ]);
  assert.deepEqual(calls[1], ['/usr/bin/codesign', ['--verify', '--strict', addon]]);

  calls.length = 0;
  signServerFsevents('/server', {
    platform: 'darwin',
    env: { APPLE_SIGNING_IDENTITY: ' Developer ID Test ' },
    run,
    isFile: () => true,
  });
  assert.deepEqual(calls[0]?.[1], [
    '--force',
    '--sign',
    'Developer ID Test',
    '--options',
    'runtime',
    addon,
  ]);

  calls.length = 0;
  assert.throws(
    () => signServerFsevents('/server', { platform: 'darwin', env: {}, run, isFile: () => false }),
    /missing node_modules\/fsevents\/fsevents\.node/
  );
  assert.equal(
    signServerFsevents('/server', { platform: 'linux', env: {}, run, isFile: () => false }),
    null
  );
  assert.deepEqual(calls, []);
});

test('the bundler, stager and packaged-app verifiers all call the fsevents checks', () => {
  assert.match(serverBundler, /stageFsevents\(\{ stagePackageTree, log \}\)/);
  assert.match(serverBundler, /external: \[[^\]]*'fsevents'/);
  assert.match(desktopStager, /signServerFsevents\(stagedServer/);
  for (const verifier of [
    'verify-desktop-production',
    'verify-desktop-preview',
    'smoke-packaged-app',
  ]) {
    const source = readFileSync(path.join(repoRoot, `build/scripts/${verifier}.ts`), 'utf8');
    assert.match(source, /assertPackagedFsevents\(/, verifier);
  }
});

test('desktop profiles require a compiled web UI in the server bundle', () => {
  assert.match(serverBundler, /SNAGLET_BUILD_PROFILE\?\.startsWith\('desktop-'\)/);
  assert.match(serverBundler, /desktop build requires compiled UI assets/);
});

test('only the production desktop build updates itself', () => {
  const production = resolveBuildProfile('desktop-production');
  assert.equal(production.updatesEnabled, true);
  assert.equal(production.updateChannel, 'stable');
  for (const name of ['browser-preview', 'desktop-preview'] as const) {
    const profile = resolveBuildProfile(name);
    assert.equal(profile.updatesEnabled, false, name);
    assert.equal(profile.updateChannel, 'disabled', name);
    assert.throws(
      () =>
        buildProfileSchema.parse({ ...profile, updatesEnabled: true, updateChannel: 'preview' }),
      /only desktop production may update itself/
    );
  }
  assert.throws(
    () => buildProfileSchema.parse({ ...production, updateChannel: 'disabled' }),
    /enabled updates require an update channel/
  );
  assert.throws(
    () => buildProfileSchema.parse({ ...production, updatesEnabled: false }),
    /disabled updates require the disabled channel/
  );
});

test('the production build trusts the release key and reads latest.json from the release repo', () => {
  const release = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/shared/constants/release.json'), 'utf8')
  ) as { repository: string };
  const production = builtConfig('tauri.production.conf.json');
  const updater = production.plugins?.updater;
  assert.equal(production.identifier, 'com.snaglet.app');
  assert.deepEqual(updater?.endpoints, [
    `https://github.com/${release.repository}/releases/latest/download/latest.json`,
  ]);
  // A minisign public key, base64-encoded as tauri-plugin-updater expects.
  assert.match(
    Buffer.from(updater?.pubkey ?? '', 'base64').toString('utf8'),
    /^untrusted comment: minisign public key: [0-9A-F]{16}\nRW[A-Za-z0-9+/]{54}\n$/
  );
  // ship-desktop.mjs builds the update archive from the signed, stapled app;
  // Tauri's own updater artifacts would hold the unsigned build.
  assert.equal(production.bundle.createUpdaterArtifacts, false);
});

test('the preview build has no updater key or endpoint and a non-production identifier', () => {
  // The shell refuses this identifier (and the desktop-preview profile) before
  // updating; app_update.rs tests that refusal. Here the built config itself
  // leaves nothing to install a production release with.
  const preview = builtConfig('tauri.preview.conf.json');
  assert.deepEqual(preview.plugins?.updater, { endpoints: [], pubkey: '' });
  assert.equal(preview.identifier, 'com.snaglet.app.preview');
  assert.equal(preview.bundle.createUpdaterArtifacts, false);
  // The command passes the compiled profile and identifier to that refusal.
  assert.match(
    desktopShell,
    /app_update::refusal\(\s*cfg!\(debug_assertions\),\s*option_env!\("SNAGLET_BUILD_PROFILE"\),\s*&app\.config\(\)\.identifier,?\s*\)/
  );
});

test('desktop shell has no plaintext provider-token filesystem commands', () => {
  for (const command of ['read_provider_token', 'write_provider_token', 'delete_provider_token']) {
    assert.doesNotMatch(desktopShell, new RegExp(command));
  }
});

test('desktop sidecar preserves OS HOME and fails closed for unavailable Snaglet homes', () => {
  assert.doesNotMatch(desktopSidecar, /\.env\("HOME",\s*&dir\)/);
  assert.match(desktopSidecar, /Snaglet-owned state derives exclusively from SNAGLET_HOME/);
  assert.match(desktopSidecar, /saved Snaglet home .* is unavailable or not writable/);
});

test('packaged desktop opts into automatic local model bootstrap', () => {
  assert.match(desktopSidecar, /\.env\("SNAGLET_LOCAL_INTELLIGENCE",\s*"true"\)/);
});

test('desktop sidecar refuses silent credential-key replacement', () => {
  assert.match(desktopSidecar, /credential\.key is malformed; refusing to replace it/);
  assert.match(desktopSidecar, /credential\.key is missing beside an existing Snaglet database/);
});

test('desktop staging accepts only the ripgrep archive checksum pinned in the repo', () => {
  assert.match(desktopStager, /const expected = pinnedRipgrepArchiveSha256\(target\);/);
  assert.match(desktopStager, /const actual = sha256\(archive\);\s+if \(actual !== expected\)/);
  // A checksum fetched from the same release proves nothing about which release was vetted.
  assert.doesNotMatch(desktopStager, /ripgrep\/releases\/download\/[^\n]*\.sha256/);
});

test('desktop staging emits the schema 3 managed PostgreSQL resource contract', () => {
  assert.match(
    desktopStager,
    /function createManifest\(runtime, postgres, ripgrep\)[\s\S]*?postgres,\s+profile: profileName,\s+ripgrep,\s+schemaVersion: 3,/
  );
  assert.match(desktopStager, /bin: 'pg\/bin'/);
  assert.match(desktopStager, /root: 'pg'/);

  for (const executable of ['postgres', 'initdb', 'pg_ctl', 'pg_dump', 'pg_restore']) {
    assert.match(
      desktopStager,
      new RegExp(`['"]${executable}['"]`),
      `desktop staging must require PostgreSQL executable ${executable}`
    );
  }

  // PostgreSQL drops the `postgresql/` suffix from pkglibdir/sharedir
  // when the install prefix contains "postgres"/"pgsql", so the staged layout
  // may be nested (lib/postgresql, share/postgresql) or flat (lib, share). The
  // stager must DETECT which layout the runtime uses rather than hardcode one.
  assert.match(
    desktopStager,
    /pgLibRelative = statSync\(path\.join\(stagedPostgres, 'lib\/postgresql'\)[\s\S]*?\? 'lib\/postgresql'\s*:\s*'lib'/,
    'desktop staging must detect nested-vs-flat PostgreSQL pkglibdir layouts'
  );
  assert.match(
    desktopStager,
    /pgShareRelative = statSync\(path\.join\(stagedPostgres, 'share\/postgresql'\)[\s\S]*?\? 'share\/postgresql'\s*:\s*'share'/,
    'desktop staging must detect nested-vs-flat PostgreSQL sharedir layouts'
  );

  // Every required extension asset is asserted through the DETECTED roots, so
  // the guard holds for both layouts instead of only the nested one.
  for (const asset of ['vector', 'pg_trgm']) {
    assert.match(
      desktopStager,
      new RegExp(`\\$\\{pgLibRelative\\}/${asset}\\.\\$\\{extensionSuffix\\}`),
      `desktop staging must require PostgreSQL extension library ${asset} under the detected lib root`
    );
    assert.match(
      desktopStager,
      new RegExp(`\\$\\{pgShareRelative\\}/extension/${asset}\\.control`),
      `desktop staging must require PostgreSQL extension metadata ${asset} under the detected share root`
    );
  }
});

test('managed PostgreSQL runtime ships the upstream license texts on every platform', () => {
  const runtimeBuilder = readFileSync(
    path.join(repoRoot, 'packages/db/runtime/postgres/binaries.ts'),
    'utf8'
  );
  // Windows extracts the vendor archive's license files; the macOS/Linux source
  // build copies PostgreSQL's COPYRIGHT. Both copy pgvector's LICENSE.
  assert.match(runtimeBuilder, /'pgsql\/server_license\.txt'/);
  assert.equal(runtimeBuilder.match(/'pgvector-LICENSE'/g)?.length, 2);
  assert.match(runtimeBuilder, /path\.join\(postgresSourceDir, 'COPYRIGHT'\)/);
  assert.match(runtimeBuilder, /'postgresql-COPYRIGHT'/);
  // Desktop staging bundles every top-level license file of the runtime.
  assert.match(desktopStager, /\/license\|copyright\|readme\/i\.test\(entry\)/);
});

test('desktop bundling builds and stages the required native helpers by policy', () => {
  // The policy table (apps/server/scripts/lib/nativeHelpers.mjs) is what the
  // bundle runs; its behavior is unit-tested in native-helpers.test.ts. Here
  // only the wiring and the required set are pinned.
  const policy = readFileSync(
    path.join(repoRoot, 'apps/server/scripts/lib/nativeHelpers.mjs'),
    'utf8'
  );
  for (const helper of ['apple-stt', 'apple-tts', 'nlp-helper']) {
    assert.match(
      policy,
      new RegExp(`name: '${helper}',[\\s\\S]*?policy: 'required'`),
      `${helper} must be a required desktop helper`
    );
  }
  assert.match(policy, /name: 'apple-chat',[\s\S]*?policy: 'best-effort'/);
  assert.match(policy, /desktop bundle requires \$\{relative\}/);
  assert.match(
    serverBundler,
    /execFileSync\('bash', \[script\], \{ cwd: SERVER_DIR, stdio: 'inherit' \}\)/
  );
  // The SDK version comes from the same selection the helper build scripts use.
  assert.match(serverBundler, /sdkVersion: helperSdkVersion\(\)/);
  assert.match(serverBundler, /source "\$1"; snaglet_macos_sdk_version/);
});

test('browser preview builds web and server once', () => {
  assert.deepEqual(taskPlan('browser-preview'), [
    'clean',
    'packages',
    'web',
    'server',
    'browser-preview',
  ]);
});
