import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBuildProfile } from '../profiles';
import { verifyPackagedPostgres } from './postgres-artifact';
import { FORBIDDEN_STAGED_PATH, sourceMapPolicyForbids } from './staged-path-policy.mjs';
import { requestServerShutdown } from '../../scripts/lib/child-shutdown';
import {
  sanitizeScratchPreviewEnvironment,
  scratchTestCredentialEnvironment,
} from '../../scripts/preview-scratch';

interface StagingManifest {
  files: Array<{ path: string; sha256: string; size: number }>;
  node: { executable: string; sha256: string; triple: string; version: string };
  postgres: {
    bin: string;
    machOFiles: number;
    minimumMacOSVersion: string | null;
    pgvectorVersion: string;
    platform: string;
    postgresVersion: string;
    root: string;
    runtimeId: string;
    windowsManifestRevision?: string;
    signingIdentity: string | null;
  };
  profile: string;
  schemaVersion: number;
  totalBytes: number;
}

const profile = resolveBuildProfile(process.env.SNAGLET_BUILD_PROFILE ?? 'desktop-preview');
if (profile.name === 'browser-preview') {
  throw new Error('Desktop stage verification requires a desktop build profile');
}
const output = path.resolve(profile.outputDirectory);
const staged = path.join(output, 'staged');
const manifestPath = path.join(output, 'staging-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StagingManifest;
const runtime = mkdtempSync(path.join(os.tmpdir(), 'snaglet-desktop-stage-'));
const pgRoot = path.join(staged, manifest.postgres.root);
const pgData = path.join(runtime, 'postgres');
const pgCtl = path.join(pgRoot, 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
const port = profile.serverPort;
const baseUrl = `http://127.0.0.1:${port}`;
const shutdownToken = randomBytes(32).toString('hex');
const authToken = randomBytes(32).toString('hex');
let serverListening = false;

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`Unsupported staged file type: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

function verifyManifest(): void {
  if (
    manifest.schemaVersion !== 3 ||
    manifest.profile !== profile.name ||
    manifest.node.version !== '22.22.0' ||
    manifest.postgres.root !== 'pg' ||
    manifest.postgres.bin !== 'pg/bin'
  ) {
    throw new Error('Desktop staging manifest identity is invalid');
  }
  const actualPaths = walkFiles(staged).map((file) =>
    path.relative(staged, file).split(path.sep).join('/')
  );
  const manifestPaths = manifest.files.map((file) => file.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifestPaths)) {
    throw new Error('Desktop staging manifest file list is incomplete');
  }
  for (const file of manifest.files) {
    if (FORBIDDEN_STAGED_PATH.test(file.path)) {
      throw new Error(`Forbidden staged path: ${file.path}`);
    }
    if (sourceMapPolicyForbids(profile.sourceMaps, file.path)) {
      throw new Error(`Source map violates profile policy: ${file.path}`);
    }
    const absolute = path.join(staged, file.path);
    if (statSync(absolute).size !== file.size || hash(absolute) !== file.sha256) {
      throw new Error(`Staging manifest mismatch: ${file.path}`);
    }
  }
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total !== manifest.totalBytes) throw new Error('Staging manifest totalBytes is invalid');
  const node = path.join(staged, manifest.node.executable);
  if (hash(node) !== manifest.node.sha256) throw new Error('Staged Node runtime hash is invalid');

  const postgres = verifyPackagedPostgres(pgRoot);
  for (const key of [
    'machOFiles',
    'minimumMacOSVersion',
    'pgvectorVersion',
    'platform',
    'postgresVersion',
    'runtimeId',
    'windowsManifestRevision',
  ] as const) {
    if (postgres[key] !== manifest.postgres[key]) {
      throw new Error(`Staged PostgreSQL metadata mismatch: ${key}`);
    }
  }
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Staged server exited with code ${child.exitCode}`);
    try {
      // Readiness must belong to the spawned child, even if another Snaglet server
      // already occupies this profile's fixed port.
      if (!serverListening) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          checks?: { database?: { status?: string } };
        };
        if (body.checks?.database?.status === 'ok') return;
      }
    } catch {
      // The staged server or its fresh managed cluster is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Staged server did not become database-ready within 120 seconds');
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  let shutdownRequestError: unknown;
  let gracefulTimeout = false;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32')
        await requestServerShutdown(baseUrl, shutdownToken, authToken);
      else child.kill('SIGTERM');
    } catch (error: unknown) {
      shutdownRequestError = error;
      child.kill('SIGKILL');
    }
  }
  if (!(await waitForExit(child, 90_000))) {
    gracefulTimeout = true;
    child.kill('SIGKILL');
    if (!(await waitForExit(child, 5_000))) {
      throw new Error(`Staged Node server death is unconfirmed; preserving ${runtime}`);
    }
  }
  if (statSync(path.join(pgData, 'PG_VERSION'), { throwIfNoEntry: false })?.isFile()) {
    const status = spawnSync(pgCtl, ['status', '-D', pgData], { stdio: 'ignore' });
    if (status.status === 0) {
      const cleanup = spawnSync(
        pgCtl,
        ['stop', '-D', pgData, '-m', 'immediate', '-w', '-t', '30'],
        {
          stdio: 'inherit',
        }
      );
      if (cleanup.status !== 0) {
        throw new Error(`Staged PostgreSQL cleanup failed; preserving ${runtime}`);
      }
      throw new Error(
        'Staged Node server exited without stopping its exact owned PostgreSQL cluster'
      );
    }
    if (status.status !== 3) {
      throw new Error(`Staged PostgreSQL status is inconclusive; preserving ${runtime}`);
    }
  }
  if (shutdownRequestError) {
    throw new Error('Staged Node server graceful shutdown request failed', {
      cause: shutdownRequestError,
    });
  }
  if (gracefulTimeout) throw new Error('Staged Node server exceeded its shutdown budget');
}

verifyManifest();
const nodeExecutable = path.join(staged, manifest.node.executable);
const serverDirectory = path.join(staged, 'server');
const env: NodeJS.ProcessEnv = {
  ...sanitizeScratchPreviewEnvironment(process.env),
  ...scratchTestCredentialEnvironment({}),
  // This staged artifact sits beneath the checkout. Explicit empty overrides
  // keep its env loader from restoring a live database URL from a repo .env.
  DATABASE_URL: '',
  SNAGLET_DATABASE_URL: '',
  SNAGLET_DB_CONFIG_PATH: '',
  SNAGLET_DATABASE_NAME: 'snaglet',
  SNAGLET_ENV: 'prod',
  API_BASE_URL: baseUrl,
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  SNAGLET_ALLOWED_ORIGINS: baseUrl,
  SNAGLET_BIND_HOST: '127.0.0.1',
  SNAGLET_AUTH_TOKEN: authToken,
  SNAGLET_BACKUPS_DIR: path.join(runtime, 'data/backups'),
  SNAGLET_BUILD_PROFILE: profile.name,
  SNAGLET_DB_MODE: 'managed',
  SNAGLET_HOME: path.join(runtime, 'home'),
  SNAGLET_HOME_POINTER_FILE: path.join(runtime, 'home-pointer.json'),
  SNAGLET_LOG_DIR: path.join(runtime, 'logs'),
  SNAGLET_PG_BINDIR: path.join(pgRoot, 'bin'),
  SNAGLET_PG_DATA_DIR: pgData,
  SNAGLET_PG_OWNED: '1',
  SNAGLET_SHUTDOWN_TOKEN: shutdownToken,
  NODE_ENV: 'production',
  PORT: String(port),
  RUN_BACKGROUND_WORKERS: 'false',
};
const child = spawn(nodeExecutable, ['server.mjs'], {
  cwd: serverDirectory,
  stdio: ['ignore', 'pipe', 'inherit'],
  env,
  windowsHide: true,
});
let startupOutput = '';
child.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
  startupOutput = `${startupOutput}${chunk.toString('utf8')}`.slice(-4_096);
  if (startupOutput.includes(`Server running on 127.0.0.1:${port}`)) serverListening = true;
});

try {
  await waitForReady(child);
  const response = await fetch(baseUrl);
  if (!response.ok || !(await response.text()).includes('<div id="root">')) {
    throw new Error('Staged server did not serve the built desktop UI');
  }
  console.log(
    `[desktop-stage] verified manifest, PostgreSQL ${manifest.postgres.postgresVersion}, and staged Node ${manifest.node.version} server at ${baseUrl}`
  );
} finally {
  await stopServer(child);
  rmSync(runtime, { force: true, recursive: true });
}
