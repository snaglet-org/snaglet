/**
 * get_local_context tool unit tests — keyless IP geolocation (primary
 * ipwho.is -> fallback ipapi.co), fallback on primary failure, a structured
 * error when both fail, and the short in-memory TTL cache. Any other request,
 * such as a weather lookup, fails the test: the fetch mock throws on a URL it
 * does not know.
 *
 * `global.fetch` is mocked so no real network I/O happens. The tool keeps
 * its cache in a module-scope variable, so each test does `jest.resetModules()`
 * + a fresh dynamic import to start from an empty cache instead of leaking
 * state between tests.
 */

import type { ToolHandler } from '@server/services/ToolService/types';

type FetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

const IPWHO_IS_OK: FetchResponse = {
  ok: true,
  json: async () => ({
    success: true,
    city: 'Testville',
    region: 'Test Region',
    country: 'Testland',
    latitude: 40.1234,
    longitude: -75.4321,
    timezone: { id: 'America/New_York' },
  }),
};

const IPAPI_CO_OK: FetchResponse = {
  ok: true,
  json: async () => ({
    city: 'Testville',
    region: 'Test Region',
    country_name: 'Testland',
    latitude: 40.1234,
    longitude: -75.4321,
    timezone: 'America/New_York',
  }),
};

function fetchDispatcher(
  handlers: Record<string, () => FetchResponse | Promise<FetchResponse>>
): jest.Mock {
  return jest.fn(async (input: unknown) => {
    const url = String(input);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) return handler();
    }
    throw new Error(`unexpected fetch url in test: ${url}`);
  });
}

const originalFetch = global.fetch;

async function loadTool(): Promise<ToolHandler> {
  const mod = await import('@server/services/ToolService/handlers/trivial/localContext');
  return mod.default;
}

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('get_local_context tool', () => {
  it('resolves location via ipwho.is (primary) and returns only the location', async () => {
    global.fetch = fetchDispatcher({
      'ipwho.is': () => IPWHO_IS_OK,
      'ipapi.co': () => {
        throw new Error('ipapi.co should not be called when ipwho.is succeeds');
      },
    }) as unknown as typeof fetch;

    const tool = await loadTool();
    const result = await tool({}, {});
    const parsed = JSON.parse(result as string);

    expect(parsed.location).toEqual({
      city: 'Testville',
      region: 'Test Region',
      country: 'Testland',
      lat: 40.1234,
      lon: -75.4321,
      timezone: 'America/New_York',
    });
    expect(Object.keys(parsed)).toEqual(['location']);
  });

  it('falls back to ipapi.co when ipwho.is fails or rate-limits', async () => {
    const fetchMock = fetchDispatcher({
      'ipwho.is': () => ({
        ok: true,
        json: async () => ({ success: false, message: 'quota exceeded' }),
      }),
      'ipapi.co': () => IPAPI_CO_OK,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const tool = await loadTool();
    const result = await tool({}, {});
    const parsed = JSON.parse(result as string);

    expect(parsed.location.city).toBe('Testville');
    expect(parsed.location.country).toBe('Testland');
    // ipwho.is, then ipapi.co.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an honest structured error (not a throw) when every location provider fails', async () => {
    global.fetch = fetchDispatcher({
      'ipwho.is': () => {
        throw new Error('network unreachable');
      },
      'ipapi.co': () => ({ ok: false, status: 429, json: async () => ({}) }),
    }) as unknown as typeof fetch;

    const tool = await loadTool();
    const result = await tool({}, {});
    const parsed = JSON.parse(result as string);

    expect(parsed.error).toBe(true);
    expect(parsed.location).toBeNull();
    expect(parsed.message).toContain('network unreachable');
    expect(parsed.message).toContain('429');
  });

  it('serves a second call within the TTL window from cache, with no new network requests', async () => {
    const fetchMock = fetchDispatcher({
      'ipwho.is': () => IPWHO_IS_OK,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const tool = await loadTool();
    await tool({}, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool({}, {});
    expect(fetchMock).toHaveBeenCalledTimes(1); // the cache served the second call
  });

  it('re-fetches the location once the TTL has elapsed', async () => {
    jest.useFakeTimers();
    const fetchMock = fetchDispatcher({
      'ipwho.is': () => IPWHO_IS_OK,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const tool = await loadTool();
    await tool({}, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(6 * 60 * 1000); // past the 5-minute TTL
    await tool({}, {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing required field from a provider as a failure, not a crash with NaN coordinates', async () => {
    global.fetch = fetchDispatcher({
      'ipwho.is': () => ({
        ok: true,
        json: async () => ({ success: true, city: 'Nowhere' /* no latitude/longitude */ }),
      }),
      'ipapi.co': () => ({ ok: false, status: 500, json: async () => ({}) }),
    }) as unknown as typeof fetch;

    const tool = await loadTool();
    const result = await tool({}, {});
    const parsed = JSON.parse(result as string);

    expect(parsed.error).toBe(true);
    expect(parsed.location).toBeNull();
  });
});
