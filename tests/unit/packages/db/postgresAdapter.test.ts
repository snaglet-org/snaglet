import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolConfig } from 'pg';
import {
  legacyCompatibleTimeZone,
  PostgresAdapter,
  type PostgresAdapterDependencies,
} from '@snaglet/db/adapters/postgres';

interface QueryRecord {
  sql: string;
  params: unknown[] | undefined;
}

interface FakeQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

class FakePoolClient {
  readonly queries: QueryRecord[] = [];
  releaseCalls = 0;
  rollbackError: Error | undefined;
  unlockError: Error | undefined;
  queryResult: FakeQueryResult = { rows: [{ scope: 'transaction' }], rowCount: 1 };

  async query(sql: string, params?: unknown[]): Promise<FakeQueryResult> {
    this.queries.push({ sql, params });
    if (sql === 'ROLLBACK' && this.rollbackError) throw this.rollbackError;
    if (sql === 'SELECT pg_advisory_unlock(hashtext($1))' && this.unlockError) {
      throw this.unlockError;
    }
    return this.queryResult;
  }

  release(): void {
    this.releaseCalls += 1;
  }
}

class FakePool {
  readonly queries: QueryRecord[] = [];
  readonly errorHandlers: Array<(error: Error) => void> = [];
  readonly client = new FakePoolClient();
  connectCalls = 0;
  endCalls = 0;
  queryResult: FakeQueryResult = { rows: [{ scope: 'pool' }], rowCount: 1 };

  async query(sql: string, params?: unknown[]): Promise<FakeQueryResult> {
    this.queries.push({ sql, params });
    return this.queryResult;
  }

  async connect(): Promise<FakePoolClient> {
    this.connectCalls += 1;
    return this.client;
  }

  on(event: string, listener: (error: Error) => void): this {
    if (event === 'error') this.errorHandlers.push(listener);
    return this;
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  emitIdleError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}

interface AdapterHarness {
  adapter: PostgresAdapter;
  pool: FakePool;
  configs: PoolConfig[];
  onPoolError: jest.Mock<(error: Error) => void>;
}

function createHarness(options: PoolConfig = {}): AdapterHarness {
  const pool = new FakePool();
  const configs: PoolConfig[] = [];
  const onPoolError = jest.fn<(error: Error) => void>();
  const dependencies: PostgresAdapterDependencies = {
    createPool: (config) => {
      configs.push(config);
      return pool as unknown as Pool;
    },
    onPoolError,
  };
  return {
    adapter: new PostgresAdapter(options, dependencies),
    pool,
    configs,
    onPoolError,
  };
}

describe('PostgresAdapter', () => {
  it('enforces pool limits, installs per-pool parsers, and appends the legacy timezone option', () => {
    const first = createHarness({
      host: '/tmp/snaglet-pg-one',
      max: 99,
      idleTimeoutMillis: 1,
      allowExitOnIdle: true,
      options: '-c statement_timeout=0',
    });
    const second = createHarness({ host: '/tmp/snaglet-pg-two' });
    const firstConfig = first.configs[0];
    const secondConfig = second.configs[0];

    expect(firstConfig).toMatchObject({
      host: '/tmp/snaglet-pg-one',
      max: 10,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
      options: `-c statement_timeout=0 -c timezone=${legacyCompatibleTimeZone()}`,
    });
    expect(secondConfig.options).toBe(`-c timezone=${legacyCompatibleTimeZone()}`);
    expect(firstConfig.types).toBeDefined();
    expect(secondConfig.types).toBeDefined();
    expect(firstConfig.types).not.toBe(secondConfig.types);
  });

  it('copies readonly parameters and preserves query rows and rowCount', async () => {
    const { adapter, pool } = createHarness();
    pool.queryResult = { rows: [{ id: 'row-1' }, { id: 'row-2' }], rowCount: 2 };
    const params: ReadonlyArray<unknown> = Object.freeze(['alpha', 7]);

    const result = await adapter.query<{ id: string }>('SELECT * FROM items WHERE a = $1', params);

    expect(result).toEqual({ rows: [{ id: 'row-1' }, { id: 'row-2' }], rowCount: 2 });
    expect(pool.queries).toEqual([
      { sql: 'SELECT * FROM items WHERE a = $1', params: ['alpha', 7] },
    ]);
    expect(pool.queries[0].params).not.toBe(params);
  });

  it('passes a multi-statement script to pool.query without parameters', async () => {
    const { adapter, pool } = createHarness();
    const script = 'CREATE TABLE sample(id integer); INSERT INTO sample VALUES (1);';

    await adapter.exec(script);

    expect(pool.queries).toEqual([{ sql: script, params: undefined }]);
  });

  it('commits successful work on one checked-out client and releases it', async () => {
    const { adapter, pool } = createHarness();
    const params: ReadonlyArray<unknown> = Object.freeze(['value']);

    const value = await adapter.transaction(async (tx) => {
      const result = await tx.query(
        'INSERT INTO sample(value) VALUES ($1) RETURNING value',
        params
      );
      await tx.exec('UPDATE sample SET value = value; DELETE FROM sample WHERE false;');
      return result.rows[0]?.scope;
    });

    expect(value).toBe('transaction');
    expect(pool.connectCalls).toBe(1);
    expect(pool.client.queries).toEqual([
      { sql: 'BEGIN', params: undefined },
      {
        sql: 'INSERT INTO sample(value) VALUES ($1) RETURNING value',
        params: ['value'],
      },
      {
        sql: 'UPDATE sample SET value = value; DELETE FROM sample WHERE false;',
        params: undefined,
      },
      { sql: 'COMMIT', params: undefined },
    ]);
    expect(pool.client.queries[1].params).not.toBe(params);
    expect(pool.client.releaseCalls).toBe(1);
  });

  it('rolls back and releases when the callback fails', async () => {
    const { adapter, pool } = createHarness();
    const original = new Error('callback failed');

    const transaction = adapter.transaction(async () => {
      throw original;
    });

    await expect(transaction).rejects.toBe(original);
    expect(pool.client.queries.map((entry) => entry.sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pool.client.releaseCalls).toBe(1);
  });

  it('preserves the callback error when rollback also fails', async () => {
    const { adapter, pool } = createHarness();
    const original = new Error('original callback failure');
    pool.client.rollbackError = new Error('rollback failure');

    const transaction = adapter.transaction(async () => {
      throw original;
    });

    await expect(transaction).rejects.toBe(original);
    expect(pool.client.queries.map((entry) => entry.sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pool.client.releaseCalls).toBe(1);
  });

  it('rejects nested transactions while transaction end remains a no-op', async () => {
    const { adapter, pool } = createHarness();

    await adapter.transaction(async (tx) => {
      await expect(tx.transaction(async () => 'nested')).rejects.toThrow(/nested transactions/i);
      await expect(tx.end()).resolves.toBeUndefined();
      expect(pool.client.releaseCalls).toBe(0);
      expect(pool.endCalls).toBe(0);
    });

    expect(pool.client.queries.map((entry) => entry.sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(pool.client.releaseCalls).toBe(1);
    expect(pool.endCalls).toBe(0);
  });

  it('holds an advisory lock on one client without wrapping callback scripts in a transaction', async () => {
    const { adapter, pool } = createHarness();
    const migrationScript = 'BEGIN; CREATE TABLE locked_work(id integer); COMMIT;';

    const result = await adapter.withAdvisoryLock('snaglet_migrations', async (session) => {
      const query = await session.query('SELECT $1::text AS value', ['inside-lock']);
      await session.exec(migrationScript);
      return query.rows[0]?.scope;
    });

    expect(result).toBe('transaction');
    expect(pool.connectCalls).toBe(1);
    expect(pool.client.queries).toEqual([
      {
        sql: 'SELECT pg_advisory_lock(hashtext($1))',
        params: ['snaglet_migrations'],
      },
      { sql: 'SELECT $1::text AS value', params: ['inside-lock'] },
      { sql: migrationScript, params: undefined },
      {
        sql: 'SELECT pg_advisory_unlock(hashtext($1))',
        params: ['snaglet_migrations'],
      },
    ]);
    expect(pool.client.releaseCalls).toBe(1);
  });

  it('unlocks and releases after callback failure while preserving it over unlock failure', async () => {
    const { adapter, pool } = createHarness();
    const callbackError = new Error('migration callback failed');
    pool.client.unlockError = new Error('advisory unlock failed');

    const locked = adapter.withAdvisoryLock('snaglet_migrations', async () => {
      throw callbackError;
    });

    await expect(locked).rejects.toBe(callbackError);
    expect(pool.client.queries).toEqual([
      {
        sql: 'SELECT pg_advisory_lock(hashtext($1))',
        params: ['snaglet_migrations'],
      },
      {
        sql: 'SELECT pg_advisory_unlock(hashtext($1))',
        params: ['snaglet_migrations'],
      },
    ]);
    expect(pool.client.releaseCalls).toBe(1);
  });

  it('surfaces an unlock failure after a successful advisory-lock callback and still releases', async () => {
    const { adapter, pool } = createHarness();
    const unlockError = new Error('advisory unlock failed');
    pool.client.unlockError = unlockError;

    const locked = adapter.withAdvisoryLock('snaglet_migrations', async () => 'completed');

    await expect(locked).rejects.toBe(unlockError);
    expect(pool.client.queries.map((entry) => entry.sql)).toEqual([
      'SELECT pg_advisory_lock(hashtext($1))',
      'SELECT pg_advisory_unlock(hashtext($1))',
    ]);
    expect(pool.client.releaseCalls).toBe(1);
  });

  it('ends once and rejects query, exec, transaction, and advisory lock after end', async () => {
    const { adapter, pool } = createHarness();

    await adapter.end();
    await adapter.end();

    expect(pool.endCalls).toBe(1);
    await expect(adapter.query('SELECT 1')).rejects.toThrow(/query\(\) after end\(\)/i);
    await expect(adapter.exec('SELECT 1; SELECT 2;')).rejects.toThrow(/exec\(\) after end\(\)/i);
    await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
      /transaction\(\) after end\(\)/i
    );
    await expect(
      adapter.withAdvisoryLock('snaglet_migrations', async () => undefined)
    ).rejects.toThrow(/cannot lock after end\(\)/i);
    expect(pool.queries).toEqual([]);
    expect(pool.connectCalls).toBe(0);
  });

  it('registers a callable idle-pool error handler', () => {
    const { pool, onPoolError } = createHarness();
    const error = new Error('idle client failed');

    expect(pool.errorHandlers).toHaveLength(1);
    pool.emitIdleError(error);

    expect(onPoolError).toHaveBeenCalledTimes(1);
    expect(onPoolError).toHaveBeenCalledWith(error);
  });
});
