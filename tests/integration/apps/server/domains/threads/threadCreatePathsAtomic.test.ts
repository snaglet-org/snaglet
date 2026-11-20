/**
 * The `thread` tool's create op and `socket:session:create` write the thread
 * and its first participants as one unit, like POST /api/threads
 * (threadCreateAtomic.test.ts). A failure injected into the last participant
 * write leaves no thread or earlier participant, and nothing is broadcast,
 * emitted or replied. On success events go out after the commit, in order: the
 * tool broadcasts workspace.created, then thread.created, then fires the
 * thread:create hook; the session handler fires the hook, then replies
 * socket:session:created (it never broadcasts). At each event a separate
 * connection already sees the whole roster. Socket fan-out and hooks are observed.
 */

import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

/** Every observed event, in call order (broadcasts, hook emit calls, replies). */
const mockEvents: Array<{ type: string; id: string | undefined }> = [];

// Records when a site calls emitThreadCreate (the builder runs async after
// it), then runs the real one, so its order against the synchronous
// broadcasts and replies is exact.
jest.mock('@server/services/customHooks/threadCreateEvent', () => {
  const actual = jest.requireActual<{
    emitThreadCreate: (threadId: string, ...rest: unknown[]) => void;
  }>('@server/services/customHooks/threadCreateEvent');
  return {
    ...actual,
    emitThreadCreate: (threadId: string, ...rest: unknown[]) => {
      mockEvents.push({ type: 'emitThreadCreate', id: threadId });
      actual.emitThreadCreate(threadId, ...rest);
    },
  };
});

import { Agents, ThreadParticipants, Users, getDb } from '@snaglet/db';
import type { SocketSessionCreateMsg, WsMessage, WsMessageHandler } from '@snaglet/shared/types';
import { hooks, type HookEventMap } from '@server/services/HookService';
import { registerSessionHandlers } from '@server/services/SocketService/handlers/sessionHandlers';
import threadCreate from '@server/services/ToolService/handlers/threads/threadCreate';
import { wsService } from '@server/services/WebSocketService';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';
const CLIENT_ID = 'client-1';

interface Persisted {
  threads: number;
  nodes: number;
  participants: number;
}

let userId: string;
let sessionCreate: WsMessageHandler<SocketSessionCreateMsg['payload']>;

beforeAll(async () => {
  await Agents.create({ id: AGENT_A, name: 'Test Agent A' });
  await Agents.create({ id: AGENT_B, name: 'Test Agent B' });
  userId = (await Users.getOrCreateLocalUser()).id;

  const registered = new Map<string, WsMessageHandler<unknown>>();
  const register = jest
    .spyOn(wsService, 'registerHandler')
    .mockImplementation((type: string, handler: WsMessageHandler<unknown>) => {
      registered.set(type, handler);
    });
  registerSessionHandlers();
  register.mockRestore();
  sessionCreate = registered.get('socket:session:create')!;
});

afterEach(() => {
  jest.restoreAllMocks();
  mockEvents.length = 0;
});

/** Rows a separate (pool) connection sees for a thread id. */
async function persisted(threadId: string): Promise<Persisted> {
  const { rows } = await getDb().query<{ threads: string; nodes: string; participants: string }>(
    `SELECT (SELECT count(*) FROM public.threads WHERE id = $1) AS threads,
            (SELECT count(*) FROM public.nodes WHERE id = $1) AS nodes,
            (SELECT count(*) FROM public.thread_participants WHERE thread_id = $1) AS participants`,
    [threadId]
  );
  const row = rows[0]!;
  return {
    threads: Number(row.threads),
    nodes: Number(row.nodes),
    participants: Number(row.participants),
  };
}

/**
 * Observe the socket fan-out (broadcasts and direct replies) into
 * `mockEvents`, and return what a separate connection saw for the thread at
 * the first event naming it.
 */
function observeSocket(): { firstVisible: Map<string, Promise<Persisted>> } {
  const firstVisible = new Map<string, Promise<Persisted>>();
  const record = (type: string, payload: unknown): void => {
    const p = payload as { node?: { id?: string }; thread?: { id?: string }; threadId?: string };
    const id = p.node?.id ?? p.thread?.id ?? p.threadId;
    mockEvents.push({ type, id });
    if (id && !firstVisible.has(id)) firstVisible.set(id, persisted(id));
  };
  jest
    .spyOn(wsService, 'broadcastToChannel')
    .mockImplementation((_channel: string, message: WsMessage<unknown>) => {
      record(message.type, message.payload);
    });
  jest
    .spyOn(wsService, 'sendToClient')
    .mockImplementation((_clientId: string, message: WsMessage<unknown>) => {
      record(message.type, message.payload);
    });
  return { firstVisible };
}

/** Capture `thread:create` hook emits (and keep real hooks from running). */
function observeThreadCreateHook(): {
  emits: Array<HookEventMap['thread:create']>;
  next: Promise<HookEventMap['thread:create']>;
} {
  const emits: Array<HookEventMap['thread:create']> = [];
  let resolveNext: (payload: HookEventMap['thread:create']) => void = () => {};
  const next = new Promise<HookEventMap['thread:create']>((resolve) => {
    resolveNext = resolve;
  });
  jest.spyOn(hooks, 'emit').mockImplementation((event, payload) => {
    if (event !== 'thread:create') return;
    const created = payload as HookEventMap['thread:create'];
    emits.push(created);
    resolveNext(created);
  });
  return { emits, next };
}

/** Make the next `method` call run for real, then fail; returns the thread ids it saw. */
function failAfterRealWrite(method: 'addParticipant' | 'addUserParticipant'): string[] {
  const attempted: string[] = [];
  if (method === 'addParticipant') {
    const real = ThreadParticipants.addParticipant.bind(ThreadParticipants);
    jest
      .spyOn(ThreadParticipants, 'addParticipant')
      .mockImplementation(async (...args: Parameters<typeof real>) => {
        attempted.push(args[0].threadId);
        await real(...args);
        throw new Error('injected participant failure');
      });
  } else {
    const real = ThreadParticipants.addUserParticipant.bind(ThreadParticipants);
    jest
      .spyOn(ThreadParticipants, 'addUserParticipant')
      .mockImplementation(async (...args: Parameters<typeof real>) => {
        attempted.push(args[0].threadId);
        await real(...args);
        throw new Error('injected participant failure');
      });
  }
  return attempted;
}

/** Let a fire-and-forget hook builder that might have started finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('thread tool (op: create) atomicity', () => {
  const input = {
    title: 'Test thread',
    project_id: null,
    agent_ids: [AGENT_A, AGENT_B],
  };

  it('leaves no thread, node or participant and broadcasts nothing when a participant write fails', async () => {
    observeSocket();
    const hook = observeThreadCreateHook();
    // The human participant is resolved automatically (no participant_user_ids).
    // Injecting a failure into that addUserParticipant write still proves the
    // thread and every earlier participant roll back as one unit.
    const attempted = failAfterRealWrite('addUserParticipant');

    await expect(threadCreate({ ...input }, {}, { agentId: AGENT_A })).rejects.toThrow(
      'injected participant failure'
    );

    expect(attempted).toHaveLength(1);
    expect(await persisted(attempted[0]!)).toEqual({ threads: 0, nodes: 0, participants: 0 });
    await settle();
    expect(mockEvents).toEqual([]);
    expect(hook.emits).toEqual([]);
  });

  it('creates the thread with every participant and emits only after the commit, in order', async () => {
    const socket = observeSocket();
    const hook = observeThreadCreateHook();

    const result = await threadCreate({ ...input }, {}, { agentId: AGENT_A });

    const id = (result as { rawContent: { thread_id: string } }).rawContent.thread_id;
    expect(await persisted(id)).toEqual({ threads: 1, nodes: 1, participants: 3 });
    expect(mockEvents.filter((e) => e.id === id).map((e) => e.type)).toEqual([
      'workspace.created',
      'thread.created',
      'emitThreadCreate',
    ]);
    // The first broadcast already sees the committed thread and full roster.
    expect(await socket.firstVisible.get(id)).toEqual({ threads: 1, nodes: 1, participants: 3 });

    // The hook builder reads the roster through the pool, so a complete
    // roster here means it ran after the commit too.
    const created = await hook.next;
    expect(created.id).toBe(id);
    expect(created.createdBy).toEqual({ kind: 'agent', id: AGENT_A });
    expect(created.participants.map((p) => `${p.kind}:${p.id}`).sort()).toEqual([
      `agent:${AGENT_A}`,
      `agent:${AGENT_B}`,
      `user:${userId}`,
    ]);
  });
});

describe('socket:session:create atomicity', () => {
  it('leaves no thread, node or participant and replies with nothing when the participant write fails', async () => {
    observeSocket();
    const hook = observeThreadCreateHook();
    const attempted = failAfterRealWrite('addParticipant');

    await expect(
      Promise.resolve(sessionCreate({ agentId: AGENT_A }, { clientId: CLIENT_ID }))
    ).rejects.toThrow('injected participant failure');

    expect(attempted).toHaveLength(1);
    expect(await persisted(attempted[0]!)).toEqual({ threads: 0, nodes: 0, participants: 0 });
    const { rows } = await getDb().query<{ count: string }>(
      'SELECT count(*) FROM public.socket_sessions WHERE thread_id = $1',
      [attempted[0]]
    );
    expect(Number(rows[0]!.count)).toBe(0);
    await settle();
    expect(mockEvents).toEqual([]);
    expect(hook.emits).toEqual([]);
  });

  it('creates the thread with its participant and emits only after the commit, in order', async () => {
    const socket = observeSocket();
    const hook = observeThreadCreateHook();

    await sessionCreate({ agentId: AGENT_A }, { clientId: CLIENT_ID });

    const reply = mockEvents.find((e) => e.type === 'socket:session:created');
    const id = reply?.id;
    expect(id).toEqual(expect.any(String));
    expect(await persisted(id!)).toEqual({ threads: 1, nodes: 1, participants: 1 });
    // The hook is fired before the reply, and nothing is broadcast.
    expect(mockEvents.map((e) => e.type)).toEqual(['emitThreadCreate', 'socket:session:created']);
    expect(mockEvents.every((e) => e.id === id)).toBe(true);
    // The reply already sees the committed thread and its participant.
    expect(await socket.firstVisible.get(id!)).toEqual({ threads: 1, nodes: 1, participants: 1 });

    const created = await hook.next;
    expect(created.id).toBe(id);
    expect(created.createdBy).toEqual({ kind: 'user' });
    expect(created.participants.map((p) => `${p.kind}:${p.id}`)).toEqual([`agent:${AGENT_A}`]);
  });
});
