/**
 * Entitlement reconciliation logic — probe verdicts drive import/deactivate,
 * with cached verdicts reused unless stale or forced. The probe is injected so
 * no network is touched.
 */

const listByProviderId = jest.fn();
const setEntitlement = jest.fn();
const bulkUpsert = jest.fn(async () => []);

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    listByProviderId: (...a: unknown[]) => listByProviderId(...a),
    setEntitlement: (...a: unknown[]) => setEntitlement(...a),
    bulkUpsert: (...a: unknown[]) => bulkUpsert(...a),
  },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  reconcileProviderEntitlements,
  type ModelProbe,
} from '@server/services/ProviderModelDiscoveryService/reconcile';
import type { DiscoveredModel } from '@server/services/ProviderModelDiscoveryService/types';

function cand(modelId: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { modelId, displayName: modelId, alreadyImported: false, ...extra };
}

const NOW = Date.parse('2026-07-06T12:00:00.000Z');
const now = () => NOW;

beforeEach(() => {
  jest.clearAllMocks();
  listByProviderId.mockResolvedValue([]);
});

describe('reconcileProviderEntitlements', () => {
  it('imports passing models and deactivates blocked ones with the reason', async () => {
    listByProviderId.mockResolvedValue([
      { id: 'row-ok', modelId: 'gpt-5.4', metadata: {} },
      { id: 'row-bad', modelId: 'gpt-5.5', metadata: {} },
    ]);
    const probe: ModelProbe = jest.fn(async (id) =>
      id === 'gpt-5.5'
        ? { ok: false, reason: 'The requested model is not supported.' }
        : { ok: true }
    );

    const summary = await reconcileProviderEntitlements({
      providerId: 'copilot',
      candidates: [cand('gpt-5.4'), cand('gpt-5.5')],
      probe,
      now,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    // passing → active verdict
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-ok',
      expect.objectContaining({ status: 'ok', checkedAt: new Date(NOW).toISOString() }),
      true
    );
    // blocked → inactive with reason
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-bad',
      expect.objectContaining({
        status: 'blocked',
        reason: 'The requested model is not supported.',
      }),
      false
    );
    expect(summary.working).toEqual(['gpt-5.4']);
    expect(summary.pruned).toEqual([
      { modelId: 'gpt-5.5', reason: 'The requested model is not supported.' },
    ]);
  });

  it('treats transient probe failures as inconclusive — no prune, no cached verdict', async () => {
    // A 429/5xx/network failure is a condition of the moment, not an
    // entitlement verdict: pruning on it would deactivate a perfectly good
    // model during a probe burst.
    listByProviderId.mockResolvedValue([{ id: 'row-good', modelId: 'gemma-4', metadata: {} }]);
    const probe: ModelProbe = jest.fn(async () => ({
      ok: false,
      transient: true,
      reason: 'Too many requests in a short window.',
    }));

    const summary = await reconcileProviderEntitlements({
      providerId: 'together',
      candidates: [cand('gemma-4')],
      probe,
      now,
    });

    // Row untouched: no verdict written, no deactivation, nothing cached.
    expect(setEntitlement).not.toHaveBeenCalled();
    expect(summary.working).toEqual([]);
    expect(summary.pruned).toEqual([]);
    expect(summary.inconclusive).toEqual([
      { modelId: 'gemma-4', reason: 'Too many requests in a short window.' },
    ]);
  });

  it('reuses a fresh cached verdict without re-probing', async () => {
    listByProviderId.mockResolvedValue([
      {
        id: 'row-1',
        modelId: 'gpt-5.4',
        metadata: {
          entitlement: { status: 'ok', checkedAt: new Date(NOW - 60_000).toISOString() },
        },
      },
    ]);
    const probe: ModelProbe = jest.fn(async () => ({ ok: true }));

    const summary = await reconcileProviderEntitlements({
      providerId: 'copilot',
      candidates: [cand('gpt-5.4')],
      probe,
      now,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(setEntitlement).not.toHaveBeenCalled(); // cached verdict already persisted
    expect(summary.working).toEqual(['gpt-5.4']);
  });

  it('re-probes a stale cached verdict', async () => {
    listByProviderId.mockResolvedValue([
      {
        id: 'row-1',
        modelId: 'gpt-5.4',
        metadata: {
          entitlement: {
            status: 'blocked',
            reason: 'old',
            checkedAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(),
          },
        },
      },
    ]);
    const probe: ModelProbe = jest.fn(async () => ({ ok: true }));

    await reconcileProviderEntitlements({
      providerId: 'copilot',
      candidates: [cand('gpt-5.4')],
      probe,
      now,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ status: 'ok' }),
      true
    );
  });

  it('force re-probes even a fresh cached verdict', async () => {
    listByProviderId.mockResolvedValue([
      {
        id: 'row-1',
        modelId: 'gpt-5.4',
        metadata: { entitlement: { status: 'ok', checkedAt: new Date(NOW).toISOString() } },
      },
    ]);
    const probe: ModelProbe = jest.fn(async () => ({ ok: false, reason: 'now blocked' }));

    await reconcileProviderEntitlements({
      providerId: 'copilot',
      candidates: [cand('gpt-5.4')],
      probe,
      force: true,
      now,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ status: 'blocked' }),
      false
    );
  });

  it('creates a new active row for a passing model that is not yet imported', async () => {
    listByProviderId.mockResolvedValue([]); // nothing imported
    const probe: ModelProbe = jest.fn(async () => ({ ok: true }));

    await reconcileProviderEntitlements({
      providerId: 'codex',
      candidates: [cand('gpt-5.5', { supportsReasoning: true, contextWindowTokens: 400_000 })],
      probe,
      now,
    });

    expect(setEntitlement).not.toHaveBeenCalled(); // no existing row to update
    expect(bulkUpsert).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'gpt-5.5',
          metadata: expect.objectContaining({
            entitlement: expect.objectContaining({ status: 'ok' }),
          }),
        }),
      ])
    );
  });

  it('does not create rows for blocked models that were never imported', async () => {
    listByProviderId.mockResolvedValue([]);
    const probe: ModelProbe = jest.fn(async () => ({ ok: false, reason: 'blocked' }));

    const summary = await reconcileProviderEntitlements({
      providerId: 'codex',
      candidates: [cand('gpt-5.2-codex')],
      probe,
      now,
    });

    expect(setEntitlement).not.toHaveBeenCalled();
    expect(bulkUpsert).not.toHaveBeenCalled();
    expect(summary.pruned).toEqual([{ modelId: 'gpt-5.2-codex', reason: 'blocked' }]);
  });
});
