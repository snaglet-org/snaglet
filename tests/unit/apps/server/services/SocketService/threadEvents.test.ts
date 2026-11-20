/**
 * threadEvents — append-only narration of thread-variable state.
 *
 * These emitters persist author-less `thread_event` message rows (via
 * Messages.createEvent) and broadcast them live. This suite verifies the
 * narration content, the idempotency of the turn-zero event, and that each
 * emission both persists and broadcasts as `thread_event`.
 */

const createEvent = jest.fn();
const hasEventOfKind = jest.fn();
const findById = jest.fn();
const broadcastToChannel = jest.fn();
const workSnapshot = jest.fn();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    createEvent: (...a: unknown[]) => createEvent(...a),
    hasEventOfKind: (...a: unknown[]) => hasEventOfKind(...a),
  },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...a: unknown[]) => findById(...a) },
}));

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));

// Who is running right now — the mid-run injection target set. Mocked (rather
// than driving the real registry) so these tests state the run state directly.
jest.mock('@server/services/ActiveWorkRegistry', () => ({
  activeWorkRegistry: { snapshot: () => workSnapshot() },
}));

import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import {
  emitThreadStartedEvent,
  emitParticipantAddedEvent,
  emitParticipantRemovedEvent,
  emitModelChangedEvent,
  emitDispatchModeChangedEvent,
  emitVoiceModeEnabledEvent,
  emitVisionModeChangedEvent,
  emitMaxWavesChangedEvent,
  emitConversationBudgetChangedEvent,
  emitRunTimeLimitChangedEvent,
  emitAgentRunEndedEvent,
  THREAD_EVENT_KIND,
  THREAD_EVENT_LINE_PREFIX,
  THREAD_EVENT_LINE_PREFIXES,
} from '@server/services/SocketService/threadEvents';

/** The single `createEvent` payload, for suites that emit exactly one line. */
function onlyEvent(): { content: string; eventKind: string } {
  expect(createEvent).toHaveBeenCalledTimes(1);
  return createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
}

function runningAgent(agentId: string, threadId: string, runId = `run-${agentId}`) {
  return { id: runId, kind: 'thread-run', agentId, threadId, startedAt: '2026-08-06T00:00:00Z' };
}

beforeEach(() => {
  createEvent.mockReset();
  hasEventOfKind.mockReset();
  findById.mockReset();
  broadcastToChannel.mockReset();
  workSnapshot.mockReset();
  createEvent.mockResolvedValue({ id: 'message-evt', createdAt: '2026-07-04T00:00:00.000Z' });
  hasEventOfKind.mockResolvedValue(false);
  findById.mockResolvedValue({ id: 'agent-x', name: 'Nova' });
  workSnapshot.mockReturnValue([]);
  pendingAgentMessages.resetForTests();
});

describe('emitThreadStartedEvent', () => {
  it('persists a turn-zero line capturing roster + mode, and broadcasts it', async () => {
    await emitThreadStartedEvent('thread-1', {
      participants: [
        { agentId: 'agent-x', name: 'Nova' },
        { agentId: 'agent-y', name: 'Vega' },
      ],
      dispatchMode: 'all',
    });

    // Known names are used as given; no lookup.
    expect(findById).not.toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledTimes(1);
    const arg = createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.started);
    expect(arg.content).toBe('[thread started · participants: Nova, Vega · mode: all]');

    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    const [channel, msg] = broadcastToChannel.mock.calls[0]! as [string, Record<string, unknown>];
    expect(channel).toBe('thread-1');
    expect(msg.type).toBe('socket:chat:message_created');
    expect((msg.payload as Record<string, unknown>).message_type).toBe('thread_event');
  });

  it('names no mode for a DM / home thread (no routing there)', async () => {
    await emitThreadStartedEvent('thread-1', {
      participants: [{ agentId: 'agent-x', name: 'Penny' }],
      dispatchMode: null,
    });
    const arg = createEvent.mock.calls[0]![0] as { content: string };
    expect(arg.content).toBe('[thread started · participants: Penny]');
  });

  it('names a lone participant (e.g. a subagent helper) by lookup, not by its id', async () => {
    findById.mockResolvedValue({ id: 'test-agent-helper-1', name: 'Test Helper' });
    await emitThreadStartedEvent('thread-1', {
      participants: [{ agentId: 'test-agent-helper-1' }],
      dispatchMode: 'all',
    });

    expect(findById).toHaveBeenCalledWith('test-agent-helper-1');
    expect(onlyEvent().content).toBe('[thread started · participants: Test Helper · mode: all]');
  });

  it('is idempotent — no-op (and no lookup) when a started event already exists', async () => {
    hasEventOfKind.mockResolvedValue(true);
    await emitThreadStartedEvent('thread-1', {
      participants: [{ agentId: 'agent-x' }],
      dispatchMode: 'all',
    });
    expect(findById).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});

describe('participant + dispatch-mode narration', () => {
  it('narrates a participant join (name hint wins, no DB lookup)', async () => {
    await emitParticipantAddedEvent('thread-1', 'agent-x', 'Vega');
    expect(findById).not.toHaveBeenCalled();
    const arg = createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.participantAdded);
    expect(arg.content).toBe('[participant added · Vega joined the thread]');
  });

  it('resolves the agent name when no hint is provided', async () => {
    await emitParticipantAddedEvent('thread-1', 'agent-x');
    expect(findById).toHaveBeenCalledWith('agent-x');
    const arg = createEvent.mock.calls[0]![0] as { content: string };
    expect(arg.content).toBe('[participant added · Nova joined the thread]');
  });

  it('narrates a participant removal', async () => {
    await emitParticipantRemovedEvent('thread-1', 'agent-x', 'Vega');
    const arg = createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.participantRemoved);
    expect(arg.content).toBe('[participant removed · Vega left the thread]');
  });

  it('narrates a dispatch-mode change', async () => {
    await emitDispatchModeChangedEvent('thread-1', 'mentioned');
    const arg = createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.dispatchModeChanged);
    expect(arg.content).toBe('[dispatch mode changed · now: mentioned]');
  });

  it('narrates which participant changed models, including the old and new model', async () => {
    await emitModelChangedEvent(
      'thread-1',
      'agent-x',
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      { providerId: 'openai', modelId: 'gpt-5' }
    );

    expect(findById).toHaveBeenCalledWith('agent-x');
    const arg = createEvent.mock.calls[0]![0] as { content: string; eventKind: string };
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.modelChanged);
    expect(arg.content).toBe(
      '[participant model changed · Nova · from: anthropic/claude-sonnet-4-5 · to: openai/gpt-5]'
    );
  });
});

describe('vision mode narration', () => {
  it('narrates a grant with the capture tool to call, under the shared vision prefix', async () => {
    await emitVisionModeChangedEvent('thread-1', null, 'screen');
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.visionModeEnabled);
    expect(arg.content).toBe(
      '[vision mode enabled · source: screen · call capture_user_screen({}) only when you need to look — one frame per turn]'
    );
    expect(arg.content.startsWith(THREAD_EVENT_LINE_PREFIX.visionMode)).toBe(true);
  });

  it('names the camera tool for a camera grant and both tools for `both`', async () => {
    await emitVisionModeChangedEvent('thread-1', null, 'camera');
    expect(onlyEvent().content).toContain('call capture_user_camera({})');

    createEvent.mockClear();
    await emitVisionModeChangedEvent('thread-1', null, 'both');
    expect(onlyEvent().content).toContain(
      'call capture_user_screen({}) or capture_user_camera({})'
    );
  });

  it('narrates a source switch with the new source and its tool', async () => {
    await emitVisionModeChangedEvent('thread-1', 'screen', 'camera');
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.visionModeSourceChanged);
    expect(arg.content).toBe(
      '[vision mode source changed · from: screen · to: camera · call capture_user_camera({}) only when you need to look — one frame per turn]'
    );
  });

  it('narrates a revocation with no tool hint — there is nothing to call', async () => {
    await emitVisionModeChangedEvent('thread-1', 'both', null);
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.visionModeDisabled);
    expect(arg.content).toBe('[vision mode disabled]');
  });

  it('is a no-op when the source did not actually change', async () => {
    await emitVisionModeChangedEvent('thread-1', 'screen', 'screen');
    await emitVisionModeChangedEvent('thread-1', null, null);
    expect(createEvent).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});

describe('voice mode narration carries an actionable hint', () => {
  it('tells the agent replies are spoken automatically, and not to call the TTS tools', async () => {
    // The honest instruction is the inverse of a tool call: the voice session's
    // own sink speaks the reply, so shell `say` / `text_to_speech` would bypass it.
    await emitVoiceModeEnabledEvent('thread-1');
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.voiceModeEnabled);
    expect(arg.content).toBe(
      '[voice mode enabled · your replies are spoken automatically — just reply, 1-3 sentences; do not play speech yourself (shell say, text_to_speech)]'
    );
    expect(arg.content.startsWith(THREAD_EVENT_LINE_PREFIX.voiceMode)).toBe(true);
  });
});

describe('budget / cap / duration narration', () => {
  it('names the max_waves sentinels instead of printing the raw -1 encoding', async () => {
    await emitMaxWavesChangedEvent('thread-1', null, 12);
    expect(onlyEvent().content).toBe('[max dispatch waves changed · from: default · to: 12]');

    createEvent.mockClear();
    await emitMaxWavesChangedEvent('thread-1', 12, -1);
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.maxWavesChanged);
    expect(arg.content).toBe('[max dispatch waves changed · from: 12 · to: unbounded]');
  });

  it('narrates the conversation output-token budget, with null read as the default', async () => {
    await emitConversationBudgetChangedEvent('thread-1', 50000, null);
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.conversationBudgetChanged);
    expect(arg.content).toBe(
      '[conversation budget changed · output tokens · from: 50000 · to: default]'
    );
  });

  it('narrates a participant run time limit in the units the control offers', async () => {
    await emitRunTimeLimitChangedEvent('thread-1', 'agent-x', null, 900);
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.runTimeLimitChanged);
    expect(arg.content).toBe('[run time limit changed · Nova · from: unlimited · to: 15m]');

    createEvent.mockClear();
    await emitRunTimeLimitChangedEvent('thread-1', 'agent-x', 7200, null);
    expect(onlyEvent().content).toBe('[run time limit changed · Nova · from: 2h · to: unlimited]');
  });
});

describe('agent run-ended narration', () => {
  it('summarizes the turn — who, how long, how many tool calls — and nothing else', async () => {
    await emitAgentRunEndedEvent('thread-1', {
      agentName: 'Nova',
      durationMs: 72_000,
      toolCalls: 7,
    });
    const arg = onlyEvent();
    expect(arg.eventKind).toBe(THREAD_EVENT_KIND.agentRunEnded);
    expect(arg.content).toBe('[agent run ended · Nova · 1m12s · 7 tool calls]');
  });

  it('renders sub-minute runs in seconds and singularizes a lone tool call', async () => {
    await emitAgentRunEndedEvent('thread-1', {
      agentName: 'Vega',
      durationMs: 4200,
      toolCalls: 1,
    });
    expect(onlyEvent().content).toBe('[agent run ended · Vega · 4s · 1 tool call]');
  });

  it('renders a zero-tool run without pretending work happened', async () => {
    await emitAgentRunEndedEvent('thread-1', { agentName: 'Vega', durationMs: 900, toolCalls: 0 });
    expect(onlyEvent().content).toBe('[agent run ended · Vega · 1s · 0 tool calls]');
  });

  it('is broadcast for the UI but never injected into a running agent (other kinds still are)', async () => {
    workSnapshot.mockReturnValue([runningAgent('agent-running', 'thread-1')]);

    await emitAgentRunEndedEvent('thread-1', { agentName: 'Nova', durationMs: 5000, toolCalls: 2 });
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(pendingAgentMessages.listUnread('thread-1', 'agent-running')).toHaveLength(0);

    await emitDispatchModeChangedEvent('thread-1', 'all');
    const queued = pendingAgentMessages.listUnread('thread-1', 'agent-running');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).not.toContain('agent run ended');
  });
});

describe('mid-run injection — a state change reaches an already-running agent', () => {
  it('queues the persisted line for every agent running in this thread', async () => {
    workSnapshot.mockReturnValue([
      runningAgent('agent-running', 'thread-1'),
      runningAgent('agent-other-thread', 'thread-2'),
    ]);

    await emitDispatchModeChangedEvent('thread-1', 'mentioned');

    const queued = pendingAgentMessages.listUnread('thread-1', 'agent-running');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toBe('system');
    // Byte-identical to the persisted row, so the mid-run and replayed copies
    // cannot describe the same change differently.
    expect(queued[0]!.content).toBe(onlyEvent().content);
    // An agent running in a different thread is never targeted.
    expect(pendingAgentMessages.listUnread('thread-2', 'agent-other-thread')).toHaveLength(0);
  });

  it('is author-less — no userId and no agentId on the queued row', async () => {
    workSnapshot.mockReturnValue([runningAgent('agent-running', 'thread-1')]);
    await emitVisionModeChangedEvent('thread-1', null, 'screen');
    const [queued] = pendingAgentMessages.listUnread('thread-1', 'agent-running');
    expect(queued!.senderUserId).toBeNull();
    expect(queued!.senderAgentId).toBeNull();
  });

  it('queues once per agent even when that agent has two live runs (model fallback)', async () => {
    workSnapshot.mockReturnValue([
      runningAgent('agent-running', 'thread-1', 'run-attempt-1'),
      runningAgent('agent-running', 'thread-1', 'run-attempt-2'),
    ]);
    await emitMaxWavesChangedEvent('thread-1', null, 8);
    expect(pendingAgentMessages.listUnread('thread-1', 'agent-running')).toHaveLength(1);
  });

  it('queues nothing when no agent is running — replay alone delivers it', async () => {
    workSnapshot.mockReturnValue([]);
    await emitDispatchModeChangedEvent('thread-1', 'all');
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(pendingAgentMessages.listUnread('thread-1', 'agent-running')).toHaveLength(0);
  });
});

describe('best-effort emission — narration never breaks the mutation that triggered it', () => {
  it('resolves (does not throw) when the persist fails, and queues nothing', async () => {
    workSnapshot.mockReturnValue([runningAgent('agent-running', 'thread-1')]);
    createEvent.mockRejectedValue(new Error('db down'));

    await expect(emitDispatchModeChangedEvent('thread-1', 'mentioned')).resolves.toBeUndefined();
    await expect(emitMaxWavesChangedEvent('thread-1', null, 5)).resolves.toBeUndefined();
    await expect(
      emitConversationBudgetChangedEvent('thread-1', null, 1000)
    ).resolves.toBeUndefined();
    await expect(
      emitRunTimeLimitChangedEvent('thread-1', 'agent-x', null, 60)
    ).resolves.toBeUndefined();
    await expect(emitVisionModeChangedEvent('thread-1', null, 'screen')).resolves.toBeUndefined();
    await expect(
      emitAgentRunEndedEvent('thread-1', { agentName: 'Nova', durationMs: 1, toolCalls: 0 })
    ).resolves.toBeUndefined();

    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(pendingAgentMessages.listUnread('thread-1', 'agent-running')).toHaveLength(0);
  });

  it('still persists + broadcasts when the mid-run injection lookup throws', async () => {
    workSnapshot.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    await expect(emitDispatchModeChangedEvent('thread-1', 'all')).resolves.toBeUndefined();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
  });
});

describe('prefix registry', () => {
  it('exports every declared prefix for downstream narration classification', () => {
    // THREAD_EVENT_LINE_PREFIXES is what ContextWindowService scans. A new kind
    // that forgets its prefix entry would be classified as real conversation.
    expect(THREAD_EVENT_LINE_PREFIXES).toEqual(Object.values(THREAD_EVENT_LINE_PREFIX));
    expect(new Set(THREAD_EVENT_LINE_PREFIXES).size).toBe(THREAD_EVENT_LINE_PREFIXES.length);
  });

  it('every emitted line starts with a registered prefix', async () => {
    const emit = async (fn: () => Promise<void>): Promise<string> => {
      createEvent.mockClear();
      await fn();
      return onlyEvent().content;
    };
    const lines = [
      await emit(() =>
        emitThreadStartedEvent('t', {
          participants: [{ agentId: 'agent-x', name: 'Nova' }],
          dispatchMode: 'all',
        })
      ),
      await emit(() => emitParticipantAddedEvent('t', 'agent-x', 'Nova')),
      await emit(() => emitParticipantRemovedEvent('t', 'agent-x', 'Nova')),
      await emit(() => emitModelChangedEvent('t', 'agent-x', null, null)),
      await emit(() => emitDispatchModeChangedEvent('t', 'all')),
      await emit(() => emitVoiceModeEnabledEvent('t')),
      await emit(() => emitVisionModeChangedEvent('t', null, 'screen')),
      await emit(() => emitVisionModeChangedEvent('t', 'screen', 'camera')),
      await emit(() => emitVisionModeChangedEvent('t', 'screen', null)),
      await emit(() => emitMaxWavesChangedEvent('t', null, 3)),
      await emit(() => emitConversationBudgetChangedEvent('t', null, 3)),
      await emit(() => emitRunTimeLimitChangedEvent('t', 'agent-x', null, 30)),
      await emit(() =>
        emitAgentRunEndedEvent('t', { agentName: 'N', durationMs: 1, toolCalls: 0 })
      ),
    ];
    for (const line of lines) {
      expect(THREAD_EVENT_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))).toBe(true);
    }
  });
});
