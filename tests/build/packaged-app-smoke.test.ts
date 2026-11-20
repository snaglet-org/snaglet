import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  assertSidecarEnvContract,
  desktopRuntimeInitScript,
  FRESH_HOME_ARTIFACTS,
  isReadyBody,
  locatePackagedApp,
  packagedLaunchEnvironment,
  parseCheckpointManifest,
  parseCliSession,
  parseProcessEnvironment,
  SIDECAR_ENV_FORBIDDEN,
  SIDECAR_ENV_SECRETS,
  STRIPPED_LAUNCH_ENV,
} from '../../build/scripts/packaged-app';
import { desktopProduction } from '../../build/profiles/desktop-production';

const HOME = '/tmp/snaglet-app-smoke-test/.snaglet';
const PG_BIN = '/tmp/snaglet-app-smoke-test/Snaglet.app/Contents/Resources/pg/bin';
const RG = '/tmp/snaglet-app-smoke-test/Snaglet.app/Contents/Resources/rg/rg';

function contractEnv(overrides: Record<string, string | null> = {}): Map<string, string> {
  const env = new Map<string, string>([
    ['SNAGLET_APP_VERSION', '2.3.4'],
    ['NODE_ENV', 'production'],
    ['SNAGLET_LOCAL_INTELLIGENCE', 'true'],
    ['SNAGLET_DB_MODE', 'managed'],
    ['SNAGLET_PG_OWNED', '1'],
    ['PORT', '43121'],
    ['API_BASE_URL', 'http://127.0.0.1:43121'],
    ['SNAGLET_ALLOWED_ORIGINS', 'http://127.0.0.1:43121'],
    ['SNAGLET_HOME', HOME],
    ['SNAGLET_PG_DATA_DIR', `${HOME}/postgres`],
    ['SNAGLET_PG_BINDIR', PG_BIN],
    ['SNAGLET_RIPGREP_PATH', RG],
    ['SNAGLET_LOG_DIR', `${HOME}/logs`],
    ['SNAGLET_BACKUPS_DIR', `${HOME}/backups`],
    ['SNAGLET_PARENT_PID', '4242'],
    ['RUN_BACKGROUND_WORKERS', 'false'],
    ['SNAGLET_AUTH_TOKEN', 'test-token-a'],
    ['SNAGLET_SHUTDOWN_TOKEN', 'test-token-b'],
    ['SNAGLET_PANEL_TOKEN', 'test-token-c'],
    ['SNAGLET_EXPORT_GRANT_KEY', 'test-token-d'],
    ['CREDENTIAL_ENCRYPTION_KEY', 'test-token-e'],
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) env.delete(key);
    else env.set(key, value);
  }
  return env;
}

const expectations = {
  appVersion: '2.3.4',
  snagletHome: HOME,
  port: 43121,
  shellPid: 4242,
  pgBinDir: PG_BIN,
  ripgrepPath: RG,
};

test('locatePackagedApp reports a missing artifact with the build command', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'snaglet-locate-'));
  try {
    assert.throws(
      () => locatePackagedApp(desktopProduction, undefined, root),
      /pnpm build:desktop for desktop-production/
    );
    assert.throws(
      () => locatePackagedApp(desktopProduction, path.join(root, 'missing.app')),
      /Packaged app not found/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locatePackagedApp requires the executable, server bundle, migrations, helper manifest and pg_ctl', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'snaglet-locate-'));
  try {
    const app = path.join(root, 'dist/desktop-production/artifacts/Snaglet.app');
    const files = [
      'Contents/MacOS/desktop',
      'Contents/Resources/server/server.mjs',
      'Contents/Resources/server/migrations/0001_init.sql',
      'Contents/Resources/server/native/helpers.json',
      'Contents/Resources/pg/bin/pg_ctl',
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    }
    // Add files one at a time: each missing one must be named.
    for (let index = 0; index < files.length; index += 1) {
      assert.throws(
        () => locatePackagedApp(desktopProduction, undefined, root),
        /Packaged app is incomplete/
      );
      writeFileSync(path.join(app, files[index]), '');
    }
    const located = locatePackagedApp(desktopProduction, undefined, root);
    assert.equal(located.productName, 'Snaglet');
    assert.equal(located.pgCtl, path.join(app, 'Contents/Resources/pg/bin/pg_ctl'));
    assert.equal(located.serverDir, path.join(app, 'Contents/Resources/server'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packagedLaunchEnvironment strips every database/home override and isolates HOME', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    SNAGLET_DATABASE_URL: 'postgresql://live',
    SNAGLET_HOME: '/Users/someone/.snaglet',
    PGHOST: 'db',
    // What packages/db's load-env hook puts into a smoke process from the checkout .env.
    LOG_LEVEL: 'error',
    SNAGLET_ENV: 'dev',
    SNAGLET_LOG_FILE: 'false',
  };
  for (const key of STRIPPED_LAUNCH_ENV) base[key] = base[key] ?? 'leak';
  const env = packagedLaunchEnvironment('/tmp/runtime', '/tmp/runtime/.snaglet', base);
  for (const key of STRIPPED_LAUNCH_ENV) assert.equal(key in env, false, `${key} leaked`);
  for (const key of ['LOG_LEVEL', 'SNAGLET_ENV', 'SNAGLET_LOG_FILE'])
    assert.equal(key in env, false, `${key} leaked`);
  assert.equal(env.HOME, '/tmp/runtime');
  assert.equal(env.SNAGLET_HOME, '/tmp/runtime/.snaglet');
  assert.equal(env.RUN_BACKGROUND_WORKERS, 'false');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(base.SNAGLET_HOME, '/Users/someone/.snaglet', 'input env must not be mutated');
});

test('parseCliSession returns the loopback port and shell pid, rejecting other shapes', () => {
  const session = parseCliSession(
    JSON.stringify({ serverUrl: 'http://127.0.0.1:43121', sidecarToken: 'test-token', pid: 4242 })
  );
  assert.deepEqual(session, { port: 43121, token: 'test-token', shellPid: 4242 });
  assert.throws(() => parseCliSession('not json'), /not JSON/);
  assert.throws(
    () =>
      parseCliSession(
        JSON.stringify({ serverUrl: 'http://example.com:80', sidecarToken: 't', pid: 1 })
      ),
    /loopback/
  );
  assert.throws(
    () =>
      parseCliSession(
        JSON.stringify({ serverUrl: 'http://127.0.0.1:4000', sidecarToken: '', pid: 1 })
      ),
    /token/
  );
  assert.throws(
    () =>
      parseCliSession(JSON.stringify({ serverUrl: 'http://127.0.0.1:4000', sidecarToken: 't' })),
    /shell pid/
  );
});

test('parseProcessEnvironment reads KEY=VALUE pairs after the command line', () => {
  const env = parseProcessEnvironment(
    '/Applications/Snaglet.app/Contents/MacOS/snaglet-node server.mjs NODE_ENV=production SNAGLET_HOME=/tmp/x/.snaglet SNAGLET_PG_OWNED=1 lower=ignored'
  );
  assert.equal(env.get('NODE_ENV'), 'production');
  assert.equal(env.get('SNAGLET_HOME'), '/tmp/x/.snaglet');
  assert.equal(env.get('SNAGLET_PG_OWNED'), '1');
  assert.equal(env.has('lower'), false);
});

test('sidecar env contract passes on the documented sidecar.rs environment', () => {
  const checked = assertSidecarEnvContract(contractEnv(), expectations);
  assert.ok(checked.includes('SNAGLET_LOCAL_INTELLIGENCE'));
  assert.ok(checked.includes('SNAGLET_AUTH_TOKEN'));
});

test('sidecar env contract names offending keys but never values', () => {
  const cases: Array<[Record<string, string | null>, RegExp]> = [
    [{ SNAGLET_APP_VERSION: null }, /SNAGLET_APP_VERSION missing/],
    [{ SNAGLET_APP_VERSION: '0.0.0' }, /SNAGLET_APP_VERSION has an unexpected value/],
    [{ NODE_ENV: 'development' }, /NODE_ENV has an unexpected value/],
    [{ SNAGLET_LOCAL_INTELLIGENCE: 'false' }, /SNAGLET_LOCAL_INTELLIGENCE has an unexpected value/],
    [{ SNAGLET_PG_OWNED: null }, /SNAGLET_PG_OWNED missing/],
    [{ SNAGLET_HOME: '/Users/someone/.snaglet' }, /SNAGLET_HOME has an unexpected value/],
    [{ SNAGLET_PARENT_PID: '1' }, /SNAGLET_PARENT_PID has an unexpected value/],
    [{ SNAGLET_RIPGREP_PATH: null }, /SNAGLET_RIPGREP_PATH missing/],
    [{ SNAGLET_RIPGREP_PATH: '/usr/local/bin/rg' }, /SNAGLET_RIPGREP_PATH has an unexpected value/],
    [{ SNAGLET_AUTH_TOKEN: null }, /SNAGLET_AUTH_TOKEN missing/],
    [{ SNAGLET_DATABASE_URL: 'postgresql://live' }, /SNAGLET_DATABASE_URL must not be set/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(
      () => assertSidecarEnvContract(contractEnv(override), expectations),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, pattern);
        for (const secret of SIDECAR_ENV_SECRETS)
          assert.equal(error.message.includes(contractEnv().get(secret)!), false);
        assert.equal(error.message.includes('/Users/someone'), false);
        return true;
      }
    );
  }
  assert.deepEqual(
    [...SIDECAR_ENV_FORBIDDEN],
    ['DATABASE_URL', 'SNAGLET_DATABASE_URL', 'SNAGLET_DB_CONFIG_PATH']
  );
});

test('readiness requires both database and schema checks to be ok', () => {
  assert.equal(
    isReadyBody({ status: 'ok', checks: { database: { status: 'ok' }, schema: { status: 'ok' } } }),
    true
  );
  assert.equal(
    isReadyBody({
      status: 'ok',
      checks: { database: { status: 'ok' }, schema: { status: 'error' } },
    }),
    false
  );
  assert.equal(isReadyBody({ status: 'ok', checks: { database: { status: 'error' } } }), false);
  assert.equal(isReadyBody({}), false);
});

test('fresh-home layout and checkpoint manifest contracts', () => {
  assert.deepEqual(
    [...FRESH_HOME_ARTIFACTS],
    ['postgres/PG_VERSION', 'logs/server.log', 'credential.key', 'runtime/desktop-cli-session.json']
  );
  const manifest = parseCheckpointManifest({
    schemaVersion: 1,
    format: 'custom',
    pendingMigrations: ['0002_example.sql', '0003_example.sql'],
    sha256: 'a'.repeat(64),
    byteLength: 1024,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(manifest.pendingMigrations.length, 2);
  assert.throws(() => parseCheckpointManifest({ ...manifest, format: 'plain' }), /format/);
  assert.throws(() => parseCheckpointManifest({ ...manifest, sha256: 'xyz' }), /sha256/);
  assert.throws(
    () => parseCheckpointManifest({ ...manifest, pendingMigrations: 'none' }),
    /pendingMigrations/
  );
});

interface InjectedWindow {
  location: { origin: string };
  __SNAGLET_DESKTOP__?: { apiBaseUrl: string; appName: string; token: string; panelToken: string };
  __TAURI_INTERNALS__?: { invoke: () => Promise<unknown> };
}

/** Run the generated init script in a bare page-like realm: no tsx helpers, no `__name`. */
function runInitScript(source: string): InjectedWindow {
  const window: InjectedWindow = { location: { origin: 'http://127.0.0.1:43121' } };
  const context = vm.createContext({ window, Promise });
  vm.runInContext(source, context, { filename: 'desktop-runtime-init.js' });
  return window;
}

test('desktop runtime init script injects the exact shell globals in a realm without esbuild helpers', () => {
  const source = desktopRuntimeInitScript({
    appName: 'Snaglet',
    token: 'test-session-token',
    panelToken: 'test-panel-token',
  });
  // A serialized callback would carry esbuild's `__name` helper and throw
  // before the global is set, leaving the UI unauthenticated.
  assert.doesNotMatch(source, /__name/);
  const window = runInitScript(source);
  // Spread: the object was created in the VM realm, whose Object prototype differs.
  assert.deepEqual(
    { ...window.__SNAGLET_DESKTOP__ },
    {
      apiBaseUrl: 'http://127.0.0.1:43121/api',
      appName: 'Snaglet',
      token: 'test-session-token',
      panelToken: 'test-panel-token',
    }
  );
  assert.equal(typeof window.__TAURI_INTERNALS__?.invoke, 'function');
});

test('desktop runtime init script embeds hostile token characters safely', () => {
  const token = 'quote"back\\slash\nnewline</script>\u2028sep';
  const window = runInitScript(
    desktopRuntimeInitScript({ appName: 'Snaglet', token, panelToken: '' })
  );
  assert.equal(window.__SNAGLET_DESKTOP__?.token, token);
  assert.equal(window.__SNAGLET_DESKTOP__?.panelToken, '');
});
