/**
 * `seeds/provider-models.sql`, the shipped cloud model catalog (real DB). A
 * model with no `models` row budgets against DEFAULT_CONTEXT_WINDOW (8192), so
 * a fresh install needs these rows before any discovery runs.
 * `ensureBuiltinCatalog` replays the seed on every boot, and removing a model is
 * a soft delete (`Models.deactivateByUser`), so an `ON CONFLICT ... DO UPDATE`
 * seed would resurrect user-removed models. This suite pins that the catalog is
 * present with real windows, a replay changes nothing, and a deactivated model
 * stays deactivated while a missing row is restored. Mutations run in one
 * transaction that is always rolled back.
 */
import { describe, expect, it } from '@jest/globals';
import { transaction, getDb } from '@snaglet/db';
import type { DbClient } from '@snaglet/db/adapters/types';
import {
  reapplyLocalModelSeeds,
  reapplyProviderCatalogSeed,
  reapplySeedFiles,
  SEED_REPLAY_FILES,
} from '@snaglet/db/migrations';

class RollbackSentinel extends Error {}

/** The exact seed sequence `ensureBuiltinCatalog` and `doReset` both run. */
async function replayCatalogSeeds(client: DbClient): Promise<void> {
  await reapplyProviderCatalogSeed(client);
  await reapplySeedFiles(client, [...SEED_REPLAY_FILES]);
  await reapplyLocalModelSeeds(client);
}

/** Active LLM model count per provider, ordered by provider id. */
async function activeCountsByProvider(
  client: Pick<DbClient, 'query'>
): Promise<Record<string, number>> {
  const { rows } = await client.query<{ provider_id: string; n: string }>(
    `SELECT provider_id, COUNT(*)::text AS n FROM public.models
      WHERE is_active AND type = 'llm'
      GROUP BY provider_id`
  );
  return Object.fromEntries(rows.map((r) => [r.provider_id, Number(r.n)]));
}

/** Full fingerprint of the models table — catches a silent UPDATE, not just a count. */
async function modelsFingerprint(client: Pick<DbClient, 'query'>): Promise<string> {
  const { rows } = await client.query<{ digest: string }>(
    `SELECT COALESCE(
       md5(string_agg(row_fingerprint, '|' ORDER BY row_fingerprint)),
       'empty'
     ) AS digest
       FROM (
         SELECT id || ':' || provider_id || ':' || model_id || ':' || display_name
                || ':' || COALESCE(context_window_tokens::text, '-')
                || ':' || COALESCE(max_output_tokens::text, '-')
                || ':' || is_active::text
                || ':' || COALESCE(metadata::text, '{}')
                || ':' || sort_order::text AS row_fingerprint
           FROM public.models
       ) rows`
  );
  return rows[0].digest;
}

// Every provider this seed ships, and how many active models each contributes
// on a freshly provisioned database. Machine-local providers (ollama,
// lm-studio) are deliberately absent — their models describe one laptop.
const SEEDED_MODEL_COUNTS: Record<string, number> = {
  anthropic: 18,
  codex: 12,
  copilot: 30,
  deepseek: 2,
  google: 14,
  mistral: 37,
  openai: 65,
  together: 171,
  xai: 8,
};

describe('provider-models seed — shipped catalog, replayed safely (real DB)', () => {
  it('ships every cloud provider catalog with real context windows', async () => {
    const counts = await activeCountsByProvider(getDb());
    for (const [providerId, expected] of Object.entries(SEEDED_MODEL_COUNTS)) {
      expect({ providerId, count: counts[providerId] }).toEqual({ providerId, count: expected });
    }

    // Machine-local providers must arrive empty and be filled by discovery.
    const { rows: localRows } = await getDb().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.models
        WHERE provider_id IN ('ollama', 'lm-studio')`
    );
    expect(localRows[0].n).toBe('0');

    // A NULL window falls back to the 8192 default, so a seeded row carries
    // one only where the provider publishes no window for that model.
    const { rows: nullWindows } = await getDb().query<{ provider_id: string; model_id: string }>(
      `SELECT provider_id, model_id FROM public.models
        WHERE is_active AND type = 'llm'
          AND provider_id = ANY($1::text[])
          AND context_window_tokens IS NULL
        ORDER BY provider_id, model_id`,
      [Object.keys(SEEDED_MODEL_COUNTS)]
    );
    expect(nullWindows).toEqual([
      // Codex's model list states no window for these three.
      { provider_id: 'codex', model_id: 'gpt-6-astra' },
      { provider_id: 'codex', model_id: 'gpt-6-luna' },
      { provider_id: 'codex', model_id: 'gpt-6.1-terra' },
    ]);

    // Spot-check the newest Codex models alongside two well-known models end to end.
    const { rows: spot } = await getDb().query<{
      provider_id: string;
      model_id: string;
      context_window_tokens: number | null;
      max_output_tokens: number | null;
    }>(
      `SELECT provider_id, model_id, context_window_tokens, max_output_tokens
         FROM public.models
        WHERE (provider_id, model_id) IN (
          ('anthropic', 'claude-opus-4-5'), ('codex', 'gpt-6-astra'), ('codex', 'gpt-6.1-sol'), ('openai', 'gpt-4o')
        )
        ORDER BY provider_id, model_id`
    );
    expect(spot).toEqual([
      {
        provider_id: 'anthropic',
        model_id: 'claude-opus-4-5',
        context_window_tokens: 200000,
        max_output_tokens: 64000,
      },
      {
        provider_id: 'codex',
        model_id: 'gpt-6-astra',
        context_window_tokens: null,
        max_output_tokens: 128000,
      },
      {
        provider_id: 'codex',
        model_id: 'gpt-6.1-sol',
        context_window_tokens: 500000,
        max_output_tokens: 128000,
      },
      {
        provider_id: 'openai',
        model_id: 'gpt-4o',
        context_window_tokens: 128000,
        max_output_tokens: 16384,
      },
    ]);
  });

  it('marks deprecated and legacy models, and pins a default only to a seeded current model', async () => {
    const { rows: marked } = await getDb().query<{ id: string; lifecycle: string | null }>(
      `SELECT id, metadata->>'lifecycle' AS lifecycle FROM public.models
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [['anthropic:claude-fable-5-2', 'anthropic:claude-opus-4-8', 'anthropic:claude-sonnet-4-5']]
    );
    expect(marked).toEqual([
      { id: 'anthropic:claude-fable-5-2', lifecycle: null },
      { id: 'anthropic:claude-opus-4-8', lifecycle: 'legacy' },
      { id: 'anthropic:claude-sonnet-4-5', lifecycle: 'deprecated' },
    ]);

    const { rows: pins } = await getDb().query<{
      provider_id: string;
      model_id: string;
      is_active: boolean;
      supports_tools: boolean;
      lifecycle: string | null;
    }>(
      `SELECT p.id AS provider_id, m.model_id, m.is_active, m.supports_tools,
              m.metadata->>'lifecycle' AS lifecycle
         FROM public.providers p
         JOIN public.models m
           ON m.provider_id = p.id AND m.model_id = p.default_metadata->>'defaultModelId'
        WHERE p.default_metadata ? 'defaultModelId'
        ORDER BY p.id`
    );
    // Each pin is a current, active model that can run agents with tools.
    const pin = (provider_id: string, model_id: string) => ({
      provider_id,
      model_id,
      is_active: true,
      supports_tools: true,
      lifecycle: null,
    });
    expect(pins).toEqual([
      pin('deepseek', 'deepseek-v4-pro'),
      pin('mistral', 'mistral-large-latest'),
      pin('together', 'zai-org/GLM-5.3-Flash'),
    ]);
  });

  it('is idempotent — replaying against an intact catalog changes nothing', async () => {
    let before!: string;

    await expect(
      transaction(async (client) => {
        before = await modelsFingerprint(client);

        await replayCatalogSeeds(client);
        expect(await modelsFingerprint(client)).toBe(before);

        // Twice more, because "idempotent" must not mean "converges eventually".
        await replayCatalogSeeds(client);
        await replayCatalogSeeds(client);
        expect(await modelsFingerprint(client)).toBe(before);

        throw new RollbackSentinel();
      })
    ).rejects.toBeInstanceOf(RollbackSentinel);

    expect(await modelsFingerprint(getDb())).toBe(before);
  });

  it('never resurrects a user-removed model, while still healing a missing one', async () => {
    await expect(
      transaction(async (client) => {
        // A model the user deliberately removed from the picker, stamped the
        // way `DELETE /api/models/:id` stamps it.
        const { rows: removed } = await client.query<{ id: string }>(
          `UPDATE public.models
              SET is_active = FALSE,
                  metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deactivatedBy}', '"user"'::jsonb, true),
                  updated_at = NOW()
            WHERE provider_id = 'anthropic' AND model_id = 'claude-opus-4-5'
            RETURNING id`
        );
        expect(removed).toHaveLength(1);

        // A row lost out of band — the case the heal path exists for.
        const { rows: deleted } = await client.query(
          `DELETE FROM public.models
            WHERE provider_id = 'openai' AND model_id = 'gpt-4o'
            RETURNING id`
        );
        expect(deleted).toHaveLength(1);

        await replayCatalogSeeds(client);

        // The user's removal stands: still inactive, still stamped, same row.
        const { rows: afterRemoved } = await client.query<{
          id: string;
          is_active: boolean;
          deactivated_by: string | null;
        }>(
          `SELECT id, is_active, metadata->>'deactivatedBy' AS deactivated_by
             FROM public.models
            WHERE provider_id = 'anthropic' AND model_id = 'claude-opus-4-5'`
        );
        expect(afterRemoved).toEqual([
          { id: removed[0].id, is_active: false, deactivated_by: 'user' },
        ]);

        // The genuinely missing row came back, active, with its real window.
        const { rows: afterDeleted } = await client.query<{
          is_active: boolean;
          context_window_tokens: number | null;
        }>(
          `SELECT is_active, context_window_tokens FROM public.models
            WHERE provider_id = 'openai' AND model_id = 'gpt-4o'`
        );
        expect(afterDeleted).toEqual([{ is_active: true, context_window_tokens: 128000 }]);

        throw new RollbackSentinel();
      })
    ).rejects.toBeInstanceOf(RollbackSentinel);
  });

  it('leaves a locally discovered row alone rather than overwriting it', async () => {
    await expect(
      transaction(async (client) => {
        // Discovery writes rows keyed by a random uuid; the seed uses the
        // deterministic `<provider>:<model>` id. The seed must recognize the
        // row through the (provider_id, model_id) unique constraint and skip
        // it, not insert a duplicate and not overwrite the local edits.
        await client.query(
          `DELETE FROM public.models WHERE provider_id = 'xai' AND model_id = 'grok-4.3'`
        );
        await client.query(
          `INSERT INTO public.models (
             id, provider_id, model_id, display_name, description,
             context_window_tokens, max_output_tokens, sort_order, metadata
           ) VALUES (
             gen_random_uuid(), 'xai', 'grok-4.3', 'Locally renamed Grok', '',
             12345, 678, 42, '{"entitlement": {"status": "available"}}'::jsonb
           )`
        );

        await replayCatalogSeeds(client);

        const { rows } = await client.query<{
          display_name: string;
          context_window_tokens: number | null;
          sort_order: number;
        }>(
          `SELECT display_name, context_window_tokens, sort_order FROM public.models
            WHERE provider_id = 'xai' AND model_id = 'grok-4.3'`
        );
        expect(rows).toEqual([
          { display_name: 'Locally renamed Grok', context_window_tokens: 12345, sort_order: 42 },
        ]);

        throw new RollbackSentinel();
      })
    ).rejects.toBeInstanceOf(RollbackSentinel);
  });
});
