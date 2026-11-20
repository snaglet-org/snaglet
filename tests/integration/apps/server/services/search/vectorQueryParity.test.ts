/**
 * Vector query parity — the HNSW-shaped vector queries must return the
 * same top results as a brute-force cosine reference on a seeded dataset
 * (best-chunk dedup, archived exclusion, project/path filters, agent-scoped
 * memory recall, near-duplicate detection, RAG winning-chunk offsets).
 *
 * Runs `verify-vector-parity.ts` in a child process, handing it this file's
 * own database in the run's shared managed cluster. The script provisions a
 * scratch cluster only when nobody hands it a database (standalone CLI use).
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { suiteDatabaseUrl } from '../../../../../support/pgTestCluster';

const serverDir = path.resolve(__dirname, '../../../../../../apps/server');

describe('vector query parity (managed PostgreSQL, child process)', () => {
  it('every vector query matches the brute-force reference', () => {
    const stdout = execFileSync(
      process.execPath,
      ['--import=tsx', 'src/scripts/verify-vector-parity.ts'],
      {
        cwd: serverDir,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        // The script logs the full migration chain + per-check detail; the
        // default 1 MB cap kills the child with ENOBUFS before it can finish.
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SNAGLET_VERIFIER_DATABASE_URL: suiteDatabaseUrl() },
      }
    );
    const lines = stdout.trim().split('\n');
    const report = JSON.parse(lines[lines.length - 1]) as { ok: boolean; checks: string[] };
    expect(report.ok).toBe(true);
    expect(report.checks).toContain('searchSimilar');
    expect(report.checks).toContain('workspaceSearchNodes-semantic');
    expect(report.checks).toContain('searchFileNodes');
    expect(report.checks).toContain('memories-hybrid-vector-arm');
    expect(report.checks).toContain('rag-winning-chunk');
  }, 150_000);
});
