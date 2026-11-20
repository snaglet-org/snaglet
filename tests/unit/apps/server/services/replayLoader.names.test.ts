/**
 * buildReplayPayload names teammates always, and people only in a group thread
 * (more than one agent, or more than one person); a 1:1 thread keeps the
 * person's messages plain.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const listMessages = jest.fn<() => Promise<unknown[]>>();
const listParticipants = jest.fn<() => Promise<unknown[]>>();
const findUser = jest.fn<(id: string) => Promise<{ name: string } | null>>();
const findAgent = jest.fn<(id: string) => Promise<{ name: string } | null>>();

jest.mock('@snaglet/db/db', () => ({ getDb: jest.fn(), transaction: jest.fn() }));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listByThreadId: () => listMessages() },
}));
jest.mock('@snaglet/db/tables/runs', () => ({ Runs: { listByThreadId: async () => [] } }));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { getByThreadId: async () => [] },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { listByThread: () => listParticipants() },
}));
jest.mock('@snaglet/db/tables/users', () => ({
  Users: { findById: (id: string) => findUser(id) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (id: string) => findAgent(id) },
}));

import { buildReplayPayload } from '@server/services/SocketService/handlers/chatPhases/replayLoader';

const row = (over: Record<string, unknown>) => ({
  id: 'm',
  threadId: 't',
  agentId: null,
  userId: null,
  role: 'user',
  content: '',
  runId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  injectedDuringRun: false,
  externalSenderLabel: null,
  messageType: 'message',
  visibleToAgentId: null,
  ...over,
});

const person = (userId: string) => ({ agentId: null, userId });
const agent = (agentId: string) => ({ agentId, userId: null });

beforeEach(() => {
  listMessages.mockReset();
  listParticipants.mockReset();
  findUser.mockReset();
  findAgent.mockReset();
  findUser.mockImplementation(async (id) => ({ name: id === 'u1' ? 'Test User' : 'Sam' }));
  findAgent.mockImplementation(async (id) => ({ name: id === 'bo' ? 'Bo' : 'Ada' }));
  listMessages.mockResolvedValue([
    row({ id: 'm1', userId: 'u1', content: '@Ada @Bo go' }),
    row({
      id: 'm2',
      role: 'assistant',
      agentId: 'bo',
      content: 'on it',
      createdAt: '2026-10-20T10:00:05.000Z',
    }),
  ]);
});

describe('buildReplayPayload — who is named', () => {
  it('group (two agents): the person and the teammate are both named', async () => {
    listParticipants.mockResolvedValue([agent('ada'), agent('bo'), person('u1')]);
    const { messages } = await buildReplayPayload('t', 'ada');
    expect(messages.map((m) => m.content)).toEqual([
      '[message from Test User] @Ada @Bo go',
      '[message from Bo] on it',
    ]);
  });

  it('group (two people, one agent): the people are named', async () => {
    listParticipants.mockResolvedValue([agent('ada'), person('u1'), person('u2')]);
    const { messages } = await buildReplayPayload('t', 'ada');
    expect(messages[0]!.content).toBe('[message from Test User] @Ada @Bo go');
  });

  it('1:1 (one agent, one person): the person stays plain', async () => {
    listParticipants.mockResolvedValue([agent('ada'), person('u1')]);
    const { messages } = await buildReplayPayload('t', 'ada');
    expect(messages[0]!.content).toBe('@Ada @Bo go');
    expect(findUser).not.toHaveBeenCalled();
  });

  it('a failed roster lookup leaves people plain instead of failing the turn', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    listParticipants.mockRejectedValue(new Error('db down'));
    const { messages } = await buildReplayPayload('t', 'ada');
    expect(messages[0]!.content).toBe('@Ada @Bo go');
    warn.mockRestore();
  });

  it('a missing user name falls back to "user"', async () => {
    findUser.mockResolvedValue(null);
    listParticipants.mockResolvedValue([agent('ada'), agent('bo')]);
    const { messages } = await buildReplayPayload('t', 'ada');
    expect(messages[0]!.content).toBe('[message from user] @Ada @Bo go');
  });
});
