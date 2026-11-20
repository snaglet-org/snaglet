/**
 * dropPinnedPinkDefaults: on the first boot after upgrading, saved theme
 * colors that equal the old pink palette's default for their token (what an
 * older Reset saved) are removed, so those tokens follow today's defaults;
 * every other saved color stays. Success records `appearance.colors_cleanup`
 * and later boots stop there, so a color picked after the upgrade is never
 * dropped; a failed run records nothing and runs again. The settings rows live
 * in memory.
 */
const mockRows = new Map<string, unknown>();
const mockInfo = jest.fn();
let mockFailNextMerge = false;

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: async (category: string, key: string) =>
      mockRows.has(`${category}.${key}`)
        ? { category, key, value: mockRows.get(`${category}.${key}`) }
        : null,
    write: async (category: string, key: string, value: unknown) => {
      mockRows.set(`${category}.${key}`, structuredClone(value));
    },
  },
}));
// INSERT … ON CONFLICT DO NOTHING, SELECT … FOR UPDATE, UPDATE — answered from mockRows.
jest.mock('@snaglet/db', () => ({
  transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    if (mockFailNextMerge) {
      mockFailNextMerge = false;
      throw new Error('database went away');
    }
    return run({
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
    });
  },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: (...args: unknown[]) => mockInfo(...args), warn: jest.fn(), debug: jest.fn() },
}));

import { dropPinnedPinkDefaults } from '@server/services/settings/appearanceColorsCleanup';
import { settingsService } from '@server/services/settings';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';

/** What "Reset all to defaults" saved before resets removed colors. */
const OLD_RESET_ROW: Record<string, string> = {
  disabled: '#f4ecf3',
  background: '#ffffff',
  foreground: '#ffd6fe',
  'activity-bar': '#fff2db',
  sidebar: '#ffdbe8',
  'status-bar': '#fff2db',
  raised: '#ffffff',
  chrome: '#ff8f8f',
  field: '#d3d6fe',
  selected: '#fab3c4',
  text: '#19141a',
  'text-muted': '#910094',
  line: '#fbbcd7',
  border: '#652a49',
  detail: '#fd3887',
  'detail-2': '#ff6d6d',
  'color-container-project': '#ffb3d9',
  'color-container-default': '#9fd8ff',
  'color-node-doc': '#52a3ff',
  'color-node-thread': '#f887d4',
  agent: '#c9b6ff',
  'color-node-tool': '#ffd36e',
  'color-node-memory': '#d59cf0',
  'color-node-image': '#ff8870',
};
const saved = () => mockRows.get('appearance.colors');
const marker = () => mockRows.get('appearance.colors_cleanup');

beforeEach(() => {
  mockRows.clear();
  mockInfo.mockClear();
  mockFailNextMerge = false;
  settingsService.invalidate();
});

it('covers every token of the palette', () => {
  expect(Object.keys(OLD_RESET_ROW).sort()).toEqual(
    workspaceColorTokens.map((token) => token.name).sort()
  );
});

it('on the first boot, strips a theme an old Reset pinned and records that it ran', async () => {
  mockRows.set('appearance.colors', { ...OLD_RESET_ROW, sidebar: '#123456' });
  const removed = await dropPinnedPinkDefaults();
  expect(removed).toHaveLength(23);
  expect(saved()).toEqual({ sidebar: '#123456' });
  expect(marker()).toEqual({ done: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  expect(mockInfo).toHaveBeenCalledTimes(1);
  expect(mockInfo.mock.calls[0]?.[0]).toMatch(/dropped 23 theme color\(s\)/);
});

it('leaves a color picked after the upgrade alone on every later boot, even an old default', async () => {
  mockRows.set('appearance.colors', { ...OLD_RESET_ROW });
  await dropPinnedPinkDefaults();
  expect(saved()).toEqual({});
  mockInfo.mockClear();
  // White was the old Background default; picked again after the upgrade, it stays.
  mockRows.set('appearance.colors', { background: '#ffffff' });
  expect(await dropPinnedPinkDefaults()).toEqual([]);
  expect(await dropPinnedPinkDefaults()).toEqual([]);
  expect(saved()).toEqual({ background: '#ffffff' });
  expect(mockInfo).not.toHaveBeenCalled();
});

it('leaves no marker when it fails, so the next boot tries again', async () => {
  mockRows.set('appearance.colors', { ...OLD_RESET_ROW });
  mockFailNextMerge = true;
  await expect(dropPinnedPinkDefaults()).rejects.toThrow('database went away');
  expect(marker()).toBeUndefined();
  expect(saved()).toEqual(OLD_RESET_ROW);
  expect(await dropPinnedPinkDefaults()).toHaveLength(24);
  expect(saved()).toEqual({});
  expect(marker()).toBeDefined();
});

it('keeps custom colors that match no old default, and still records the run', async () => {
  mockRows.set('appearance.colors', { detail: '#00aa88', text: '#112233' });
  expect(await dropPinnedPinkDefaults()).toEqual([]);
  expect(saved()).toEqual({ detail: '#00aa88', text: '#112233' });
  expect(marker()).toBeDefined();
  expect(mockInfo).not.toHaveBeenCalled();
});

it('keeps an old default saved on another token', async () => {
  // Pink on the text token is a choice, not a pinned default.
  mockRows.set('appearance.colors', { text: '#fd3887' });
  expect(await dropPinnedPinkDefaults()).toEqual([]);
  expect(saved()).toEqual({ text: '#fd3887' });
});

it('reaches a pinned color saved under an old token name', async () => {
  mockRows.set('appearance.colors', { canvas: '#f4ecf3', detail: '#00aa88' });
  expect(await dropPinnedPinkDefaults()).toEqual(['disabled']);
  expect(saved()).toEqual({ detail: '#00aa88' });
});

it('creates no theme when none was saved, and records the run', async () => {
  expect(await dropPinnedPinkDefaults()).toEqual([]);
  expect(saved()).toBeUndefined();
  expect(marker()).toBeDefined();
});
