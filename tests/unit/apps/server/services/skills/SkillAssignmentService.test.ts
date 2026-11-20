/**
 * SkillAssignmentService with built-in skills in the registry: a built-in id
 * sent in a write is ignored (not an error), and no list returned to the UI
 * ever holds one. The DB models are stubbed in memory.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SkillAssignmentRow, SkillMode, SkillRegistryRow } from '@snaglet/db';

function reg(id: string, scope: SkillRegistryRow['scope'], slug = id): SkillRegistryRow {
  return {
    id,
    scope,
    projectId: null,
    slug,
    name: slug,
    description: '',
    sourcePath: `/s/${slug}/SKILL.md`,
    contentHash: null,
    status: 'valid',
    error: null,
    indexedAt: '',
    createdAt: '',
    updatedAt: '',
  };
}

const registry = [
  reg('mine', 'personal'),
  reg('other', 'personal'),
  reg('override', 'personal', 'snaglet-search'),
  reg('b-search', 'builtin', 'snaglet-search'),
  reg('b-dms', 'builtin', 'snaglet-agent-collab'),
];

/** Assignment rows keyed by `${agentId}|${threadId ?? ''}`. */
const store = new Map<string, string[]>();
const key = (agentId: string, threadId: string | null) => `${agentId}|${threadId ?? ''}`;
const toRows = (agentId: string, threadId: string | null): SkillAssignmentRow[] =>
  (store.get(key(agentId, threadId)) ?? []).map((skillId, i) => ({
    id: `a${i}`,
    agentId,
    skillId,
    threadId,
    createdAt: '',
  }));
let mode: SkillMode = 'inherit';

const mockReplace = jest.fn(
  async (agentId: string, threadId: string | null, ids: readonly string[]) => {
    store.set(key(agentId, threadId), [...ids]);
    return toRows(agentId, threadId);
  }
);

jest.mock('@snaglet/db', () => ({
  SkillRegistry: { listAll: async () => registry },
  SkillAssignments: {
    listForAgent: async (agentId: string, threadId: string | null) => toRows(agentId, threadId),
    replace: (agentId: string, threadId: string | null, ids: readonly string[]) =>
      mockReplace(agentId, threadId, ids),
    getMode: async () => mode,
    setMode: async (_t: string, _a: string, m: SkillMode) => {
      mode = m;
      return true;
    },
  },
  Threads: { findById: async (id: string) => (id === 't1' ? { id } : null) },
}));

const mockEmit = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (event: unknown) => mockEmit(event),
}));

import { SkillAssignmentService } from '@server/services/skills/SkillAssignmentService';

beforeEach(() => {
  store.clear();
  mode = 'inherit';
  mockReplace.mockClear();
  mockEmit.mockReset();
});

describe('SkillAssignmentService realtime', () => {
  // The agent pane's Skills section follows a change made by an agent's tool
  // or another window. Skills live outside the agent row, so the event has
  // no revision.
  it('replaceGeneral announces agent.updated naming skills when the set changed', async () => {
    store.set(key('agent', null), ['mine']);
    await SkillAssignmentService.replaceGeneral('agent', ['mine', 'other']);
    expect(mockEmit.mock.calls).toEqual([
      [{ type: 'agent.updated', agentId: 'agent', changed: ['skills'] }],
    ]);
  });

  it('replaceGeneral stays quiet when the same set is saved again, in any order', async () => {
    store.set(key('agent', null), ['mine', 'other']);
    await SkillAssignmentService.replaceGeneral('agent', ['other', 'mine', 'b-search']);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('thread picks are not the agent’s general set and announce nothing', async () => {
    await SkillAssignmentService.updateThread('t1', 'agent', { skillIds: ['other'] });
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('SkillAssignmentService and built-in skills', () => {
  it('replaceGeneral ignores built-in ids instead of failing, and never returns one', async () => {
    const saved = await SkillAssignmentService.replaceGeneral('agent', ['mine', 'b-search']);
    expect(saved).toEqual(['mine']);
    expect(mockReplace).toHaveBeenCalledWith('agent', null, ['mine']);
  });

  it('a personal skill with a built-in slug is the user’s and is kept', async () => {
    expect(await SkillAssignmentService.replaceGeneral('agent', ['override'])).toEqual([
      'override',
    ]);
  });

  it('still refuses unknown ids, writing nothing', async () => {
    await expect(
      SkillAssignmentService.replaceGeneral('agent', ['b-search', 'nope'])
    ).rejects.toThrow('Unknown skill id(s): nope');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('listGeneral leaves out a built-in assigned before this rule', async () => {
    store.set(key('agent', null), ['b-dms', 'mine']);
    expect(await SkillAssignmentService.listGeneral('agent')).toEqual(['mine']);
  });

  it('thread state shows no built-in in picks, defaults or the resolved lists', async () => {
    store.set(key('agent', null), ['b-dms', 'mine']);
    store.set(key('agent', 't1'), ['b-search', 'other']);
    mode = 'add';
    const state = await SkillAssignmentService.getThreadState('t1', 'agent');
    expect(state.generalSkillIds).toEqual(['mine']);
    expect(state.threadSkillIds).toEqual(['other']);
    expect(state.resolved.effective.map((e) => e.skill.id)).toEqual(['mine', 'other']);
    expect(state.resolved.dropped).toEqual([]);
  });

  it('updateThread drops built-in picks and saves the rest', async () => {
    const state = await SkillAssignmentService.updateThread('t1', 'agent', {
      mode: 'override',
      skillIds: ['b-search', 'other'],
    });
    expect(mockReplace).toHaveBeenCalledWith('agent', 't1', ['other']);
    expect(state).toMatchObject({ mode: 'override', threadSkillIds: ['other'] });
  });
});
