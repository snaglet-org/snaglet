/**
 * useChatStream: the bubble-per-utterance realtime contract.
 *   - deltas accumulate into the current utterance bubble (agentId:runId);
 *   - socket:chat:message_created (assistant, matching run_id) finalizes that
 *     bubble with the persisted content and resets the accumulator;
 *   - socket:done doesn't build the transcript from `reply`: it carries
 *     run-complete state and finalizes any leftover accumulator;
 *   - two agents streaming at once finalize independently.
 * `useWs` and `useThreadHistory` are mocked.
 */
import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketThreadMemoryExtractionMsg, WsMessage } from '@snaglet/shared/types';
import type { ThreadMessage } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

// Capture every frame handler the mounted hooks register so the test can push
// frames — to one pane or, like the real provider, to all of them at once.
const wsHolder = vi.hoisted(() => ({
  handlers: new Set<(raw: WsMessage) => void>(),
  send: vi.fn(),
}));

vi.mock('@desktop/ws/useWs.js', () => ({
  useWs: () => ({
    send: wsHolder.send,
    addMessageListener: (h: (raw: WsMessage) => void) => {
      wsHolder.handlers.add(h);
      return () => {
        wsHolder.handlers.delete(h);
      };
    },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    connectionState: 'open',
  }),
}));

function dispatch(raw: WsMessage) {
  for (const handler of [...wsHolder.handlers]) handler(raw);
}

const PARTICIPANTS = ['agent-1', 'agent-2'];

// What the next history catch-up will report as newly persisted rows.
const historyHolder = vi.hoisted(() => ({
  refreshAdds: [] as ThreadMessage[],
  refreshCalls: 0,
}));

// Real useState so the socket handler's setMessages/setActivities mutate
// observable state; everything else is a static no-op stub.
vi.mock('./useThreadHistory.js', () => ({
  useThreadHistory: () => {
    const [messages, setMessages] = React.useState<ThreadMessage[]>([]);
    const [activities, setActivities] = React.useState(new Map());
    // Mirrors the real catch-up: merge the persisted rows, report them back.
    const refreshLatest = React.useCallback(async () => {
      historyHolder.refreshCalls += 1;
      const added = historyHolder.refreshAdds;
      setMessages((prev) => [...prev, ...added.filter((m) => !prev.some((p) => p.id === m.id))]);
      return added;
    }, []);
    return {
      messages,
      setMessages,
      activities,
      setActivities,
      participantAgentIds: PARTICIPANTS,
      loading: false,
      error: null,
      retry: () => {},
      refetchParticipants: async () => {},
      hasMoreOlder: false,
      hasMoreNewer: false,
      paginating: false,
      loadOlder: async () => {},
      loadNewer: async () => {},
      initialFocusMessageId: null,
      initialFocusRequestId: null,
      initialFocusIsNavigation: false,
      reload: () => {},
      refreshLatest,
    };
  },
}));

// Capture toast calls so send-stage failures can be asserted.
const toastHolder = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast.js', () => ({
  showToast: toastHolder.showToast,
}));

import { markThreadRunFinished, markThreadRunStarted } from '@desktop/utils/threadRunState';
import { useChatStream } from './useChatStream';

const THREAD_ID = 'thread-1';

function push(frame: { type: string; payload: Record<string, unknown> }) {
  act(() => {
    dispatch({
      type: frame.type,
      channel: THREAD_ID,
      payload: frame.payload,
    } as WsMessage);
  });
}

function assistantRows(messages: ThreadMessage[]) {
  return messages.filter((m) => m.role === 'assistant');
}

beforeEach(() => {
  wsHolder.handlers.clear();
  wsHolder.send.mockReset();
  historyHolder.refreshAdds = [];
  historyHolder.refreshCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useChatStream — bubble per utterance', () => {
  it('sends a targeted abort for one agent', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:session:created',
      payload: { sessionId: 's1', threadId: THREAD_ID },
    });

    act(() => result.current.stopAgentGeneration('agent-1'));

    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'socket:chat:abort',
      payload: { sessionId: 's1', agent_id: 'agent-1' },
    });
  });

  it('finalizes a streaming bubble on message_created and starts a fresh bubble for the next utterance', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    // Utterance 1 streams.
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'let me check' },
    });
    let streamingBubble = result.current.messages.find((m) => m.id === 'streaming:agent-1:R1');
    expect(streamingBubble?.content).toBe('let me check');

    // Server persists utterance 1 (snake_case) — authoritative content replaces the transient.
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-1',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: 'R1',
        content: 'let me check the files',
      },
    });
    // Transient gone; persisted row present with authoritative text.
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-1:R1')).toBeUndefined();
    const persisted1 = result.current.messages.find((m) => m.id === 'srv-1');
    expect(persisted1?.content).toBe('let me check the files');

    // Utterance 2 streams on the same run: a fresh accumulator, not a resurrection of #1.
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'all done!' },
    });
    streamingBubble = result.current.messages.find((m) => m.id === 'streaming:agent-1:R1');
    expect(streamingBubble?.content).toBe('all done!');

    // Both the persisted utterance and the fresh streaming bubble coexist.
    expect(result.current.messages.some((m) => m.id === 'srv-1')).toBe(true);
  });

  it('discards failed text and thinking before retry while preserving prior activity', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    // An unrelated run and completed steps from an earlier iteration on R1
    // must survive the targeted retry reset.
    push({
      type: 'socket:thinking:chunk',
      payload: { sessionId: 's2', agentId: 'agent-2', runId: 'R2', text: 'unrelated thought' },
    });
    push({
      type: 'socket:thinking:chunk',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'prior thought' },
    });
    push({
      type: 'socket:tool:call',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        runId: 'R1',
        callId: 'call-1',
        toolName: 'search',
        toolInput: { query: 'snaglet' },
      },
    });
    push({
      type: 'socket:tool:result',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        runId: 'R1',
        callId: 'call-1',
        success: true,
        output: 'found',
        durationMs: 12,
      },
    });

    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'partial attempt' },
    });
    push({
      type: 'socket:thinking:chunk',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'failed thought' },
    });
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-1:R1')?.content).toBe(
      'partial attempt'
    );

    push({
      type: 'socket:agent:stream:retry',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', delayMs: 2_000 },
    });
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-1:R1')).toBeUndefined();
    expect(result.current.activities.get('R1')?.steps).toMatchObject([
      { kind: 'thinking', text: 'prior thought', live: false },
      { kind: 'tool_call', id: 'call-1', status: 'done' },
    ]);
    expect(result.current.activities.get('R2')?.steps).toMatchObject([
      { kind: 'thinking', text: 'unrelated thought', live: true },
    ]);
    expect(
      result.current.activities
        .get('R1')
        ?.steps.some((step) => step.kind === 'thinking' && step.text.includes('failed thought'))
    ).toBe(false);

    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'clean retry' },
    });
    push({
      type: 'socket:thinking:chunk',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'clean thought' },
    });
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-1:R1')?.content).toBe(
      'clean retry'
    );
    const retrySteps = result.current.activities.get('R1')?.steps ?? [];
    expect(retrySteps[retrySteps.length - 1]).toMatchObject({
      kind: 'thinking',
      text: 'clean thought',
      live: true,
    });
  });

  it('socket:done does NOT swap the transcript with reply; it attaches usage to the terminal utterance', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'hello' },
    });
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-1',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: 'R1',
        content: 'hello world',
      },
    });

    push({
      type: 'socket:done',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        runId: 'R1',
        reply: 'THIS REPLY MUST NOT APPEAR',
        usage: { inputTokens: 10, outputTokens: 5, contextWindowTokens: 200000 },
      },
    });

    const rows = assistantRows(result.current.messages);
    // Exactly one assistant bubble — done.reply neither replaced nor added one.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('srv-1');
    expect(rows[0]!.content).toBe('hello world');
    expect(
      result.current.messages.some((m) => m.content.includes('THIS REPLY MUST NOT APPEAR'))
    ).toBe(false);
    // Usage rode socket:done and attached to the terminal utterance.
    expect(rows[0]!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      contextWindowTokens: 200000,
    });
    // No streaming bubble lingering; run cleared.
    expect(result.current.messages.some((m) => m.id.startsWith('streaming:'))).toBe(false);
    expect(result.current.working).toBe(false);
  });

  it('gracefully finalizes a leftover accumulator when socket:done races ahead of the terminal message_created', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    // Terminal text streamed but its message_created has not arrived yet.
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'final answer' },
    });
    push({
      type: 'socket:done',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', usage: { outputTokens: 3 } },
    });

    // Nothing was dropped — a provisional bubble carries the streamed text and
    // the usage that rode socket:done.
    let rows = assistantRows(result.current.messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('done:agent-1:R1');
    expect(rows[0]!.content).toBe('final answer');
    expect(rows[0]!.usage).toEqual({ outputTokens: 3 });

    // The late server row supersedes the provisional bubble (no duplication),
    // and the run-level usage (which rides socket:done, not message_created)
    // carries onto the replacing row instead of vanishing until reload.
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-late',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: 'R1',
        content: 'final answer',
      },
    });
    rows = assistantRows(result.current.messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('srv-late');
    expect(rows[0]!.usage).toEqual({ outputTokens: 3 });
    expect(result.current.messages.some((m) => m.id === 'done:agent-1:R1')).toBe(false);
  });

  it('keeps two concurrent agents keyed independently — finalizing one does not touch the other', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'from one' },
    });
    push({
      type: 'socket:delta',
      payload: { sessionId: 's2', agentId: 'agent-2', runId: 'R2', text: 'from two' },
    });

    expect(result.current.messages.find((m) => m.id === 'streaming:agent-1:R1')?.content).toBe(
      'from one'
    );
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-2:R2')?.content).toBe(
      'from two'
    );

    // Finalize agent-1 only.
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-a1',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: 'R1',
        content: 'one final',
      },
    });

    // agent-1's transient is gone; agent-2's is untouched.
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-1:R1')).toBeUndefined();
    expect(result.current.messages.find((m) => m.id === 'streaming:agent-2:R2')?.content).toBe(
      'from two'
    );
    expect(result.current.messages.find((m) => m.id === 'srv-a1')?.content).toBe('one final');
  });
});

describe('useChatStream — live wave indicator', () => {
  it('tracks the max wave from socket:agent:continuing and clears when the run settles', async () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    expect(result.current.currentWave).toBeNull();

    // Agent goes active, wave 2 begins.
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'thinking' },
    });
    push({
      type: 'socket:agent:continuing',
      payload: { sessionId: 's1', agentId: 'agent-1', wave: 2 },
    });
    expect(result.current.currentWave).toBe(2);

    // A mid-wave joiner re-announcing an older wave must not regress it.
    push({
      type: 'socket:agent:continuing',
      payload: { sessionId: 's1', agentId: 'agent-2', wave: 2 },
    });
    push({
      type: 'socket:agent:continuing',
      payload: { sessionId: 's1', agentId: 'agent-1', wave: 3 },
    });
    expect(result.current.currentWave).toBe(3);

    // Run settles (status cleared). The reset is debounced: `working`
    // flickers false between sequential waves, so the indicator must survive
    // the gap and clear only after the idle delay.
    push({
      type: 'socket:done',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', reply: 'done', durationMs: 5 },
    });
    expect(result.current.working).toBe(false);
    expect(result.current.currentWave).toBe(3);
    await waitFor(() => expect(result.current.currentWave).toBeNull(), { timeout: 4000 });
  });

  it('drops the previous thread’s wave and dispatch hint when the thread changes', () => {
    const { result, rerender } = renderHook(({ threadId }) => useChatStream(threadId), {
      initialProps: { threadId: THREAD_ID },
    });
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'thinking' },
    });
    push({
      type: 'socket:agent:continuing',
      payload: { sessionId: 's1', agentId: 'agent-1', wave: 2 },
    });
    push({
      type: 'socket:chat:dispatch_hint',
      payload: { sessionId: 's1', threadId: THREAD_ID, message: 'Mention an agent to reply' },
    });
    expect(result.current.currentWave).toBe(2);
    expect(result.current.dispatchHint).toBe('Mention an agent to reply');

    rerender({ threadId: 'thread-2' });
    expect(result.current.currentWave).toBeNull();
    expect(result.current.dispatchHint).toBeNull();
  });
});

describe('useChatStream — run-error surfacing', () => {
  it('socket:error paints a live, run-scoped error bubble and clears streaming indicators', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    // Agent is mid-stream and marked active.
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'let me try…' },
    });
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'thinking' },
    });
    expect(result.current.working).toBe(true);
    expect(result.current.messages.some((m) => m.id === 'streaming:agent-1:R1')).toBe(true);

    // Provider error terminates the run — broadcast on the thread channel.
    push({
      type: 'socket:error',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        runId: 'R1',
        message: '[Ada] Model error: 401 invalid api key',
      },
    });

    // A visible error bubble now sits on the run…
    const errorRow = result.current.messages.find((m) => m.id === 'error:agent-1:R1');
    expect(errorRow?.runError?.summary).toContain('401 invalid api key');
    // …and the streaming + typing/status indicators were cleared (no refetch).
    expect(result.current.messages.some((m) => m.id.startsWith('streaming:'))).toBe(false);
    expect(result.current.working).toBe(false);
  });

  it('the persisted run_error row supersedes the transient socket:error bubble (no double render)', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    push({
      type: 'socket:error',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', message: 'boom' },
    });
    expect(result.current.messages.some((m) => m.id === 'error:agent-1:R1')).toBe(true);

    // persistRunErrorMessage's authoritative row lands (snake_case, carries run_id).
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-err',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: 'R1',
        content: '⚠ Model error: boom',
        run_error: {
          kind: 'model_failure',
          summary: 'boom',
          provider: 'openai',
          model_id: 'gpt-x',
          agent_name: 'Ada',
        },
      },
    });

    // Transient stripped; exactly one error row remains — the persisted one.
    expect(result.current.messages.some((m) => m.id === 'error:agent-1:R1')).toBe(false);
    const errorRows = result.current.messages.filter((m) => m.runError != null);
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]!.id).toBe('srv-err');
  });

  it('a socket:error with no kind paints a runtime bubble', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', message: 'boom' },
    });
    const row = result.current.messages.find((m) => m.id === 'error:agent-1:R1');
    expect(row?.runError).toMatchObject({ kind: 'runtime', summary: 'boom' });
  });

  it('a no_model socket:error paints a no_model bubble with its summary', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:error',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        kind: 'no_model',
        message: 'Pick a provider and model for Ada to answer.',
      },
    });
    const row = result.current.messages.find((m) => m.id === 'error:agent-1:default');
    expect(row?.agentId).toBe('agent-1');
    expect(row?.runError).toMatchObject({
      kind: 'no_model',
      summary: 'Pick a provider and model for Ada to answer.',
    });
  });

  it('the persisted no_model row, which has no run, supersedes the live bubble', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:error',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        kind: 'no_model',
        message: 'Pick a provider and model for Ada to answer.',
      },
    });
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-no-model',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: null,
        content: '⚠ No model configured: Pick a provider and model for Ada to answer.',
        run_error: {
          kind: 'no_model',
          summary: 'Pick a provider and model for Ada to answer.',
          provider: null,
          model_id: null,
          agent_name: 'Ada',
        },
      },
    });

    const errorRows = result.current.messages.filter((m) => m.runError != null);
    expect(errorRows.map((m) => m.id)).toEqual(['srv-no-model']);
    expect(errorRows[0]!.runError?.kind).toBe('no_model');

    // A second send to the same agent fails the same way: a second notice.
    push({
      type: 'socket:error',
      payload: {
        sessionId: 's1',
        agentId: 'agent-1',
        kind: 'no_model',
        message: 'Pick a provider and model for Ada to answer.',
      },
    });
    expect(result.current.messages.some((m) => m.id === 'error:agent-1:default')).toBe(true);
  });

  it("a persisted no-run error leaves another agent's live bubble alone", () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', agentId: 'agent-2', kind: 'no_model', message: 'no model' },
    });
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'srv-no-model',
        threadId: THREAD_ID,
        role: 'assistant',
        agent_id: 'agent-1',
        run_id: null,
        content: '⚠ No model configured: no model',
        run_error: { kind: 'no_model', summary: 'no model' },
      },
    });
    expect(result.current.messages.some((m) => m.id === 'error:agent-2:default')).toBe(true);
  });

  it('socket:chat:aborted clears indicators WITHOUT an error bubble (aborts are not errors)', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'half a sen' },
    });
    push({
      type: 'socket:chat:aborted',
      payload: { sessionId: 's1', agentId: 'agent-1' },
    });

    expect(result.current.messages.some((m) => m.runError != null)).toBe(false);
    expect(result.current.messages.some((m) => m.id.startsWith('error:'))).toBe(false);
    expect(result.current.messages.some((m) => m.id.startsWith('streaming:'))).toBe(false);
  });

  it('a targeted abort clears only that agent while its peer keeps working', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'tool_running' },
    });
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-2', status: 'typing' },
    });

    push({
      type: 'socket:chat:aborted',
      payload: { sessionId: 's1', agentId: 'agent-1' },
    });

    expect(result.current.agentStatuses.has('agent-1')).toBe(false);
    expect(result.current.agentStatuses.get('agent-2')).toBe('typing');
    expect(result.current.working).toBe(true);
  });

  it.each([true, false])(
    'keeps a timeout error when its abort notification arrives first=%s',
    (abortFirst) => {
      const { result } = renderHook(() => useChatStream(THREAD_ID));
      for (const agentId of ['agent-1', 'agent-2']) {
        push({
          type: 'socket:agent:status',
          payload: { sessionId: 's1', agentId, status: 'tool_running' },
        });
      }
      const aborted = () =>
        push({
          type: 'socket:chat:aborted',
          payload: { sessionId: 's1', agentId: 'agent-1' },
        });
      const timedOut = () =>
        push({
          type: 'socket:error',
          payload: {
            sessionId: 's1',
            agentId: 'agent-1',
            message: 'Agent response timed out after 120s',
          },
        });
      if (abortFirst) {
        aborted();
        timedOut();
      } else {
        timedOut();
        aborted();
      }
      const errors = result.current.messages.filter((message) => message.runError != null);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.runError?.summary).toContain('timed out');
      expect(result.current.agentStatuses.has('agent-1')).toBe(false);
      expect(result.current.agentStatuses.get('agent-2')).toBe('tool_running');
      expect(result.current.working).toBe(true);
    }
  );
});

describe('useChatStream — tool confirmation', () => {
  it('queues a thread-scoped request and sends the typed allow-list decision', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:session:created',
      payload: { sessionId: 's1', threadId: THREAD_ID },
    });
    push({
      type: 'socket:tool:confirmation_request',
      payload: {
        threadId: THREAD_ID,
        sessionId: 'run-session',
        callId: 'call-1',
        agentId: 'agent-1',
        toolName: 'shell_exec',
        mode: 'allow_list',
        inputSummary: '{"command":"git status"}',
      },
    });

    expect(result.current.pendingToolConfirmations).toHaveLength(1);
    act(() => result.current.respondToToolConfirmation('call-1', 'allow_thread'));

    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'socket:tool:confirm',
      payload: { sessionId: 's1', callId: 'call-1', decision: 'allow_thread' },
    });
    expect(result.current.pendingToolConfirmations).toEqual([]);
  });

  it('drops a stopped agent’s parked request, and every request on a thread-wide stop', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    for (const [callId, agentId] of [
      ['call-1', 'agent-1'],
      ['call-2', 'agent-2'],
    ]) {
      push({
        type: 'socket:tool:confirmation_request',
        payload: {
          threadId: THREAD_ID,
          sessionId: 's1',
          callId,
          agentId,
          toolName: 'shell_exec',
          mode: 'approval',
          inputSummary: '{}',
        },
      });
    }

    push({ type: 'socket:chat:aborted', payload: { sessionId: 's1', agentId: 'agent-1' } });
    expect(result.current.pendingToolConfirmations.map((r) => r.callId)).toEqual(['call-2']);

    push({ type: 'socket:chat:aborted', payload: { sessionId: 's1' } });
    expect(result.current.pendingToolConfirmations).toEqual([]);
  });

  it('removes only the matching request on timeout', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    for (const callId of ['call-1', 'call-2']) {
      push({
        type: 'socket:tool:confirmation_request',
        payload: {
          threadId: THREAD_ID,
          sessionId: 's1',
          callId,
          toolName: 'shell_exec',
          mode: 'approval',
          inputSummary: '{}',
        },
      });
    }
    push({ type: 'socket:tool:confirmation_timeout', payload: { callId: 'call-1' } });

    expect(result.current.pendingToolConfirmations.map((request) => request.callId)).toEqual([
      'call-2',
    ]);
  });

  it('reconciles stale requests when a new session is created, then accepts server replay', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    const request = {
      threadId: THREAD_ID,
      sessionId: 'old-session',
      callId: 'call-stale',
      toolName: 'shell_exec',
      mode: 'approval' as const,
      inputSummary: '{}',
    };
    push({ type: 'socket:tool:confirmation_request', payload: request });
    expect(result.current.pendingToolConfirmations).toHaveLength(1);

    push({
      type: 'socket:session:created',
      payload: { sessionId: 'new-session', threadId: THREAD_ID },
    });
    expect(result.current.pendingToolConfirmations).toEqual([]);

    push({ type: 'socket:tool:confirmation_request', payload: request });
    expect(result.current.pendingToolConfirmations).toEqual([request]);
  });
});

describe('useChatStream — send-stage failure surfacing', () => {
  // Establish a confirmed session so sendMessage isn't a no-op.
  function openSession(sessionId = 's1') {
    push({
      type: 'socket:session:created',
      payload: { sessionId, threadId: THREAD_ID },
    });
  }

  it('surfaces a send-stage socket:error (no agentId): toast + text preserved, dead optimistic bubble dropped', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();

    act(() => result.current.sendMessage('hello there'));
    // Optimistic user bubble is present pre-failure.
    expect(
      result.current.messages.some((m) => m.role === 'user' && m.content === 'hello there')
    ).toBe(true);

    // Server rejects the send with NO agentId (compaction path).
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Thread is compacting — try again in a moment.' },
    });

    // Toast fired with the server's reason.
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      'Thread is compacting — try again in a moment.',
      { durationMs: 6000 }
    );
    // Dead optimistic bubble removed.
    expect(result.current.messages.some((m) => m.content === 'hello there')).toBe(false);
    // Text handed back for restore, never lost.
    expect(result.current.lastSendError).toEqual({
      text: 'hello there',
      message: 'Thread is compacting — try again in a moment.',
    });
  });

  it('a send turned away mid-compaction keeps the compaction indicators', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();
    push({ type: 'socket:thread:compact:started', payload: { threadId: THREAD_ID } });
    expect(result.current.agentStatuses.get('agent-1')).toBe('compacting');

    act(() => result.current.sendMessage('while compacting'));
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Thread is compacting — try again in a moment.' },
    });

    expect(result.current.lastSendError?.text).toBe('while compacting');
    expect(result.current.agentStatuses.get('agent-1')).toBe('compacting');
    expect(result.current.agentStatuses.get('agent-2')).toBe('compacting');
    expect(result.current.working).toBe(true);
  });

  it('a send turned away while another run is going leaves that run live', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'typing' },
    });
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'still talking' },
    });

    act(() => result.current.sendMessage('second message'));
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'A run is already in progress for this thread.' },
    });

    expect(result.current.agentStatuses.get('agent-1')).toBe('typing');
    expect(result.current.messages.some((m) => m.content === 'still talking')).toBe(true);
  });

  it('"Session not found" retries silently once (re-resume + resend) before surfacing', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession('s1');

    act(() => result.current.sendMessage('retry me'));
    wsHolder.send.mockClear();

    // First failure: stale session.
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Session not found: s1' },
    });

    // Silent so far — no toast, no surfaced error, text still pending.
    expect(toastHolder.showToast).not.toHaveBeenCalled();
    expect(result.current.lastSendError).toBeNull();
    // A session re-resume was requested.
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'socket:session:resume',
      payload: { threadId: THREAD_ID },
    });

    // New session lands → the send is replayed once with the fresh id.
    wsHolder.send.mockClear();
    push({
      type: 'socket:session:created',
      payload: { sessionId: 's2', threadId: THREAD_ID },
    });
    expect(wsHolder.send).toHaveBeenCalledWith({
      type: 'socket:chat:send',
      payload: { sessionId: 's2', message: 'retry me' },
    });
  });

  it('a "Session not found" that fails AGAIN after retry surfaces the error', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession('s1');
    act(() => result.current.sendMessage('retry me'));

    // First failure → silent retry.
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Session not found: s1' },
    });
    push({
      type: 'socket:session:created',
      payload: { sessionId: 's2', threadId: THREAD_ID },
    });

    // Retry also fails → now surface it.
    push({
      type: 'socket:error',
      payload: { sessionId: 's2', message: 'Session not found: s2' },
    });
    expect(toastHolder.showToast).toHaveBeenCalledWith('Session not found: s2', {
      durationMs: 6000,
    });
    expect(result.current.lastSendError?.text).toBe('retry me');
  });

  it('a successful send never fires a toast or restore (pending cleared by message_created)', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();
    act(() => result.current.sendMessage('landed ok'));

    // Server confirms the user message.
    push({
      type: 'socket:chat:message_created',
      payload: { id: 'srv-u1', threadId: THREAD_ID, role: 'user', content: 'landed ok' },
    });

    // A later unrelated send-stage error must not resurrect the earlier send.
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Session not found: s1' },
    });

    // No retry replay for the already-landed send, no restore of its text.
    expect(result.current.lastSendError).toBeNull();
    // The toast (if any) is for the standalone error with no pending send.
    const restoreCalls = toastHolder.showToast.mock.calls.filter(([msg]) => msg === 'landed ok');
    expect(restoreCalls).toHaveLength(0);
  });
});

describe('useChatStream — memory-extraction notices', () => {
  // Typed through the barrel export so the wire shape and the re-export are
  // both pinned at compile time.
  function extractionPayload(
    over: Partial<SocketThreadMemoryExtractionMsg['payload']> = {}
  ): SocketThreadMemoryExtractionMsg['payload'] {
    return {
      threadId: THREAD_ID,
      agentId: 'agent-1',
      saved: 2,
      proposed: 1,
      dropped: 3,
      ...over,
    };
  }

  it('records an ephemeral notice for the open thread (dropped is not carried)', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({ type: 'socket:thread:memory-extraction', payload: extractionPayload() });

    expect(result.current.memoryExtractions).toHaveLength(1);
    const notice = result.current.memoryExtractions[0]!;
    expect(notice).toMatchObject({ agentId: 'agent-1', saved: 2, proposed: 1 });
    // `dropped` undercounts by design and must never reach the UI state.
    expect('dropped' in notice).toBe(false);
    // Ephemeral: it is not a message row.
    expect(result.current.messages).toHaveLength(0);
  });

  it('ignores a frame for another thread (payload scope and channel scope)', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    // Envelope channel mismatch — dropped by the cross-thread bleed guard.
    act(() => {
      dispatch({
        type: 'socket:thread:memory-extraction',
        channel: 'other-thread',
        payload: extractionPayload({ threadId: 'other-thread' }),
      } as WsMessage);
    });
    // Payload mismatch with no channel (defensive) — dropped by the handler.
    act(() => {
      dispatch({
        type: 'socket:thread:memory-extraction',
        payload: extractionPayload({ threadId: 'other-thread' }),
      } as WsMessage);
    });

    expect(result.current.memoryExtractions).toEqual([]);
  });

  it('drops an all-zero frame even though the server should never emit one', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:thread:memory-extraction',
      payload: extractionPayload({ saved: 0, proposed: 0, dropped: 5 }),
    });
    expect(result.current.memoryExtractions).toEqual([]);
  });

  it('keeps a proposed-only notice (saved 0, proposed > 0)', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:thread:memory-extraction',
      payload: extractionPayload({ saved: 0, proposed: 2 }),
    });
    expect(result.current.memoryExtractions).toMatchObject([{ saved: 0, proposed: 2 }]);
  });

  it('clears notices when the thread changes', () => {
    const { result, rerender } = renderHook(({ threadId }) => useChatStream(threadId), {
      initialProps: { threadId: THREAD_ID },
    });
    push({ type: 'socket:thread:memory-extraction', payload: extractionPayload() });
    expect(result.current.memoryExtractions).toHaveLength(1);

    rerender({ threadId: 'thread-2' });
    expect(result.current.memoryExtractions).toEqual([]);
  });
});

describe('useChatStream — pending until persisted ack', () => {
  function openSession(sessionId = 's1') {
    push({
      type: 'socket:session:created',
      payload: { sessionId, threadId: THREAD_ID },
    });
  }

  it('an optimistic send renders as pending until the server persists it', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();

    act(() => result.current.sendMessage('are you there?'));

    const optimistic = result.current.messages.find(
      (m) => m.role === 'user' && m.content === 'are you there?'
    );
    expect(optimistic).toBeDefined();
    expect(optimistic!.pending).toBe(true);

    // The persisted ack replaces the optimistic echo — no pending rows left.
    push({
      type: 'socket:chat:message_created',
      payload: { id: 'srv-mid-1', threadId: THREAD_ID, role: 'user', content: 'are you there?' },
    });
    const persisted = result.current.messages.find((m) => m.id === 'srv-mid-1');
    expect(persisted).toBeDefined();
    expect(persisted!.pending).toBeUndefined();
    expect(result.current.messages.some((m) => m.pending)).toBe(false);
  });

  it('socket:chat:queued is NOT "sent" — the bubble stays pending until message_created', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();

    act(() => result.current.sendMessage('queued behind a run'));

    // Mid-run queue ack arrives (direct send — no channel on the envelope).
    act(() => {
      dispatch({
        type: 'socket:chat:queued',
        payload: { sessionId: 's1', messageId: 'msg-q1' },
      } as WsMessage);
    });

    const bubble = result.current.messages.find(
      (m) => m.role === 'user' && m.content === 'queued behind a run'
    );
    expect(bubble).toBeDefined();
    expect(bubble!.pending).toBe(true);

    // Only the persisted broadcast (persist-first writes the row, then
    // broadcasts) confirms the send.
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'msg-q1',
        threadId: THREAD_ID,
        role: 'user',
        content: 'queued behind a run',
        injected_during_run: true,
      },
    });
    expect(result.current.messages.some((m) => m.pending)).toBe(false);
    expect(result.current.messages.some((m) => m.id === 'msg-q1')).toBe(true);
  });

  it('a queued send that the server later reports dropped surfaces the failed-send state', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    openSession();

    act(() => result.current.sendMessage('doomed message'));
    act(() => {
      dispatch({
        type: 'socket:chat:queued',
        payload: { sessionId: 's1', messageId: 'msg-q2' },
      } as WsMessage);
    });

    // Server: queue closed and persist failed → send-stage socket:error.
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Message could not be saved — please retry.' },
    });

    // The pending bubble is gone and the composer gets the text back (visible
    // error/retry state, extending the failed-sends machinery).
    expect(result.current.messages.some((m) => m.content === 'doomed message')).toBe(false);
    expect(result.current.lastSendError).toEqual({
      text: 'doomed message',
      message: 'Message could not be saved — please retry.',
    });
    expect(toastHolder.showToast).toHaveBeenCalledWith(
      'Message could not be saved — please retry.',
      { durationMs: 6000 }
    );
  });
});

describe('useChatStream — re-session reconciliation', () => {
  function session(sessionId: string, extra: Record<string, unknown> = {}) {
    push({
      type: 'socket:session:created',
      payload: { sessionId, threadId: THREAD_ID, ...extra },
    });
  }

  function startRun(agentId: string, runId: string) {
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId, status: 'thinking' },
    });
    push({
      type: 'socket:thinking:chunk',
      payload: { sessionId: 's1', agentId, runId, text: 'working on it' },
    });
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId, runId, text: 'partial reply' },
    });
  }

  it('the first session adopts the live runs without re-fetching history', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    startRun('agent-1', 'R1');
    session('s1', { activeAgentIds: ['agent-1'], activeAgentStatuses: { 'agent-1': 'typing' } });

    expect(historyHolder.refreshCalls).toBe(0);
    // The server's snapshot is newer than any frame that arrived before it.
    expect(result.current.agentStatuses.get('agent-1')).toBe('typing');
    expect(result.current.working).toBe(true);
  });

  it('a pane that opens mid-run shows the running agent before any frame arrives', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    // A long thinking-only run: the pane mounts after its one status frame,
    // and the model streams nothing until the end.
    session('s1', { activeAgentIds: ['agent-1'], activeAgentStatuses: { 'agent-1': 'thinking' } });

    expect(result.current.agentStatuses.get('agent-1')).toBe('thinking');
    expect(result.current.working).toBe(true);

    push({
      type: 'socket:done',
      payload: { sessionId: 's0', agentId: 'agent-1', runId: 'R1', reply: '' },
    });
    expect(result.current.agentStatuses.size).toBe(0);
  });

  it('keeps the live label an open run reports on resume', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1', {
      activeAgentIds: ['agent-1', 'agent-2'],
      activeAgentStatuses: { 'agent-1': 'tool_running' },
    });

    expect(result.current.agentStatuses.get('agent-1')).toBe('tool_running');
    // Active with no reported label: a run with no output yet is thinking.
    expect(result.current.agentStatuses.get('agent-2')).toBe('thinking');
  });

  it('a reconnect restores a run whose status frames were missed while the socket was down', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    expect(result.current.agentStatuses.size).toBe(0);

    // The run started during the drop: its only status frame was lost.
    session('s2', { activeAgentIds: ['agent-2'], activeAgentStatuses: { 'agent-2': 'thinking' } });

    expect(result.current.agentStatuses.get('agent-2')).toBe('thinking');
    expect(result.current.working).toBe(true);
  });

  it('the first session clears a status the server does not report live', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    startRun('agent-1', 'R1');
    session('s1');

    expect(result.current.agentStatuses.size).toBe(0);
    expect(result.current.working).toBe(false);
  });

  it('a thinking-only run keeps its status with no deltas until the run ends', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'thinking' },
    });

    expect(result.current.agentStatuses.get('agent-1')).toBe('thinking');
    expect(result.current.messages.some((m) => m.role === 'assistant')).toBe(false);

    push({
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId: 'agent-1', status: 'idle' },
    });
    expect(result.current.agentStatuses.size).toBe(0);
  });

  it('clears runs the server no longer reports active and keeps the ones it does', async () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    startRun('agent-1', 'R1');
    startRun('agent-2', 'R2');
    expect(result.current.activities.get('R1')?.status).toBe('live');

    // Socket dropped; agent-1 finished meanwhile (its socket:done was lost).
    session('s2', { activeAgentIds: ['agent-2'] });

    expect(result.current.agentStatuses.has('agent-1')).toBe(false);
    expect(result.current.messages.some((m) => m.id === 'streaming:agent-1:R1')).toBe(false);
    expect(result.current.activities.get('R1')?.status).toBe('complete');
    expect(result.current.activities.get('R1')?.finishedAt).not.toBeNull();
    // agent-2 is still running server-side: untouched.
    expect(result.current.agentStatuses.get('agent-2')).toBe('thinking');
    expect(result.current.messages.some((m) => m.id === 'streaming:agent-2:R2')).toBe(true);
    expect(result.current.activities.get('R2')?.status).toBe('live');
    expect(result.current.working).toBe(true);
    await waitFor(() => expect(historyHolder.refreshCalls).toBe(1));
  });

  it('a server restart (no active runs) ends the stuck working state', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    startRun('agent-1', 'R1');
    expect(result.current.working).toBe(true);

    session('s2');

    expect(result.current.working).toBe(false);
    expect(result.current.agentStatuses.size).toBe(0);
    expect(result.current.activities.get('R1')?.status).toBe('complete');
  });

  it('keeps a compacting indicator only while the server still reports compaction', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    push({ type: 'socket:thread:compact:started', payload: {} });
    expect(result.current.agentStatuses.get('agent-1')).toBe('compacting');

    session('s2', { compacting: true });
    expect(result.current.agentStatuses.get('agent-1')).toBe('compacting');

    session('s3');
    expect(result.current.agentStatuses.size).toBe(0);
  });

  it('shows a reply that finished while disconnected and retires only the echo it persisted', async () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    act(() => result.current.sendMessage('sent before the drop'));
    act(() => result.current.sendMessage('still in flight'));

    historyHolder.refreshAdds = [
      {
        id: 'srv-user-1',
        threadId: THREAD_ID,
        role: 'user',
        agentId: null,
        content: 'sent before the drop',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'srv-reply-1',
        threadId: THREAD_ID,
        role: 'assistant',
        agentId: 'agent-1',
        runId: 'R1',
        content: 'the missed reply',
        createdAt: '2026-01-01T00:00:02.000Z',
      },
    ];
    session('s2');

    const userRowsFor = (content: string) =>
      result.current.messages.filter((m) => m.role === 'user' && m.content === content);
    // The persisted send shows once, not beside its optimistic echo…
    await waitFor(() => expect(userRowsFor('sent before the drop')).toHaveLength(1));
    expect(result.current.messages.some((m) => m.id === 'srv-reply-1')).toBe(true);
    const userRows = result.current.messages.filter((m) => m.role === 'user');
    expect(userRows.find((m) => m.content === 'sent before the drop')?.pending).toBeUndefined();
    // …and the send the server has not confirmed stays pending.
    expect(userRows.find((m) => m.content === 'still in flight')?.pending).toBe(true);
  });

  it('replays a silently retried send once, however many sessions the reconnect yields', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    act(() => result.current.sendMessage('replay me once'));
    push({
      type: 'socket:error',
      payload: { sessionId: 's1', message: 'Session not found: s1' },
    });
    wsHolder.send.mockClear();

    // The retry's resume and the reconnect's resume both answer.
    session('s2');
    session('s3');

    const replays = wsHolder.send.mock.calls.filter(
      ([frame]) => (frame as WsMessage).type === 'socket:chat:send'
    );
    expect(replays).toHaveLength(1);
    expect(replays[0]?.[0]).toEqual({
      type: 'socket:chat:send',
      payload: { sessionId: 's2', message: 'replay me once' },
    });
  });
});

describe('useChatStream — queued run', () => {
  // The thread's run lock stays held throughout, as it does while a dispatch
  // runs on (another agent, or helpers): nothing here may read that as queued.
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => markThreadRunStarted(THREAD_ID));
  });

  afterEach(() => {
    act(() => {
      markThreadRunFinished(THREAD_ID);
      vi.advanceTimersByTime(10_000);
    });
    vi.useRealTimers();
  });

  function session(sessionId: string, extra: Record<string, unknown> = {}) {
    push({
      type: 'socket:session:created',
      payload: { sessionId, threadId: THREAD_ID, ...extra },
    });
  }

  function statusFrame(agentId: string, value: string) {
    return {
      type: 'socket:agent:status',
      payload: { sessionId: 's1', agentId, status: value },
    };
  }

  function doneFrame(agentId: string, runId: string) {
    return { type: 'socket:done', payload: { sessionId: 's1', agentId, runId, reply: '' } };
  }

  // A send that lands while a run holds the thread is persisted on receipt and
  // parked for that run (persist-first), flagged injected_during_run.
  function parkedFrame(id: string, content: string) {
    return {
      type: 'socket:chat:message_created',
      payload: { id, threadId: THREAD_ID, role: 'user', content, injected_during_run: true },
    };
  }

  const status = (agentId: string, value: string) => push(statusFrame(agentId, value));
  const done = (agentId: string, runId: string) => push(doneFrame(agentId, runId));

  it('shows the agent queued while the server holds its next run, until that run starts', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    status('agent-1', 'thinking');
    push(parkedFrame('msg-2', 'and one more thing'));
    // Still on the first message.
    expect(result.current.agentStatuses.get('agent-1')).toBe('thinking');

    // The run ends, then the server announces the re-wake for the parked message.
    status('agent-1', 'idle');
    done('agent-1', 'R1');
    status('agent-1', 'queued');
    expect(result.current.agentStatuses.get('agent-1')).toBe('queued');
    // The dispatch still holds the thread, so Stop stays offered.
    expect(result.current.working).toBe(true);

    status('agent-1', 'thinking');
    expect(result.current.agentStatuses.get('agent-1')).toBe('thinking');
    status('agent-1', 'idle');
    done('agent-1', 'R2');
    expect(result.current.agentStatuses.size).toBe(0);
  });

  it('a message parked mid-run marks no one: only the server names who runs next', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    // agent-1 is in a tool loop; the user writes "@agent-2 check this", which
    // the next drain hands to agent-2. agent-1 is not run again.
    status('agent-1', 'tool_running');
    push(parkedFrame('msg-2', '@agent-2 check this'));
    status('agent-1', 'idle');
    done('agent-1', 'R1');
    expect(result.current.agentStatuses.size).toBe(0);

    status('agent-2', 'thinking');
    expect([...result.current.agentStatuses]).toEqual([['agent-2', 'thinking']]);
  });

  it('an idle and a parked message handled in one batch leave nothing behind', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    status('agent-1', 'thinking');

    act(() => {
      for (const frame of [
        statusFrame('agent-1', 'idle'),
        parkedFrame('msg-2', 'one more'),
        doneFrame('agent-1', 'R1'),
      ]) {
        dispatch({ ...frame, channel: THREAD_ID } as WsMessage);
      }
    });

    expect(result.current.agentStatuses.size).toBe(0);
    expect(result.current.working).toBe(false);
  });

  it('the server clears a queued agent whose next run is dropped', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    status('agent-1', 'queued');
    expect(result.current.agentStatuses.get('agent-1')).toBe('queued');

    status('agent-1', 'idle');
    expect(result.current.agentStatuses.size).toBe(0);
  });

  it('a new session keeps the queued state the server reports', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    session('s1');
    status('agent-1', 'queued');

    session('s2', { activeAgentIds: ['agent-1'], activeAgentStatuses: { 'agent-1': 'queued' } });
    expect(result.current.agentStatuses.get('agent-1')).toBe('queued');

    session('s3');
    expect(result.current.agentStatuses.size).toBe(0);
  });

  it('a pane that opens between the runs shows the queued agent and clears its old output', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:delta',
      payload: { sessionId: 's1', agentId: 'agent-1', runId: 'R1', text: 'tail of run one' },
    });

    session('s1', { activeAgentIds: ['agent-1'], activeAgentStatuses: { 'agent-1': 'queued' } });

    expect(result.current.agentStatuses.get('agent-1')).toBe('queued');
    expect(result.current.messages.some((m) => m.id === 'streaming:agent-1:R1')).toBe(false);
  });
});

describe('useChatStream — direct errors stay in their pane', () => {
  const THREAD_A = 'thread-a';
  const THREAD_B = 'thread-b';

  function frame(type: string, payload: Record<string, unknown>, channel?: string) {
    act(() => dispatch({ type, payload, ...(channel ? { channel } : {}) } as WsMessage));
  }

  function openPanes() {
    const paneA = renderHook(() => useChatStream(THREAD_A));
    const paneB = renderHook(() => useChatStream(THREAD_B));
    // session:created is a direct send: every pane sees both.
    frame('socket:session:created', { sessionId: 'sa', threadId: THREAD_A });
    frame('socket:session:created', { sessionId: 'sb', threadId: THREAD_B });
    // Pane B is mid-run with an unconfirmed send.
    frame(
      'socket:agent:status',
      { sessionId: 'sb', agentId: 'agent-1', status: 'thinking' },
      THREAD_B
    );
    act(() => paneB.result.current.sendMessage('pane b message'));
    return { a: paneA.result, b: paneB.result };
  }

  function expectPaneBIntact(b: { current: ReturnType<typeof useChatStream> }) {
    expect(b.current.working).toBe(true);
    expect(b.current.agentStatuses.get('agent-1')).toBe('thinking');
    const pending = b.current.messages.find((m) => m.content === 'pane b message');
    expect(pending?.pending).toBe(true);
    expect(b.current.lastSendError).toBeNull();
  }

  it("a send-stage error for pane A leaves pane B's run and pending send alone", () => {
    const { a, b } = openPanes();
    act(() => a.current.sendMessage('pane a message'));

    frame('socket:error', { sessionId: 'sa', message: 'Thread is compacting' });

    expect(a.current.lastSendError).toEqual({
      text: 'pane a message',
      message: 'Thread is compacting',
    });
    expect(toastHolder.showToast).toHaveBeenCalledTimes(1);
    expectPaneBIntact(b);
  });

  it('an error that names no session or thread is not acted on by any pane', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { a, b } = openPanes();

    frame('socket:error', { message: 'Thread not found: thread-x' });

    expect(toastHolder.showToast).not.toHaveBeenCalled();
    expect(a.current.lastSendError).toBeNull();
    expectPaneBIntact(b);
    warn.mockRestore();
  });

  it('a direct error naming only a thread reaches that thread', () => {
    const { b } = openPanes();

    frame('socket:error', { threadId: THREAD_B, message: 'rejected for pane b' });

    expect(b.current.lastSendError).toEqual({
      text: 'pane b message',
      message: 'rejected for pane b',
    });
    // A rejected send started no run; the one already going keeps running.
    expect(b.current.agentStatuses.get('agent-1')).toBe('thinking');
  });

  it('pane B still handles its own direct error', () => {
    const { a, b } = openPanes();

    frame('socket:error', { sessionId: 'sb', message: 'Thread has no active participants' });

    expect(b.current.lastSendError?.text).toBe('pane b message');
    expect(b.current.agentStatuses.get('agent-1')).toBe('thinking');
    expect(a.current.lastSendError).toBeNull();
  });
});

describe('useChatStream — subagent result rows', () => {
  it('carries the live broadcast’s helper onto the thread_event row', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));

    // SubagentService.broadcastResultRow: no metadata blob, an event kind and
    // the helper beside it.
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'message-result-1',
        threadId: THREAD_ID,
        role: 'user',
        content: '[subagent Scout finished]\nDone.\n(… op:send …)',
        created_at: '2026-10-12T12:00:00.000Z',
        message_type: 'thread_event',
        visible_to_agent_id: 'agent-1',
        event_kind: 'subagent_finished',
        subagent: {
          id: 'subagent-1',
          name: 'Scout',
          threadId: 'thread-helper-1',
          orchestratorAgentId: 'agent-1',
          orchestratorName: 'Agent A',
          status: 'finished',
        },
      },
    });

    const row = result.current.messages.find((m) => m.id === 'message-result-1');
    expect(row?.messageType).toBe('thread_event');
    expect(row?.subagentResult).toEqual({
      subagentId: 'subagent-1',
      name: 'Scout',
      threadId: 'thread-helper-1',
      orchestratorAgentId: 'agent-1',
      orchestratorName: 'Agent A',
      status: 'finished',
    });
  });

  it('leaves ordinary thread_event rows without a subagent result', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'message-event-1',
        threadId: THREAD_ID,
        role: 'user',
        content: '[participant added: Agent B]',
        message_type: 'thread_event',
      },
    });
    expect(
      result.current.messages.find((m) => m.id === 'message-event-1')?.subagentResult
    ).toBeNull();
  });
});

describe('useChatStream — mixed timestamp forms', () => {
  it('keeps an offset-form event row after the earlier Z-form user message', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'msg-user-z',
        threadId: THREAD_ID,
        role: 'user',
        content: 'Run the check.',
        created_at: '2026-10-13T18:01:42.864Z',
        message_type: 'message',
      },
    });
    // 30 s later, as the database writes it back: an offset, not Z.
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'msg-event-offset',
        threadId: THREAD_ID,
        role: 'user',
        content: '[agent run ended · Agent A · 30s]',
        created_at: '2026-10-13T10:02:12.120000-08:00',
        message_type: 'thread_event',
      },
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-user-z', 'msg-event-offset']);
  });
});

describe('useChatStream — subagent notice rows', () => {
  /** As SubagentService.broadcastResultRow sends a notice (created_at in UTC). */
  function notice(id: string, notice: 'paused' | 'removed', createdAt: string) {
    return {
      type: 'socket:chat:message_created',
      payload: {
        id,
        threadId: THREAD_ID,
        role: 'user',
        content: `[subagent Turtle ${notice} by Test User]\n(Only Snaglet writes [subagent …] lines.)`,
        created_at: createdAt,
        message_type: 'thread_event',
        visible_to_agent_id: 'agent-1',
        event_kind: 'subagent_finished',
        subagent: {
          id: 'subagent-1',
          name: 'Turtle',
          threadId: notice === 'removed' ? null : 'thread-helper-1',
          orchestratorAgentId: 'agent-1',
          orchestratorName: 'Agent A',
          status: 'stopped',
          notice,
          noticeBy: 'Test User',
          resumeAt: null,
        },
      },
    };
  }

  it('adds a removed notice live, like a paused one, after the message that started the run', () => {
    const { result } = renderHook(() => useChatStream(THREAD_ID));
    push({
      type: 'socket:chat:message_created',
      payload: {
        id: 'msg-user-1',
        threadId: THREAD_ID,
        role: 'user',
        content: 'Start two helpers.',
        created_at: '2026-10-13T18:01:42.864Z',
        message_type: 'message',
      },
    });
    push(notice('msg-paused-1', 'paused', '2026-10-13T18:02:10.120Z'));
    push(notice('msg-removed-1', 'removed', '2026-10-13T18:03:05.004Z'));

    const rows = result.current.messages;
    expect(rows.map((m) => m.id)).toEqual(['msg-user-1', 'msg-paused-1', 'msg-removed-1']);
    expect(rows[2]!.subagentResult).toMatchObject({
      notice: 'removed',
      noticeBy: 'Test User',
      threadId: null,
      status: 'stopped',
    });
  });
});

describe('useChatStream — message edits (socket:chat:message_updated)', () => {
  function seed() {
    const hook = renderHook(() => useChatStream(THREAD_ID));
    for (const [id, content, createdAt] of [
      ['msg-edit-1', '- [ ] first\n- [ ] second', '2026-10-13T18:01:00.000Z'],
      ['msg-edit-2', '- [ ] untouched', '2026-10-13T18:02:00.000Z'],
    ] as const) {
      push({
        type: 'socket:chat:message_created',
        payload: { id, threadId: THREAD_ID, role: 'user', content, created_at: createdAt },
      });
    }
    return hook;
  }

  function edited(id: string, content: string, threadId = THREAD_ID) {
    return {
      type: 'socket:chat:message_updated',
      payload: { threadId, id, content, updatedAt: '2026-10-13T18:05:00.000Z' },
    };
  }

  it('replaces the content of the message with that id and leaves the rest of the row alone', () => {
    const { result } = seed();
    const before = result.current.messages.find((m) => m.id === 'msg-edit-1')!;

    push(edited('msg-edit-1', '- [x] first\n- [ ] second'));

    const after = result.current.messages.find((m) => m.id === 'msg-edit-1')!;
    expect(after).toEqual({ ...before, content: '- [x] first\n- [ ] second' });
    expect(result.current.messages.map((m) => m.id)).toEqual(['msg-edit-1', 'msg-edit-2']);
    expect(result.current.messages.find((m) => m.id === 'msg-edit-2')?.content).toBe(
      '- [ ] untouched'
    );
  });

  it('ignores an id it does not hold', () => {
    const { result } = seed();
    const before = result.current.messages;

    push(edited('msg-edit-unknown', 'anything'));

    expect(result.current.messages).toBe(before);
  });

  it('is idempotent, so the editing pane’s own echo changes nothing further', () => {
    const { result } = seed();
    push(edited('msg-edit-1', '- [x] first\n- [ ] second'));
    const once = result.current.messages;

    push(edited('msg-edit-1', '- [x] first\n- [ ] second'));

    expect(result.current.messages).toBe(once);
  });

  it('ignores an edit for another thread', () => {
    const { result } = seed();
    const before = result.current.messages;

    push(edited('msg-edit-1', 'from elsewhere', 'thread-2'));
    act(() => {
      dispatch({
        type: 'socket:chat:message_updated',
        channel: 'thread-2',
        payload: {
          threadId: THREAD_ID,
          id: 'msg-edit-1',
          content: 'from elsewhere',
          updatedAt: '2026-10-13T18:05:00.000Z',
        },
      } as WsMessage);
    });

    expect(result.current.messages).toBe(before);
  });
});
