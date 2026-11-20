/**
 * The status record behind the session snapshot (liveRunStatuses): what each
 * agent's bubble shows, kept per thread so a view that opens or reconnects
 * mid-run gets it. A run status counts only while the run is registered; a
 * turn still assembling its context and a queued agent count as recorded; the
 * thread's lock release clears whatever is left.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    sendToClient: jest.fn(),
  },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: { socket: { event: jest.fn() } },
}));
jest.mock('@server/realtime/surfaces/agentWork', () => ({
  emitAgentWorkStarted: jest.fn(),
  emitAgentWorkFinished: jest.fn(),
}));
jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadRunStarted: jest.fn(),
  emitThreadRunFinished: jest.fn(),
}));

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import {
  emitAgentStatus,
  initLiveRunStatuses,
  liveRunStatuses,
} from '@server/services/SocketService/handlers/chatHelpers/agentStatusEvents';

type Status = Parameters<typeof emitAgentStatus>[3];

let threadSeq = 0;
let thread = '';

function startRun(runId: string, agentId: string, threadId = thread): void {
  activeWorkRegistry.registerThreadRun({
    id: runId,
    agentId,
    agentName: agentId,
    threadId,
    threadTitle: 'Planning',
  });
}

function status(agentId: string, value: Status, threadId = thread, beforeRun = false): void {
  emitAgentStatus('client-1', 'session-1', agentId, value, { threadId, beforeRun });
}

function statusFrames(threadId = thread): Array<[string, string]> {
  return broadcastToChannel.mock.calls
    .filter(([channel]) => channel === threadId)
    .map(([, frame]) => {
      const { payload } = frame as { payload: { agentId: string; status: string } };
      return [payload.agentId, payload.status];
    });
}

beforeEach(() => {
  activeWorkRegistry.clear();
  broadcastToChannel.mockClear();
  thread = `thread-${++threadSeq}`;
});

describe('liveRunStatuses', () => {
  it('reports the latest status of each run in the thread', () => {
    startRun('run-a', 'agent-a');
    status('agent-a', 'thinking');
    status('agent-a', 'tool_running');
    startRun('run-b', 'agent-b');
    status('agent-b', 'thinking');

    expect(liveRunStatuses(thread)).toEqual(
      new Map([
        ['agent-a', 'tool_running'],
        ['agent-b', 'thinking'],
      ])
    );
  });

  it('still broadcasts every status on the thread channel', () => {
    startRun('run-a', 'agent-a');
    status('agent-a', 'thinking');

    expect(broadcastToChannel).toHaveBeenCalledWith(thread, {
      type: 'socket:agent:status',
      payload: { sessionId: 'session-1', agentId: 'agent-a', status: 'thinking' },
    });
  });

  it('drops an agent once it goes idle', () => {
    startRun('run-a', 'agent-a');
    status('agent-a', 'thinking');
    activeWorkRegistry.unregister('run-a');
    status('agent-a', 'idle');

    expect(liveRunStatuses(thread).size).toBe(0);
  });

  it('never reports a run status once the run is unregistered', () => {
    startRun('run-a', 'agent-a');
    status('agent-a', 'typing');
    activeWorkRegistry.unregister('run-a');

    expect(liveRunStatuses(thread).size).toBe(0);
  });

  it('reports a turn assembling its context before its run is registered', () => {
    status('agent-a', 'thinking', thread, true);

    expect(liveRunStatuses(thread)).toEqual(new Map([['agent-a', 'thinking']]));
  });

  it('reports a queued agent, which has no run yet', () => {
    status('agent-a', 'queued');

    expect(liveRunStatuses(thread)).toEqual(new Map([['agent-a', 'queued']]));
  });

  it('reads a live run with no status yet as thinking', () => {
    startRun('run-a', 'agent-a');

    expect(liveRunStatuses(thread)).toEqual(new Map([['agent-a', 'thinking']]));
  });

  it('is scoped to the thread', () => {
    const other = `${thread}-other`;
    startRun('run-a', 'agent-a', other);
    status('agent-a', 'thinking', other);

    expect(liveRunStatuses(thread).size).toBe(0);
    expect(liveRunStatuses(other)).toEqual(new Map([['agent-a', 'thinking']]));
  });
});

describe('emitAgentStatus idle', () => {
  it('is not sent for an agent the thread shows nothing for', () => {
    status('agent-a', 'idle');

    expect(statusFrames()).toEqual([]);
  });

  it('is sent for an agent the thread shows', () => {
    status('agent-a', 'queued');
    status('agent-a', 'idle');

    expect(statusFrames()).toEqual([
      ['agent-a', 'queued'],
      ['agent-a', 'idle'],
    ]);
  });
});

describe('the thread lock release', () => {
  initLiveRunStatuses();

  it('sends idle for every agent still shown and forgets them', () => {
    expect(activeRunTracker.startSession('session-1', thread)).toBe(true);
    status('agent-a', 'queued');
    status('agent-b', 'thinking', thread, true);
    broadcastToChannel.mockClear();

    activeRunTracker.finishSession('session-1');

    expect(statusFrames().sort()).toEqual([
      ['agent-a', 'idle'],
      ['agent-b', 'idle'],
    ]);
    expect(liveRunStatuses(thread).size).toBe(0);
  });

  it('leaves other threads alone', () => {
    const other = `${thread}-other`;
    expect(activeRunTracker.startSession('session-2', thread)).toBe(true);
    status('agent-a', 'queued', other);

    activeRunTracker.finishSession('session-2');

    expect(liveRunStatuses(other)).toEqual(new Map([['agent-a', 'queued']]));
  });
});
