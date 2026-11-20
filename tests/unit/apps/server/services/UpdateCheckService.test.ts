/**
 * UpdateCheckService — version comparison contract.
 *
 * The daily-check plumbing (timers, GitHub fetch, notification dedupe) is
 * integration-shaped; what must never silently regress is the semver
 * comparison that decides "newer than running": a wrong answer either spams
 * update notifications on every check or hides real updates forever.
 */

const mockReadState = jest.fn();
const mockWriteState = jest.fn();
const mockNotify = jest.fn();
jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: (...args: unknown[]) => mockReadState(...args),
    write: (...args: unknown[]) => mockWriteState(...args),
  },
}));
// A stored GitHub token exists; the update check must still not send it.
jest.mock('@server/services/ProviderCredentialService/credentials', () => ({
  getSecretByProviderId: jest.fn(async () => 'stored-token'),
}));
jest.mock('@server/services/NotificationService', () => ({
  notificationService: { create: (...args: unknown[]) => mockNotify(...args) },
}));

import { SNAGLET_REPOSITORY } from '@snaglet/shared/constants';
import { logger } from '@server/config/logger';
import { compareVersions, updateCheckService } from '@server/services/UpdateCheckService';

describe('packaged release checks', () => {
  const savedVersion = process.env.SNAGLET_APP_VERSION;
  let value: unknown;
  beforeEach(() => {
    process.env.SNAGLET_APP_VERSION = '2.3.4';
    value = null;
    mockNotify.mockReset();
    mockWriteState.mockClear();
    mockReadState.mockImplementation(async () => ({ value }));
    mockWriteState.mockImplementation(async (_category, _key, state) => {
      value = state;
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedVersion === undefined) delete process.env.SNAGLET_APP_VERSION;
    else process.env.SNAGLET_APP_VERSION = savedVersion;
  });

  it.each([
    ['v2.3.4', false],
    ['v2.3.5', true],
    [null, false],
  ] as const)(
    'checks the distribution repository for release %s using the packaged version',
    async (version, newer) => {
      const fetchRelease = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          version
            ? JSON.stringify({
                tag_name: version,
                html_url: `https://github.com/${SNAGLET_REPOSITORY}/releases/tag/${version}`,
                published_at: '2026-01-01T00:00:00Z',
              })
            : '',
          { status: version ? 200 : 404 }
        )
      );
      const status = await updateCheckService.checkNow();
      expect(fetchRelease).toHaveBeenCalledWith(
        `https://api.github.com/repos/${SNAGLET_REPOSITORY}/releases/latest`,
        expect.any(Object)
      );
      expect(status.currentVersion).toBe('2.3.4');
      expect(status.updateAvailable).toBe(newer);
      expect(mockNotify).toHaveBeenCalledTimes(newer ? 1 : 0);
    }
  );

  it.each([403, 429])(
    'keeps the last check time on a rate-limited %s so the next tick retries, quietly',
    async (status) => {
      value = {
        lastCheckedAt: '2026-01-01T00:00:00.000Z',
        lastNotifiedVersion: null,
        latest: null,
      };
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
      const loud = ['info', 'warn', 'error'].map((level) =>
        jest.spyOn(logger, level as 'info' | 'warn' | 'error')
      );
      const result = await updateCheckService.checkNow();
      expect(result.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(mockWriteState).not.toHaveBeenCalled();
      for (const spy of loud) expect(spy).not.toHaveBeenCalled();
    }
  );

  it('records the check time when GitHub answers with another error', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const result = await updateCheckService.checkNow();
    expect(result.lastCheckedAt).not.toBeNull();
  });

  it('sends the release request without a stored credential', async () => {
    const fetchRelease = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    await updateCheckService.checkNow();
    const init = fetchRelease.mock.calls[0][1];
    expect(Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'authorization'
    );
  });
});

describe('compareVersions', () => {
  it('detects a newer patch/minor/major', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal, v-prefix and all', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('V1.2.3', 'v1.2.3')).toBe(0);
  });

  it('orders older before newer', () => {
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });

  it('pads missing parts with zeros', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('release outranks pre-release of the same core', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  it('survives junk numerics without throwing', () => {
    // 'not-a-version' parses as core "not" + pre-release "a-version":
    // numerics zero out and the pre-release tag sorts it below a real
    // 0.0.0 release. The contract is "no throw, junk never outranks a
    // real release", not any particular ordering among junk.
    expect(compareVersions('not-a-version', '0.0.0')).toBeLessThan(0);
    expect(compareVersions('1.x.3', '1.0.3')).toBe(0);
  });
});
