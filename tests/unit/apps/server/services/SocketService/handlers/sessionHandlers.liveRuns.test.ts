/**
 * `session:resume` tells a view that opens or reconnects mid-run which agents
 * are running in the thread and each one's latest status, read from the
 * in-memory run state, so the view shows a run whose status frames it missed.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Handler = (payload: { threadId?: string }, meta: { clientId: string }) => Promise<void>;

const handlers = new Map<string, Handler>();
const sendToClient = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    registerHandler: (type: string, handler: Handler) => handlers.set(type, handler),
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: jest.fn(),
  },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: { socket: { event: jest.fn() } },
}));
jest.mock('@server/realtime/surfaces/agentWork', () => ({
  emitAgentWorkStarted: jest.fn(),
  emitAgentWorkFinished: jest.fn(),
}));
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: {
    findById: async (id: string) => ({ id, title: 'Planning' }),
    create: jest.fn(),
  },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: async () => [{ agentId: 'agent-a' }, { agentId: 'agent-b' }],
    addParticipant: jest.fn(),
  },
}));
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: async (id: string) => ({ id, name: id }) },
}));
jest.mock('@server/services/SocketService/store', () => ({
  setSession: async () => undefined,
}));
jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: { emitCurrentState: jest.fn() },
}));

import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { emitAgentStatus } from '@server/services/SocketService/handlers/chatHelpers/agentStatusEvents';
import { registerSessionHandlers } from '@server/services/SocketService/handlers/sessionHandlers';

const THREAD = 'thread-1111111111111-aaaaaaaaa';

function startRun(runId: string, agentId: string, threadId = THREAD): void {
  activeWorkRegistry.registerThreadRun({
    id: runId,
    agentId,
    agentName: agentId,
    threadId,
    threadTitle: 'Planning',
  });
}

async function resume(): Promise<Record<string, unknown>> {
  await handlers.get('socket:session:resume')!({ threadId: THREAD }, { clientId: 'client-1' });
  const created = sendToClient.mock.calls
    .map(([, frame]) => frame as { type: string; payload: Record<string, unknown> })
    .find((frame) => frame.type === 'socket:session:created');
  expect(created).toBeDefined();
  return created!.payload;
}

beforeEach(() => {
  jest.clearAllMocks();
  handlers.clear();
  activeWorkRegistry.clear();
  registerSessionHandlers();
});

describe('session:resume reports the live runs', () => {
  it('names each running agent with its latest status', async () => {
    startRun('run-a', 'agent-a');
    emitAgentStatus('client-0', 'session-0', 'agent-a', 'thinking', { threadId: THREAD });
    emitAgentStatus('client-0', 'session-0', 'agent-a', 'tool_running', { threadId: THREAD });
    startRun('run-b', 'agent-b', 'thread-elsewhere');

    const payload = await resume();

    expect(payload.activeAgentIds).toEqual(['agent-a']);
    expect(payload.activeAgentStatuses).toEqual({ 'agent-a': 'tool_running' });
  });

  it('reports nothing when no run is live, even with a status left behind', async () => {
    startRun('run-a', 'agent-a');
    emitAgentStatus('client-0', 'session-0', 'agent-a', 'typing', { threadId: THREAD });
    activeWorkRegistry.unregister('run-a');

    const payload = await resume();

    expect(payload.activeAgentIds).toBeUndefined();
    expect(payload.activeAgentStatuses).toBeUndefined();
  });

  it('names a turn still assembling its context and an agent queued for another run', async () => {
    emitAgentStatus('client-0', 'session-0', 'agent-b', 'thinking', {
      threadId: THREAD,
      beforeRun: true,
    });
    emitAgentStatus('client-0', 'session-0', 'agent-a', 'queued', { threadId: THREAD });

    const payload = await resume();

    expect(payload.activeAgentStatuses).toEqual({ 'agent-a': 'queued', 'agent-b': 'thinking' });
    expect([...(payload.activeAgentIds as string[])].sort()).toEqual(['agent-a', 'agent-b']);

    for (const agentId of ['agent-a', 'agent-b']) {
      emitAgentStatus('client-0', 'session-0', agentId, 'idle', { threadId: THREAD });
    }
  });
});
