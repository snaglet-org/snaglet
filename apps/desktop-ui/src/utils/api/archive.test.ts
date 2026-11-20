import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { setPanelToken } from '../panelToken';
import { archiveApi } from './archive';
import { automationsApi } from './automations';

afterEach(() => {
  vi.unstubAllGlobals();
  setPanelToken(null);
});

function stubFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: {} }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type Call = [string, { method?: string; headers?: Record<string, string> }];

describe('archive panel headers', () => {
  it('sends the panel token with the sweep, which purges archived automations', async () => {
    setPanelToken('the-panel-token');
    const fetchMock = stubFetchOk();

    await archiveApi.sweepAll();

    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe('/api/archive/sweep-all');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Snaglet-Panel-Token': 'the-panel-token',
    });
  });

  it('restores and purges an archived automation through its own routes, with the token', async () => {
    setPanelToken('the-panel-token');
    const fetchMock = stubFetchOk();

    await automationsApi.restore('automation-1111111111111-aaaaaaaaa');
    await automationsApi.purge('automation-1111111111111-aaaaaaaaa');

    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map(([url, init]) => [init.method, url])).toEqual([
      ['POST', '/api/automations/automation-1111111111111-aaaaaaaaa/restore'],
      ['DELETE', '/api/automations/automation-1111111111111-aaaaaaaaa/purge'],
    ]);
    for (const [, init] of calls) {
      expect(init.headers).toMatchObject({ 'X-Snaglet-Panel-Token': 'the-panel-token' });
    }
  });
});
