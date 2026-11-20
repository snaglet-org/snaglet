/** node-postgres implementation of Snaglet's engine-neutral DbClient. */
import { getErrorMessage } from '@snaglet/shared/utils';
import * as pg from 'pg';
import type { CustomTypesConfig, Pool, PoolClient, PoolConfig, QueryResultRow } from 'pg';
import type { DbClient, DbQueryResult } from './types';

export const POSTGRES_POOL_MAX = 10;
export const POSTGRES_POOL_IDLE_TIMEOUT_MS = 30_000;

export interface PostgresAdapterDependencies {
  createPool?: (config: PoolConfig) => Pool;
  onPoolError?: (error: Error) => void;
  /**
   * Pool size for a deliberately small auxiliary pool (the tables reader keeps
   * two connections). Connection options never change it: the application
   * pool always gets {@link POSTGRES_POOL_MAX}.
   */
  poolMax?: number;
}

/**
 * Keep PostgreSQL sessions on Snaglet's historical fixed-offset zone during the
 * compatibility window so timestamptz strings retain their existing values.
 */
export function legacyCompatibleTimeZone(year = new Date().getFullYear()): string {
  const standardOffsetMinutes = Math.max(
    new Date(year, 0, 1).getTimezoneOffset(),
    new Date(year, 6, 1).getTimezoneOffset()
  );
  if (standardOffsetMinutes === 0) return 'Etc/GMT0';
  const sign = standardOffsetMinutes > 0 ? '+' : '-';
  return `Etc/GMT${sign}${Math.trunc(Math.abs(standardOffsetMinutes) / 60)}`;
}

function parseInt8(value: string): number | bigint {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : BigInt(value);
}

function parseTimestamp(value: string): string {
  return value ? `${value.replace(' ', 'T')}Z` : value;
}

function parseTimestampWithTimeZone(value: string): string {
  if (!value) return value;
  const iso = value.replace(' ', 'T');
  return /[+-]\d{2}$/.test(iso) ? `${iso}:00` : iso;
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Per-pool parsers. Never mutate node-postgres' process-global registry. */
export function createPostgresTypeParsers(): CustomTypesConfig {
  const overrides = new pg.TypeOverrides(pg.types);
  overrides.setTypeParser(pg.types.builtins.INT8, parseInt8);
  overrides.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => value);
  overrides.setTypeParser(pg.types.builtins.TIMESTAMP, parseTimestamp);
  overrides.setTypeParser(pg.types.builtins.TIMESTAMPTZ, parseTimestampWithTimeZone);
  overrides.setTypeParser(pg.types.builtins.DATE, parseDate);
  return overrides;
}

export function createPostgresPoolConfig(options: PoolConfig): PoolConfig {
  const callerOptions = options.options?.trim();
  const timezoneOption = `-c timezone=${legacyCompatibleTimeZone()}`;
  return {
    ...options,
    max: POSTGRES_POOL_MAX,
    idleTimeoutMillis: POSTGRES_POOL_IDLE_TIMEOUT_MS,
    allowExitOnIdle: false,
    types: createPostgresTypeParsers(),
    options: callerOptions ? `${callerOptions} ${timezoneOption}` : timezoneOption,
  };
}

/**
 * One checked-out connection, handed to {@link PostgresAdapter.withConnection}.
 * `processId` is the server backend pid, so a caller that gives up on a query
 * client-side can still cancel the backend through another pool.
 */
export interface PostgresConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default mirrors DbClient.query
  query<T = any>(sql: string, params?: ReadonlyArray<unknown>): Promise<DbQueryResult<T>>;
  readonly processId: number | null;
  /**
   * Mark the connection unusable (a client-side timeout left a query in
   * flight on the wire). It is destroyed instead of returned to the pool.
   */
  discard(reason: Error): void;
}

/**
 * node-postgres answers a multi-statement simple query (no parameters) with
 * an array of results, one per statement; callers want the last one, the way
 * psql shows it.
 */
interface RawQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

function lastQueryResult<T>(result: RawQueryResult | RawQueryResult[]): DbQueryResult<T> {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  return { rows: (last?.rows ?? []) as T[], rowCount: last?.rowCount ?? null };
}

class CheckedOutClient implements DbClient {
  constructor(
    private readonly client: PoolClient,
    private readonly insideTransaction = false
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): Promise<DbQueryResult<T>> {
    const result = await this.client.query<T & QueryResultRow>(
      sql,
      params ? Array.from(params) : undefined
    );
    return lastQueryResult<T>(result as RawQueryResult | RawQueryResult[]);
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.insideTransaction) {
      throw new Error('PostgresAdapter: nested transactions are not supported');
    }
    try {
      await this.client.query('BEGIN');
      const result = await fn(new CheckedOutClient(this.client, true));
      await this.client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      try {
        await this.client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error if rollback also fails.
      }
      throw error;
    }
  }

  async end(): Promise<void> {
    // The outer transaction owns release and the pool owns lifecycle.
  }
}

export class PostgresAdapter implements DbClient {
  private readonly pool: Pool;
  private ended = false;

  constructor(options: PoolConfig, dependencies: PostgresAdapterDependencies = {}) {
    const base = createPostgresPoolConfig(options);
    const config = dependencies.poolMax ? { ...base, max: dependencies.poolMax } : base;
    this.pool = dependencies.createPool?.(config) ?? new pg.Pool(config);
    const onPoolError =
      dependencies.onPoolError ??
      ((error: Error) => {
        console.error(`[DB] idle PostgreSQL client error: ${getErrorMessage(error)}`);
      });
    this.pool.on('error', onPoolError);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): Promise<DbQueryResult<T>> {
    if (this.ended) throw new Error('PostgresAdapter: cannot query() after end()');
    const result = await this.pool.query<T & QueryResultRow>(
      sql,
      params ? Array.from(params) : undefined
    );
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  async exec(sql: string): Promise<void> {
    if (this.ended) throw new Error('PostgresAdapter: cannot exec() after end()');
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.ended) throw new Error('PostgresAdapter: cannot transaction() after end()');
    const client = await this.pool.connect();
    try {
      return await new CheckedOutClient(client).transaction(fn);
    } finally {
      client.release();
    }
  }

  /**
   * Hold a session-level advisory lock on one checked-out connection. Migration
   * files may contain their own BEGIN/COMMIT, so this deliberately does not add
   * an outer transaction around the callback.
   */
  async withAdvisoryLock<T>(key: string, fn: (session: DbClient) => Promise<T>): Promise<T> {
    if (this.ended) throw new Error('PostgresAdapter: cannot lock after end()');
    const client = await this.pool.connect();
    let locked = false;
    let failed = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      locked = true;
      return await fn(new CheckedOutClient(client));
    } catch (error: unknown) {
      failed = true;
      throw error;
    } finally {
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (unlockError: unknown) {
        if (!failed) throw unlockError;
      } finally {
        client.release();
      }
    }
  }

  /**
   * Run `fn` on one checked-out connection without an implicit transaction.
   * The connection returns to the pool afterward unless `fn` discarded it.
   */
  async withConnection<T>(fn: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    if (this.ended) throw new Error('PostgresAdapter: cannot withConnection() after end()');
    const client = await this.pool.connect();
    // node-postgres records the backend pid on connect; @types/pg leaves it
    // off PoolClient, so read it through a narrow view.
    const { processID } = client as unknown as { processID?: number | null };
    let discarded: Error | undefined;
    try {
      return await fn({
        async query<R = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>) {
          const result = await client.query<R & QueryResultRow>(
            sql,
            params ? Array.from(params) : undefined
          );
          return lastQueryResult<R>(result as RawQueryResult | RawQueryResult[]);
        },
        processId: typeof processID === 'number' ? processID : null,
        discard(reason: Error) {
          discarded = reason;
        },
      });
    } finally {
      // pg-pool destroys a client released with an error instead of reusing it.
      client.release(discarded);
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.pool.end();
  }
}
