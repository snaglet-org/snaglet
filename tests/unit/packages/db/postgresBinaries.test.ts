import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  ensurePostgresBinaries as resolvePostgresBinaries,
  postgresExecutableName,
  type EnsurePostgresBinariesOptions,
  postgresRuntimeEnvironment,
  postgresRuntimeRoot,
  type BinDir,
  type PostgresRuntimeManifest,
} from '@snaglet/db/runtime/postgres/binaries';
import {
  PGVECTOR_SOURCE,
  PGVECTOR_VERSION,
  POSTGRES_MINIMUM_MACOS_VERSION,
  POSTGRES_RUNTIME_ID,
  POSTGRES_SOURCE,
  POSTGRES_VERSION,
  POSTGRES_WINDOWS_BINARY,
  POSTGRES_WINDOWS_MANIFEST_REVISION,
} from '@snaglet/db/runtime/postgres/version';

const REQUIRED_BINARIES = [
  'postgres',
  'initdb',
  'pg_ctl',
  'pg_dump',
  'pg_restore',
  'pg_config',
  'psql',
  'createdb',
  'dropdb',
] as const;

const runtimePlatform = (() => {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  throw new Error(`Unsupported test platform ${process.platform}-${process.arch}`);
})();
const cacheId =
  process.platform === 'win32'
    ? `${POSTGRES_RUNTIME_ID}-${POSTGRES_WINDOWS_MANIFEST_REVISION}`
    : POSTGRES_RUNTIME_ID;

let scratchDirs: string[] = [];
let priorBindir: string | undefined;
let priorOwned: string | undefined;

beforeEach(() => {
  priorBindir = process.env.SNAGLET_PG_BINDIR;
  priorOwned = process.env.SNAGLET_PG_OWNED;
  delete process.env.SNAGLET_PG_BINDIR;
  delete process.env.SNAGLET_PG_OWNED;
});

afterEach(async () => {
  if (priorBindir === undefined) delete process.env.SNAGLET_PG_BINDIR;
  else process.env.SNAGLET_PG_BINDIR = priorBindir;
  if (priorOwned === undefined) delete process.env.SNAGLET_PG_OWNED;
  else process.env.SNAGLET_PG_OWNED = priorOwned;
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'snaglet-postgres-binaries-test-'));
  scratchDirs.push(dir);
  return dir;
}

function validManifest(overrides: Partial<PostgresRuntimeManifest> = {}): PostgresRuntimeManifest {
  return {
    schemaVersion: 2,
    runtimeId: POSTGRES_RUNTIME_ID,
    postgresVersion: POSTGRES_VERSION,
    pgvectorVersion: PGVECTOR_VERSION,
    platform: runtimePlatform,
    sourceSha256: {
      postgres: POSTGRES_SOURCE.sha256,
      pgvector: PGVECTOR_SOURCE.sha256,
    },
    minimumMacOSVersion: process.platform === 'darwin' ? POSTGRES_MINIMUM_MACOS_VERSION : null,
    builtAt: '2026-07-22T00:00:00.000Z',
    ...(process.platform === 'win32'
      ? {
          windowsBinarySha256: POSTGRES_WINDOWS_BINARY.sha256,
          windowsManifestRevision: POSTGRES_WINDOWS_MANIFEST_REVISION,
        }
      : {}),
    ...overrides,
  };
}

async function createFakeRuntime(
  rootDir: string,
  options: {
    manifest?: PostgresRuntimeManifest | false;
    postgresVersionOutput?: string;
  } = {}
): Promise<string> {
  const binDir = path.join(rootDir, 'bin');
  const extensionLibDir = path.join(rootDir, 'lib', 'postgresql');
  const extensionShareDir = path.join(rootDir, 'share', 'postgresql', 'extension');
  await Promise.all([
    mkdir(binDir, { recursive: true }),
    mkdir(extensionLibDir, { recursive: true }),
    mkdir(extensionShareDir, { recursive: true }),
  ]);

  const postgresVersionOutput =
    options.postgresVersionOutput ?? `postgres (PostgreSQL) ${POSTGRES_VERSION}`;
  for (const binary of REQUIRED_BINARIES) {
    const output = binary === 'postgres' ? postgresVersionOutput : binary;
    const contents =
      binary === 'pg_config'
        ? `${extensionLibDir}\n${path.join(rootDir, 'share', 'postgresql')}\n`
        : output;
    await writeFile(path.join(binDir, postgresExecutableName(binary)), contents, { mode: 0o755 });
  }

  const librarySuffix =
    process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  await Promise.all([
    writeFile(path.join(extensionLibDir, `vector.${librarySuffix}`), 'fake-vector'),
    writeFile(path.join(extensionLibDir, `pg_trgm.${librarySuffix}`), 'fake-pg-trgm'),
    writeFile(
      path.join(extensionShareDir, 'vector.control'),
      `default_version = '${PGVECTOR_VERSION}'`
    ),
    writeFile(path.join(extensionShareDir, 'pg_trgm.control'), 'comment = fake-pg-trgm'),
  ]);

  if (options.manifest !== false) {
    const manifest = options.manifest ?? validManifest();
    if (process.platform === 'win32') {
      manifest.windowsExecutableSha256 = Object.fromEntries(
        await Promise.all(
          REQUIRED_BINARIES.map(async (binary) => {
            const name = postgresExecutableName(binary);
            return [
              name,
              createHash('sha256')
                .update(await readFile(path.join(binDir, name)))
                .digest('hex'),
            ];
          })
        )
      );
    }
    await writeFile(
      path.join(rootDir, 'snaglet-postgres-runtime.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }
  return binDir;
}

function ensurePostgresBinaries(options: EnsurePostgresBinariesOptions = {}) {
  return resolvePostgresBinaries({
    ...options,
    inspectBinary: (executable) => readFile(executable, 'utf8'),
  });
}

describe('managed PostgreSQL binary resolution', () => {
  it('rejects Windows executables changed after manifest publication', async () => {
    if (process.platform !== 'win32') return;
    const root = await scratchDir();
    process.env.SNAGLET_PG_BINDIR = await createFakeRuntime(root);
    process.env.SNAGLET_PG_OWNED = '1';
    await writeFile(path.join(process.env.SNAGLET_PG_BINDIR, 'initdb.exe'), 'changed executable');
    await expect(ensurePostgresBinaries()).rejects.toThrow(/manifest is missing or incompatible/);
  });

  it('rejects Windows artifacts predating the UTF-8 manifest revision', async () => {
    if (process.platform !== 'win32') return;
    const root = await scratchDir();
    process.env.SNAGLET_PG_BINDIR = await createFakeRuntime(root, {
      manifest: validManifest({ windowsManifestRevision: undefined }),
    });
    process.env.SNAGLET_PG_OWNED = '1';
    await expect(ensurePostgresBinaries()).rejects.toThrow(/manifest is missing or incompatible/);
  });
  it('uses and validates SNAGLET_PG_BINDIR before considering the managed cache', async () => {
    const root = await scratchDir();
    const overrideRoot = path.join(root, 'override-runtime');
    const overrideBin = await createFakeRuntime(overrideRoot, { manifest: false });
    process.env.SNAGLET_PG_BINDIR = overrideBin;

    const runtime = await ensurePostgresBinaries({
      runtimeBaseDir: path.join(root, 'missing-cache'),
      buildIfMissing: false,
    });

    expect(runtime.rootDir).toBe(overrideRoot);
    expect(runtime.binDir).toBe(overrideBin);
    expect(runtime.postgres).toBe(path.join(overrideBin, postgresExecutableName('postgres')));
  });

  it('does not fall back to a valid cache when SNAGLET_PG_BINDIR is invalid', async () => {
    const root = await scratchDir();
    const runtimeBaseDir = path.join(root, 'cache');
    await createFakeRuntime(postgresRuntimeRoot(runtimeBaseDir));
    process.env.SNAGLET_PG_BINDIR = path.join(root, 'invalid-override', 'bin');

    await expect(ensurePostgresBinaries({ runtimeBaseDir, buildIfMissing: false })).rejects.toThrow(
      /Snaglet|PostgreSQL runtime is missing executable|invalid-override/
    );
  });

  it('resolves a compatible runtime from the target-scoped managed cache', async () => {
    const root = await scratchDir();
    const runtimeBaseDir = path.join(root, 'cache');
    const runtimeRoot = postgresRuntimeRoot(runtimeBaseDir);
    await createFakeRuntime(runtimeRoot);

    const runtime = await ensurePostgresBinaries({ runtimeBaseDir, buildIfMissing: false });

    expect(runtime.rootDir).toBe(runtimeRoot);
    expect(runtime.libDir).toBe(path.join(runtimeRoot, 'lib'));
    expect(runtime.shareDir).toBe(path.join(runtimeRoot, 'share'));
  });

  it('reports an actionable command without attempting a build when buildIfMissing is false', async () => {
    const root = await scratchDir();
    const runtimeBaseDir = path.join(root, 'empty-cache');

    await expect(ensurePostgresBinaries({ runtimeBaseDir, buildIfMissing: false })).rejects.toThrow(
      /Run pnpm pg:runtime:build --strict/
    );
  });

  it('requires a compatible manifest for an owned packaged binary override', async () => {
    const root = await scratchDir();
    process.env.SNAGLET_PG_BINDIR = await createFakeRuntime(path.join(root, 'unverified'), {
      manifest: false,
    });
    process.env.SNAGLET_PG_OWNED = '1';
    await expect(ensurePostgresBinaries()).rejects.toThrow(/manifest is missing or incompatible/);
  });

  it('keeps only one Windows PATH spelling so staged DLL lookup wins', async () => {
    if (process.platform !== 'win32') return;
    const root = await scratchDir();
    process.env.SNAGLET_PG_BINDIR = await createFakeRuntime(path.join(root, 'runtime'));
    const runtime = await ensurePostgresBinaries();
    const env = postgresRuntimeEnvironment(runtime, { Path: 'C:\\caller', PRESERVE_ME: 'yes' });
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(env.PATH).toBe(`${runtime.binDir};C:\\caller`);
    expect(env.PRESERVE_ME).toBe('yes');
  });

  it('never source-builds executables in packaged owned mode without a staged bindir', async () => {
    process.env.SNAGLET_PG_OWNED = '1';
    await expect(ensurePostgresBinaries()).rejects.toThrow(/SNAGLET_PG_BINDIR.*refusing/i);
  });

  it('constructs child-process paths without discarding the caller environment', async () => {
    const root = await scratchDir();
    const runtimeRoot = path.join(root, 'runtime');
    const binDir = await createFakeRuntime(runtimeRoot, { manifest: false });
    process.env.SNAGLET_PG_BINDIR = binDir;
    const runtime: BinDir = await ensurePostgresBinaries({ buildIfMissing: false });

    const env = postgresRuntimeEnvironment(runtime, {
      PATH: '/caller/bin',
      DYLD_LIBRARY_PATH: '/caller/dyld',
      LD_LIBRARY_PATH: '/caller/ld',
      PRESERVE_ME: 'yes',
    });

    expect(env.PATH).toBe(`${runtime.binDir}${path.delimiter}/caller/bin`);
    expect(env.DYLD_LIBRARY_PATH).toBe(
      process.platform === 'win32'
        ? '/caller/dyld'
        : `${runtime.libDir}${path.delimiter}/caller/dyld`
    );
    expect(env.LD_LIBRARY_PATH).toBe(
      process.platform === 'win32' ? '/caller/ld' : `${runtime.libDir}${path.delimiter}/caller/ld`
    );
    expect(env.PRESERVE_ME).toBe('yes');
  });

  it('rejects an otherwise complete cache with a mismatched pinned manifest', async () => {
    const root = await scratchDir();
    const runtimeBaseDir = path.join(root, 'cache');
    const runtimeRoot = postgresRuntimeRoot(runtimeBaseDir);
    await createFakeRuntime(runtimeRoot, {
      manifest: validManifest({ postgresVersion: '17.9' as typeof POSTGRES_VERSION }),
    });

    await expect(ensurePostgresBinaries({ runtimeBaseDir, buildIfMissing: false })).rejects.toThrow(
      /manifest is missing or incompatible/
    );
  });

  it('rejects a cache built for a different minimum macOS version', async () => {
    if (process.platform !== 'darwin') return;
    const root = await scratchDir();
    const runtimeBaseDir = path.join(root, 'cache');
    const runtimeRoot = postgresRuntimeRoot(runtimeBaseDir);
    await createFakeRuntime(runtimeRoot, {
      manifest: validManifest({ minimumMacOSVersion: '26.0' }),
    });

    await expect(ensurePostgresBinaries({ runtimeBaseDir, buildIfMissing: false })).rejects.toThrow(
      /manifest is missing or incompatible/
    );
  });

  it('rejects a binary whose reported version only starts with the pinned version', async () => {
    const root = await scratchDir();
    const runtimeRoot = path.join(root, 'runtime');
    const binDir = await createFakeRuntime(runtimeRoot, {
      manifest: false,
      postgresVersionOutput: `postgres (PostgreSQL) ${POSTGRES_VERSION}0`,
    });
    process.env.SNAGLET_PG_BINDIR = binDir;

    await expect(ensurePostgresBinaries({ buildIfMissing: false })).rejects.toThrow(
      /version mismatch/
    );
  });
});

describe('runtime base dir — SNAGLET_PG_RUNTIME_DIR path resolution', () => {
  // `.env` values are never shell-expanded, so a literal `~` would resolve
  // against the process cwd and compile PostgreSQL into `<repo>/~/…`. The env
  // value expands `~` and rejects bare relatives.
  let priorRuntimeDir: string | undefined;

  beforeEach(() => {
    priorRuntimeDir = process.env.SNAGLET_PG_RUNTIME_DIR;
  });

  afterEach(() => {
    if (priorRuntimeDir === undefined) delete process.env.SNAGLET_PG_RUNTIME_DIR;
    else process.env.SNAGLET_PG_RUNTIME_DIR = priorRuntimeDir;
  });

  it('expands SNAGLET_PG_RUNTIME_DIR=~/… against the user home directory', () => {
    process.env.SNAGLET_PG_RUNTIME_DIR = '~/snaglet-test-runtime-cache';
    expect(postgresRuntimeRoot()).toBe(
      path.join(homedir(), 'snaglet-test-runtime-cache', cacheId, runtimePlatform)
    );
  });

  it('leaves an absolute SNAGLET_PG_RUNTIME_DIR unchanged', async () => {
    const dir = await scratchDir();
    process.env.SNAGLET_PG_RUNTIME_DIR = dir;
    expect(postgresRuntimeRoot()).toBe(path.join(dir, cacheId, runtimePlatform));
  });

  it('rejects a bare relative SNAGLET_PG_RUNTIME_DIR instead of resolving against cwd', () => {
    process.env.SNAGLET_PG_RUNTIME_DIR = 'relative/runtime-cache';
    expect(() => postgresRuntimeRoot()).toThrow(/SNAGLET_PG_RUNTIME_DIR must be an absolute path/);
  });
});
