import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const listByNames = jest.fn();
const isEnabled = jest.fn<(name: string) => Promise<boolean>>();

jest.mock('@snaglet/db/tables/feature_flags', () => ({
  FeatureFlags: {
    listByNames: (...args: unknown[]) => listByNames(...args),
    isEnabled: (name: string) => isEnabled(name),
  },
}));

import { featureFlagService } from '@server/services/FeatureFlagService';
import { FRONTEND_FEATURE_FLAG_NAMES } from '@snaglet/shared/types';

describe('FeatureFlagService', () => {
  it('returns only the frontend allowlist', async () => {
    listByNames.mockResolvedValue([
      { id: 'flag-local', name: 'local_model_removal_ui', enabled: true },
      { id: 'flag-cli', name: 'cli_pane_ui', enabled: true },
      { id: 'flag-fallback', name: 'fallback_credentials', enabled: true },
      { id: 'flag-hub', name: 'hub_home', enabled: true },
      { id: 'flag-internal', name: 'internal_only', enabled: true },
    ]);

    await expect(featureFlagService.getFrontendFlags()).resolves.toEqual({
      local_model_removal_ui: true,
      cli_pane_ui: true,
      fallback_credentials: true,
      hub_home: true,
    });
    expect(listByNames).toHaveBeenCalledWith([
      'local_model_removal_ui',
      'cli_pane_ui',
      'fallback_credentials',
      'hub_home',
    ]);
  });

  it('turns a flag on only when its row is enabled', async () => {
    listByNames.mockResolvedValue([{ id: 'flag-cli', name: 'cli_pane_ui', enabled: true }]);
    await expect(featureFlagService.getFrontendFlags()).resolves.toMatchObject({
      cli_pane_ui: true,
      local_model_removal_ui: false,
      fallback_credentials: false,
      hub_home: false,
    });
  });

  it('fails closed when the seeded rows are absent', async () => {
    listByNames.mockResolvedValue([]);
    await expect(featureFlagService.getFrontendFlags()).resolves.toEqual({
      local_model_removal_ui: false,
      cli_pane_ui: false,
      fallback_credentials: false,
      hub_home: false,
    });
  });
});

describe('FeatureFlagService server flags', () => {
  let now = 1_000_000;

  beforeEach(() => {
    isEnabled.mockReset();
    featureFlagService.clearServerFlagCache();
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the row and reuses the value within the cache window', async () => {
    isEnabled.mockResolvedValue(true);

    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(true);
    now += 29_000;
    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(true);

    expect(isEnabled).toHaveBeenCalledTimes(1);
    expect(isEnabled).toHaveBeenCalledWith('reranker');
  });

  it('reads the row again once the cached value expires', async () => {
    isEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(false);
    now += 30_000;
    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(true);

    expect(isEnabled).toHaveBeenCalledTimes(2);
  });

  it('reads the row again after the cache is cleared', async () => {
    isEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(false);
    featureFlagService.clearServerFlagCache();
    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(true);
  });

  it('treats a failed read as off', async () => {
    isEnabled.mockRejectedValue(new Error('database unavailable'));

    await expect(featureFlagService.isServerFlagEnabled('reranker')).resolves.toBe(false);
  });

  it('keeps the reranker flag out of the frontend allowlist', async () => {
    listByNames.mockResolvedValue([{ id: 'flag-reranker', name: 'reranker', enabled: true }]);

    expect(FRONTEND_FEATURE_FLAG_NAMES).not.toContain('reranker');
    const flags = await featureFlagService.getFrontendFlags();
    expect(Object.keys(flags)).toEqual([...FRONTEND_FEATURE_FLAG_NAMES]);
  });
});
