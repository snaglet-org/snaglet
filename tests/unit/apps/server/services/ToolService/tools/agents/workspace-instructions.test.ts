/**
 * workspace_instructions — get and set over the real settings service and the
 * `agent.global_instructions` schema, with the settings row in memory: get
 * returns the text and the limit, set replaces the text whole and returns the
 * previous text, a text over the limit changes nothing, authorship, the
 * `settings:changed` event Home follows, and that set is the one op that asks
 * a person first.
 */
const mockRows = new Map<string, unknown>();
const mockWrite = jest.fn();
const mockBroadcast = jest.fn();

jest.mock('@snaglet/db/tables/settings', () => ({
  Settings: {
    read: async (category: string, key: string) =>
      mockRows.has(`${category}.${key}`)
        ? { category, key, value: mockRows.get(`${category}.${key}`) }
        : null,
    write: async (category: string, key: string, value: unknown, actor: unknown) => {
      mockRows.set(`${category}.${key}`, value);
      mockWrite(category, key, value, actor);
    },
  },
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => mockBroadcast(...args) },
}));

import tool from '@server/services/ToolService/tools/agents/workspace-instructions/tool';
import definition from '@server/services/ToolService/tools/agents/workspace-instructions/definition';
import { settingsService } from '@server/services/settings';
import { initSettingsSurface } from '@server/realtime/surfaces/settings';
import { runWithActor } from '@server/realtime/actorContext';
import { AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@snaglet/shared/constants';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

const KEY = 'agent.global_instructions';
const run = async (input: Record<string, unknown>, context?: ToolHandlerContext) =>
  JSON.parse(String(await tool(input, {}, context))) as Record<string, unknown>;

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

describe('workspace_instructions get', () => {
  it('returns the saved text, its length and the limit, and writes nothing', async () => {
    mockRows.set(KEY, 'Keep answers short.');
    expect(await run({ op: 'get' })).toEqual({
      text: 'Keep answers short.',
      length: 19,
      limit: AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH,
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns an empty text when nothing is saved', async () => {
    expect(await run({ op: 'get' })).toMatchObject({ text: '', length: 0 });
  });
});

describe('workspace_instructions set', () => {
  it('replaces the text whole, attributed to the agent, and returns the previous text', async () => {
    mockRows.set(KEY, 'Keep answers short.');
    const out = await run(
      { op: 'set', text: 'Keep answers short.\nUse metric units.' },
      { agentId: 'patty' }
    );
    expect(mockRows.get(KEY)).toBe('Keep answers short.\nUse metric units.');
    expect(mockWrite).toHaveBeenCalledWith(
      'agent',
      'global_instructions',
      'Keep answers short.\nUse metric units.',
      { agentId: 'patty' }
    );
    expect(out).toMatchObject({ saved: true, length: 37, previous: 'Keep answers short.' });
  });

  it('clears the text with an empty string', async () => {
    mockRows.set(KEY, 'Old text');
    expect(await run({ op: 'set', text: '' }, { agentId: 'patty' })).toMatchObject({
      previous: 'Old text',
      length: 0,
    });
    expect(mockRows.get(KEY)).toBe('');
  });

  it('accepts a text at the limit and refuses one over it, changing nothing', async () => {
    const atLimit = 'a'.repeat(AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH);
    await run({ op: 'set', text: atLimit }, { agentId: 'patty' });
    expect(mockRows.get(KEY)).toBe(atLimit);
    mockWrite.mockClear();
    await expect(run({ op: 'set', text: `${atLimit}b` }, { agentId: 'patty' })).rejects.toThrow(
      `Nothing changed: the text is ${AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH + 1} characters and the limit is ${AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH}`
    );
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRows.get(KEY)).toBe(atLimit);
  });

  it('refuses a set without text, and an unknown op', async () => {
    await expect(run({ op: 'set' })).rejects.toThrow('set needs text');
    await expect(run({ op: 'append', text: 'x' })).rejects.toThrow('op must be get or set');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('keeps the person as the author when they run it themselves', async () => {
    const person = { actorKind: 'user' as const, actorId: 'user-1', actorName: 'Test User' };
    await runWithActor(person, () =>
      run({ op: 'set', text: 'Be brief.' }, { agentId: 'patty', bypassToolAccess: true })
    );
    expect(mockWrite).toHaveBeenCalledWith('agent', 'global_instructions', 'Be brief.', {
      userId: 'user-1',
    });
  });

  it('tells open windows the setting changed', async () => {
    await run({ op: 'set', text: 'Be brief.' }, { agentId: 'patty' });
    expect(mockBroadcast).toHaveBeenCalledWith('settings', {
      type: 'settings:changed',
      payload: { category: 'agent', key: 'global_instructions' },
    });
  });
});

describe('workspace_instructions definition', () => {
  it('marks set, and only set, as the op that asks a person first', () => {
    expect(definition.id).toBe('workspace_instructions');
    expect(definition.destructiveOps).toEqual(['set']);
    expect(definition.parameters_schema).toMatchObject({
      properties: { op: { enum: ['get', 'set'] } },
    });
    expect(definition.description).toMatch(/show the person the exact new text/);
    expect(definition.description).toMatch(/Never put secrets/);
  });
});
