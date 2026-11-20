import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { setPanelToken } from '../panelToken';
import { schedulesApi } from './schedules';

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

describe('schedulesApi panel headers', () => {
  it('sends JSON headers without an unavailable panel token', async () => {
    const fetchMock = stubFetchOk();

    await schedulesApi.setEnabled('schedule-1', true);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('attaches the current panel token to manual runs', async () => {
    setPanelToken('the-panel-token');
    const fetchMock = stubFetchOk();

    await schedulesApi.runNow('schedule-1');

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Snaglet-Panel-Token': 'the-panel-token',
    });
  });
});
