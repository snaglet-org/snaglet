/**
 * Clean-slate ('all') reset catalog reseeding, against the real database.
 * `DatabaseBackupService.doReset('all')` wipes every content table except the
 * `_migrations` ledger, so the fresh-DB bootstrap never reruns; without a
 * reseed, `providers`, `models` and `mcp_servers` would stay empty (and an
 * empty `models` breaks the local embedder pipeline via `embeddings.model_id`).
 * doReset reseeds with three ordered calls (see packages/db/migrations.ts):
 * `reapplyProviderCatalogSeed`, `reapplySeedFiles(SEED_REPLAY_FILES)`, then
 * `reapplyLocalModelSeeds`. This test runs that sequence in one transaction
 * that is always rolled back, so a migration that breaks a seed fails here
 * rather than in a user's reset.
 */
import { describe, expect, it } from '@jest/globals';
import { transaction, getDb } from '@snaglet/db';
import type { DbClient } from '@snaglet/db/adapters/types';
import {
  SEED_REPLAY_FILES,
  reapplySeedFiles,
  reapplyProviderCatalogSeed,
  reapplyLocalModelSeeds,
} from '@snaglet/db/migrations';

class RollbackSentinel extends Error {}

async function tableCount(client: Pick<DbClient, 'query'>, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM public.${table}`);
  return Number(rows[0].n);
}

async function replayAll(client: DbClient): Promise<void> {
  await reapplyProviderCatalogSeed(client);
  await reapplySeedFiles(client, [...SEED_REPLAY_FILES]);
  await reapplyLocalModelSeeds(client);
}

describe('DatabaseBackupService clean-slate reset — catalog reseeding (real DB)', () => {
  it('reseeds providers/mcp_servers/models after a full wipe, matches the real catalog, and is idempotent', async () => {
    let before!: { providers: number; models: number; mcp_servers: number };

    await expect(
      transaction(async (client) => {
        before = {
          providers: await tableCount(client, 'providers'),
          models: await tableCount(client, 'models'),
          mcp_servers: await tableCount(client, 'mcp_servers'),
        };
        // Sanity: the test DB is a normally-provisioned, already-migrated
        // database (provision-test-db.ts runs the full chain) — the catalog
        // should already be non-empty before we even start.
        expect(before.providers).toBeGreaterThan(0);
        expect(before.models).toBeGreaterThan(0);

        // Mirrors doReset's scope==='all' wipe of these three tables. (doReset
        // also wipes every other content table; that discovery is plumbing
        // this test does not target.)
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query('DELETE FROM public.models');
        await client.query('DELETE FROM public.mcp_servers');
        await client.query('DELETE FROM public.providers');
        await client.query('SET LOCAL session_replication_role = origin');

        expect(await tableCount(client, 'providers')).toBe(0);
        expect(await tableCount(client, 'models')).toBe(0);
        expect(await tableCount(client, 'mcp_servers')).toBe(0);

        // Run 1
        await replayAll(client);

        const run1 = {
          providers: await tableCount(client, 'providers'),
          models: await tableCount(client, 'models'),
          mcp_servers: await tableCount(client, 'mcp_servers'),
        };
        expect(run1.providers).toBeGreaterThan(0);
        expect(run1.models).toBeGreaterThan(0);
        // No builtin MCP servers are seeded.
        expect(run1.mcp_servers).toBe(0);
        // Reseeding from scratch must reproduce exactly the same catalog the
        // real, already-applied migration chain produced.
        expect(run1).toEqual(before);

        // The local-runtime model catalog a fresh install produces: L6 reranker
        // active, local embedder active, the fixed
        // apple-on-device row (replayed via SEED_REPLAY_FILES), and no
        // query-extractor row. Hosted-provider catalogs are counted separately
        // below; listing several hundred model ids here would bury these rows.
        const { rows: modelRows } = await client.query<{
          provider_id: string;
          model_id: string;
          is_active: boolean;
        }>(
          `SELECT provider_id, model_id, is_active FROM public.models
            WHERE provider_id IN ('apple-on-device', 'snaglet-local', 'local-onnx')
            ORDER BY provider_id, model_id`
        );
        expect(modelRows).toEqual([
          {
            provider_id: 'apple-on-device',
            model_id: 'apple-on-device',
            is_active: true,
          },
          {
            provider_id: 'local-onnx',
            model_id: 'nomic-embed-text-v1.5',
            is_active: true,
          },
          {
            provider_id: 'snaglet-local',
            model_id: 'ms-marco-MiniLM-L6-v2-qint8-arm64',
            is_active: true,
          },
        ]);

        // The hosted-provider catalogs (seeds/provider-models.sql) come back
        // too: a clean-slate reset that restored the provider cards but left
        // the model lists empty would leave every agent budgeting against
        // DEFAULT_CONTEXT_WINDOW (8192).
        const { rows: cloudCatalog } = await client.query<{ provider_id: string; n: string }>(
          `SELECT provider_id, COUNT(*)::text AS n FROM public.models
            WHERE is_active AND type = 'llm'
              AND provider_id NOT IN ('apple-on-device', 'snaglet-local', 'local-onnx')
            GROUP BY provider_id
            ORDER BY provider_id`
        );
        expect(cloudCatalog).toEqual([
          { provider_id: 'anthropic', n: '18' },
          { provider_id: 'codex', n: '12' },
          { provider_id: 'copilot', n: '30' },
          { provider_id: 'deepseek', n: '2' },
          { provider_id: 'google', n: '14' },
          { provider_id: 'mistral', n: '37' },
          { provider_id: 'openai', n: '65' },
          { provider_id: 'together', n: '171' },
          { provider_id: 'xai', n: '8' },
        ]);

        // There is no notion provider row; replay must not create one.
        expect(await tableCount(client, `providers WHERE id = 'notion'`)).toBe(0);

        // Nor a built-in Notion or GitHub MCP server.
        expect(await tableCount(client, `mcp_servers WHERE id = 'notion'`)).toBe(0);
        expect(await tableCount(client, `mcp_servers WHERE id = 'github'`)).toBe(0);

        // Run 2 (idempotency)
        await replayAll(client);

        const run2 = {
          providers: await tableCount(client, 'providers'),
          models: await tableCount(client, 'models'),
          mcp_servers: await tableCount(client, 'mcp_servers'),
        };
        expect(run2).toEqual(run1);

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
});
