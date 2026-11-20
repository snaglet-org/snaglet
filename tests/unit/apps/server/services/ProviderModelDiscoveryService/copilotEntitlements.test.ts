/**
 * Copilot entitlement reconciliation — the non-probing pass. Unlike codex /
 * together, copilot is never probed (a probe burns premium quota), so it is
 * not in the probe map. The reconciler reactivates unstamped inactive rows the
 * live catalog still lists, skips rows the user removed
 * (metadata.deactivatedBy === 'user'), leaves rows absent from the catalog
 * alone, and re-marks plan_blocked/available from the payload hint while
 * keeping reconciled rows active. Probe/normalizer modules are mocked.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/ProviderChatService/providers/codex', () => ({
  probeCodexModel: jest.fn(),
}));
jest.mock('@server/services/ProviderChatService/providers/together', () => ({
  probeTogetherModel: jest.fn(),
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

const listByProviderId = jest.fn<(providerId: string) => Promise<unknown[]>>();
const setEntitlement =
  jest.fn<(id: string, entitlement: unknown, isActive: boolean) => Promise<void>>();
jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    listByProviderId: (...a: [string]) => listByProviderId(...a),
    setEntitlement: (...a: [string, unknown, boolean]) => setEntitlement(...a),
  },
}));

import {
  isEntitlementReconcilable,
  reconcileCopilotEntitlements,
  reconcileEntitlements,
} from '@server/services/ProviderModelDiscoveryService/entitlements';
import type { DiscoveredModel } from '@server/services/ProviderModelDiscoveryService/types';

function row(
  modelId: string,
  isActive: boolean,
  entitlementStatus?: string,
  metadataExtras: Record<string, unknown> = {}
) {
  return {
    id: `row-${modelId}`,
    providerId: 'copilot',
    modelId,
    displayName: modelId,
    isActive,
    metadata: {
      ...(entitlementStatus ? { entitlement: { status: entitlementStatus } } : {}),
      ...metadataExtras,
    },
  };
}

function candidate(modelId: string, entitlement?: DiscoveredModel['entitlement']): DiscoveredModel {
  return {
    modelId,
    displayName: modelId,
    alreadyImported: true,
    ...(entitlement ? { entitlement } : {}),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setEntitlement.mockResolvedValue(undefined);
});

describe('copilot is reconcilable but never probed', () => {
  it('copilot stays entitlement-reconcilable', () => {
    expect(isEntitlementReconcilable('copilot')).toBe(true);
  });

  it('the probe-based reconciler refuses copilot (would burn premium quota)', async () => {
    await expect(reconcileEntitlements('copilot')).rejects.toThrow(/not supported/i);
  });
});

describe('reconcileCopilotEntitlements (non-probing)', () => {
  it('reactivates every row, marks plan_blocked/available from the payload, and never deactivates', async () => {
    listByProviderId.mockResolvedValue([
      // Auto-deactivated without a user stamp — must be flipped back to active.
      row('gpt-5.5', false, 'plan_blocked'),
      // Active, previously marked plan_blocked at chat time; payload now clean
      // → optimistically cleared to available (a plan change would surface here).
      row('gpt-5.4', true, 'plan_blocked'),
      // Payload still gates this one → stays plan_blocked.
      row('o3-preview', true),
    ]);

    const summary = await reconcileCopilotEntitlements([
      candidate('gpt-5.5'), // no hint → available
      candidate('gpt-5.4'), // no hint → available (clears prior chat-time block)
      candidate('o3-preview', {
        status: 'plan_blocked',
        reason: 'Copilot model policy is "unconfigured"',
        source: 'discovery',
      }),
    ]);

    // Every write keeps the row active (3rd arg true) — never deactivated.
    expect(setEntitlement).toHaveBeenCalledTimes(3);
    for (const call of setEntitlement.mock.calls) {
      expect(call[2]).toBe(true);
    }

    expect(setEntitlement).toHaveBeenCalledWith(
      'row-gpt-5.5',
      expect.objectContaining({ status: 'available', source: 'discovery' }),
      true
    );
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-gpt-5.4',
      expect.objectContaining({ status: 'available' }),
      true
    );
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-o3-preview',
      expect.objectContaining({ status: 'plan_blocked', source: 'discovery' }),
      true
    );

    expect(summary.total).toBe(3);
    expect(summary.reactivated).toBe(1); // only gpt-5.5 was inactive
    expect(summary.planBlocked).toEqual(['o3-preview']);
    expect(summary.available.sort()).toEqual(['gpt-5.4', 'gpt-5.5']);
    expect(summary.skippedUserRemoved).toEqual([]);
    expect(summary.skippedNotInCatalog).toEqual([]);
  });

  it('skips a user-removed row entirely — no reactivation, no status rewrite', async () => {
    listByProviderId.mockResolvedValue([
      // The user hit "Remove model": DELETE /api/models/:id stamped this.
      row('gpt-4o', false, undefined, { deactivatedBy: 'user' }),
      // Control: an unstamped inactive row in the catalog still gets amnesty.
      row('gpt-5.5', false),
    ]);

    const summary = await reconcileCopilotEntitlements([
      candidate('gpt-4o'), // in the catalog, but the user said no
      candidate('gpt-5.5'),
    ]);

    // The user-removed row was never written — stays inactive, keeps metadata.
    expect(setEntitlement).toHaveBeenCalledTimes(1);
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-gpt-5.5',
      expect.objectContaining({ status: 'available' }),
      true
    );
    expect(setEntitlement).not.toHaveBeenCalledWith(
      'row-gpt-4o',
      expect.anything(),
      expect.anything()
    );

    expect(summary.skippedUserRemoved).toEqual(['gpt-4o']);
    expect(summary.reactivated).toBe(1); // only the unstamped amnesty row
    expect(summary.available).toEqual(['gpt-5.5']);
  });

  it('reactivates an unstamped inactive row that the catalog still lists', async () => {
    listByProviderId.mockResolvedValue([
      // Auto-deactivated row: inactive, no provenance stamp.
      row('gpt-5.5', false, 'plan_blocked'),
    ]);

    const summary = await reconcileCopilotEntitlements([candidate('gpt-5.5')]);

    expect(setEntitlement).toHaveBeenCalledWith(
      'row-gpt-5.5',
      expect.objectContaining({ status: 'available' }),
      true // flipped back to active
    );
    expect(summary.reactivated).toBe(1);
  });

  it('leaves a row missing from the live catalog untouched — never resurrects it', async () => {
    listByProviderId.mockResolvedValue([
      // Delisted/stale model, currently inactive: no catalog signal → no write.
      row('gpt-3.5-legacy', false),
      // Delisted but active: also untouched (no optimistic 'available' rewrite).
      row('gpt-4-old', true, 'plan_blocked'),
      // Control: a catalog-listed row still reconciles normally.
      row('gpt-5.4', true),
    ]);

    const summary = await reconcileCopilotEntitlements([candidate('gpt-5.4')]);

    expect(setEntitlement).toHaveBeenCalledTimes(1);
    expect(setEntitlement).toHaveBeenCalledWith(
      'row-gpt-5.4',
      expect.objectContaining({ status: 'available' }),
      true
    );

    expect(summary.skippedNotInCatalog.sort()).toEqual(['gpt-3.5-legacy', 'gpt-4-old']);
    expect(summary.reactivated).toBe(0); // the inactive delisted row stays down
    expect(summary.available).toEqual(['gpt-5.4']);
  });
});
