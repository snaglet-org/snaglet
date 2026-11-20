/**
 * Runs against this file's own database in the shared managed cluster: the
 * subject is how PostgresAdapter shapes results, not how a cluster starts.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import type { DbClient } from '@snaglet/db/adapters/types';
import { suiteDatabaseUrl } from '../../../support/pgTestCluster';

const PARITY_QUERY = `
  SELECT
    42::int8 AS safe_int8,
    9007199254740992::int8 AS unsafe_int8,
    123.450::numeric AS numeric_value,
    'NaN'::numeric AS numeric_nan,
    1.25::float8 AS float_value,
    TRUE::bool AS bool_value,
    TIMESTAMP '2024-01-02 03:04:05.678' AS timestamp_value,
    TIMESTAMPTZ '2024-01-02 03:04:05.678+05:30' AS timestamptz_value,
    DATE '2024-01-02' AS date_value,
    '{"a":1,"b":[true]}'::jsonb AS json_value,
    ARRAY['a', NULL, 'c']::text[] AS text_array,
    array_fill(0.125::real, ARRAY[768])::vector(768) AS vector_value,
    NULL::int8 AS null_int8,
    NULL::numeric AS null_numeric,
    NULL::float8 AS null_float,
    NULL::bool AS null_bool,
    NULL::timestamp AS null_timestamp,
    NULL::timestamptz AS null_timestamptz,
    NULL::date AS null_date,
    NULL::jsonb AS null_json,
    NULL::text[] AS null_array,
    NULL::vector(768) AS null_vector
`;

async function duplicateErrorCode(db: DbClient, table: string): Promise<unknown> {
  await db.exec(`CREATE TEMP TABLE ${table} (id integer PRIMARY KEY);`);
  await db.query(`INSERT INTO ${table} (id) VALUES (1)`);
  try {
    await db.query(`INSERT INTO ${table} (id) VALUES (1)`);
  } catch (error: unknown) {
    return (error as { code?: unknown }).code;
  }
  throw new Error(`${table} did not reject a duplicate primary key`);
}

function expectedLegacyTimestamptz(): string {
  const offsetMinutes = Math.max(
    new Date(2024, 0, 1).getTimezoneOffset(),
    new Date(2024, 6, 1).getTimezoneOffset()
  );
  const local = new Date(Date.parse('2024-01-01T21:34:05.678Z') - offsetMinutes * 60_000)
    .toISOString()
    .replace(/Z$/, '');
  const sign = offsetMinutes > 0 ? '-' : '+';
  const hours = Math.trunc(Math.abs(offsetMinutes) / 60)
    .toString()
    .padStart(2, '0');
  return `${local}${sign}${hours}:00`;
}

describe('PostgresAdapter legacy-compatible result contract', () => {
  let postgres: PostgresAdapter;

  beforeAll(async () => {
    postgres = new PostgresAdapter({ connectionString: suiteDatabaseUrl() });
    await postgres.exec(
      'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
    );
  });

  afterAll(async () => {
    await postgres?.end();
  });

  it('preserves the measured legacy JavaScript shapes for the fixed type battery', async () => {
    const postgresResult = await postgres.query<Record<string, unknown>>(PARITY_QUERY);

    expect(postgresResult.rowCount).toBe(1);
    const row = postgresResult.rows[0]!;
    expect(row).toMatchObject({
      safe_int8: 42,
      unsafe_int8: 9007199254740992n,
      numeric_value: '123.450',
      numeric_nan: 'NaN',
      float_value: 1.25,
      bool_value: true,
      timestamp_value: '2024-01-02T03:04:05.678Z',
      timestamptz_value: expectedLegacyTimestamptz(),
      json_value: { a: 1, b: [true] },
      text_array: ['a', null, 'c'],
      null_int8: null,
      null_numeric: null,
      null_float: null,
      null_bool: null,
      null_timestamp: null,
      null_timestamptz: null,
      null_date: null,
      null_json: null,
      null_array: null,
      null_vector: null,
    });
    expect(row.date_value).toEqual(new Date('2024-01-02T00:00:00.000Z'));
    expect(row.vector_value).toMatch(/^\[0\.125,/);
  });

  it('preserves SQLSTATE error codes used by model catch sites', async () => {
    await expect(duplicateErrorCode(postgres, 'postgres_unique_parity')).resolves.toBe('23505');
  });
});
