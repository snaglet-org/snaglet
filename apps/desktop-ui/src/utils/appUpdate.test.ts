import { afterEach, describe, expect, it, vi } from 'vitest';
import { SNAGLET_REPOSITORY } from '@snaglet/shared/constants/release';
import { appUpdateApi } from './api';
import { runAppUpdate } from './appUpdate';

vi.mock('./api', () => ({ appUpdateApi: { status: vi.fn() } }));
vi.mock('./tauriEnv', () => ({ isTauriEnv: () => false }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAppUpdate in the browser shell', () => {
  it('opens the latest release the server knows about', async () => {
    const url = `https://github.com/${SNAGLET_REPOSITORY}/releases/tag/v9.9.9`;
    vi.mocked(appUpdateApi.status).mockResolvedValue({
      currentVersion: '1.0.0',
      lastCheckedAt: null,
      latest: { version: 'v9.9.9', url, publishedAt: null, name: null },
      updateAvailable: true,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await expect(runAppUpdate()).resolves.toBe('opened release page');
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener');
  });

  it('falls back to the release repository when the server has no release', async () => {
    vi.mocked(appUpdateApi.status).mockRejectedValue(new Error('offline'));
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await runAppUpdate();
    expect(open).toHaveBeenCalledWith(
      `https://github.com/${SNAGLET_REPOSITORY}/releases/latest`,
      '_blank',
      'noopener'
    );
  });
});
