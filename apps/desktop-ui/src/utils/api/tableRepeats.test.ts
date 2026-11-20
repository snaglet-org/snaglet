import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { FetchError } from './core';
import { isStaleRepeatError, tableRepeatsApi } from './tableRepeats';

afterEach(() => vi.unstubAllGlobals());

const TABLE = 'table-1111111111111-aaaaaaaaa';
const ENTRY = '11111111-2222-3333-4444-555555555555';
const FIELD = 'field-due';
const REV = { expectedRevision: '7', schemaVersion: '3' };
const BASE = `/api/tables/${TABLE}/entries/${ENTRY}`;

function mockFetch(data: unknown = { ok: 1 }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body) : undefined,
  }));
}

describe('tableRepeatsApi', () => {
  it('reads one entry’s repeats and log', async () => {
    const view = { entryId: ENTRY, revision: '7', repeats: {}, log: [] };
    const fetchMock = mockFetch(view);
    await expect(tableRepeatsApi.get(TABLE, ENTRY)).resolves.toEqual(view);
    expect(calls(fetchMock)).toEqual([{ url: `${BASE}/repeats`, method: 'GET', body: undefined }]);
  });

  it('sets a repeat: body passes through unchanged', async () => {
    const fetchMock = mockFetch();
    await tableRepeatsApi.set(TABLE, ENTRY, FIELD, { ...REV, rrule: 'FREQ=WEEKLY;BYDAY=MO' });
    await tableRepeatsApi.set(TABLE, ENTRY, FIELD, {
      ...REV,
      rrule: 'FREQ=MONTHLY',
      date: '2026-11-01',
      expectedCurrent: null,
    });
    expect(calls(fetchMock)).toEqual([
      {
        url: `${BASE}/repeats/${FIELD}`,
        method: 'PUT',
        body: { ...REV, rrule: 'FREQ=WEEKLY;BYDAY=MO' },
      },
      {
        url: `${BASE}/repeats/${FIELD}`,
        method: 'PUT',
        body: {
          ...REV,
          rrule: 'FREQ=MONTHLY',
          date: '2026-11-01',
          expectedCurrent: null,
        },
      },
    ]);
  });

  it('clears with the revision pair in the query', async () => {
    const fetchMock = mockFetch();
    await tableRepeatsApi.clear(TABLE, ENTRY, FIELD, REV);
    expect(calls(fetchMock)).toEqual([
      {
        url: `${BASE}/repeats/${FIELD}?expectedRevision=7&schemaVersion=3`,
        method: 'DELETE',
        body: undefined,
      },
    ]);
  });

  it('posts complete, skip, move and shift', async () => {
    const fetchMock = mockFetch();
    await tableRepeatsApi.complete(TABLE, ENTRY, FIELD, REV);
    await tableRepeatsApi.skip(TABLE, ENTRY, FIELD, { ...REV, toUpcoming: true });
    await tableRepeatsApi.move(TABLE, ENTRY, FIELD, { ...REV, to: '2026-10-14' });
    await tableRepeatsApi.shift(TABLE, ENTRY, FIELD, {
      ...REV,
      occurrence: '2026-10-12',
      to: '2026-10-13',
    });
    expect(calls(fetchMock)).toEqual([
      { url: `${BASE}/repeats/${FIELD}/complete`, method: 'POST', body: REV },
      { url: `${BASE}/repeats/${FIELD}/skip`, method: 'POST', body: { ...REV, toUpcoming: true } },
      { url: `${BASE}/repeats/${FIELD}/move`, method: 'POST', body: { ...REV, to: '2026-10-14' } },
      {
        url: `${BASE}/repeats/${FIELD}/shift`,
        method: 'POST',
        body: { ...REV, occurrence: '2026-10-12', to: '2026-10-13' },
      },
    ]);
  });

  it('undoes one logged occurrence on the occurrences route with fieldId in the body', async () => {
    const fetchMock = mockFetch();
    await tableRepeatsApi.undoOccurrence(TABLE, ENTRY, 'tocc-abc', { ...REV, fieldId: FIELD });
    expect(calls(fetchMock)).toEqual([
      {
        url: `${BASE}/occurrences/tocc-abc/undo`,
        method: 'POST',
        body: { ...REV, fieldId: FIELD },
      },
    ]);
  });

  it('encodes ids in the path', async () => {
    const fetchMock = mockFetch();
    await tableRepeatsApi.complete('t/1', 'e 1', 'f?1', REV);
    expect(calls(fetchMock)[0]!.url).toBe('/api/tables/t%2F1/entries/e%201/repeats/f%3F1/complete');
  });
});

describe('isStaleRepeatError', () => {
  it('is true only for a 409 FetchError', () => {
    expect(isStaleRepeatError(new FetchError('stale', 409))).toBe(true);
    expect(isStaleRepeatError(new FetchError('bad', 400))).toBe(false);
    expect(isStaleRepeatError(new Error('x'))).toBe(false);
  });
});
