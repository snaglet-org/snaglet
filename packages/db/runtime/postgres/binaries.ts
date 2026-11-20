import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { expandHomePath, resolveConfiguredPath } from '@snaglet/shared/utils/paths';
import { resolveDbHome } from '../snaglet-home';
import { withWindowsPostgresLease } from './lease';
import { resolveWindowsBuildEnvironment } from './windows-build';
import { resolveDarwinBuildEnvironment } from './darwin-build';
import { applyWindowsUtf8Manifests } from './windows-manifest';
import {
  PGVECTOR_SOURCE,
  PGVECTOR_VERSION,
  POSTGRES_MINIMUM_MACOS_VERSION,
  POSTGRES_RUNTIME_ID,
  POSTGRES_SOURCE,
  POSTGRES_VERSION,
  POSTGRES_WINDOWS_BINARY,
  POSTGRES_WINDOWS_MANIFEST_REVISION,
} from './version';

const MANIFEST_FILE = 'snaglet-postgres-runtime.json';
const BUILD_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
const execFileAsync = promisify(execFile);
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

type SupportedPlatform = 'darwin-arm64' | 'linux-x64' | 'win32-x64';

export interface PostgresRuntimeManifest {
  schemaVersion: 2;
  runtimeId: typeof POSTGRES_RUNTIME_ID;
  postgresVersion: typeof POSTGRES_VERSION;
  pgvectorVersion: typeof PGVECTOR_VERSION;
  platform: SupportedPlatform;
  sourceSha256: {
    postgres: string;
    pgvector: string;
  };
  minimumMacOSVersion: string | null;
  windowsBinarySha256?: string;
  windowsManifestRevision?: typeof POSTGRES_WINDOWS_MANIFEST_REVISION;
  windowsExecutableSha256?: Record<string, string>;
  builtAt: string;
}

export interface BinDir {
  rootDir: string;
  binDir: string;
  libDir: string;
  shareDir: string;
  postgres: string;
  initdb: string;
  pgCtl: string;
  pgDump: string;
  pgRestore: string;
  pgConfig: string;
  psql: string;
  createdb: string;
  dropdb: string;
}

export interface BuildPostgresRuntimeOptions {
  targetRoot?: string;
  force?: boolean;
  archive?: boolean;
  log?: (line: string) => void;
}

export type PostgresBinaryInspector = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => Promise<string>;

export interface EnsurePostgresBinariesOptions {
  inspectBinary?: PostgresBinaryInspector;
  runtimeBaseDir?: string;
  buildIfMissing?: boolean;
  log?: (line: string) => void;
}

function platformKey(): SupportedPlatform {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  throw new Error(
    `Managed PostgreSQL is not built for ${process.platform}-${process.arch}; supported platforms are darwin-arm64, linux-x64, and win32-x64.`
  );
}

function defaultRuntimeBaseDir(): string {
  // Strictly resolved: this directory is created (and compiled into) if
  // missing, so a literal `~` or relative value must never reach mkdir.
  const configured = process.env.SNAGLET_PG_RUNTIME_DIR?.trim();
  if (configured) return resolveConfiguredPath(configured, 'SNAGLET_PG_RUNTIME_DIR');
  return path.join(resolveDbHome(), 'cache', 'postgres-runtime');
}

export function postgresRuntimeRoot(runtimeBaseDir = defaultRuntimeBaseDir()): string {
  const cacheId =
    process.platform === 'win32'
      ? `${POSTGRES_RUNTIME_ID}-${POSTGRES_WINDOWS_MANIFEST_REVISION}`
      : POSTGRES_RUNTIME_ID;
  return path.join(runtimeBaseDir, cacheId, platformKey());
}

function extensionLibraryName(extension: 'vector' | 'pg_trgm'): string {
  return `${extension}.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`;
}

export function postgresExecutableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function describeRuntime(rootDir: string): BinDir {
  const binDir = path.join(rootDir, 'bin');
  return {
    rootDir,
    binDir,
    libDir: path.join(rootDir, 'lib'),
    shareDir: path.join(rootDir, 'share'),
    postgres: path.join(binDir, postgresExecutableName('postgres')),
    initdb: path.join(binDir, postgresExecutableName('initdb')),
    pgCtl: path.join(binDir, postgresExecutableName('pg_ctl')),
    pgDump: path.join(binDir, postgresExecutableName('pg_dump')),
    pgRestore: path.join(binDir, postgresExecutableName('pg_restore')),
    pgConfig: path.join(binDir, postgresExecutableName('pg_config')),
    psql: path.join(binDir, postgresExecutableName('psql')),
    createdb: path.join(binDir, postgresExecutableName('createdb')),
    dropdb: path.join(binDir, postgresExecutableName('dropdb')),
  };
}

export function postgresRuntimeEnvironment(
  runtime: BinDir,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const append = (current: string | undefined, value: string): string =>
    current ? `${value}${path.delimiter}${current}` : value;
  const environment = { ...base };
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH');
  const currentPath = pathKey ? environment[pathKey] : undefined;
  if (process.platform === 'win32') {
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === 'PATH') delete environment[key];
    }
    return { ...environment, PATH: append(currentPath, runtime.binDir) };
  }
  return {
    ...environment,
    PATH: append(base.PATH, runtime.binDir),
    DYLD_LIBRARY_PATH: append(base.DYLD_LIBRARY_PATH, runtime.libDir),
    LD_LIBRARY_PATH: append(base.LD_LIBRARY_PATH, runtime.libDir),
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadVerified(
  source: { url: string; sha256: string },
  target: string,
  log: (line: string) => void
): Promise<void> {
  log(`download ${source.url}`);
  const response = await fetch(source.url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${source.url}`);
  }
  await writeFile(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  const actual = await sha256File(target);
  if (actual !== source.sha256) {
    throw new Error(
      `Checksum mismatch for ${source.url}: expected ${source.sha256}, received ${actual}`
    );
  }
  log(`verified sha256 ${actual}`);
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.quiet ? 'ignore' : 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed ${signal ? `with signal ${signal}` : `with exit code ${String(code)}`}`
          )
        );
      }
    });
  });
}

async function allFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  }
  return result;
}

async function relocateDarwinRuntime(rootDir: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  for (const filePath of await allFiles(rootDir)) {
    const { stdout: fileDescription } = await execFileAsync('/usr/bin/file', ['-b', filePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (!fileDescription.includes('Mach-O')) continue;

    const { stdout } = await execFileAsync('/usr/bin/otool', ['-L', filePath], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split('\n').slice(1)) {
      const dependency = line.trim().split(' (compatibility version', 1)[0]?.trim();
      if (!dependency?.startsWith(`${rootDir}${path.sep}`)) continue;
      const relative = path.relative(path.dirname(filePath), dependency).split(path.sep).join('/');
      await run(
        '/usr/bin/install_name_tool',
        ['-change', dependency, `@loader_path/${relative}`, filePath],
        { quiet: true }
      );
    }
    if (filePath.endsWith('.dylib')) {
      await run(
        '/usr/bin/install_name_tool',
        ['-id', `@loader_path/${path.basename(filePath)}`, filePath],
        { quiet: true }
      );
    }
  }
}

async function parkExisting(target: string, label: string): Promise<void> {
  try {
    await access(target);
  } catch {
    return;
  }
  const parked = `${target}.${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  await rename(target, parked);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function parkStaleBuildLock(lockPath: string): Promise<boolean> {
  let pid: number | undefined;
  try {
    const parsed = safeJsonParse<Record<string, unknown> | null>(
      await readFile(lockPath, 'utf8'),
      null
    );
    if (process.platform === 'win32' && parsed?.lease === 'windows-pipe-v1') {
      await parkExisting(lockPath, 'stale');
      return true;
    }
    if (parsed && typeof parsed === 'object' && 'pid' in parsed) {
      const candidate = (parsed as { pid?: unknown }).pid;
      if (typeof candidate === 'number') pid = candidate;
    }
  } catch {
    // A just-created lock may briefly be empty. Its age check below prevents
    // another builder from reclaiming it while the owner writes metadata.
  }

  if (pid !== undefined && processIsAlive(pid)) return false;
  let ageMs: number;
  try {
    ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (pid === undefined && ageMs < BUILD_LOCK_TIMEOUT_MS) return false;
  try {
    await parkExisting(lockPath, 'stale');
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function readManifest(rootDir: string): Promise<PostgresRuntimeManifest | null> {
  try {
    const value = safeJsonParse<unknown>(
      await readFile(path.join(rootDir, MANIFEST_FILE), 'utf8'),
      null
    );
    if (!value || typeof value !== 'object') return null;
    const manifest = value as Partial<PostgresRuntimeManifest>;
    if (
      manifest.schemaVersion !== 2 ||
      manifest.runtimeId !== POSTGRES_RUNTIME_ID ||
      manifest.postgresVersion !== POSTGRES_VERSION ||
      manifest.pgvectorVersion !== PGVECTOR_VERSION ||
      manifest.platform !== platformKey() ||
      manifest.sourceSha256?.postgres !== POSTGRES_SOURCE.sha256 ||
      manifest.sourceSha256?.pgvector !== PGVECTOR_SOURCE.sha256 ||
      (process.platform === 'win32' &&
        (manifest.windowsBinarySha256 !== POSTGRES_WINDOWS_BINARY.sha256 ||
          manifest.windowsManifestRevision !== POSTGRES_WINDOWS_MANIFEST_REVISION)) ||
      manifest.minimumMacOSVersion !==
        (process.platform === 'darwin' ? POSTGRES_MINIMUM_MACOS_VERSION : null)
    ) {
      return null;
    }
    if (process.platform === 'win32') {
      for (const binary of REQUIRED_BINARIES) {
        const name = postgresExecutableName(binary);
        const expected = manifest.windowsExecutableSha256?.[name];
        if (
          !expected ||
          !/^[a-f0-9]{64}$/.test(expected) ||
          (await sha256File(path.join(rootDir, 'bin', name))) !== expected
        )
          return null;
      }
    }
    return manifest as PostgresRuntimeManifest;
  } catch {
    return null;
  }
}

export async function assertPostgresBinaryLayout(
  binDir: string,
  options: { requireManifest?: boolean; inspectBinary?: PostgresBinaryInspector } = {}
): Promise<void> {
  const rootDir = path.dirname(binDir);
  await Promise.all(
    REQUIRED_BINARIES.map((binary) =>
      access(path.join(binDir, postgresExecutableName(binary)), fsConstants.X_OK).catch(
        (error: unknown) => {
          throw new Error(
            `PostgreSQL runtime is missing executable ${path.join(binDir, postgresExecutableName(binary))}: ${getErrorMessage(error)}`
          );
        }
      )
    )
  );

  // Verify transformed Windows bytes before executing even pg_config.
  if (options.requireManifest && !(await readManifest(rootDir))) {
    throw new Error(`PostgreSQL runtime manifest is missing or incompatible at ${rootDir}`);
  }

  // PostgreSQL drops the `postgresql/` suffix from pkglibdir/sharedir when the
  // install prefix itself contains "postgres" or "pgsql", so the layout cannot
  // be hardcoded — ask pg_config where this runtime actually keeps them.
  const inspect =
    options.inspectBinary ??
    (async (executable, args, env) => {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
      });
      return stdout;
    });
  const environment = postgresRuntimeEnvironment(describeRuntime(rootDir));
  const reportedDirs = await inspect(
    path.join(binDir, postgresExecutableName('pg_config')),
    ['--pkglibdir', '--sharedir'],
    environment
  );
  const [pkglibdir, sharedir] = reportedDirs.split('\n').map((line) => line.trim());
  if (!pkglibdir || !sharedir) {
    throw new Error(`pg_config at ${binDir} did not report pkglibdir/sharedir`);
  }
  const canonicalRoot = await realpath(rootDir);
  for (const directory of [pkglibdir, sharedir]) {
    const relative = path.relative(canonicalRoot, await realpath(directory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(
        `PostgreSQL runtime references assets outside its relocatable root: ${directory}`
      );
    }
  }
  const extensionDir = path.join(sharedir, 'extension');
  await Promise.all([
    access(path.join(pkglibdir, extensionLibraryName('vector')), fsConstants.R_OK),
    access(path.join(pkglibdir, extensionLibraryName('pg_trgm')), fsConstants.R_OK),
    access(path.join(extensionDir, 'vector.control'), fsConstants.R_OK),
    access(path.join(extensionDir, 'pg_trgm.control'), fsConstants.R_OK),
  ]).catch((error: unknown) => {
    throw new Error(
      `PostgreSQL runtime at ${rootDir} is missing vector/pg_trgm extension assets: ${getErrorMessage(error)}`
    );
  });

  const vectorControl = await readFile(path.join(extensionDir, 'vector.control'), 'utf8');
  const vectorVersion = /^\s*default_version\s*=\s*'([^']+)'/m.exec(vectorControl)?.[1];
  if (vectorVersion !== PGVECTOR_VERSION) {
    throw new Error(
      `PostgreSQL runtime pgvector version mismatch: expected ${PGVECTOR_VERSION}, received ${vectorVersion ?? 'missing default_version'}`
    );
  }

  const stdout = await inspect(
    path.join(binDir, postgresExecutableName('postgres')),
    ['--version'],
    environment
  );
  const reportedVersion = stdout.match(/\bPostgreSQL\)?\s+([0-9]+(?:\.[0-9]+)+)\b/)?.[1];
  if (reportedVersion !== POSTGRES_VERSION) {
    throw new Error(
      `PostgreSQL runtime version mismatch at ${binDir}: expected ${POSTGRES_VERSION}, received ${stdout.trim()}`
    );
  }
}

async function waitForConcurrentBuild(rootDir: string, startedAt: number): Promise<BinDir> {
  while (Date.now() - startedAt < BUILD_LOCK_TIMEOUT_MS) {
    try {
      await assertPostgresBinaryLayout(path.join(rootDir, 'bin'), { requireManifest: true });
      return describeRuntime(rootDir);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(
    `Timed out waiting for another PostgreSQL runtime build at ${rootDir}; inspect ${rootDir}.build.lock`
  );
}

export async function buildPostgresRuntime(
  options: BuildPostgresRuntimeOptions = {}
): Promise<BinDir> {
  if (process.platform === 'win32') {
    const targetRoot = path.resolve(options.targetRoot ?? postgresRuntimeRoot());
    return withWindowsPostgresLease(
      `${targetRoot}.build`,
      () => buildPostgresRuntimeUnlocked(options),
      BUILD_LOCK_TIMEOUT_MS
    );
  }
  return buildPostgresRuntimeUnlocked(options);
}

async function buildPostgresRuntimeUnlocked(options: BuildPostgresRuntimeOptions): Promise<BinDir> {
  const log = options.log ?? ((line: string) => console.log(`[pg:runtime] ${line}`));
  const targetRoot = path.resolve(options.targetRoot ?? postgresRuntimeRoot());
  const binDir = path.join(targetRoot, 'bin');

  if (!options.force) {
    try {
      await assertPostgresBinaryLayout(binDir, { requireManifest: true });
      log(`present ${targetRoot}`);
      return describeRuntime(targetRoot);
    } catch {
      // Missing/incompatible cache is rebuilt below.
    }
  }

  await mkdir(path.dirname(targetRoot), { recursive: true });
  const lockPath = `${targetRoot}.build.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      try {
        await lock.writeFile(
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            targetRoot,
            ...(process.platform === 'win32' ? { lease: 'windows-pipe-v1' } : {}),
          }) + '\n'
        );
      } catch (error: unknown) {
        await lock
          .close()
          .catch((cleanupError: unknown) =>
            log(`failed to close PostgreSQL build lock: ${getErrorMessage(cleanupError)}`)
          );
        await unlink(lockPath).catch((cleanupError: unknown) =>
          log(`failed to remove PostgreSQL build lock: ${getErrorMessage(cleanupError)}`)
        );
        throw error;
      }
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await parkStaleBuildLock(lockPath)) {
        log(`reclaimed stale build lock ${lockPath}`);
        continue;
      }
      log(`waiting for concurrent build ${targetRoot}`);
      return waitForConcurrentBuild(targetRoot, Date.now());
    }
  }

  const buildDir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-pg-build-'));
  const stagingRoot = `${targetRoot}.staging-${process.pid}-${randomBytes(4).toString('hex')}`;
  const jobs = String(Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length)));
  const postgresArchive = path.join(buildDir, `postgresql-${POSTGRES_VERSION}.tar.bz2`);
  const pgvectorArchive = path.join(buildDir, `pgvector-${PGVECTOR_VERSION}.tar.gz`);
  const postgresSourceDir = path.join(buildDir, `postgresql-${POSTGRES_VERSION}`);
  const pgvectorSourceDir = path.join(buildDir, `pgvector-${PGVECTOR_VERSION}`);
  let buildEnvironment: NodeJS.ProcessEnv = process.env;
  let windowsExecutableSha256: Record<string, string> | undefined;

  try {
    log(`building ${POSTGRES_RUNTIME_ID} for ${platformKey()} (${jobs} jobs)`);
    if (process.platform === 'darwin') {
      buildEnvironment = await resolveDarwinBuildEnvironment({ log });
    }
    if (process.platform === 'win32') {
      const compilerEnvironment = await resolveWindowsBuildEnvironment();
      const binaryArchive = path.join(buildDir, 'postgresql-windows.zip');
      await downloadVerified(POSTGRES_WINDOWS_BINARY, binaryArchive, log);
      await downloadVerified(PGVECTOR_SOURCE, pgvectorArchive, log);
      await run('tar', [
        '-xf',
        binaryArchive,
        '-C',
        buildDir,
        'pgsql/bin',
        'pgsql/lib',
        'pgsql/share',
        'pgsql/include',
        'pgsql/doc',
        'pgsql/server_license.txt',
        'pgsql/commandlinetools_3rd_party_licenses.txt',
      ]);
      await run('tar', ['-xzf', pgvectorArchive, '-C', buildDir]);
      await cp(path.join(buildDir, 'pgsql'), stagingRoot, { recursive: true });
      await cp(path.join(pgvectorSourceDir, 'LICENSE'), path.join(stagingRoot, 'pgvector-LICENSE'));
      await cp(
        path.join(pgvectorSourceDir, 'README.md'),
        path.join(stagingRoot, 'pgvector-README.md')
      );
      // Building only pgvector keeps the vendor's verified PostgreSQL DLLs
      // and ABI together; discovery also supports a normal PowerShell shell.
      const vectorEnvironment = { ...compilerEnvironment, PGROOT: stagingRoot };
      await run('nmake.exe', ['/F', 'Makefile.win'], {
        cwd: pgvectorSourceDir,
        env: vectorEnvironment,
      });
      await run('nmake.exe', ['/F', 'Makefile.win', 'install'], {
        cwd: pgvectorSourceDir,
        env: vectorEnvironment,
      });
      windowsExecutableSha256 = await applyWindowsUtf8Manifests(
        path.join(stagingRoot, 'bin'),
        REQUIRED_BINARIES.map(postgresExecutableName),
        buildDir,
        compilerEnvironment
      );
    } else {
      await downloadVerified(POSTGRES_SOURCE, postgresArchive, log);
      await downloadVerified(PGVECTOR_SOURCE, pgvectorArchive, log);
      await run('tar', ['-xjf', postgresArchive, '-C', buildDir]);
      await run('tar', ['-xzf', pgvectorArchive, '-C', buildDir]);
      await mkdir(stagingRoot, { recursive: true });

      await run(
        path.join(postgresSourceDir, 'configure'),
        [
          `--prefix=${stagingRoot}`,
          '--without-readline',
          '--without-zlib',
          '--without-icu',
          '--without-llvm',
          '--without-lz4',
          '--without-zstd',
        ],
        { cwd: postgresSourceDir, env: buildEnvironment }
      );
      await run('make', [`-j${jobs}`], { cwd: postgresSourceDir, env: buildEnvironment });
      await run('make', ['install'], { cwd: postgresSourceDir, env: buildEnvironment });
      await run('make', ['-C', path.join(postgresSourceDir, 'contrib', 'pg_trgm'), 'install'], {
        env: buildEnvironment,
      });

      const vectorEnv = {
        ...buildEnvironment,
        PG_CONFIG: path.join(stagingRoot, 'bin', 'pg_config'),
      };
      await run('make', [`-j${jobs}`, 'OPTFLAGS='], {
        cwd: pgvectorSourceDir,
        env: vectorEnv,
      });
      await run('make', ['OPTFLAGS=', 'install'], {
        cwd: pgvectorSourceDir,
        env: vectorEnv,
      });

      // `make install` copies no license texts. Ship them beside the runtime
      // as the Windows branch does; desktop staging bundles every top-level
      // license/copyright/readme file. pgvector's LICENSE and README.md come
      // from the same pinned archive Windows copies them from.
      await cp(path.join(pgvectorSourceDir, 'LICENSE'), path.join(stagingRoot, 'pgvector-LICENSE'));
      await cp(
        path.join(pgvectorSourceDir, 'README.md'),
        path.join(stagingRoot, 'pgvector-README.md')
      );
      const postgresCopyright = path.join(postgresSourceDir, 'COPYRIGHT');
      if ((await stat(postgresCopyright).catch(() => null))?.isFile()) {
        await cp(postgresCopyright, path.join(stagingRoot, 'postgresql-COPYRIGHT'));
      } else {
        log(`PostgreSQL source has no COPYRIGHT file at ${postgresCopyright}; none shipped`);
      }
    }
    await relocateDarwinRuntime(stagingRoot);

    const manifest: PostgresRuntimeManifest = {
      schemaVersion: 2,
      runtimeId: POSTGRES_RUNTIME_ID,
      postgresVersion: POSTGRES_VERSION,
      pgvectorVersion: PGVECTOR_VERSION,
      platform: platformKey(),
      sourceSha256: {
        postgres: POSTGRES_SOURCE.sha256,
        pgvector: PGVECTOR_SOURCE.sha256,
      },
      minimumMacOSVersion: process.platform === 'darwin' ? POSTGRES_MINIMUM_MACOS_VERSION : null,
      ...(process.platform === 'win32'
        ? {
            windowsBinarySha256: POSTGRES_WINDOWS_BINARY.sha256,
            windowsManifestRevision: POSTGRES_WINDOWS_MANIFEST_REVISION,
            windowsExecutableSha256,
          }
        : {}),
      builtAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(stagingRoot, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o644,
      }
    );
    await assertPostgresBinaryLayout(path.join(stagingRoot, 'bin'), { requireManifest: true });

    await parkExisting(targetRoot, options.force ? 'replaced' : 'invalid');
    await rename(stagingRoot, targetRoot);
    log(`installed ${targetRoot}`);

    if (options.archive) {
      const archivePath = `${targetRoot}.tar.gz`;
      await parkExisting(archivePath, 'replaced');
      await parkExisting(`${archivePath}.sha256`, 'replaced');
      await run('tar', [
        '-czf',
        archivePath,
        '-C',
        path.dirname(targetRoot),
        path.basename(targetRoot),
      ]);
      const archiveSha = await sha256File(archivePath);
      await writeFile(`${archivePath}.sha256`, `${archiveSha}  ${path.basename(archivePath)}\n`, {
        mode: 0o644,
      });
      log(`archive ${archivePath} sha256 ${archiveSha}`);
    }

    return describeRuntime(targetRoot);
  } catch (error: unknown) {
    let diagnostic = '';
    try {
      const configLog = await readFile(path.join(postgresSourceDir, 'config.log'), 'utf8');
      const logPath = `${stagingRoot}.config.log`;
      await writeFile(logPath, configLog, { mode: 0o600 });
      diagnostic = ` Configure diagnostics saved to ${logPath}`;
    } catch {
      // Failures before configure have no config.log. Preserve the original error.
    }
    throw new Error(
      `Failed to build ${POSTGRES_RUNTIME_ID}: ${getErrorMessage(error)}${diagnostic}`
    );
  } finally {
    await lock
      .close()
      .catch((error: unknown) => log(`failed to close build lock: ${getErrorMessage(error)}`));
    await unlink(lockPath).catch((error: unknown) =>
      log(`failed to remove build lock: ${getErrorMessage(error)}`)
    );
    await rm(buildDir, { recursive: true, force: true }).catch((error: unknown) =>
      log(`failed to remove build directory: ${getErrorMessage(error)}`)
    );
    await rm(stagingRoot, { recursive: true, force: true }).catch((error: unknown) =>
      log(`failed to remove staging runtime: ${getErrorMessage(error)}`)
    );
  }
}

export async function ensurePostgresBinaries(
  options: EnsurePostgresBinariesOptions = {}
): Promise<BinDir> {
  const override = process.env.SNAGLET_PG_BINDIR?.trim();
  if (override) {
    // `~` in SNAGLET_PG_BINDIR expands like every other path-like setting. A
    // relative value resolves against the cwd: it points at binaries that
    // must already exist, and the layout assertion below
    // fails loudly if they don't — it cannot silently create misplaced state.
    const binDir = path.resolve(expandHomePath(override));
    await assertPostgresBinaryLayout(binDir, {
      requireManifest: process.env.SNAGLET_PG_OWNED === '1',
      inspectBinary: options.inspectBinary,
    });
    return describeRuntime(path.dirname(binDir));
  }
  if (process.env.SNAGLET_PG_OWNED === '1') {
    throw new Error(
      'Packaged Snaglet owns its PostgreSQL lifecycle but SNAGLET_PG_BINDIR is unset; refusing to compile or download executable code at runtime.'
    );
  }

  const rootDir = postgresRuntimeRoot(options.runtimeBaseDir);
  const binDir = path.join(rootDir, 'bin');
  try {
    await assertPostgresBinaryLayout(binDir, {
      requireManifest: true,
      inspectBinary: options.inspectBinary,
    });
    return describeRuntime(rootDir);
  } catch (error: unknown) {
    if (options.buildIfMissing === false) {
      throw new Error(
        `PostgreSQL runtime is unavailable at ${rootDir}: ${getErrorMessage(error)}. Run pnpm pg:runtime:build --strict.`
      );
    }
  }

  return buildPostgresRuntime({ targetRoot: rootDir, log: options.log });
}

export async function postgresRuntimeSizeBytes(runtime: BinDir): Promise<number> {
  const rootDir = runtime.rootDir;
  const pending = [rootDir];
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entry = await stat(current);
    if (!entry.isDirectory()) {
      total += entry.size;
      continue;
    }
    for (const name of await readdir(current)) pending.push(path.join(current, name));
  }
  return total;
}
