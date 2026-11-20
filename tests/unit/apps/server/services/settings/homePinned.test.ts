/**
 * `home.pinned`: the Home pane writes one pin at a time through the settings
 * entry path [userId, '<kind>:<id>']. Pins of different people and different
 * items never overwrite each other, an unpin drops the person's map once it is
 * empty, and a pin of an unknown kind is refused. The settings row lives in
 * memory, as in mapSettingWrites.test.ts.
 */
const mockRows = new Map<string, unknown>();

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: { read: async () => null },
}));
jest.mock('@snaglet/db', () => ({
  transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      query: async (sql: string, params: unknown[]) => {
        const [category, key, json] = params as string[];
        const id = `${category}.${key}`;
        if (sql.includes('INSERT')) {
          if (!mockRows.has(id)) mockRows.set(id, JSON.parse(json!));
        } else if (sql.includes('FOR UPDATE')) {
          return { rows: mockRows.has(id) ? [{ value: structuredClone(mockRows.get(id)) }] : [] };
        } else if (sql.includes('UPDATE')) {
          mockRows.set(id, JSON.parse(json!));
        }
        return { rows: [] };
      },
    }),
}));

import { registry, settingsService } from '@server/services/settings';

function pinnedDef() {
  const def = registry.get('home', 'pinned');
  if (!def) throw new Error('home.pinned is not registered');
  return def;
}

const docPin = { kind: 'doc', id: 'doc-1', title: 'Plan', pinnedAt: '2026-11-16T10:00:00.000Z' };
const tablePin = { kind: 'table', id: 'table-1', pinnedAt: '2026-11-16T11:00:00.000Z' };

beforeEach(() => {
  mockRows.clear();
  settingsService.invalidate();
});

describe('home.pinned', () => {
  it('defaults to no pins', () => {
    expect(pinnedDef().default).toEqual({});
  });

  it('keeps pins per person and per item', async () => {
    await settingsService.writeEntry(pinnedDef(), ['user-a', 'doc:doc-1'], docPin);
    await settingsService.writeEntry(pinnedDef(), ['user-a', 'table:table-1'], tablePin);
    await settingsService.writeEntry(pinnedDef(), ['user-b', 'doc:doc-1'], docPin);

    expect(mockRows.get('home.pinned')).toEqual({
      'user-a': { 'doc:doc-1': docPin, 'table:table-1': tablePin },
      'user-b': { 'doc:doc-1': docPin },
    });
  });

  it('drops a person’s map with their last unpin', async () => {
    await settingsService.writeEntry(pinnedDef(), ['user-a', 'doc:doc-1'], docPin);
    await settingsService.writeEntry(pinnedDef(), ['user-b', 'doc:doc-1'], docPin);

    await settingsService.removeEntry(pinnedDef(), ['user-a', 'doc:doc-1']);

    expect(mockRows.get('home.pinned')).toEqual({ 'user-b': { 'doc:doc-1': docPin } });
  });

  it('refuses a pin of an unknown kind', async () => {
    await expect(
      settingsService.writeEntry(pinnedDef(), ['user-a', 'agent:agent-1'], {
        kind: 'agent',
        id: 'agent-1',
        pinnedAt: '2026-11-16T10:00:00.000Z',
      })
    ).rejects.toThrow();
    expect(mockRows.get('home.pinned') ?? {}).toEqual({});
  });
});
