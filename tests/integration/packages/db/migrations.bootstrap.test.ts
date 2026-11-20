/**
 * Migration harness regression test — fresh managed PostgreSQL bootstrap
 * through every bundled migration, ledger idempotency, seed replay safety,
 * and the schema contract (vector(768) + HNSW + local-onnx seed).
 *
 * Runs in a child process (`packages/db/scripts/verify-fresh-bootstrap.ts`) so
 * the verifier's destructive raw migration replays stay outside this file's
 * own database. It is handed an EMPTY database in the run's shared cluster —
 * not the migrated, seeded per-file clone, because applying the migrations
 * from scratch is the thing under test.
 */

import { migrationFiles } from '@snaglet/db/migration-files';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createEmptyTestDatabase, type EmptyTestDatabase } from '../../../support/pgTestCluster';

const dbPackageDir = path.resolve(__dirname, '../../../../packages/db');

describe('migration harness (empty database in the shared managed cluster, child process)', () => {
  let target: EmptyTestDatabase;

  beforeAll(() => {
    target = createEmptyTestDatabase('bootstrap');
  });

  afterAll(() => {
    target?.drop();
  });

  it('fresh bootstrap from 0001_init + idempotent re-apply + schema contract', () => {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', 'scripts/verify-fresh-bootstrap.ts'], {
      cwd: dbPackageDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, SNAGLET_VERIFIER_DATABASE_URL: target.url },
    });
    const lines = stdout.trim().split('\n');
    const report = JSON.parse(lines[lines.length - 1]) as {
      ok: boolean;
      migrationCount: number;
      baselineLedger: boolean;
      idempotentReapply: boolean;
      vectorTypmod: number;
      hnswIndex: boolean;
      localModelSeeded: boolean;
      builtinMcpConfirmation: boolean;
      catalogSeedReplay: boolean;
      ghostAgentGuarded: boolean;
      xaiSeeded: boolean;
      featureFlags: boolean;
      localModelRemovalUiDisabled: boolean;
      statusCategoryRetired: boolean;
      memberReferenceKind: boolean;
    };
    expect(report.ok).toBe(true);
    // Fresh bootstrap includes every bundled migration, and a subsequent
    // db:migrate remains a no-op.
    expect(report.migrationCount).toBe(migrationFiles().length);
    expect(report.baselineLedger).toBe(true);
    expect(report.idempotentReapply).toBe(true);
    expect(report.vectorTypmod).toBe(768);
    expect(report.hnswIndex).toBe(true);
    expect(report.localModelSeeded).toBe(true);
    expect(report.builtinMcpConfirmation).toBe(true);
    expect(report.catalogSeedReplay).toBe(true);
    expect(report.ghostAgentGuarded).toBe(true);
    expect(report.xaiSeeded).toBe(true);
    expect(report.featureFlags).toBe(true);
    expect(report.localModelRemovalUiDisabled).toBe(true);
    expect(report.statusCategoryRetired).toBe(true);
    expect(report.memberReferenceKind).toBe(true);
  }, 150_000);
});
