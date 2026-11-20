import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  openSync,
  writeSync,
  closeSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import winston from 'winston';
import { buildFileTransports } from '@server/config/logger';
import {
  resolveHomeFrom,
  readSnagletPointer,
  validateHomePath,
  ensureSnagletHome,
  ensureHomeManifest,
  cleanupStaleDownloads,
  getSnagletStorage,
  clearSnagletStorageCategory,
} from '@server/services/snagletHome';

/**
 * Tests for the Settable Snaglet home path resolution layer. Each test runs against
 * a throwaway tmp dir so nothing touches the real `~/.snaglet` / `~/.snaglet.json`.
 */

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'snaglethome-'));
}

function pointerFile(dir: string): string {
  return path.join(dir, '.snaglet.json');
}

describe('resolveHomeFrom — precedence', () => {
  const DEFAULT = '/home/user/.snaglet';

  it('prefers the SNAGLET_HOME env var above everything', () => {
    const result = resolveHomeFrom('/env/path', { homePath: '/pointer/path' }, DEFAULT);
    expect(result).toBe('/env/path');
  });

  it('trims whitespace and ignores a blank env var', () => {
    expect(resolveHomeFrom('   ', { homePath: '/pointer/path' }, DEFAULT)).toBe('/pointer/path');
    expect(resolveHomeFrom('  /env/path  ', {}, DEFAULT)).toBe('/env/path');
  });

  it('falls back to the pointer homePath when no env var', () => {
    expect(resolveHomeFrom(undefined, { homePath: '/pointer/path' }, DEFAULT)).toBe(
      '/pointer/path'
    );
  });

  it('falls back to the default when neither env nor pointer is set', () => {
    expect(resolveHomeFrom(undefined, {}, DEFAULT)).toBe(DEFAULT);
    expect(resolveHomeFrom(undefined, { homePath: '   ' }, DEFAULT)).toBe(DEFAULT);
  });
});

describe('resolveHomeFrom — tilde expansion and relative rejection', () => {
  // dotenv never shell-expands, so `SNAGLET_HOME=~/.snaglet` in a `.env` file reaches
  // Node as the literal string `~/.snaglet`. Resolving it against the process cwd
  // would create misdirected homes like `<repo>/~/.snaglet`, each with its own
  // PostgreSQL cluster.
  const DEFAULT = '/home/user/.snaglet';

  it('expands SNAGLET_HOME=~/.snaglet against the user home directory', () => {
    expect(resolveHomeFrom('~/.snaglet', {}, DEFAULT)).toBe(path.join(homedir(), '.snaglet'));
  });

  it('expands a bare SNAGLET_HOME=~ to the home directory', () => {
    expect(resolveHomeFrom('~', {}, DEFAULT)).toBe(homedir());
  });

  it('expands a tilde pointer homePath', () => {
    expect(resolveHomeFrom(undefined, { homePath: '~/snaglet-data' }, DEFAULT)).toBe(
      path.join(homedir(), 'snaglet-data')
    );
  });

  it('rejects a bare relative SNAGLET_HOME instead of resolving against cwd', () => {
    expect(() => resolveHomeFrom('relative/home', {}, DEFAULT)).toThrow(
      /SNAGLET_HOME must be an absolute path/
    );
  });

  it('rejects a bare relative pointer homePath', () => {
    expect(() => resolveHomeFrom(undefined, { homePath: 'relative-home' }, DEFAULT)).toThrow(
      /homePath in the Snaglet pointer file must be an absolute path/
    );
  });
});

describe('readSnagletPointer — pointer file', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a well-formed ~/.snaglet.json', () => {
    const file = pointerFile(dir);
    writeFileSync(file, JSON.stringify({ homePath: '/a/b', recentPaths: ['/a/b'] }));
    expect(readSnagletPointer(file)).toEqual({ homePath: '/a/b', recentPaths: ['/a/b'] });
  });

  it('returns {} when no pointer file exists', () => {
    expect(readSnagletPointer(pointerFile(dir))).toEqual({});
  });

  it('returns {} when the pointer file is malformed', () => {
    const file = pointerFile(dir);
    writeFileSync(file, '{ not json');
    expect(readSnagletPointer(file)).toEqual({});
  });
});

describe('validateHomePath — writability', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a writable existing folder and returns its canonical path', async () => {
    const result = await validateHomePath(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(realpathSync(dir));
  });

  it('creates a missing folder under a valid parent and accepts it', async () => {
    const target = path.join(dir, 'new-home');
    expect(existsSync(target)).toBe(false);
    const result = await validateHomePath(target);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(realpathSync(target));
    expect(existsSync(target)).toBe(true);
  });

  it('rejects an empty path', async () => {
    const result = await validateHomePath('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects a relative path', async () => {
    const result = await validateHomePath('relative/path');
    expect(result.ok).toBe(false);
  });

  it('leaves no write-probe file behind on success', async () => {
    await validateHomePath(dir);
    expect(existsSync(path.join(dir, '.snaglet-write-probe'))).toBe(false);
  });

  // Suitability guard — do not adopt a populated non-Snaglet folder (e.g. a repo).
  it('rejects a non-empty folder that is not an existing Snaglet home', async () => {
    const repo = path.join(dir, 'some-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'package.json'), '{}');
    writeFileSync(path.join(repo, 'README.md'), '# repo');
    const result = await validateHomePath(repo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_snaglet_home');
    // Rejected target must not be seeded.
    expect(existsSync(path.join(repo, '.snaglet-write-probe'))).toBe(false);
  });

  it('accepts a non-empty folder that is a managed PostgreSQL Snaglet home', async () => {
    const existingHome = path.join(dir, 'postgres-home');
    mkdirSync(path.join(existingHome, 'postgres'), { recursive: true });
    writeFileSync(path.join(existingHome, 'something-else.txt'), 'x');
    const result = await validateHomePath(existingHome);
    expect(result.ok).toBe(true);
  });

  it('accepts an empty folder', async () => {
    const empty = path.join(dir, 'empty');
    mkdirSync(empty, { recursive: true });
    const result = await validateHomePath(empty);
    expect(result.ok).toBe(true);
  });
});

describe('ensureSnagletHome — get-or-create + partial fill', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the required subdirectories in a fresh home', async () => {
    const home = path.join(dir, 'fresh');
    await ensureSnagletHome(home);
    expect(existsSync(path.join(home, 'projects'))).toBe(true);
    expect(existsSync(path.join(home, 'backups'))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(home, 'home.json'), 'utf8')) as {
      schemaVersion: number;
      installationId: string;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.installationId).toEqual(expect.any(String));
    if (process.platform !== 'win32') expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('completes a partial home without clobbering existing contents', async () => {
    const home = path.join(dir, 'partial');
    mkdirSync(path.join(home, 'projects'), { recursive: true });
    const sentinel = path.join(home, 'projects', 'keep.txt');
    writeFileSync(sentinel, 'do not delete');

    await ensureSnagletHome(home);

    // Existing content preserved...
    expect(existsSync(sentinel)).toBe(true);
    // ...and the missing required dirs were filled in.
    expect(existsSync(path.join(home, 'backups'))).toBe(true);
  });

  it('is idempotent — a second call is a no-op', async () => {
    const home = path.join(dir, 'idempotent');
    await ensureSnagletHome(home);
    await expect(ensureSnagletHome(home)).resolves.toBeUndefined();
  });
});

describe('Snaglet home manifest and replaceable downloads', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves installation identity across opens', async () => {
    const first = await ensureHomeManifest(dir);
    const second = await ensureHomeManifest(dir);
    expect(second.installationId).toBe(first.installationId);
  });

  it('refuses a home created by a newer layout schema', async () => {
    writeFileSync(
      path.join(dir, 'home.json'),
      JSON.stringify({ schemaVersion: 99, installationId: 'future' })
    );
    await expect(ensureHomeManifest(dir)).rejects.toThrow(/newer than this app supports/);
  });

  it('removes only stale process-scoped model downloads', async () => {
    const models = path.join(dir, 'models', 'embedders');
    mkdirSync(models, { recursive: true });
    const stale = path.join(models, 'model.onnx.123.download');
    const fresh = path.join(models, 'model.onnx.456.download');
    const published = path.join(models, 'model.onnx');
    writeFileSync(stale, 'partial');
    writeFileSync(fresh, 'partial');
    writeFileSync(published, 'canonical');
    const now = Date.now();
    const old = new Date(now - 48 * 60 * 60 * 1_000);
    utimesSync(stale, old, old);

    await expect(cleanupStaleDownloads(path.join(dir, 'models'), now)).resolves.toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(published)).toBe(true);
  });
});

describe('getSnagletStorage — clear descriptions', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('describes what Clear does for exactly the removable categories', async () => {
    const categories = await getSnagletStorage(dir);

    const removable = categories.filter((category) => category.removable);
    // The same set DELETE /api/snaglet-home/storage/:key agrees to clear.
    expect(removable.map((category) => category.key).sort()).toEqual(
      ['build', 'logs', 'models', 'temp'].sort()
    );
    for (const category of removable) {
      expect(category.clearDescription).toMatch(/^Deletes /);
      // UI copy: plain sentences, no em dashes.
      expect(category.clearDescription).not.toContain('\u2014');
    }
    for (const category of categories.filter((item) => !item.removable)) {
      expect(category.clearDescription).toBeNull();
    }
    // Clearing logs needs no restart before new lines show up.
    const logs = categories.find((category) => category.key === 'logs');
    expect(logs?.clearDescription).not.toMatch(/restart/i);
  });
});

describe('clearSnagletStorageCategory — logs', () => {
  const prevLogFile = process.env.SNAGLET_LOG_FILE;
  let dir: string;
  let logsDir: string;
  let fileLogger: winston.Logger | null;
  let consoleFd: number | null;

  beforeEach(() => {
    delete process.env.SNAGLET_LOG_FILE;
    dir = makeTmpDir();
    logsDir = path.join(dir, 'logs');
    mkdirSync(logsDir);
    fileLogger = null;
    consoleFd = null;
  });
  afterEach(() => {
    fileLogger?.close();
    if (consoleFd !== null) closeSync(consoleFd);
    rmSync(dir, { recursive: true, force: true });
    if (prevLogFile === undefined) delete process.env.SNAGLET_LOG_FILE;
    else process.env.SNAGLET_LOG_FILE = prevLogFile;
  });

  /** winston writes asynchronously: wait until `text` reaches the file. */
  async function waitForText(file: string, text: string): Promise<string> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (content.includes(text)) return content;
      if (Date.now() > deadline) {
        throw new Error(`"${text}" never reached ${path.basename(file)}; it has: ${content}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('empties the open log files in place, so new lines land without a restart', async () => {
    // The server logger as it runs: its real rotating file transports.
    fileLogger = winston.createLogger({ transports: buildFileTransports(logsDir) });
    fileLogger.info('line before clear');
    fileLogger.error('error before clear');
    await waitForText(path.join(logsDir, 'server.log'), 'line before clear');
    await waitForText(path.join(logsDir, 'server.error.log'), 'error before clear');
    // The desktop shell's capture of the server's console: an append-mode handle.
    consoleFd = openSync(path.join(logsDir, 'sidecar.console.log'), 'a');
    writeSync(consoleFd, 'console before clear\n');
    // Nothing holds these open, so they go.
    writeFileSync(path.join(logsDir, 'server1.log'), 'rotated before clear');
    writeFileSync(path.join(logsDir, 'sidecar.console.previous.log'), 'last launch');
    mkdirSync(path.join(logsDir, 'stray'));

    await clearSnagletStorageCategory('logs', dir);

    expect(readdirSync(logsDir).sort()).toEqual([
      'server.error.log',
      'server.log',
      'sidecar.console.log',
    ]);
    for (const name of readdirSync(logsDir)) {
      expect(statSync(path.join(logsDir, name)).size).toBe(0);
    }

    fileLogger.info('line after clear');
    fileLogger.error('error after clear');
    writeSync(consoleFd, 'console after clear\n');

    const serverLog = await waitForText(path.join(logsDir, 'server.log'), 'line after clear');
    const errorLog = await waitForText(path.join(logsDir, 'server.error.log'), 'error after clear');
    for (const content of [serverLog, errorLog]) {
      expect(content).not.toContain('before clear');
      // Appends start at the new end: no zero-filled gap where the cleared lines were.
      expect(content).not.toContain('\0');
    }
    expect(readFileSync(path.join(logsDir, 'sidecar.console.log'), 'utf8')).toBe(
      'console after clear\n'
    );
  });

  it('creates the logs folder when it is missing', async () => {
    rmSync(logsDir, { recursive: true, force: true });

    await clearSnagletStorageCategory('logs', dir);

    expect(readdirSync(logsDir)).toEqual([]);
  });
});
