/**
 * settingsService map writes and the hooks a setting opts in to, the seam the
 * Theme view's saves and resets (PATCH) and change_color_theme share:
 * - `nullRemovesEntry`: a null removes the entry (appearance.colors); any other
 *   map still stores null as given (a budget's `maxWaves: null` means "no cap").
 * - `normalize`: a theme saved under old token names is carried over to
 *   today's names before the write, so a reset by today's names reaches it.
 * - `entryKeys`: a write naming anything but a token is refused.
 * Only a merge that sets something creates the row. The settings row lives in
 * memory; the real SQL and row lock are in the integration suite.
 */
import { z } from 'zod';

const mockRows = new Map<string, unknown>();

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: { read: async () => null },
}));
// INSERT … ON CONFLICT DO NOTHING, SELECT … FOR UPDATE, UPDATE — answered from mockRows.
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

import { settingsService } from '@server/services/settings';
import { SettingsEntryError } from '@server/services/settings/settingsService';
import { defineCategory } from '@server/services/settings/defineSetting';
import { appearanceSettings } from '@server/services/settings/categories/appearance';
import { workspaceColorResetPatch } from '@snaglet/shared/constants/workspaceTheme';

const colors = appearanceSettings.colors;
const testDefs = defineCategory('test_map_setting_writes', {
  caps: {
    key: 'caps',
    schema: z.record(z.string(), z.number().nullable()),
    default: {} as Record<string, number | null>,
    description: '',
  },
});

/** Run `write` and collect the settings:changed events it emits. */
async function events(write: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const off = settingsService.onChange((event) => seen.push(event));
  try {
    await write();
  } finally {
    off();
  }
  return seen;
}

beforeEach(() => {
  mockRows.clear();
  settingsService.invalidate();
});

describe('nullRemovesEntry', () => {
  it('removes a color given as null and sets the rest, in one merge', async () => {
    mockRows.set('appearance.colors', { detail: '#00aa88', sidebar: '#eeeeee' });
    const merged = await settingsService.mergeEntries(colors, { detail: null, text: '#112233' });
    expect(merged).toEqual({ sidebar: '#eeeeee', text: '#112233' });
    expect(mockRows.get('appearance.colors')).toEqual({ sidebar: '#eeeeee', text: '#112233' });
  });

  it('leaves an empty theme when every saved color is reset', async () => {
    mockRows.set('appearance.colors', { detail: '#00aa88' });
    await settingsService.mergeEntries(colors, workspaceColorResetPatch());
    expect(mockRows.get('appearance.colors')).toEqual({});
  });

  it('creates no row for a reset when nothing was saved', async () => {
    const seen = await events(() => settingsService.mergeEntries(colors, { detail: null }));
    expect(mockRows.has('appearance.colors')).toBe(false);
    expect(seen).toEqual([]);
  });

  it('stores null as given in a map that did not opt in', async () => {
    mockRows.set('test_map_setting_writes.caps', { waves: 3 });
    await settingsService.mergeEntries(testDefs.caps, { waves: null, depth: 2 });
    expect(mockRows.get('test_map_setting_writes.caps')).toEqual({ waves: null, depth: 2 });
  });
});

describe('normalize', () => {
  it('resets a theme saved under old token names to an empty theme, and says so', async () => {
    mockRows.set('appearance.colors', {
      panel: '#333333',
      canvas: '#111111',
      'color-node-agent': '#222222',
      'color-container-status': '#444444',
    });
    const seen = await events(() =>
      settingsService.mergeEntries(colors, workspaceColorResetPatch())
    );
    expect(mockRows.get('appearance.colors')).toEqual({});
    expect(seen).toEqual([
      expect.objectContaining({ category: 'appearance', key: 'colors', value: {} }),
    ]);
  });

  it('carries old token names over to today’s when a color is set', async () => {
    mockRows.set('appearance.colors', { panel: '#333333', fg: '#222222' });
    await settingsService.mergeEntries(colors, { text: '#112233' });
    expect(mockRows.get('appearance.colors')).toEqual({
      foreground: '#333333',
      sidebar: '#333333',
      'activity-bar': '#333333',
      'status-bar': '#333333',
      background: '#222222',
      text: '#112233',
    });
  });

  it('resets one token that was saved under its old name', async () => {
    mockRows.set('appearance.colors', { canvas: '#111111', text: '#112233' });
    await settingsService.removeEntry(colors, ['disabled']);
    expect(mockRows.get('appearance.colors')).toEqual({ text: '#112233' });
  });
});

describe('entryKeys', () => {
  it('refuses a write naming anything but a token, and writes nothing', async () => {
    mockRows.set('appearance.colors', { detail: '#00aa88' });
    await expect(settingsService.mergeEntries(colors, { nope: null })).rejects.toThrow(
      SettingsEntryError
    );
    await expect(
      settingsService.mergeEntries(colors, { canvas: '#111111', text: '#112233' })
    ).rejects.toThrow(/Unknown entry for appearance\.colors: canvas\. Valid entries: disabled/);
    await expect(settingsService.removeEntry(colors, ['nope'])).rejects.toThrow(SettingsEntryError);
    expect(mockRows.get('appearance.colors')).toEqual({ detail: '#00aa88' });
  });
});

it('creates no row for an empty merge', async () => {
  await settingsService.mergeEntries(colors, {});
  await settingsService.mergeEntries(testDefs.caps, {});
  expect(mockRows.size).toBe(0);
});
