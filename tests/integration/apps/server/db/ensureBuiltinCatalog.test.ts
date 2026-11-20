/**
 * `ensureBuiltinCatalog` (packages/db/migrations.ts) heals the builtin catalog
 * on every boot (real DB). A full reset reseeds providers/models/mcp_servers
 * (see resetCatalogSeeding.test.ts), but a row deleted out of band would stay
 * missing: the migration ledger already marks every migration applied, so the
 * fresh-DB bootstrap never runs again. This test deletes a builtin provider and
 * model, checks one call restores them and returns `true`, and a second call is
 * a no-op returning `false`. The mutation runs in one transaction that is
 * always rolled back; each integration file has its own database clone.
 */
import { describe, expect, it } from '@jest/globals';
import { transaction, getDb } from '@snaglet/db';
import type { DbClient } from '@snaglet/db/adapters/types';
import { ensureBuiltinCatalog } from '@snaglet/db/migrations';

class RollbackSentinel extends Error {}

async function rowExists(client: Pick<DbClient, 'query'>, sql: string): Promise<boolean> {
  const { rows } = await client.query(sql);
  return rows.length > 0;
}

async function tableCount(client: Pick<DbClient, 'query'>, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM public.${table}`);
  return Number(rows[0].n);
}

describe('ensureBuiltinCatalog — boot-invariant catalog healing (real DB)', () => {
  it('restores an out-of-band-deleted provider/model row, then no-ops on replay', async () => {
    let before!: { providers: number; models: number; mcp_servers: number };

    await expect(
      transaction(async (client) => {
        before = {
          providers: await tableCount(client, 'providers'),
          models: await tableCount(client, 'models'),
          mcp_servers: await tableCount(client, 'mcp_servers'),
        };
        expect(before.providers).toBeGreaterThan(0);
        expect(before.models).toBeGreaterThan(0);

        // Sanity: the two target rows exist before we delete them.
        expect(
          await rowExists(client, `SELECT 1 FROM public.providers WHERE id = 'anthropic'`)
        ).toBe(true);
        expect(
          await rowExists(
            client,
            `SELECT 1 FROM public.models WHERE provider_id = 'local-onnx' AND model_id = 'nomic-embed-text-v1.5'`
          )
        ).toBe(true);

        // Simulate an out-of-band loss: delete a provider and a model directly,
        // not via a clean-slate reset. Deleting `anthropic` cascades its
        // seeded `models` rows away too, and the replay restores card and
        // catalog together — hence the recount below compares totals rather
        // than assuming a single row moved. (No builtin MCP servers are seeded,
        // so mcp_servers is only checked for no drift.)
        await client.query(`DELETE FROM public.providers WHERE id = 'anthropic'`);
        await client.query(
          `DELETE FROM public.models WHERE provider_id = 'local-onnx' AND model_id = 'nomic-embed-text-v1.5'`
        );

        expect(
          await rowExists(client, `SELECT 1 FROM public.providers WHERE id = 'anthropic'`)
        ).toBe(false);
        expect(
          await rowExists(
            client,
            `SELECT 1 FROM public.models WHERE provider_id = 'local-onnx' AND model_id = 'nomic-embed-text-v1.5'`
          )
        ).toBe(false);

        // Call 1: heals the out-of-band loss
        const healed = await ensureBuiltinCatalog(client);
        expect(healed).toBe(true);

        expect(
          await rowExists(client, `SELECT 1 FROM public.providers WHERE id = 'anthropic'`)
        ).toBe(true);
        expect(
          await rowExists(
            client,
            `SELECT 1 FROM public.models WHERE provider_id = 'local-onnx' AND model_id = 'nomic-embed-text-v1.5'`
          )
        ).toBe(true);

        const afterHeal = {
          providers: await tableCount(client, 'providers'),
          models: await tableCount(client, 'models'),
          mcp_servers: await tableCount(client, 'mcp_servers'),
        };
        expect(afterHeal).toEqual(before);

        // Call 2: catalog already intact — must be a clean no-op
        const healedAgain = await ensureBuiltinCatalog(client);
        expect(healedAgain).toBe(false);

        const afterNoop = {
          providers: await tableCount(client, 'providers'),
          models: await tableCount(client, 'models'),
          mcp_servers: await tableCount(client, 'mcp_servers'),
        };
        expect(afterNoop).toEqual(before);

        // Always roll back so the file's database clone remains unchanged.
        throw new RollbackSentinel();
      })
    ).rejects.toBeInstanceOf(RollbackSentinel);

    // Confirm the rollback actually left no trace in this file's clone.
    const after = {
      providers: await tableCount(getDb(), 'providers'),
      models: await tableCount(getDb(), 'models'),
      mcp_servers: await tableCount(getDb(), 'mcp_servers'),
    };
    expect(after).toEqual(before);
  });

  it('skips reseeding (and never touches the DB beyond the pending check) when migrations are pending', async () => {
    const queried: string[] = [];
    // Minimal fake DbClient: `pendingMigrationCount` only ever calls
    // `query()` (to create/read the ledger table). Reporting zero applied
    // migrations against the real, non-empty migration file list guarantees
    // a positive pending count without touching a real database. `exec` and
    // `transaction` throw if called — the guard must return before either
    // runs.
    const fakeDb: DbClient = {
      query: async (sql: string) => {
        queried.push(sql);
        return { rows: [], rowCount: 0 };
      },
      exec: async () => {
        throw new Error('ensureBuiltinCatalog must not run seed SQL when migrations are pending');
      },
      transaction: async () => {
        throw new Error(
          'ensureBuiltinCatalog must not open a transaction when migrations are pending'
        );
      },
      end: async () => undefined,
    };

    const result = await ensureBuiltinCatalog(fakeDb);
    expect(result).toBe(false);
    // Confirms the guard actually ran its pending-check queries (ledger
    // create + applied-names read) rather than short-circuiting earlier.
    expect(queried.length).toBeGreaterThan(0);
  });
});
