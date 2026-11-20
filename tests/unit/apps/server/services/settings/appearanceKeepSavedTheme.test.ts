/**
 * keepSavedThemeOnNewDefault: on the first boot after the default theme turned
 * dark (Soft Pastel Garden), a customized saved theme gets the previous (sage)
 * default saved for every color it left unset, so it looks exactly as it did;
 * one holding only sage defaults is cleared, so it follows the new default; no
 * saved theme stays none. Success records `appearance.colors_default_kept` and
 * later boots stop there; a failed run records nothing and runs again. The
 * settings rows live in memory.
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

import { keepSavedThemeOnNewDefault } from '@server/services/settings/appearanceKeepSavedTheme';
import { settingsService } from '@server/services/settings';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';

/** The light default before Soft Pastel Garden. */
const SAGE: Record<string, string> = {
  disabled: '#e6e9df',
  background: '#fffdf7',
  foreground: '#f1f3e9',
  'activity-bar': '#d8e3cf',
  sidebar: '#e8efdf',
  'status-bar': '#d8e3cf',
  raised: '#ffffff',
  chrome: '#dce7d3',
  field: '#f5f5eb',
  selected: '#f2cfb8',
  text: '#30392d',
  'text-muted': '#59664f',
  line: '#d5ddcb',
  border: '#8b9c7b',
  detail: '#a54e32',
  'detail-2': '#526d47',
  'color-container-project': '#678353',
  'color-container-default': '#98ab7d',
  'color-node-doc': '#4d7b82',
  'color-node-thread': '#ad4d4c',
  agent: '#aa91b6',
  'color-node-tool': '#977229',
  'color-node-memory': '#91769f',
  'color-node-image': '#bd754e',
};
const saved = () => mockRows.get('appearance.colors');
const marker = () => mockRows.get('appearance.colors_default_kept');

beforeEach(() => {
  mockRows.clear();
  mockInfo.mockClear();
  mockFailNextMerge = false;
  settingsService.invalidate();
});

it('covers every token of the palette', () => {
  expect(Object.keys(SAGE).sort()).toEqual(workspaceColorTokens.map((t) => t.name).sort());
});

it('keeps a customized theme looking exactly as before: the old default fills every unset color', async () => {
  mockRows.set('appearance.colors', { detail: '#00aa88', background: '#ffffff' });
  const result = await keepSavedThemeOnNewDefault();
  expect(result.outcome).toBe('kept');
  expect(result.tokens).toHaveLength(22);
  // The person's own colors untouched, everything else what they saw.
  expect(saved()).toEqual({ ...SAGE, detail: '#00aa88', background: '#ffffff' });
  expect(marker()).toEqual({ done: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  expect(mockInfo).toHaveBeenCalledTimes(1);
});

it('leaves a theme that already names every color untouched', async () => {
  const full = { ...SAGE, text: '#112233' };
  mockRows.set('appearance.colors', { ...full });
  expect(await keepSavedThemeOnNewDefault()).toEqual({ outcome: 'none', tokens: [] });
  expect(saved()).toEqual(full);
  expect(marker()).toBeDefined();
});

it('clears a saved theme holding only old defaults, so it follows the new default', async () => {
  mockRows.set('appearance.colors', { detail: SAGE.detail, text: SAGE.text });
  const result = await keepSavedThemeOnNewDefault();
  expect(result).toEqual({ outcome: 'cleared', tokens: ['detail', 'text'] });
  expect(saved()).toEqual({});
});

it('does nothing for an install with no saved theme (it gets Soft Pastel Garden), and records the run', async () => {
  expect(await keepSavedThemeOnNewDefault()).toEqual({ outcome: 'none', tokens: [] });
  expect(saved()).toBeUndefined();
  expect(marker()).toBeDefined();
});

it('runs once: a theme saved after the upgrade is never filled in', async () => {
  await keepSavedThemeOnNewDefault();
  mockRows.set('appearance.colors', { detail: '#00aa88' });
  expect(await keepSavedThemeOnNewDefault()).toEqual({ outcome: 'none', tokens: [] });
  expect(saved()).toEqual({ detail: '#00aa88' });
});

it('leaves no marker when it fails, so the next boot tries again', async () => {
  mockRows.set('appearance.colors', { detail: '#00aa88' });
  mockFailNextMerge = true;
  await expect(keepSavedThemeOnNewDefault()).rejects.toThrow('database went away');
  expect(marker()).toBeUndefined();
  expect(saved()).toEqual({ detail: '#00aa88' });
  expect((await keepSavedThemeOnNewDefault()).outcome).toBe('kept');
  expect(marker()).toBeDefined();
});

it('reads a theme saved under an old token name', async () => {
  mockRows.set('appearance.colors', { canvas: '#123456' });
  const result = await keepSavedThemeOnNewDefault();
  expect(result.outcome).toBe('kept');
  expect(saved()).toEqual({ ...SAGE, disabled: '#123456' });
});
