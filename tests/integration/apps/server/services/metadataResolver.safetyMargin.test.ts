/**
 * Integration test: safetyMarginPct rides the real metadata resolution chain
 * from models.metadata to providers.default_metadata against the live test
 * database.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, closeDatabase } from '@snaglet/db';
import { Models } from '@snaglet/db/tables/models';
import { resolveModelMetadata } from '@server/services/metadataResolver';

const TEST_MODEL_ID = 'integration-test-safety-margin-model';
const TEST_PROVIDER = 'anthropic'; // seeded in every database

async function cleanup() {
  await getDb().query(`DELETE FROM public.models WHERE provider_id = $1 AND model_id = $2`, [
    TEST_PROVIDER,
    TEST_MODEL_ID,
  ]);
}

describe('resolveModelMetadata — safetyMarginPct (real DB)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await closeDatabase();
  });

  it('model-row metadata.safetyMarginPct comes back through the resolver', async () => {
    await Models.createModel(
      TEST_PROVIDER,
      TEST_MODEL_ID,
      'Safety margin test model',
      { safetyMarginPct: 33 },
      200_000,
      8_192
    );

    const meta = await resolveModelMetadata(TEST_PROVIDER, TEST_MODEL_ID);
    expect(meta.safetyMarginPct).toBe(33);
  });

  it('a model with no margin metadata resolves to the provider default (or undefined)', async () => {
    await Models.createModel(
      TEST_PROVIDER,
      TEST_MODEL_ID,
      'Safety margin test model',
      {},
      200_000,
      8_192
    );

    const meta = await resolveModelMetadata(TEST_PROVIDER, TEST_MODEL_ID);
    // The seeded anthropic provider row carries no default_metadata margin —
    // resolution falls through to the per-provider code default in
    // ContextWindowService (2% for anthropic), which is outside this resolver.
    expect(meta.safetyMarginPct).toBeUndefined();
  });

  it('an unknown model still resolves (margin undefined, provider defaults flow through)', async () => {
    const meta = await resolveModelMetadata(TEST_PROVIDER, 'no-such-model-xyz');
    expect(meta.safetyMarginPct).toBeUndefined();
    // The seeded provider row's default_metadata.contextCompression flows
    // through for unknown models — only the margin must stay unset.
    expect(typeof meta.contextCompression).toBe('object');
  });
});
