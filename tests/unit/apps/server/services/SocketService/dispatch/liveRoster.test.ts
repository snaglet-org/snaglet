/**
 * liveRoster: a running dispatch re-reads the thread's agents only after an
 * agent joined or left (rosterVersion), with the same rules the dispatch
 * started with (archived agents out, the tool path's sender out).
 */
const mockListByThread = jest.fn();
const mockFindByIds = jest.fn();
const mockAgentGet = jest.fn();

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: (...args: unknown[]) => mockListByThread(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findByIds: (...args: unknown[]) => mockFindByIds(...args) },
}));
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...args: unknown[]) => mockAgentGet(...args) },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: { socket: { event: jest.fn() }, warn: jest.fn() },
}));

import { createLiveRoster } from '@server/services/SocketService/dispatch/liveRoster';
import {
  markThreadRosterChanged,
  threadRosterVersion,
} from '@server/services/SocketService/dispatch/rosterVersion';

const NAMES: Record<string, string> = {
  'agent-lead': 'Lead',
  'agent-nova': 'Nova',
  'agent-orion': 'Orion',
  'agent-old': 'Old',
};
const row = (agentId: string) => ({ id: `tp-${agentId}`, kind: 'agent', agentId });
const person = { id: 'tp-user', kind: 'user', agentId: null, userId: 'user-1' };

let threadSeq = 0;
function newThread(): string {
  threadSeq += 1;
  return `thread-roster-${threadSeq}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, archived: id === 'agent-old' }))
  );
  mockAgentGet.mockImplementation(async (id: string) =>
    NAMES[id] ? { id, name: NAMES[id], role: `${NAMES[id]} role` } : undefined
  );
});

describe('createLiveRoster', () => {
  it('does not query while the thread roster is unchanged', async () => {
    const roster = createLiveRoster({
      threadId: newThread(),
      ids: ['agent-lead'],
      names: new Map(),
      roles: new Map(),
    });
    await roster.refreshIfChanged();
    await roster.refreshIfChanged();
    expect(mockListByThread).not.toHaveBeenCalled();
    expect(roster.ids).toEqual(['agent-lead']);
    expect(roster.isGroup).toBe(false);
  });

  it('after an agent joins, re-reads once: the joiner resolves, is named, and the room is a group', async () => {
    const threadId = newThread();
    const names = new Map<string, string>();
    const roles = new Map<string, string>();
    const roster = createLiveRoster({ threadId, ids: ['agent-lead'], names, roles });

    mockListByThread.mockResolvedValue([row('agent-lead'), row('agent-nova'), person]);
    markThreadRosterChanged(threadId);
    await roster.refreshIfChanged();
    await roster.refreshIfChanged();

    expect(mockListByThread).toHaveBeenCalledTimes(1);
    expect(roster.ids).toEqual(['agent-lead', 'agent-nova']);
    expect(roster.isGroup).toBe(true);
    expect(roster.resolve('AGENT-NOVA')).toBe('agent-nova');
    expect(names.get('agent-nova')).toBe('Nova');
    expect(names.get('agent-lead')).toBe('Lead');
    expect(roles.get('agent-nova')).toBe('Nova role');
  });

  it('after an agent leaves, it no longer resolves, but its name stays for the skipped notice', async () => {
    const threadId = newThread();
    const names = new Map([
      ['agent-lead', 'Lead'],
      ['agent-nova', 'Nova'],
    ]);
    const roster = createLiveRoster({
      threadId,
      ids: ['agent-lead', 'agent-nova'],
      names,
      roles: new Map(),
    });

    mockListByThread.mockResolvedValue([row('agent-lead'), person]);
    markThreadRosterChanged(threadId);
    await roster.refreshIfChanged();

    expect(roster.ids).toEqual(['agent-lead']);
    expect(roster.resolve('agent-nova')).toBeUndefined();
    expect(roster.isGroup).toBe(false);
    expect(names.get('agent-nova')).toBe('Nova');
  });

  it('keeps archived agents and the excluded sender out, as the start did', async () => {
    const threadId = newThread();
    const roster = createLiveRoster({
      threadId,
      ids: ['agent-lead'],
      names: new Map(),
      roles: new Map(),
      excludeAgentId: 'agent-orion',
    });

    mockListByThread.mockResolvedValue([
      row('agent-lead'),
      row('agent-orion'),
      row('agent-old'),
      row('agent-nova'),
    ]);
    markThreadRosterChanged(threadId);
    await roster.refreshIfChanged();

    expect(roster.ids).toEqual(['agent-lead', 'agent-nova']);
  });

  it('parallel turns share one read', async () => {
    const threadId = newThread();
    const roster = createLiveRoster({
      threadId,
      ids: ['agent-lead'],
      names: new Map(),
      roles: new Map(),
    });
    mockListByThread.mockResolvedValue([row('agent-lead'), row('agent-nova')]);
    markThreadRosterChanged(threadId);

    await Promise.all([roster.refreshIfChanged(), roster.refreshIfChanged()]);

    expect(mockListByThread).toHaveBeenCalledTimes(1);
    expect(roster.ids).toEqual(['agent-lead', 'agent-nova']);
  });

  it('keeps the roster it has when the read fails, and retries on the next refresh', async () => {
    const threadId = newThread();
    const roster = createLiveRoster({
      threadId,
      ids: ['agent-lead', 'agent-nova'],
      names: new Map(),
      roles: new Map(),
    });
    mockListByThread.mockRejectedValueOnce(new Error('db down'));
    markThreadRosterChanged(threadId);

    await roster.refreshIfChanged();
    expect(roster.ids).toEqual(['agent-lead', 'agent-nova']);
    expect(mockListByThread).toHaveBeenCalledTimes(1);

    mockListByThread.mockResolvedValue([row('agent-lead')]);
    await roster.refreshIfChanged();
    expect(roster.ids).toEqual(['agent-lead']);
    expect(mockListByThread).toHaveBeenCalledTimes(2);
    // Read once it succeeded: no further reads until the next change.
    await roster.refreshIfChanged();
    expect(mockListByThread).toHaveBeenCalledTimes(2);
  });

  it('a change between the dispatch’s first read and its start is not lost', async () => {
    const threadId = newThread();
    // The version is taken just before the first roster read…
    const versionAtRead = threadRosterVersion(threadId);
    // …an agent joins before the dispatch builds its roster…
    markThreadRosterChanged(threadId);
    mockListByThread.mockResolvedValue([row('agent-lead'), row('agent-nova')]);
    const roster = createLiveRoster({
      threadId,
      ids: ['agent-lead'],
      names: new Map(),
      roles: new Map(),
      version: versionAtRead,
    });
    // …and the first refresh picks it up.
    await roster.refreshIfChanged();
    expect(roster.ids).toEqual(['agent-lead', 'agent-nova']);
  });

  it('copies the starting ids instead of changing the caller’s array', async () => {
    const threadId = newThread();
    const start = ['agent-lead'];
    const roster = createLiveRoster({ threadId, ids: start, names: new Map(), roles: new Map() });
    mockListByThread.mockResolvedValue([row('agent-lead'), row('agent-nova')]);
    markThreadRosterChanged(threadId);
    await roster.refreshIfChanged();
    expect(start).toEqual(['agent-lead']);
  });
});

describe('rosterVersion', () => {
  it('starts at 0 and goes up per change, per thread', () => {
    const a = newThread();
    const b = newThread();
    expect(threadRosterVersion(a)).toBe(0);
    markThreadRosterChanged(a);
    markThreadRosterChanged(a);
    expect(threadRosterVersion(a)).toBe(2);
    expect(threadRosterVersion(b)).toBe(0);
  });
});
