/** Scratch-only lifecycle proof for Snaglet's managed PostgreSQL runtime. */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { ensurePostgresBinaries, postgresRuntimeEnvironment } from '../runtime/postgres/binaries';
import { getErrorMessage } from '@snaglet/shared/utils';
import { PostgresRuntime, stampPostgresDataDir } from '../runtime/postgres/runtime';

async function main(): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'snaglet-pg-runtime-verify-'));
  const snagletHome = path.join(scratch, 'Home with spaces ü 日本');
  const dataDir = path.join(snagletHome, 'postgres');
  const first = new PostgresRuntime({ snagletHome, dataDir });
  let stopped = false;

  try {
    await first.ensureCluster();
    const started = await first.start();
    if (!started.running || !started.pid || !started.socketReady) {
      throw new Error(`initial start was not healthy: ${JSON.stringify(started)}`);
    }

    const replacement = new PostgresRuntime({ snagletHome, dataDir });
    if (!(await replacement.adoptIfRunning())) {
      throw new Error('fresh runtime instance did not adopt the live postmaster');
    }
    const adopted = await replacement.status();
    if (adopted.pid !== started.pid || !adopted.socketReady) {
      throw new Error(`adoption changed or lost the postmaster: ${JSON.stringify(adopted)}`);
    }

    let socketRecovered = adopted;
    if (replacement.transport === 'socket') {
      // A tmp cleaner may remove the socket while its postmaster survives.
      await rm(replacement.socketDir, { recursive: true, force: true });
      socketRecovered = await replacement.start();
      if (
        !socketRecovered.running ||
        !socketRecovered.socketReady ||
        socketRecovered.pid === started.pid
      ) {
        throw new Error(`socket-loss recovery was not healthy: ${JSON.stringify(socketRecovered)}`);
      }
    } else {
      const originalPassword = await readFile(replacement.passwordPath, 'utf8');
      try {
        await writeFile(replacement.passwordPath, 'incorrect-verification-password\n');
        if ((await replacement.status()).state !== 'conflict')
          throw new Error('Unauthenticated server was accepted');
      } finally {
        await writeFile(replacement.passwordPath, originalPassword);
      }
    }

    const info = await replacement.connectionInfo();
    const pool = new Pool({
      host: info.host,
      port: info.port,
      user: info.user,
      password: info.password,
      database: info.database,
    });
    try {
      await pool.query('CREATE EXTENSION vector; CREATE EXTENSION pg_trgm');
      const extensions = await pool.query<{ extname: string; extversion: string }>(
        "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname"
      );
      if (extensions.rows.length !== 2) throw new Error('Required native extensions did not load');
      console.log(JSON.stringify({ nativeExtensions: extensions.rows }));
      await pool.query(
        "CREATE TABLE runtime_verification(value text); INSERT INTO runtime_verification VALUES ('restart-persistence')"
      );
    } finally {
      await pool.end();
    }

    // Immediate shutdown exercises PostgreSQL WAL recovery without deleting
    // live files or trusting an unverified arbitrary process identifier.
    const binaries = await ensurePostgresBinaries({ buildIfMissing: false });
    await promisify(execFile)(binaries.pgCtl, ['stop', '-D', dataDir, '-m', 'immediate', '-w'], {
      env: postgresRuntimeEnvironment(binaries),
      windowsHide: true,
    });
    await replacement.start();
    const recoveredInfo = await replacement.connectionInfo();
    const recoveredPool = new Pool({
      host: recoveredInfo.host,
      port: recoveredInfo.port,
      user: recoveredInfo.user,
      password: recoveredInfo.password,
      database: recoveredInfo.database,
    });
    try {
      const result = await recoveredPool.query<{ value: string }>(
        'SELECT value FROM runtime_verification'
      );
      if (result.rows[0]?.value !== 'restart-persistence')
        throw new Error('WAL recovery lost committed data');
    } finally {
      await recoveredPool.end();
    }

    await replacement.stop('fast');
    const restarted = await replacement.start();
    if (!restarted.running || !restarted.socketReady) {
      throw new Error(`restart was not healthy: ${JSON.stringify(restarted)}`);
    }
    await stampPostgresDataDir(dataDir, 0);
    await replacement.stop('smart');
    stopped = true;

    console.log(
      JSON.stringify(
        {
          scratch,
          initialPid: started.pid,
          adoptedPid: adopted.pid,
          socketRecoveryPid: socketRecovered.pid,
          restartedPid: restarted.pid,
          socketDir: replacement.socketDir,
          host: restarted.host,
          port: restarted.port,
          transport: restarted.transport,
          result: 'PASS',
        },
        null,
        2
      )
    );
  } finally {
    if (!stopped) {
      try {
        await first.stop('fast');
        stopped = true;
      } catch (error: unknown) {
        console.warn(
          `[pg:runtime:verify] retained cluster after stop failure: ${getErrorMessage(error)}`
        );
      }
    }
    if (stopped) await rm(scratch, { recursive: true, force: true });
    else console.warn(`Retained verification cluster at ${scratch}`);
    await rm(first.socketDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[pg:runtime:verify] socket dir cleanup failed: ${getErrorMessage(err)}`);
    });
  }
}

main().catch((error: unknown) => {
  console.error(`[pg:runtime:verify] ${getErrorMessage(error)}`);
  process.exit(1);
});
