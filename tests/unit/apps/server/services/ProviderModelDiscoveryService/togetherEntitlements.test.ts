/**
 * Together entitlement binding — Together is entitlement-reconcilable like
 * Copilot/Codex, but its candidate set is the imported picker (active rows),
 * not the full multi-hundred-model catalog: reconcile probes only active
 * Together rows and deactivates a dedicated-only model with its Together
 * reason. Probe/normalizer modules are mocked.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const probeTogether = jest.fn<(id: string) => Promise<{ ok: boolean; reason?: string }>>();
jest.mock('@server/services/ProviderChatService/providers/together', () => ({
  probeTogetherModel: (...a: [string]) => probeTogether(...a),
}));
jest.mock('@server/services/ProviderChatService/providers/copilot', () => ({}));
jest.mock('@server/services/ProviderChatService/providers/codex', () => ({
  probeCodexModel: jest.fn(),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/copilot', () => ({
  discoverCopilotModels: jest.fn(),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/normalizers/codex', () => ({
  discoverCodexModels: jest.fn(),
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const listActiveByProviderId = jest.fn();
const listByProviderId = jest.fn();
const setEntitlement = jest.fn();
const bulkUpsert = jest.fn(async () => []);
jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    listActiveByProviderId: (...a: unknown[]) => listActiveByProviderId(...a),
    listByProviderId: (...a: unknown[]) => listByProviderId(...a),
    setEntitlement: (...a: unknown[]) => setEntitlement(...a),
    bulkUpsert: (...a: unknown[]) => bulkUpsert(...a),
  },
}));

import {
  isEntitlementReconcilable,
  reconcileEntitlements,
} from '@server/services/ProviderModelDiscoveryService/entitlements';

const REASON =
  'Unable to access non-serverless model Hcompany/Holo3-35B-A3B. Please visit https://api.together.ai/models/Hcompany/Holo3-35B-A3B to create and start a new dedicated endpoint for the model.';

function row(modelId: string, id: string) {
  return {
    id,
    modelId,
    displayName: modelId,
    description: null,
    family: null,
    contextWindowTokens: null,
    maxOutputTokens: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    metadata: {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Together entitlement binding', () => {
  it('is entitlement-reconcilable, alongside copilot and codex', () => {
    expect(isEntitlementReconcilable('together')).toBe(true);
    expect(isEntitlementReconcilable('copilot')).toBe(true);
    expect(isEntitlementReconcilable('codex')).toBe(true);
    expect(isEntitlementReconcilable('openai')).toBe(false);
  });

  it('probes only the imported picker and prunes the dedicated-only model', async () => {
    const serverless = row('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'row-ok');
    const dedicated = row('Hcompany/Holo3-35B-A3B', 'row-bad');
    listActiveByProviderId.mockResolvedValue([serverless, dedicated]);
    listByProviderId.mockResolvedValue([serverless, dedicated]);

    probeTogether.mockImplementation(async (id) =>
      id === 'Hcompany/Holo3-35B-A3B' ? { ok: false, reason: REASON } : { ok: true }
    );

    const summary = await reconcileEntitlements('together');

    // Candidate set was the active picker — exactly the two imported rows.
    expect(probeTogether).toHaveBeenCalledTimes(2);
    // Never imported new rows (Together reconcile only prunes the picker).
    expect(bulkUpsert).not.toHaveBeenCalled();

    // Serverless row kept active; dedicated row deactivated with the reason.
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-ok',
      expect.objectContaining({ status: 'ok' }),
      true
    );
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-bad',
      expect.objectContaining({ status: 'blocked', reason: REASON }),
      false
    );

    expect(summary.working).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo']);
    expect(summary.pruned).toEqual([{ modelId: 'Hcompany/Holo3-35B-A3B', reason: REASON }]);
  });
});
