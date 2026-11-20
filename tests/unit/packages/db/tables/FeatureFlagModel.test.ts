import { describe, expect, it, jest } from '@jest/globals';
import type { DbQueryable } from '@snaglet/db/db';

jest.mock('@snaglet/db/Model', () => ({
  Model: class {
    constructor(_definition: unknown) {}
  },
}));

import { FeatureFlags } from '@snaglet/db/tables/feature_flags';

function runnerWith(rows: unknown[]): { runner: DbQueryable; query: jest.Mock } {
  const query = jest.fn(async () => ({ rows, rowCount: rows.length }));
  return { runner: { query } as DbQueryable, query };
}

describe('FeatureFlagModel', () => {
  it('reads a named subset in deterministic name order', async () => {
    const { runner, query } = runnerWith([
      { id: 'flag-a', name: 'a_flag', enabled: false },
      { id: 'flag-z', name: 'z_flag', enabled: true },
    ]);

    await expect(FeatureFlags.listByNames(['z_flag', 'a_flag'], runner)).resolves.toEqual([
      { id: 'flag-a', name: 'a_flag', enabled: false },
      { id: 'flag-z', name: 'z_flag', enabled: true },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY name ASC'), [
      ['z_flag', 'a_flag'],
    ]);
  });

  it('does not query for an empty name set', async () => {
    const { runner, query } = runnerWith([]);
    await expect(FeatureFlags.listByNames([], runner)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves missing and non-true values disabled', async () => {
    const missing = runnerWith([]);
    const disabled = runnerWith([{ enabled: false }]);
    const enabled = runnerWith([{ enabled: true }]);

    await expect(FeatureFlags.isEnabled('missing', missing.runner)).resolves.toBe(false);
    await expect(FeatureFlags.isEnabled('disabled', disabled.runner)).resolves.toBe(false);
    await expect(FeatureFlags.isEnabled('enabled', enabled.runner)).resolves.toBe(true);
  });
});
