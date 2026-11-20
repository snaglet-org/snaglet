/**
 * memoryRecallSegment — automatic memory injection for the ephemeral
 * turn-context tail. Gated on the agent having `memory_`-prefixed tools; the
 * query is the thread title + the latest message not written by this agent;
 * the relevance floor (memoryRecallFloor.ts) injects only standouts (a flat
 * band gives no block); at most 5 entries, each truncated, with age and owner
 * attribution; recall/DB failure → null + a warning, never a throw; and the
 * segment rides the ephemeral tail with no persistence identity. In a thread
 * with one human, that person's kept facts join the same recall and render as
 * "about <name>".
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { MemorySearchResult } from '@snaglet/db/tables/memories';

const recall = jest.fn<(input: unknown) => Promise<MemorySearchResult[]>>();
const getRecentDescending = jest.fn<(threadId: string, limit: number) => Promise<unknown[]>>();
const resolveScope =
  jest.fn<(threadId: string, query: string) => Promise<{ allowedProjectIds: string[] } | null>>();
const warn = jest.fn();
const resolveMemberId = jest.fn<(threadId: string) => Promise<string | null>>();
const resolveMemberName = jest.fn<(memberId: string) => Promise<string | null>>();

jest.mock('@server/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('@server/services/MemoryService', () => ({
  memoryService: {
    recall: (...args: unknown[]) => recall(...(args as [unknown])),
  },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    getRecentDescending: (...args: unknown[]) => getRecentDescending(...(args as [string, number])),
  },
}));
jest.mock('@server/services/summary/threadHuman', () => ({
  resolveProposalMemberId: (...args: unknown[]) => resolveMemberId(...(args as [string])),
  resolveMemberName: (...args: unknown[]) => resolveMemberName(...(args as [string])),
}));
jest.mock('@server/services/summary/memoryRecallScope', () => ({
  resolveMemoryRecallProjectScope: (...args: unknown[]) =>
    resolveScope(...(args as [string, string])),
}));

import {
  buildMemoryRecallSegment,
  findInboundMessage,
  formatMemoryAge,
  renderMemoryLine,
  MEMORY_RECALL_CAP,
  MEMORY_RECALL_ENTRY_MAX_CHARS,
  MEMORY_RECALL_HEADER,
} from '@server/services/summary/memoryRecallSegment';
import { buildTurnContextMessage } from '@server/services/SystemPromptComposer/composeTurnContextTail';

const DAY_MS = 86_400_000;

function memory(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    id: 'memory-1',
    agentId: 'agent-1',
    memberId: null,
    key: 'psql-vars',
    content: 'psql -c does not interpolate variables',
    sourceThreadId: null,
    createdAt: new Date(Date.now() - 34 * DAY_MS).toISOString(),
    updatedAt: new Date(Date.now() - 34 * DAY_MS).toISOString(),
    combinedScore: 0.5,
    vectorScore: 0.8,
    keywordScore: 0,
    ...overrides,
  };
}

/** A message row as getRecentDescending returns it (newest first). */
function inbound(
  content: string,
  overrides: { agentId?: string | null; userId?: string | null; messageType?: string } = {}
) {
  return { content, agentId: null, userId: null, messageType: 'message', ...overrides };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    agentName: 'venus',
    threadId: 'thread-1',
    threadTitle: 'Postgres ops',
    hasMemoryTools: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getRecentDescending.mockResolvedValue([
    inbound('How do I pass a variable to psql?', { userId: 'user-1' }),
  ]);
  recall.mockResolvedValue([]);
  resolveScope.mockResolvedValue(null);
  resolveMemberId.mockResolvedValue(null);
  resolveMemberName.mockResolvedValue(null);
});

describe('gating', () => {
  it('injects nothing for an agent without memory tools — recall is never called', async () => {
    const out = await buildMemoryRecallSegment(baseInput({ hasMemoryTools: false }));
    expect(out).toBeNull();
    expect(recall).not.toHaveBeenCalled();
    expect(getRecentDescending).not.toHaveBeenCalled();
  });

  it('injects nothing when there is no inbound context to query with', async () => {
    getRecentDescending.mockResolvedValue([]);
    const out = await buildMemoryRecallSegment(baseInput({ threadTitle: null }));
    expect(out).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it('queries with the latest inbound message plus the thread title', async () => {
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        threadId: 'thread-1',
        query: 'Postgres ops\nHow do I pass a variable to psql?',
      })
    );
  });
});

describe('inbound query', () => {
  it("skips the agent's own replies and thread events, querying with the latest inbound message", async () => {
    getRecentDescending.mockResolvedValue([
      inbound('Both steps are done; send me the hash.', { agentId: 'agent-1' }),
      inbound('roster changed', { messageType: 'thread_event' }),
      inbound('Please split out the floor row.', { userId: 'user-1' }),
      inbound('older user message', { userId: 'user-1' }),
    ]);
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Postgres ops\nPlease split out the floor row.' })
    );
  });

  it("another agent's message counts as inbound", async () => {
    getRecentDescending.mockResolvedValue([
      inbound('Clio: shell slice landed', { agentId: 'agent-clio' }),
    ]);
    expect(await findInboundMessage('thread-1', 'agent-1')).toMatchObject({
      content: 'Clio: shell slice landed',
    });
  });

  it("falls back to the agent's own latest message when nothing inbound exists", async () => {
    getRecentDescending.mockResolvedValue([
      inbound('my own reply', { agentId: 'agent-1' }),
      inbound('thread started', { messageType: 'thread_event' }),
    ]);
    expect(await findInboundMessage('thread-1', 'agent-1')).toMatchObject({
      content: 'my own reply',
    });
  });
});

describe('relevance floor wiring', () => {
  it('a flat band of candidates → no block, not five least-irrelevant memories', async () => {
    recall.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        memory({ id: `m${i}`, content: `generic ${i}`, vectorScore: 0.66 + i * 0.005 })
      )
    );
    expect(await buildMemoryRecallSegment(baseInput())).toBeNull();
  });

  it('only the standout is injected, in recall order', async () => {
    recall.mockResolvedValue([
      memory({ id: 'm0', content: 'the standout', vectorScore: 0.75 }),
      ...Array.from({ length: 9 }, (_, i) =>
        memory({ id: `n${i}`, content: `noise ${i}`, vectorScore: 0.5 + i * 0.01 })
      ),
    ]);
    const out = await buildMemoryRecallSegment(baseInput());
    expect(out).toContain('the standout');
    expect(out).not.toContain('noise');
  });
});

describe('cap and truncation', () => {
  it('caps at 5 entries, hard', async () => {
    recall.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) =>
        memory({ id: `m${i}`, content: `admissible memory number ${i}`, vectorScore: 0.8 })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        memory({ id: `n${i}`, content: `noise ${i}`, vectorScore: 0.4 })
      ),
    ]);
    const out = await buildMemoryRecallSegment(baseInput());
    const lines = out!.split('\n').filter((l) => l.startsWith('· '));
    expect(lines).toHaveLength(MEMORY_RECALL_CAP);
    expect(out).toContain('admissible memory number 4');
    expect(out).not.toContain('admissible memory number 5');
  });

  it('truncates long content with … and collapses newlines to one line per memory', async () => {
    const long = `first line\nsecond line ${'x'.repeat(600)}`;
    recall.mockResolvedValue([memory({ content: long })]);
    const out = await buildMemoryRecallSegment(baseInput());
    const line = out!.split('\n').find((l) => l.startsWith('· '))!;
    expect(line).toContain('first line second line');
    expect(line).toContain('…');
    // Content budget: the rendered content portion stays within the cap
    // (+ attribution suffix), and the raw 600-run never appears whole.
    expect(line).not.toContain('x'.repeat(300));
    expect(line.length).toBeLessThan(MEMORY_RECALL_ENTRY_MAX_CHARS + 40);
  });
});

describe('age + owner attribution', () => {
  it('formats age compactly', () => {
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    const at = (days: number) => new Date(now - days * DAY_MS).toISOString();
    expect(formatMemoryAge(at(0), now)).toBe('today');
    expect(formatMemoryAge(at(34), now)).toBe('34d ago');
    expect(formatMemoryAge(at(91), now)).toBe('3mo ago');
    expect(formatMemoryAge(at(731), now)).toBe('2y ago');
    expect(formatMemoryAge('not-a-date', now)).toBeNull();
  });

  it('renders one line per memory in the documented shape', () => {
    const now = Date.now();
    const line = renderMemoryLine(
      memory({ createdAt: new Date(now - 34 * DAY_MS).toISOString() }),
      'venus',
      now
    );
    expect(line).toBe('· psql -c does not interpolate variables (venus, 34d ago)');
  });

  it('omits the age (not NaN) when createdAt is unparseable, and falls back to agentId as owner', async () => {
    recall.mockResolvedValue([memory({ createdAt: 'garbage' })]);
    const out = await buildMemoryRecallSegment(baseInput({ agentName: '  ' }));
    expect(out).toContain('(agent-1)');
    expect(out).not.toContain('NaN');
  });
});

describe('failure never breaks the turn', () => {
  it('recall throwing (embedding provider down) → null + logged', async () => {
    recall.mockRejectedValue(new Error('embedding provider down'));
    const out = await buildMemoryRecallSegment(baseInput());
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('buildMemoryRecallSegment failed'),
      expect.objectContaining({ agentId: 'agent-1', err: 'embedding provider down' })
    );
  });

  it('the inbound-message read throwing → null + logged', async () => {
    getRecentDescending.mockRejectedValue(new Error('db gone'));
    const out = await buildMemoryRecallSegment(baseInput());
    expect(out).toBeNull();
    expect(recall).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ephemeral tail placement', () => {
  it('rides the ephemeral turn-context message, not a durable message row', async () => {
    recall.mockResolvedValue([memory()]);
    const segment = await buildMemoryRecallSegment(baseInput());
    // The runtime folds the segment into turnContextData, which is wrapped by
    // buildTurnContextMessage — the one structurally `ephemeral: true` user
    // message that anthropicMessagePrep keeps behind the durable cache
    // breakpoint (never persisted, never replayed).
    const msg = buildTurnContextMessage(['**Your current coordinates:**\n- Thread: `t`', segment]);
    expect(msg).not.toBeNull();
    expect(msg!.ephemeral).toBe(true);
    expect(msg!.role).toBe('user');
    expect(msg!.content).toContain(MEMORY_RECALL_HEADER);
    expect(msg!.content).toContain('psql -c does not interpolate variables');
    // Same no-persistence-identity assertion the tail tests make: no id, no
    // runId, no message_type — it cannot be written as a message row.
    expect(Object.keys(msg!).sort()).toEqual(['content', 'ephemeral', 'role']);
  });

  it('an empty recall leaves the tail exactly as it was — no phantom block', async () => {
    recall.mockResolvedValue([]);
    const segment = await buildMemoryRecallSegment(baseInput());
    expect(segment).toBeNull();
    const without = buildTurnContextMessage(['coordinates data']);
    const withNull = buildTurnContextMessage(['coordinates data', segment]);
    expect(withNull!.content).toBe(without!.content);
  });
});

describe('framing', () => {
  it('frames the block as recalled memories in a one-line header', async () => {
    recall.mockResolvedValue([memory()]);
    const out = await buildMemoryRecallSegment(baseInput());
    const [header] = out!.split('\n');
    expect(header).toBe(MEMORY_RECALL_HEADER);
    expect(header).toContain('**Recalled memories** for this turn');
    // Own memories and the person's kept facts, told apart by the marker.
    expect(header).toContain('your own');
    expect(header).toContain('facts the person you work with kept about themselves');
    expect(header).toContain('"about <name>"');
    expect(header).not.toContain('your own saved memories');
  });

  it('leaves how to read a recalled memory to the cached Memory section, not every tail', async () => {
    // Reading a recalled memory and fixing one's own are said once, in the cached
    // system prompt (perceptionBlock Memory), which agents with recall hold.
    expect(MEMORY_RECALL_HEADER).not.toMatch(/premise|verify|update or delete/);
    const { perceptionBlock } =
      await import('@server/services/SystemPromptComposer/blocks/perceptionBlock');
    const block = await perceptionBlock({
      agentTools: [{ tool: { id: 'memory' } }],
    } as never);
    expect(block?.text).toContain('Recalled memories may be stale.');
    expect(block?.text).toContain('correct or delete stale memories of your own');
  });
});

describe("the thread human's kept facts", () => {
  const fact = (overrides: Partial<MemorySearchResult> = {}) =>
    memory({
      id: 'memory-fact',
      agentId: null,
      memberId: 'member-1',
      key: 'user.timezone',
      content: 'Works from Pacific time',
      ...overrides,
    });

  it('a thread with one human: recall also searches that member, in the same call', async () => {
    resolveMemberId.mockResolvedValue('member-1');
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    expect(resolveMemberId).toHaveBeenCalledWith('thread-1');
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', alsoMemberId: 'member-1' })
    );
  });

  it('no single human: recall is the agent alone (no alsoMemberId key)', async () => {
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    const arg = recall.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('alsoMemberId');
  });

  it("renders the person's facts as about them and the agent's own under its name", async () => {
    resolveMemberId.mockResolvedValue('member-1');
    resolveMemberName.mockResolvedValue('Test Person');
    recall.mockResolvedValue([memory(), fact()]);
    const out = await buildMemoryRecallSegment(baseInput());
    const lines = out!.split('\n').filter((l) => l.startsWith('· '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^· psql -c does not interpolate variables \(venus, 34d ago\)$/);
    expect(lines[1]).toMatch(/^· Works from Pacific time \(about Test Person, 34d ago\)$/);
    expect(resolveMemberName).toHaveBeenCalledWith('member-1');
  });

  it('falls back to "the user" when the person has no name', async () => {
    resolveMemberId.mockResolvedValue('member-1');
    recall.mockResolvedValue([fact()]);
    const out = await buildMemoryRecallSegment(baseInput());
    expect(out).toContain('(about the user, 34d ago)');
  });

  it("does not look the name up when none of the admitted rows are the person's", async () => {
    resolveMemberId.mockResolvedValue('member-1');
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    expect(resolveMemberName).not.toHaveBeenCalled();
  });

  it("resolving the human failing still recalls the agent's own memories", async () => {
    resolveMemberId.mockRejectedValue(new Error('db down'));
    recall.mockResolvedValue([memory()]);
    const out = await buildMemoryRecallSegment(baseInput());
    expect(recall).toHaveBeenCalledTimes(1);
    const arg = recall.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('alsoMemberId');
    expect(out).toContain('psql -c does not interpolate variables (venus, 34d ago)');
  });
});

describe('project scope', () => {
  it('flat thread → recall is unscoped (no projectScope key)', async () => {
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    expect(resolveScope).toHaveBeenCalledWith(
      'thread-1',
      'Postgres ops\nHow do I pass a variable to psql?'
    );
    const arg = recall.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('projectScope');
  });

  it('project thread → the resolved project family is passed to recall', async () => {
    resolveScope.mockResolvedValue({ allowedProjectIds: ['proj-parent', 'proj-child'] });
    recall.mockResolvedValue([memory()]);
    await buildMemoryRecallSegment(baseInput());
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        projectScope: { allowedProjectIds: ['proj-parent', 'proj-child'] },
      })
    );
  });

  it('scope resolution failing → null + logged, recall never runs unscoped', async () => {
    resolveScope.mockRejectedValue(new Error('db down'));
    const out = await buildMemoryRecallSegment(baseInput());
    expect(out).toBeNull();
    expect(recall).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
