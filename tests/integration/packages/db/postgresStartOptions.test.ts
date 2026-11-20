/**
 * The Jest cluster is started through PostgresRuntime.start(), as Snaglet starts
 * the bundled one, so its server settings are the ones Snaglet runs with.
 */
import { describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';

describe('the PostgreSQL cluster Snaglet starts', () => {
  it('has room for 256 locks per transaction', async () => {
    const { rows } = await getDb().query<{ max_locks_per_transaction: string }>(
      'SHOW max_locks_per_transaction'
    );

    expect(rows[0]?.max_locks_per_transaction).toBe('256');
  });
});
