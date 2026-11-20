/**
 * Crash-window proof for PostgreSQL restore swaps. A child process pauses
 * immediately after snaglet -> snaglet_parked_* and is SIGKILLed by the parent. The next
 * runtime start must recover the original before ensureDatabase() can create a
 * fresh empty snaglet database.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { PostgresAdapter } from '../adapters/postgres';
import { PostgresBackupAdapter } from '../adapters/postgres-backup';
import { bootstrapIfFresh } from '../migrations';
import { PostgresRuntime } from '../runtime/postgres/runtime';

interface ChildMessage {
  state?: string;
  error?: string;
}

async function connectionFor(runtime: PostgresRuntime) {
  const info = await runtime.connectionInfo();
  return {
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.user,
    password: info.password,
  };
}

async function childMain(snagletHome: string, artifactPath: string): Promise<void> {
  const runtime = new PostgresRuntime({ snagletHome, dataDir: path.join(snagletHome, 'postgres') });
  await runtime.start();
  const connection = await connectionFor(runtime);
  let active: PostgresAdapter | null = new PostgresAdapter(connection);
  const adapter = new PostgresBackupAdapter({
    connection,
    markerPath: runtime.restoreMarkerPath,
    quiesce: async () => {
      const current = active;
      active = null;
      if (current) await current.end();
    },
    reconnect: async () => {
      active = new PostgresAdapter(connection);
      await active.query('SELECT 1');
    },
    resume: () => {},
    onSwapState: async (state) => {
      if (state !== 'parked') return;
      process.send?.({ state });
      await new Promise<never>(() => {});
    },
  });
  await adapter.restore(await readFile(artifactPath), { format: 'custom' });
  throw new Error('Crash child unexpectedly completed restore');
}

async function waitForParked(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for parked swap state')),
      60_000
    );
    child.on('message', (message: ChildMessage) => {
      if (message.error) {
        clearTimeout(timer);
        reject(new Error(message.error));
      } else if (message.state === 'parked') {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Crash child exited early (${String(code)}, ${String(signal)})`));
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function parentMain(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'snaglet-restore-crash-proof-'));
  const snagletHome = path.join(scratch, 'home');
  const artifactPath = path.join(scratch, 'snapshot.dump');
  const runtime = new PostgresRuntime({ snagletHome, dataDir: path.join(snagletHome, 'postgres') });
  try {
    await runtime.start();
    const connection = await connectionFor(runtime);
    const db = new PostgresAdapter(connection);
    await bootstrapIfFresh(db);
    await db.exec(`CREATE TABLE public.restore_crash_probe (
      id text PRIMARY KEY,
      value text NOT NULL
    )`);
    await db.query(
      `INSERT INTO public.restore_crash_probe (id, value) VALUES ('original', 'must survive')`
    );
    const dumper = new PostgresBackupAdapter({
      connection,
      markerPath: runtime.restoreMarkerPath,
      quiesce: async () => {},
      reconnect: async () => {},
      resume: () => {},
    });
    await writeFile(artifactPath, await dumper.dump({ format: 'custom' }), { mode: 0o600 });
    await db.end();

    // Literal empty-cluster roundtrip: stop and remove only this verifier's
    // throwaway PostgreSQL data directory, initialize a new cluster at the
    // same scratch home, then restore the artifact through the production
    // scratch-database rename swap.
    await runtime.stop('fast');
    await rm(runtime.dataDir, { recursive: true, force: true });
    await rm(runtime.socketDir, { recursive: true, force: true });
    const emptyRuntime = new PostgresRuntime({
      snagletHome,
      dataDir: path.join(snagletHome, 'postgres'),
    });
    await emptyRuntime.start();
    const emptyConnection = await connectionFor(emptyRuntime);
    let emptyActive: PostgresAdapter | null = new PostgresAdapter(emptyConnection);
    await bootstrapIfFresh(emptyActive);
    const roundtrip = new PostgresBackupAdapter({
      connection: emptyConnection,
      markerPath: emptyRuntime.restoreMarkerPath,
      quiesce: async () => {
        const current = emptyActive;
        emptyActive = null;
        if (current) await current.end();
      },
      reconnect: async () => {
        emptyActive = new PostgresAdapter(emptyConnection);
        await emptyActive.query('SELECT 1');
      },
      resume: () => {},
    });
    await roundtrip.restore(await readFile(artifactPath), { format: 'custom' });
    if (!emptyActive) throw new Error('Empty-cluster restore did not reconnect the active pool');
    const roundtripProbe = await emptyActive.query<{ value: string }>(
      `SELECT value FROM public.restore_crash_probe WHERE id = 'original'`
    );
    if (roundtripProbe.rows[0]?.value !== 'must survive') {
      throw new Error('Empty-cluster backup/restore roundtrip lost the original probe row');
    }
    await emptyActive.end();

    const child = spawn(
      process.execPath,
      ['--import=tsx', fileURLToPath(import.meta.url), '--child', snagletHome, artifactPath],
      {
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }
    );
    await waitForParked(child);
    child.kill('SIGKILL');
    await waitForExit(child);

    const recoveryRuntime = new PostgresRuntime({
      snagletHome,
      dataDir: path.join(snagletHome, 'postgres'),
    });
    await recoveryRuntime.start();
    const recovered = new PostgresAdapter(await connectionFor(recoveryRuntime));
    const probe = await recovered.query<{ value: string }>(
      `SELECT value FROM public.restore_crash_probe WHERE id = 'original'`
    );
    if (probe.rows[0]?.value !== 'must survive') {
      throw new Error('Original database was not recovered after the interrupted swap');
    }
    const databases = await recovered.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'snaglet_restore_abandoned_%'`
    );
    const retainedCandidate = databases.rows[0];
    if (databases.rows.length !== 1 || !retainedCandidate) {
      throw new Error(`Expected one retained abandoned candidate, found ${databases.rows.length}`);
    }
    await recovered.end();
    try {
      await readFile(recoveryRuntime.restoreMarkerPath);
      throw new Error('Restore marker still exists after successful automatic recovery');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    console.log(
      JSON.stringify({
        ok: true,
        emptyClusterRoundtrip: roundtripProbe.rows[0].value,
        recoveredValue: probe.rows[0].value,
        retainedCandidate: retainedCandidate.datname,
      })
    );
  } finally {
    // A failed stop retains the explicitly allocated evidence directory.
    await runtime.stop('fast');
    await rm(runtime.socketDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

const childIndex = process.argv.indexOf('--child');
if (childIndex >= 0) {
  const snagletHome = process.argv[childIndex + 1];
  const artifactPath = process.argv[childIndex + 2];
  if (!snagletHome || !artifactPath)
    throw new Error('Crash child requires snagletHome and artifactPath');
  childMain(snagletHome, artifactPath).catch((error: unknown) => {
    process.send?.({ error: getErrorMessage(error) });
    process.exitCode = 1;
  });
} else {
  parentMain().catch((error: unknown) => {
    console.error(getErrorMessage(error));
    process.exitCode = 1;
  });
}
