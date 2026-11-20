import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { setPanelToken } from '../panelToken';
import { hookRunsApi, hooksWorkspacesApi } from './hooks';

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

describe('hooksWorkspacesApi panel headers', () => {
  it('sends JSON headers without an unavailable panel token', async () => {
    const fetchMock = stubFetchOk();

    await hooksWorkspacesApi.check('daily-report');

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('attaches the current panel token to hook runs', async () => {
    setPanelToken('the-panel-token');
    const fetchMock = stubFetchOk();

    await hooksWorkspacesApi.run('daily-report', { eventName: 'message:create' });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Snaglet-Panel-Token': 'the-panel-token',
    });
  });
});

describe('hookRunsApi lifecycle mutations', () => {
  it('clears one encoded hook ledger with DELETE', async () => {
    const fetchMock = stubFetchOk();

    await hookRunsApi.clearForHook('daily report');

    expect(fetchMock).toHaveBeenCalledWith('/api/hooks/daily%20report/runs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

describe('hooksWorkspacesApi.registry', () => {
  it('reads every registration row from the registry route', async () => {
    const fetchMock = stubFetchOk();

    await hooksWorkspacesApi.registry();

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/hooks\/registry$/);
  });
});
