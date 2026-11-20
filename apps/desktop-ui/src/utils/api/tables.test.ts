import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { tablesApi } from './tables';

afterEach(() => vi.unstubAllGlobals());

describe('tablesApi.setPlacement', () => {
  const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
  const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
  const entry = {
    id: TABLE_ID,
    name: 'reading_list',
    origin: 'custom',
    projectId: PROJECT_ID,
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('sends only the placement keys it was given and returns the placed entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { table: entry } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(tablesApi.setPlacement(TABLE_ID, { sortOrder: 1 })).resolves.toEqual({
      table: entry,
    });
    await tablesApi.setPlacement(TABLE_ID, { projectId: PROJECT_ID, sortOrder: 0 });
    await tablesApi.setPlacement(TABLE_ID, { projectId: null });
    await tablesApi.setProject(TABLE_ID, PROJECT_ID);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual(
      Array.from({ length: 4 }, () => [`/api/tables/${TABLE_ID}`, 'PATCH'])
    );
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { sortOrder: 1 },
      { projectId: PROJECT_ID, sortOrder: 0 },
      { projectId: null },
      { projectId: PROJECT_ID },
    ]);
  });
});

describe('tablesApi.createEntries', () => {
  it('posts the batch to the table’s batch route and unwraps the created entries', async () => {
    const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
    const data = { entries: [], schemaVersion: 'v', relatedEntries: {}, relatedItems: {} };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      entries: [{ id: '00000000-0000-4000-8000-000000000001', values: {} }],
      schemaVersion: 'v',
      afterEntryId: '00000000-0000-4000-8000-000000000002',
    };
    await expect(tablesApi.createEntries(TABLE_ID, input)).resolves.toEqual(data);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/tables/${TABLE_ID}/entries/batch`);
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });
});
