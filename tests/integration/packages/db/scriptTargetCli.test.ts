/**
 * db-script target guard through the real CLI entry points, in a
 * child process. Safety: HOME is a throwaway dir, so `~/.snaglet`, `~/.snaglet.json` and
 * `~/.snaglet-dev` all resolve inside $TMPDIR; the only database written is an empty
 * one in this run's shared test cluster (dropped afterward). Nothing here can
 * reach a real Snaglet home.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import { createEmptyTestDatabase, type EmptyTestDatabase } from '../../../support/pgTestCluster';

const repoRoot = path.resolve(__dirname, '../../../..');
const dbDir = path.join(repoRoot, 'packages', 'db');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

let fakeHome: string;
let target: EmptyTestDatabase;

beforeAll(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), 'snaglet-guard-cli-'));
  target = createEmptyTestDatabase('script_guard');
});

afterAll(() => {
  target?.drop();
  rmSync(fakeHome, { recursive: true, force: true });
});

function runCli(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(tsx, [script, ...args], {
    cwd: dbDir,
    encoding: 'utf8',
    timeout: 120_000,
    // A clean env: no inherited SNAGLET_* (jest sets SNAGLET_HOME / SNAGLET_DATABASE_URL).
    env: { PATH: process.env.PATH ?? '', HOME: fakeHome, TMPDIR: tmpdir(), ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function ledgerExists(): Promise<boolean> {
  const pool = new Pool({ connectionString: target.url, max: 1 });
  try {
    const { rows } = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public._migrations') IS NOT NULL AS present"
    );
    return rows[0]?.present === true;
  } finally {
    await pool.end();
  }
}

describe('db scripts refuse an implicit target', () => {
  it.each([
    ['migrations.ts', []],
    ['db.ts', []],
    ['scripts/create-scratch-database.ts', ['lane']],
  ])('%s with no target exits 2 and starts nothing', (script, args) => {
    // Agent-shell shape: NODE_ENV=production inherited, plus SNAGLET_BUNDLED=1 to
    // prove the env var cannot skip the guard.
    const r = runCli(script, args, { NODE_ENV: 'production', SNAGLET_BUNDLED: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no explicit target');
    expect(r.stderr).toContain('Nothing was written');
    expect(existsSync(path.join(fakeHome, '.snaglet', 'postgres'))).toBe(false);
  });

  it('production needs both signals', () => {
    const r = runCli('migrations.ts', ['--target=prod']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Refusing to write to PRODUCTION');
    expect(existsSync(path.join(fakeHome, '.snaglet', 'postgres'))).toBe(false);
  });
});

describe('migrate against an explicit external target', () => {
  it('--dry-run prints the target and pending list and writes nothing (no ledger)', async () => {
    const r = runCli('migrations.ts', ['--target=external', '--dry-run'], {
      SNAGLET_DATABASE_URL: target.url,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[db] target  : external');
    expect(r.stderr).toContain('dry run: nothing will be written');
    expect(r.stderr).toMatch(/\[db\] pending : 0001_init\.sql/);
    expect(r.stderr).not.toContain(new URL(target.url).password);
    expect(await ledgerExists()).toBe(false);
  });

  it('a real run prints the target block before applying anything', async () => {
    const r = runCli('migrations.ts', ['--target=external'], { SNAGLET_DATABASE_URL: target.url });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[db] target  : external');
    expect(r.stderr).toMatch(/\[db\] pending : 0001_init\.sql/);
    expect(r.stdout).toContain('✓ 0001_init.sql');
    expect(await ledgerExists()).toBe(true);
  });
});
