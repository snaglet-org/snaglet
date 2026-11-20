import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import {
  readRestoreSwapMarker,
  recoverInterruptedPostgresRestore,
  writeRestoreSwapMarker,
  type RestoreSwapMarker,
  type RestoreSwapState,
} from '@snaglet/db/runtime/postgres/restore-swap';

interface FakePoolResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

class FakeCluster {
  readonly databases = new Set<string>();
  readonly events: string[] = [];

  reset(databases: readonly string[]): void {
    this.databases.clear();
    this.databases.add('postgres');
    for (const database of databases) this.databases.add(database);
    this.events.length = 0;
  }

  async query(pool: Pool, sql: string, params?: readonly unknown[]): Promise<FakePoolResult> {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('SELECT EXISTS (SELECT 1 FROM pg_database')) {
      const database = String(params?.[0] ?? '');
      const present = this.databases.has(database);
      this.events.push(`exists:${database}:${String(present)}`);
      return { rows: [{ present }], rowCount: 1 };
    }

    if (normalized.startsWith('SELECT datname FROM pg_database')) {
      const prefix = String(params?.[0] ?? '').replace(/%$/, '');
      const rows = [...this.databases]
        .filter((database) => database.startsWith(prefix))
        .sort()
        .reverse()
        .map((datname) => ({ datname }));
      this.events.push(`list:${prefix}:${rows.map((row) => row.datname).join(',')}`);
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith('SELECT pg_terminate_backend')) {
      const database = String(params?.[0] ?? '');
      this.events.push(`terminate:${database}`);
      return { rows: [], rowCount: 0 };
    }

    const rename = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"$/.exec(normalized);
    if (rename) {
      this.databases.delete(rename[1]);
      this.databases.add(rename[2]);
      this.events.push(`rename:${rename[1]}->${rename[2]}`);
      return { rows: [], rowCount: 0 };
    }

    const drop = /^DROP DATABASE "([^"]+)"$/.exec(normalized);
    if (drop) {
      this.databases.delete(drop[1]);
      this.events.push(`drop:${drop[1]}`);
      return { rows: [], rowCount: 0 };
    }

    if (
      normalized.includes("to_regclass('public.nodes')") &&
      normalized.includes("to_regclass('public._migrations')") &&
      normalized.includes("extname = 'vector'")
    ) {
      // This schema probe is issued only by validateRestoredDatabase(), whose
      // target comes from the marker's live database. Record the boundary so
      // the test can prove validation preceded destructive parked cleanup.
      void pool;
      this.events.push('validate:live');
      return {
        rows: [{ nodes: 'nodes', ledger: '_migrations', vector: true }],
        rowCount: 1,
      };
    }

    throw new Error(`Unexpected fake Pool query: ${normalized}`);
  }
}

const fakeCluster = new FakeCluster();
const poolQuerySpy = jest.spyOn(Pool.prototype, 'query').mockImplementation(function (
  this: Pool,
  sql: string,
  params?: readonly unknown[]
) {
  return fakeCluster.query(this, sql, params);
} as unknown as Pool['query']);
const poolEndSpy = jest.spyOn(Pool.prototype, 'end').mockImplementation(async () => {});

afterAll(() => {
  poolQuerySpy.mockRestore();
  poolEndSpy.mockRestore();
});

const CONNECTION: PoolConfig = {
  connectionString: 'postgresql://snaglet:test-password@localhost:5432/snaglet',
};

describe('interrupted PostgreSQL restore recovery', () => {
  let root: string;
  let markerPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'snaglet-postgres-restore-recovery-'));
    markerPath = path.join(root, 'restore-swap.json');
    fakeCluster.reset([]);
    poolQuerySpy.mockClear();
    poolEndSpy.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeMarker(
    state: RestoreSwapState,
    names: Partial<
      Pick<RestoreSwapMarker, 'liveDatabase' | 'scratchDatabase' | 'parkedDatabase'>
    > = {}
  ): Promise<RestoreSwapMarker> {
    const marker: RestoreSwapMarker = {
      schemaVersion: 1,
      state,
      liveDatabase: names.liveDatabase ?? 'snaglet',
      scratchDatabase: names.scratchDatabase ?? 'snaglet_restore_scratch_one',
      parkedDatabase: names.parkedDatabase ?? 'snaglet_parked_one',
      startedAt: '2026-07-22T00:00:00.000Z',
    };
    await writeRestoreSwapMarker(markerPath, marker);
    return marker;
  }

  it('leaves an existing live database untouched when no restore marker exists', async () => {
    fakeCluster.reset(['snaglet']);

    await recoverInterruptedPostgresRestore({ connection: CONNECTION, markerPath });

    expect(fakeCluster.databases).toEqual(new Set(['postgres', 'snaglet']));
    expect(fakeCluster.events).toEqual(['exists:snaglet:true']);
  });

  it('rolls a parked swap back when live is missing, preserving scratch as abandoned', async () => {
    const marker = await writeMarker('parked');
    fakeCluster.reset([marker.scratchDatabase, marker.parkedDatabase]);

    await recoverInterruptedPostgresRestore({ connection: CONNECTION, markerPath });

    expect(fakeCluster.databases).toContain('snaglet');
    expect(fakeCluster.databases).not.toContain(marker.scratchDatabase);
    expect(fakeCluster.databases).not.toContain(marker.parkedDatabase);
    const abandoned = [...fakeCluster.databases].filter((name) =>
      name.startsWith('snaglet_restore_abandoned_')
    );
    expect(abandoned).toHaveLength(1);
    expect(fakeCluster.events).toEqual(
      expect.arrayContaining([
        `rename:${marker.scratchDatabase}->${abandoned[0]}`,
        `rename:${marker.parkedDatabase}->snaglet`,
      ])
    );
    expect(
      fakeCluster.events.indexOf(`rename:${marker.scratchDatabase}->${abandoned[0]}`)
    ).toBeLessThan(fakeCluster.events.indexOf(`rename:${marker.parkedDatabase}->snaglet`));
    await expect(readRestoreSwapMarker(markerPath)).resolves.toBeNull();
  });

  it('drops a parked original only after validating a promoted live database', async () => {
    const marker = await writeMarker('promoted');
    fakeCluster.reset(['snaglet', marker.parkedDatabase]);

    await recoverInterruptedPostgresRestore({ connection: CONNECTION, markerPath });

    expect(fakeCluster.databases).toContain('snaglet');
    expect(fakeCluster.databases).not.toContain(marker.parkedDatabase);
    expect(fakeCluster.events).toContain('validate:live');
    expect(fakeCluster.events).toContain(`drop:${marker.parkedDatabase}`);
    expect(fakeCluster.events.indexOf('validate:live')).toBeLessThan(
      fakeCluster.events.indexOf(`drop:${marker.parkedDatabase}`)
    );
    await expect(readRestoreSwapMarker(markerPath)).resolves.toBeNull();
  });

  it('fails closed with no marker, a missing live database, and multiple parked candidates', async () => {
    fakeCluster.reset(['snaglet_parked_first', 'snaglet_parked_second']);

    await expect(
      recoverInterruptedPostgresRestore({ connection: CONNECTION, markerPath })
    ).rejects.toThrow(/found 2 parked databases.*refusing to guess/i);

    expect(fakeCluster.databases).toEqual(
      new Set(['postgres', 'snaglet_parked_first', 'snaglet_parked_second'])
    );
    expect(fakeCluster.events.some((event) => event.startsWith('rename:'))).toBe(false);
    expect(fakeCluster.events.some((event) => event.startsWith('drop:'))).toBe(false);
  });

  it('keeps live intact and renames a preparing scratch candidate before clearing the marker', async () => {
    const marker = await writeMarker('preparing');
    fakeCluster.reset(['snaglet', marker.scratchDatabase]);

    await recoverInterruptedPostgresRestore({ connection: CONNECTION, markerPath });

    expect(fakeCluster.databases).toContain('snaglet');
    expect(fakeCluster.databases).not.toContain(marker.scratchDatabase);
    const abandoned = [...fakeCluster.databases].filter((name) =>
      name.startsWith('snaglet_restore_abandoned_')
    );
    expect(abandoned).toHaveLength(1);
    expect(fakeCluster.events).toContain(`rename:${marker.scratchDatabase}->${abandoned[0]}`);
    expect(fakeCluster.events.some((event) => event.startsWith('drop:'))).toBe(false);
    await expect(readRestoreSwapMarker(markerPath)).resolves.toBeNull();
  });

  it('propagates a non-ENOENT marker read error without opening an admin pool', async () => {
    await mkdir(markerPath);

    await expect(
      recoverInterruptedPostgresRestore({ connection: CONNECTION, markerPath })
    ).rejects.toMatchObject({ code: 'EISDIR' });

    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolEndSpy).not.toHaveBeenCalled();
  });
});
