/**
 * change_color_theme — get / set / reset over the real settings service and
 * `appearance.colors` schema, with the settings row in memory (the locked
 * merge's three statements are played against it). Pins the merge (PATCH
 * semantics), validation (nothing written on a bad entry), placeholders from
 * other ops, reset (removes the saved colors, as the Theme view does, so a
 * reset color follows later defaults, and reports every old color so one set
 * undoes it), authorship, and that every write reaches open windows as
 * `settings:changed`. The real SQL and its row lock are covered in the
 * settings service integration suite.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockRows = new Map<string, unknown>();
const mockWrite = jest.fn();
const mockBroadcast = jest.fn();

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: async (category: string, key: string) =>
      mockRows.has(`${category}.${key}`)
        ? { category, key, value: mockRows.get(`${category}.${key}`) }
        : null,
  },
}));
// settingsService.mergeEntries: INSERT … ON CONFLICT DO NOTHING, SELECT … FOR
// UPDATE, UPDATE — answered from mockRows.
jest.mock('@snaglet/db', () => ({
  transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      query: async (sql: string, params: unknown[]) => {
        const [category, key, json, userId, agentId] = params as string[];
        const id = `${category}.${key}`;
        if (sql.includes('INSERT')) {
          if (!mockRows.has(id)) mockRows.set(id, JSON.parse(json!));
        } else if (sql.includes('FOR UPDATE')) {
          return { rows: mockRows.has(id) ? [{ value: structuredClone(mockRows.get(id)) }] : [] };
        } else if (sql.includes('UPDATE')) {
          mockRows.set(id, JSON.parse(json!));
          mockWrite(category, key, JSON.parse(json!), { userId, agentId });
        }
        return { rows: [] };
      },
    }),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => mockBroadcast(...args) },
}));

import tool from '@server/services/ToolService/tools/system/change-color-theme/tool';
import definition from '@server/services/ToolService/tools/system/change-color-theme/definition';
import { settingsService } from '@server/services/settings';
import { initSettingsSurface } from '@server/realtime/surfaces/settings';
import { runWithActor } from '@server/realtime/actorContext';
import {
  defaultWorkspaceColors,
  workspaceColorTokens,
} from '@snaglet/shared/constants/workspaceTheme';
import { CORE_TOOL_IDS } from '@snaglet/shared/constants';
import { defaultTheme } from '@snaglet/theme';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

const TOOL_DIR = path.resolve(
  __dirname,
  '../../../../../../../../apps/server/src/services/ToolService/tools/system/change-color-theme'
);
const saved = () => mockRows.get('appearance.colors') as Record<string, string> | undefined;
const run = async (input: Record<string, unknown>, context?: ToolHandlerContext) =>
  String(await tool(input, {}, context));

let stopSurface: () => void;
beforeAll(() => {
  stopSurface = initSettingsSurface();
});
afterAll(() => stopSurface());
beforeEach(() => {
  mockRows.clear();
  mockWrite.mockClear();
  mockBroadcast.mockClear();
  settingsService.invalidate();
});

describe('change_color_theme get', () => {
  it('lists every token with label, description, current and default, marking customized ones', async () => {
    mockRows.set('appearance.colors', { text: '#112233', detail: '#e291b5' });
    const out = await run({ op: 'get' });
    const described = (name: string) => {
      const token = workspaceColorTokens.find((candidate) => candidate.name === name);
      if (!token) throw new Error(`no color token named ${name}`);
      return `${token.label}: ${token.description}`;
    };
    expect(out).toContain(`${workspaceColorTokens.length} tokens, 1 customized`);
    expect(out).toContain(`* text #112233 (default #f5f5f5) — ${described('text')}`);
    // A token saved at its default is not customized.
    expect(out).toContain(`  detail #e291b5 — ${described('detail')}`);
    expect(out).toContain(`  color-node-doc #9ed4d1 — ${described('color-node-doc')}`);
    expect(out).toContain('— Activity Bar: Background of the narrow strip of icons');
    for (const token of workspaceColorTokens) expect(out).toContain(` ${token.name} `);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('reads a theme saved under old token names and ignores retired tokens', async () => {
    mockRows.set('appearance.colors', { canvas: '#0a0b0c' });
    expect(await run({ op: 'get' })).toContain('* disabled #0a0b0c (default #2a2a2a)');
  });

  it.each([{ colors: null }, { colors: {} }, { tokens: [] }, { tokens: null }, { colors: '' }])(
    'treats placeholder fields of other ops as left out: %j',
    async (placeholders) => {
      expect(await run({ op: 'get', ...placeholders })).toContain('Snaglet color theme');
    }
  );
});

describe('change_color_theme set', () => {
  it('merges one or more tokens into the saved theme, lowercased, attributed to the agent', async () => {
    mockRows.set('appearance.colors', { sidebar: '#eeeeee' });
    const out = await run(
      { op: 'set', colors: { text: '#ABCDEF', 'color-node-doc': '#123456' } },
      { agentId: 'agent-1' }
    );
    expect(saved()).toEqual({
      sidebar: '#eeeeee',
      text: '#abcdef',
      'color-node-doc': '#123456',
    });
    expect(mockWrite).toHaveBeenCalledWith('appearance', 'colors', saved(), {
      userId: null,
      agentId: 'agent-1',
    });
    expect(out).toContain('text #f5f5f5 → #abcdef');
    expect(out).toContain('color-node-doc #9ed4d1 → #123456');
    expect(out).toContain('Open Snaglet windows show it now.');
  });

  it('keeps the person as the author when they run it themselves, also as an agent', async () => {
    const person = { actorKind: 'user' as const, actorId: 'user-1', actorName: 'Test User' };
    await runWithActor(person, () =>
      run(
        { op: 'set', colors: { text: '#111111' } },
        { agentId: 'agent-1', bypassToolAccess: true }
      )
    );
    await runWithActor(person, () => run({ op: 'set', colors: { text: '#222222' } }));
    expect(mockWrite.mock.calls.map((call) => call[3])).toEqual([
      { userId: 'user-1', agentId: null },
      { userId: 'user-1', agentId: null },
    ]);
  });

  it('broadcasts settings:changed for appearance.colors on every write', async () => {
    await run({ op: 'set', colors: { detail: '#00aa88' } });
    expect(mockBroadcast).toHaveBeenCalledWith('settings', {
      type: 'settings:changed',
      payload: { category: 'appearance', key: 'colors' },
    });
    mockBroadcast.mockClear();
    await run({ op: 'reset' });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when any entry is bad, and names every bad entry and the valid tokens', async () => {
    mockRows.set('appearance.colors', { text: '#112233' });
    const error = run({
      op: 'set',
      colors: { text: '#445566', bogus: '#000000', detail: 'red', sidebar: '#abc' },
    });
    await expect(error).rejects.toThrow(/^Nothing changed\. unknown token: bogus/);
    await expect(error).rejects.toThrow('detail="red"');
    await expect(error).rejects.toThrow('sidebar="#abc" (write #aabbcc)');
    await expect(error).rejects.toThrow(
      `Valid tokens: ${Object.keys(defaultWorkspaceColors).join(', ')}.`
    );
    expect(saved()).toEqual({ text: '#112233' });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('ignores a placeholder tokens field', async () => {
    for (const tokens of [[], null]) {
      await run({ op: 'set', colors: { text: '#112233' }, tokens });
    }
    expect(saved()).toEqual({ text: '#112233' });
  });

  it('refuses a missing or empty colors map, filled-in fields of other ops and unknown ops', async () => {
    await expect(run({ op: 'set' })).rejects.toThrow('set needs colors');
    await expect(run({ op: 'set', colors: {} })).rejects.toThrow('set needs colors');
    await expect(run({ op: 'set', colors: null })).rejects.toThrow('set needs colors');
    await expect(run({ op: 'set', colors: { text: '#112233' }, tokens: ['text'] })).rejects.toThrow(
      'tokens is only for op reset'
    );
    await expect(run({ op: 'reset', colors: { text: '#112233' } })).rejects.toThrow(
      'colors is only for op set'
    );
    await expect(run({ op: 'get', tokens: ['text'] })).rejects.toThrow(
      'tokens is only for op reset'
    );
    await expect(run({ op: 'paint' })).rejects.toThrow('op must be get, set or reset');
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('change_color_theme reset', () => {
  it.each([{}, { tokens: null }, { tokens: [] }, { colors: {} }, { colors: null }])(
    'resets every token, listing each changed one with its old color: %j',
    async (fields) => {
      mockRows.set('appearance.colors', { text: '#112233', 'color-node-doc': '#123456' });
      const out = await run({ op: 'reset', ...fields });
      expect(saved()).toEqual({});
      expect(out).toBe(
        'Reset every color to its default; 2 tokens changed: text #112233 → #f5f5f5, ' +
          'color-node-doc #123456 → #9ed4d1. Open Snaglet windows show it now.'
      );
    }
  );

  it('can be undone with one set of the old colors it reports', async () => {
    const before = { text: '#112233', 'color-node-doc': '#123456', sidebar: '#eeeeee' };
    mockRows.set('appearance.colors', { ...before });
    const out = await run({ op: 'reset' });
    const old = Object.fromEntries(
      [...out.matchAll(/([a-z0-9-]+) (#[0-9a-f]{6}) → #[0-9a-f]{6}/g)].map((m) => [m[1], m[2]])
    );
    expect(old).toEqual(before);
    await run({ op: 'set', colors: old });
    expect(saved()).toEqual(before);
  });

  it('says so when every color is already the default, and saves no theme', async () => {
    expect(await run({ op: 'reset' })).toBe(
      'Every color was already its default; nothing changed.'
    );
    expect(saved()).toBeUndefined();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('drops a saved color on reset instead of pinning the default, so it follows later defaults', async () => {
    await run({ op: 'set', colors: { detail: '#00aa88' } });
    expect(saved()).toEqual({ detail: '#00aa88' });
    await run({ op: 'reset' });
    expect(saved()).not.toHaveProperty('detail');
    expect(await run({ op: 'get' })).toContain(`  detail ${defaultWorkspaceColors.detail} — `);
  });

  it('moves a theme an older reset pinned to old defaults onto the current ones', async () => {
    // What "Reset all" saved before resets removed colors: the old pink palette.
    mockRows.set('appearance.colors', { detail: '#fd3887', text: '#19141a' });
    const out = await run({ op: 'reset' });
    expect(saved()).toEqual({});
    expect(out).toContain(`detail #fd3887 → ${defaultWorkspaceColors.detail}`);
    expect(out).toContain(`text #19141a → ${defaultWorkspaceColors.text}`);
  });

  it('returns the whole theme to Soft Pastel Garden, the default', async () => {
    mockRows.set('appearance.colors', {
      background: '#ffffff',
      text: '#000000',
      selected: '#00ff00',
    });
    await run({ op: 'reset' });
    const out = await run({ op: 'get' });
    expect(out).toContain(`${workspaceColorTokens.length} tokens, 0 customized`);
    for (const [name, color] of Object.entries(defaultTheme))
      expect(out).toContain(`  ${name} ${color} — `);
  });

  it('resets only the listed tokens and keeps the rest', async () => {
    mockRows.set('appearance.colors', {
      text: '#112233',
      sidebar: '#eeeeee',
      'color-node-doc': '#123456',
    });
    const out = await run({ op: 'reset', tokens: ['text', 'color-node-doc', 'detail'] });
    expect(saved()).toEqual({ sidebar: '#eeeeee' });
    expect(out).toContain('text #112233 → #f5f5f5');
    expect(out).toContain('color-node-doc #123456 → #9ed4d1');
    expect(out).toContain('detail #e291b5 (already the default)');
  });

  it('refuses unknown tokens or a tokens field that is not a list, without writing', async () => {
    await expect(run({ op: 'reset', tokens: ['text', 'nope'] })).rejects.toThrow(
      /^Nothing changed\. unknown token: nope\. Valid tokens: /
    );
    await expect(run({ op: 'reset', tokens: 'text' })).rejects.toThrow('must be a list');
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('change_color_theme definition', () => {
  it('names every token in its schema and docs, needs no confirmation and stays off the core list', () => {
    const names = workspaceColorTokens.map((token) => token.name);
    const props = definition.parameters_schema.properties as Record<
      string,
      { enum?: string[]; properties?: Record<string, unknown>; items?: { enum?: string[] } }
    >;
    expect(definition.id).toBe('change_color_theme');
    expect(definition.name).toBe('Change color theme');
    expect(props.op?.enum).toEqual(['get', 'set', 'reset']);
    expect(Object.keys(props.colors?.properties ?? {})).toEqual(names);
    expect(props.tokens?.items?.enum).toEqual(names);
    expect(definition.tier).toBe('standard');
    expect(CORE_TOOL_IDS.has('change_color_theme')).toBe(false);
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toBeUndefined();
    const docs = readFileSync(path.join(TOOL_DIR, 'TOOL.md'), 'utf8');
    for (const name of names) expect(docs).toContain(`\`${name}\``);
    expect(docs).toContain('Settings → Theme');
  });

  it('tells the model in the schema what each token colors, from the shared palette', () => {
    const colors = (
      definition.parameters_schema.properties as Record<
        string,
        { properties?: Record<string, { type?: string; description?: string }> }
      >
    ).colors?.properties;
    for (const token of workspaceColorTokens) {
      expect(colors?.[token.name]).toEqual({
        type: 'string',
        description: `${token.label}: ${token.description}`,
      });
    }
    expect(colors?.['activity-bar']?.description).toMatch(/^Activity Bar: .*far left edge/);
  });
});
