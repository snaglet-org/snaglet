/**
 * Per-frame handlers that drive a run's live mechanics: streaming deltas +
 * thinking, tool call/result, token usage, agent status, model fallback,
 * compaction, session lifecycle, dispatch hints, and the Ask /
 * tool-confirmation prompts. Called from `useChatStream`'s frame switch;
 * each receives the hook's setters + refs through {@link FrameHandlerCtx}
 * and closes over nothing.
 */
import type {
  ClarificationRequestPayload,
  SocketAgentStatusMsg,
  SocketSessionCreatedMsg,
  SocketThreadMemoryExtractionMsg,
  ToolConfirmationRequestPayload,
  WsMessage,
} from '@snaglet/shared/types';
import { isoNow } from '@snaglet/shared/utils';
import {
  appendThinkingChunk,
  discardPendingThinking,
  flushPendingThinking,
  makeRunActivity,
  makeStreamingMessage,
} from './chatStreamHelpers';
import type { ActivityStep, AgentStatus } from './types';
import type { FrameHandlerCtx } from './chatStreamFrameContext';

/** Enough to cover every reconnect in a long-lived pane; older ids are long dead server-side. */
const MAX_OWN_SESSION_IDS = 16;

export function handleSessionCreated(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const {
    threadId,
    setPendingClarification,
    setPendingToolConfirmations,
    setSessionId,
    pendingSendRef,
    retryTimerRef,
    ownSessionIdsRef,
    resyncHistory,
    send,
  } = ctx;
  const p = raw.payload as SocketSessionCreatedMsg['payload'];
  if (p.threadId !== threadId) return;
  const ownSessions = ownSessionIdsRef.current;
  // The first session is the pane opening, with nothing local to correct.
  // Any later one follows a reconnect, a server restart or a roster change,
  // and frames may have been missed in between.
  const isResession = ownSessions.size > 0;
  ownSessions.add(p.sessionId);
  for (const id of ownSessions) {
    if (ownSessions.size <= MAX_OWN_SESSION_IDS) break;
    ownSessions.delete(id);
  }
  // A new session may follow a server restart, which loses in-memory
  // parked interactions. Clear stale local panels first; the server
  // immediately replays every still-pending request after this event.
  setPendingClarification(null);
  setPendingToolConfirmations([]);
  setSessionId(p.sessionId);
  // Every session, the first included, carries the server's live runs: a pane
  // that opens or reconnects mid-run missed the status frames sent earlier.
  reconcileRunsWithServer(p, ctx);
  if (isResession) resyncHistory();
  // Silent-retry resend: after a "Session not found" error re-resumed the
  // session, resend once with the new sessionId. Gated on retriedOnce so an
  // unrelated reconnect or initial resume never replays an old send.
  const pending = pendingSendRef.current;
  if (pending && pending.retriedOnce && !pending.resent) {
    pending.resent = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    send({
      type: 'socket:chat:send',
      payload: {
        sessionId: p.sessionId,
        message: pending.text,
      },
    });
  }
}

/**
 * Adopt the agent statuses the server reports for the thread when a session
 * starts: running, starting (context assembly) or queued for another run.
 *
 * The server reads them from its in-memory run state just before sending the
 * session, so they are newer than any frame that arrived before it, and every
 * later frame arrives after it. Each reported agent gets the reported status
 * (thinking when it names none); terminal frames that fired while the socket
 * was down are lost, so every other run indicator is cleared, as is the live
 * output of a queued agent's finished run. A compaction indicator stays only
 * while the server reports one.
 */
function reconcileRunsWithServer(
  session: SocketSessionCreatedMsg['payload'],
  ctx: FrameHandlerCtx
): void {
  const { setAgentStatuses, setStreaming, setActivities } = ctx;
  const reported = session.activeAgentStatuses ?? {};
  const shown = new Set(session.activeAgentIds ?? []);
  const running = new Set([...shown].filter((agentId) => reported[agentId] !== 'queued'));
  const compacting = session.compacting === true;
  const finishedAt = isoNow();
  setAgentStatuses((prev) => {
    const next = new Map<string, AgentStatus>();
    for (const [agentId, status] of prev) {
      if (status === 'compacting' && compacting) next.set(agentId, status);
    }
    for (const agentId of shown) {
      if (next.has(agentId)) continue;
      const known = prev.get(agentId);
      next.set(
        agentId,
        reported[agentId] ?? (known && known !== 'compacting' ? known : 'thinking')
      );
    }
    return sameStatuses(prev, next) ? prev : next;
  });
  setStreaming((prev) => {
    let next: typeof prev | null = null;
    for (const [key, stream] of prev) {
      if (running.has(stream.agentId)) continue;
      next ??= new Map(prev);
      next.delete(key);
    }
    return next ?? prev;
  });
  setActivities((prev) => {
    let next: typeof prev | null = null;
    for (const [runId, run] of prev) {
      if (run.status !== 'live' || running.has(run.agentId)) continue;
      next ??= new Map(prev);
      next.set(runId, { ...flushPendingThinking(run), status: 'complete', finishedAt });
    }
    return next ?? prev;
  });
}

function sameStatuses(a: Map<string, AgentStatus>, b: Map<string, AgentStatus>): boolean {
  if (a.size !== b.size) return false;
  for (const [agentId, status] of a) if (b.get(agentId) !== status) return false;
  return true;
}

export function handleDelta(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, correlation, setStreaming } = ctx;
  const p = raw.payload as {
    sessionId: string;
    text: string;
    agentId?: string;
    runId?: string;
  };
  if (!p.agentId) return;
  const agentId = p.agentId;
  const runId = p.runId ?? 'default';
  correlation.sessionAgent.current.set(p.sessionId, agentId);
  correlation.runByAgent.current.set(agentId, runId);
  const key = `${agentId}:${runId}`;
  setStreaming((prev) => {
    const existing = prev.get(key) ?? makeStreamingMessage(threadId, agentId, runId);
    const next = new Map(prev);
    next.set(key, { ...existing, content: existing.content + p.text });
    return next;
  });
}

export function handleStreamRetry(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { correlation, setStreaming, setActivities } = ctx;
  const p = raw.payload as {
    sessionId: string;
    agentId: string;
    runId?: string | null;
  };
  const runId = p.runId ?? correlation.runByAgent.current.get(p.agentId) ?? 'default';
  const key = `${p.agentId}:${runId}`;
  setStreaming((prev) => {
    if (!prev.has(key)) return prev;
    const next = new Map(prev);
    next.delete(key);
    return next;
  });
  setActivities((prev) => {
    const existing = prev.get(runId);
    if (!existing) return prev;
    const reset = discardPendingThinking(existing);
    if (reset === existing) return prev;
    const next = new Map(prev);
    if (reset.steps.length === 0) next.delete(runId);
    else next.set(runId, reset);
    return next;
  });
}

export function handleThinkingChunk(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, correlation, setStreaming, setActivities } = ctx;
  const p = raw.payload as {
    sessionId: string;
    agentId?: string;
    text: string;
    runId?: string;
  };
  if (!p.agentId) return;
  const agentId = p.agentId;
  const runId = p.runId ?? 'default';
  correlation.sessionAgent.current.set(p.sessionId, agentId);
  correlation.runByAgent.current.set(agentId, runId);
  const key = `${agentId}:${runId}`;
  setStreaming((prev) => {
    const existing = prev.get(key) ?? makeStreamingMessage(threadId, agentId, runId);
    const next = new Map(prev);
    next.set(key, {
      ...existing,
      thinkingContent: existing.thinkingContent + p.text,
    });
    return next;
  });
  setActivities((prev) => {
    const existing = prev.get(runId) ?? makeRunActivity(threadId, agentId, runId);
    const next = new Map(prev);
    next.set(runId, appendThinkingChunk(existing, p.text));
    return next;
  });
}

export function handleToolCall(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, correlation, setStreaming, setActivities } = ctx;
  const p = raw.payload as {
    sessionId: string;
    callId: string;
    agentId?: string;
    runId?: string | null;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
  // The server stamps agentId + runId on the broadcast (see
  // runAgentTurn.ts). Falls back to session-based correlation when they are
  // absent, which can pick a previous run if no delta has arrived yet.
  const agentId = p.agentId ?? correlation.sessionAgent.current.get(p.sessionId);
  if (!agentId) return;
  const runId = p.runId ?? correlation.runByAgent.current.get(agentId) ?? 'default';
  correlation.callMeta.current.set(p.callId, {
    agentId,
    runId,
    toolName: p.toolName,
  });
  const key = `${agentId}:${runId}`;
  // Text streamed before a tool call is its own persisted utterance (via
  // socket:chat:message_created), so it is not copied into the activity
  // bubble. The accumulator's text is still reset here, so if message_created
  // is late the next deltas start a clean bubble.
  setStreaming((prev) => {
    const existing = prev.get(key) ?? makeStreamingMessage(threadId, agentId, runId);
    const next = new Map(prev);
    next.set(key, {
      ...existing,
      content: '',
      toolActivity: [
        ...existing.toolActivity,
        {
          callId: p.callId,
          toolName: p.toolName,
          input: p.toolInput ?? {},
        },
      ],
    });
    return next;
  });
  setActivities((prev) => {
    const existing = prev.get(runId) ?? makeRunActivity(threadId, agentId, runId);
    // Flush any open thinking block — a tool call closes the
    // previous thinking phase.
    const updated = flushPendingThinking(existing);
    const toolStep: ActivityStep = {
      kind: 'tool_call',
      id: p.callId,
      toolName: p.toolName,
      input: p.toolInput ?? {},
      status: 'running',
      createdAt: isoNow(),
    };
    const next = new Map(prev);
    next.set(runId, { ...updated, steps: [...updated.steps, toolStep] });
    return next;
  });
}

export function handleToolResult(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { correlation, setStreaming, setActivities, setPendingToolConfirmations } = ctx;
  const p = raw.payload as {
    sessionId: string;
    callId: string;
    agentId?: string;
    runId?: string | null;
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
  };
  setPendingToolConfirmations((prev) => prev.filter((request) => request.callId !== p.callId));
  // Prefer meta we stashed at tool:call time, but fall through
  // to payload agentId/runId for results that arrive without a
  // matching call (rare — happens when the server emits a
  // failure path that skips the call envelope).
  let meta = correlation.callMeta.current.get(p.callId);
  if (!meta && p.agentId) {
    meta = {
      agentId: p.agentId,
      runId: p.runId ?? 'default',
      toolName: 'tool',
    };
  }
  if (!meta) return;
  correlation.callMeta.current.delete(p.callId);
  const key = `${meta.agentId}:${meta.runId}`;
  const { runId } = meta;
  setStreaming((prev) => {
    const existing = prev.get(key);
    if (!existing) return prev;
    const next = new Map(prev);
    next.set(key, {
      ...existing,
      toolActivity: existing.toolActivity.map((entry) =>
        entry.callId === p.callId
          ? {
              ...entry,
              output: p.output,
              error: p.error,
              success: p.success,
              durationMs: p.durationMs,
            }
          : entry
      ),
    });
    return next;
  });
  setActivities((prev) => {
    const existing = prev.get(runId);
    if (!existing) return prev;
    const next = new Map(prev);
    next.set(runId, {
      ...existing,
      steps: existing.steps.map((step) =>
        step.kind === 'tool_call' && step.id === p.callId
          ? {
              ...step,
              output: p.output,
              error: p.error,
              success: p.success,
              durationMs: p.durationMs,
              status: 'done',
            }
          : step
      ),
    });
    return next;
  });
}

export function handleDispatchHint(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, setDispatchHint } = ctx;
  const p = raw.payload as { sessionId: string; threadId: string; message: string };
  if (p.threadId === threadId) setDispatchHint(p.message);
}

// Model fallback: the provider switch abandons the warm
// prompt cache — surface it inline in the agent's run bubble instead
// of a silent model swap.
export function handleModelFallback(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, correlation, setActivities } = ctx;
  const p = raw.payload as {
    sessionId: string;
    agentId: string;
    fromProviderId: string;
    fromModelId: string;
    toProviderId: string;
    toModelId: string;
    reason?: string;
    cacheReset?: boolean;
    estWastedCacheTokens?: number;
  };
  const runId = correlation.runByAgent.current.get(p.agentId) ?? 'default';
  const wasted =
    p.estWastedCacheTokens && p.estWastedCacheTokens > 0
      ? ` (~${p.estWastedCacheTokens.toLocaleString()} cached tokens abandoned)`
      : '';
  const noteStep: ActivityStep = {
    kind: 'note',
    id: `fallback:${runId}:${isoNow()}`,
    text:
      `Cache reset — fell back from ${p.fromProviderId}/${p.fromModelId} ` +
      `to ${p.toProviderId}/${p.toModelId}${wasted}` +
      (p.reason ? `: ${p.reason}` : ''),
    createdAt: isoNow(),
  };
  setActivities((prev) => {
    const existing = prev.get(runId) ?? makeRunActivity(threadId, p.agentId, runId);
    const flushed = flushPendingThinking(existing);
    const next = new Map(prev);
    next.set(runId, { ...flushed, steps: [...flushed.steps, noteStep] });
    return next;
  });
}

export function handleAgentStatus(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { correlation, setAgentStatuses } = ctx;
  const p = raw.payload as SocketAgentStatusMsg['payload'];
  // Status is the earliest signal that tells us which agent is
  // active on a session — register it here so a tool:call that
  // arrives before the first delta/thinking can still be
  // attributed. A queued agent is not active yet.
  if (p.status !== 'idle' && p.status !== 'queued') {
    correlation.sessionAgent.current.set(p.sessionId, p.agentId);
  }
  setAgentStatuses((prev) => {
    const next = new Map(prev);
    if (p.status === 'idle') next.delete(p.agentId);
    else next.set(p.agentId, p.status);
    return next;
  });
}

// Compaction is normally thread-scoped (one summary per participant)
// but the per-agent REST path (ContextWindowPanel's Compact button)
// emits the same events with `agentId` set. When present, only that
// agent flips to 'compacting'; otherwise mark all participants.
// compact:* events broadcast on the thread channel so the channel
// guard above already scoped this to us.
export function handleCompactStarted(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { participantAgentIds, setAgentStatuses } = ctx;
  const p = raw.payload as { agentId?: string };
  setAgentStatuses((prev) => {
    const next = new Map(prev);
    if (p.agentId) {
      next.set(p.agentId, 'compacting');
    } else {
      for (const id of participantAgentIds) next.set(id, 'compacting');
    }
    return next;
  });
}

export function handleCompactProgress(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { setAgentStatuses } = ctx;
  const p = raw.payload as { agentId: string };
  setAgentStatuses((prev) => {
    if (prev.get(p.agentId) !== 'compacting') return prev;
    const next = new Map(prev);
    next.delete(p.agentId);
    return next;
  });
}

export function handleCompactCompleteOrError(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { setAgentStatuses } = ctx;
  const p = raw.payload as { agentId?: string };
  setAgentStatuses((prev) => {
    // Per-agent path clears just that agent. Thread-wide path
    // sweeps any remaining 'compacting' entries (some may have
    // already been cleared by :progress events).
    if (p.agentId) {
      if (prev.get(p.agentId) !== 'compacting') return prev;
      const next = new Map(prev);
      next.delete(p.agentId);
      return next;
    }
    let mutated = false;
    const next = new Map(prev);
    for (const [id, status] of next) {
      if (status === 'compacting') {
        next.delete(id);
        mutated = true;
      }
    }
    return mutated ? next : prev;
  });
}

/**
 * Retained ephemeral notices are capped so a long-lived pane on a busy thread
 * cannot grow the array without bound. Compactions are rare; 20 is plenty.
 */
const MAX_MEMORY_EXTRACTION_NOTICES = 20;

/**
 * Compaction-time memory extraction wrote something for one agent: show a
 * "N memories saved · M proposed" meta line. Arrives after
 * `socket:thread:compact:complete`. Not persisted, so it is gone on reload.
 * The payload's `dropped` count is not kept; it undercounts by design.
 */
export function handleMemoryExtraction(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, setMemoryExtractions } = ctx;
  const p = raw.payload as SocketThreadMemoryExtractionMsg['payload'];
  // Scope to this hook's thread: direct sends leave `channel` undefined.
  if (p.threadId !== threadId) return;
  // The server only emits when saved or proposed is non-zero; guard here
  // too so an all-zero frame can never paint "0 memories saved".
  if (!(p.saved > 0) && !(p.proposed > 0)) return;
  const notice = {
    id: `memx:${p.agentId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    agentId: p.agentId,
    saved: p.saved,
    proposed: p.proposed,
    createdAt: isoNow(),
  };
  setMemoryExtractions((prev) => [...prev.slice(-(MAX_MEMORY_EXTRACTION_NOTICES - 1)), notice]);
}

export function handleClarificationRequest(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, setPendingClarification } = ctx;
  const p = raw.payload as ClarificationRequestPayload;
  // Scope to this hook's thread: with several chats open, every
  // pane's listener sees every subscribed thread's broadcasts, and an
  // unscoped set() opened the prompt in whichever chat rendered last.
  if (p.threadId && p.threadId !== threadId) return;
  setPendingClarification(p);
}

export function handleClarificationTimeout(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { setPendingClarification } = ctx;
  const p = raw.payload as { callId?: string };
  setPendingClarification((prev) =>
    prev && (!p.callId || prev.callId === p.callId) ? null : prev
  );
}

export function handleToolConfirmationRequest(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, setPendingToolConfirmations } = ctx;
  const p = raw.payload as ToolConfirmationRequestPayload;
  if (p.threadId !== threadId) return;
  setPendingToolConfirmations((prev) =>
    prev.some((request) => request.callId === p.callId) ? prev : [...prev, p]
  );
}

export function handleToolConfirmationTimeout(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { setPendingToolConfirmations } = ctx;
  const p = raw.payload as { callId?: string };
  setPendingToolConfirmations((prev) =>
    p.callId ? prev.filter((request) => request.callId !== p.callId) : []
  );
}
