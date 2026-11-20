/**
 * Per-frame handlers that primarily build, replace, or clear the message
 * transcript (plus the run-complete/error side-effects that ride with
 * those frames). Called from `useChatStream`'s frame switch; each function
 * receives the hook's state setters + refs through {@link FrameHandlerCtx}
 * and closes over nothing.
 */
import {
  normalizeContextPacks,
  normalizeRunError,
  subagentResultFromBroadcast,
} from '@desktop/utils/api/threads';
import type { ThreadMessage } from '@desktop/utils/api';
import type { SocketChatMessageUpdatedMsg, SocketErrorMsg, WsMessage } from '@snaglet/shared/types';
import { isoNow } from '@snaglet/shared/utils';
import { showToast } from '@desktop/utils/toast';
import { doneBubbleId, errorBubbleId, flushPendingThinking } from './chatStreamHelpers';
import type { FrameHandlerCtx } from './chatStreamFrameContext';

export function handleMessageCreated(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, setMessages, setOptimistic, pendingSendRef, retryTimerRef, setStreaming } = ctx;
  const p = raw.payload as {
    id: string;
    threadId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    // Accepts camelCase or snake_case: the user broadcast in
    // chatHandlers.ts sends snake_case.
    messageType?: ThreadMessage['messageType'];
    message_type?: ThreadMessage['messageType'];
    agentId?: string | null;
    agent_id?: string | null;
    runId?: string | null;
    run_id?: string | null;
    createdAt?: string;
    created_at?: string;
    thinkingContent?: string | null;
    toolActivity?: ThreadMessage['toolActivity'];
    injectedDuringRun?: boolean;
    injected_during_run?: boolean;
    linterTargetAgentId?: string | null;
    linter_target_agent_id?: string | null;
    fabricatedIds?: string[] | null;
    fabricated_ids?: string[] | null;
    runError?: ThreadMessage['runError'] | null;
    run_error?: ThreadMessage['runError'] | null;
    contextPacks?: Record<string, string> | null;
    context_packs?: Record<string, string> | null;
    externalSender?: ThreadMessage['externalSender'];
    external_sender?: ThreadMessage['externalSender'];
    externalSenderLabel?: ThreadMessage['externalSenderLabel'];
    external_sender_label?: ThreadMessage['externalSenderLabel'];
    // A subagent result row (SubagentService.broadcastResultRow): the event
    // kind plus the helper it reports on, in place of the metadata blob.
    event_kind?: string;
    subagent?: unknown;
  };
  if (p.threadId !== threadId) return;
  setMessages((prev) => {
    if (prev.some((m) => m.id === p.id)) return prev;
    const msg: ThreadMessage = {
      id: p.id,
      threadId: p.threadId,
      role: p.role,
      // Carry message_type so thread_event rows render as a meta line, the
      // same as the REST path (normalizeThreadMessage).
      messageType: p.messageType ?? p.message_type ?? 'message',
      agentId: p.agentId ?? p.agent_id ?? null,
      runId: p.runId ?? p.run_id ?? null,
      content: p.content,
      externalSender: p.externalSender ?? p.external_sender ?? null,
      externalSenderLabel: p.externalSenderLabel ?? p.external_sender_label ?? null,
      createdAt: p.createdAt ?? p.created_at ?? isoNow(),
      thinkingContent: p.thinkingContent ?? null,
      toolActivity: p.toolActivity ?? null,
      injectedDuringRun: p.injectedDuringRun ?? p.injected_during_run ?? false,
      linterTargetAgentId: p.linterTargetAgentId ?? p.linter_target_agent_id ?? null,
      fabricatedIds: p.fabricatedIds ?? p.fabricated_ids ?? null,
      runError: normalizeRunError(p.runError ?? p.run_error),
      contextPacks: normalizeContextPacks(p.contextPacks ?? p.context_packs),
      subagentResult: subagentResultFromBroadcast(p.event_kind, p.subagent),
    };
    // A terminal utterance whose message_created arrived after socket:done
    // left a provisional `done:<agent>:<run>` bubble. The server row
    // supersedes it; keep the fallback's usage, wakeDelta and toolActivity
    // (they ride socket:done, not message_created) so they don't vanish
    // until reload.
    if (msg.role === 'assistant' && msg.runId && msg.agentId) {
      const fallbackId = doneBubbleId(msg.agentId, msg.runId);
      const errorId = errorBubbleId(msg.agentId, msg.runId);
      // The persisted row supersedes both provisional bubbles for this run,
      // `done:` and `error:`, so the run never renders twice.
      const fallback = prev.find((m) => m.id === fallbackId);
      const withoutProvisional = prev.filter((m) => m.id !== fallbackId && m.id !== errorId);
      if (fallback) {
        const merged: ThreadMessage = {
          ...msg,
          usage: msg.usage ?? fallback.usage ?? null,
          wakeDelta: msg.wakeDelta ?? fallback.wakeDelta ?? null,
          toolActivity: msg.toolActivity ?? fallback.toolActivity ?? null,
        };
        return [...withoutProvisional, merged];
      }
      return [...withoutProvisional, msg];
    }
    // A failure that started no run (no model) has no run id: its row
    // supersedes the agent's `error:<agent>:default` bubble from socket:error.
    if (msg.role === 'assistant' && msg.runError && !msg.runId && msg.agentId) {
      const errorId = errorBubbleId(msg.agentId, 'default');
      return [...prev.filter((m) => m.id !== errorId), msg];
    }
    return [...prev, msg];
  });
  // Drop the matching optimistic user echo (first content match, so a burst
  // of sends clears in order).
  if (p.role === 'user') {
    const content = p.content;
    setOptimistic((prev) => {
      const idx = prev.findIndex((m) => m.content === content);
      if (idx < 0) return prev;
      return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
    });
    // The "send landed" signal: clear a matching pending send and its retry
    // timer, so a successful send never later fires a toast or restore.
    const pending = pendingSendRef.current;
    if (pending && pending.text === content) {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      pendingSendRef.current = null;
    }
  }
  // This persisted row finalizes the utterance that was streaming, so drop
  // its accumulator. Deleting (not blanking) it means the next deltas start
  // a fresh bubble that sorts after this row. Scoped to agentId:runId; falls
  // back to every accumulator for the agent when run_id is absent.
  if (p.role === 'assistant') {
    const agentId = p.agentId ?? p.agent_id;
    const runId = p.runId ?? p.run_id;
    if (agentId) {
      const targetKey = runId ? `${agentId}:${runId}` : null;
      setStreaming((prev) => {
        const keys = [...prev.keys()].filter((k) =>
          targetKey ? k === targetKey : k.startsWith(`${agentId}:`)
        );
        if (keys.length === 0) return prev;
        const next = new Map(prev);
        for (const k of keys) next.delete(k);
        return next;
      });
    }
  }
}

/**
 * A persisted message's content was edited (PATCH
 * /threads/:threadId/messages/:messageId). Every viewer of the thread gets the
 * frame, the editing pane included. Replacing by id is idempotent, so the
 * editor's own echo only lands the content its bubble already shows. An id
 * this pane has not loaded (outside the paged window, or an unpersisted
 * bubble) is ignored: the next fetch reads the saved content.
 *
 * Only `content` is applied: `ThreadMessage` carries no updatedAt.
 */
export function handleMessageUpdated(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, setMessages } = ctx;
  const p = raw.payload as SocketChatMessageUpdatedMsg['payload'];
  if (p.threadId !== threadId || typeof p.content !== 'string') return;
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === p.id);
    if (idx < 0) return prev;
    const target = prev[idx]!;
    if (target.content === p.content) return prev;
    const next = prev.slice();
    next[idx] = { ...target, content: p.content };
    return next;
  });
}

export function handleDone(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { threadId, streamingRef, setStreaming, setActivities, setMessages, setAgentStatuses } =
    ctx;
  // Every utterance, the terminal reply included, arrives as its own row via
  // socket:chat:message_created. `done` carries run-complete state only
  // (usage, and the signal to clear streaming and status); its `reply` never
  // builds the transcript, except as the fallback below.
  const p = raw.payload as {
    sessionId: string;
    agentId?: string;
    runId?: string;
    reply?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      contextWindowTokens?: number;
      billedInputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      providerCalls?: number;
    };
    // Wake change-delta to render as a block on this message when present.
    wakeDelta?: string | null;
  };
  if (!p.agentId) return;
  const agentId = p.agentId;
  const runId = p.runId ?? 'default';
  const key = `${agentId}:${runId}`;

  const stream = streamingRef.current.get(key);
  setStreaming((prev) => {
    if (!prev.has(key)) return prev;
    const next = new Map(prev);
    next.delete(key);
    return next;
  });
  // Mark this run's activity complete in place; on reload it is re-hydrated
  // from agent_activity_log.
  setActivities((prev) => {
    const existing = prev.get(runId);
    if (!existing) return prev;
    const flushed = flushPendingThinking(existing);
    const next = new Map(prev);
    next.set(runId, {
      ...flushed,
      status: 'complete',
      finishedAt: isoNow(),
    });
    return next;
  });

  // Usually every utterance already arrived, so `stream` is empty. If
  // socket:done beats the terminal message_created, keep the last streamed
  // text (or done.reply, for providers that don't stream) as a provisional
  // `done:<agent>:<run>` bubble; a late message_created supersedes it. Adds
  // nothing when anything for this run is already on screen.
  const leftover = (stream?.content || p.reply || '').trim();
  if (leftover.length > 0) {
    const fallbackId = doneBubbleId(agentId, runId);
    const persisted: ThreadMessage = {
      id: fallbackId,
      threadId: threadId,
      role: 'assistant',
      agentId: agentId,
      runId,
      content: stream?.content || p.reply || leftover,
      createdAt: stream?.createdAt ?? isoNow(),
      thinkingContent: stream?.thinkingContent || null,
      toolActivity: stream && stream.toolActivity.length > 0 ? stream.toolActivity : null,
      usage: p.usage ?? null,
      wakeDelta: p.wakeDelta ?? null,
    };
    setMessages((prev) =>
      prev.some((m) => m.role === 'assistant' && m.runId === runId && m.agentId === agentId)
        ? prev
        : [...prev, persisted]
    );
  }

  // Attach run-level usage and wake-delta (which ride socket:done, not
  // message_created) to the run's last utterance, so they show live.
  if (p.usage || p.wakeDelta) {
    setMessages((prev) => {
      let lastIdx = -1;
      for (let i = 0; i < prev.length; i++) {
        const m = prev[i]!;
        if (m.role === 'assistant' && m.runId === runId && m.agentId === agentId) {
          lastIdx = i;
        }
      }
      if (lastIdx < 0) return prev;
      const target = prev[lastIdx]!;
      const nextUsage = p.usage ?? target.usage ?? null;
      const nextWake = p.wakeDelta ?? target.wakeDelta ?? null;
      if (nextUsage === target.usage && nextWake === target.wakeDelta) return prev;
      const copy = prev.slice();
      copy[lastIdx] = { ...target, usage: nextUsage, wakeDelta: nextWake };
      return copy;
    });
  }

  setAgentStatuses((prev) => {
    if (!prev.has(agentId)) return prev;
    const next = new Map(prev);
    next.delete(agentId);
    return next;
  });
}

/**
 * A channel-less `socket:error` is a direct reply to one of this client's
 * requests, and every mounted chat receives it. It belongs to this pane only
 * when it names a session the server issued this pane, or failing that, this
 * pane's thread. One that names neither (the server's `session:resume`
 * rejections carry no id) cannot be attributed, and acting on it would wipe
 * some other pane's run state and drop its pending send — so it is left alone.
 * A send waiting on a silent re-resume still fails through that retry's timer.
 */
function isDirectErrorForThisPane(raw: WsMessage, ctx: FrameHandlerCtx): boolean {
  const p = (raw.payload ?? {}) as { sessionId?: unknown; threadId?: unknown };
  if (typeof p.sessionId === 'string' && p.sessionId !== '') {
    return ctx.ownSessionIdsRef.current.has(p.sessionId);
  }
  if (typeof p.threadId === 'string' && p.threadId !== '') {
    return p.threadId === ctx.threadId;
  }
  console.warn('useChatStream: ignoring a socket:error with no session or thread', raw.payload);
  return false;
}

// Abort and run errors end a run without socket:done, so mark matching live
// activities complete here and clear streaming and status state the way
// socket:done does. With no agent named, an abort sweeps every live activity
// on this thread; a socket:error with no agent is a rejected request that
// started no run, so it is surfaced and leaves run state alone.
export function handleAbortedOrError(raw: WsMessage, ctx: FrameHandlerCtx): void {
  if (raw.type === 'socket:error' && raw.channel == null && !isDirectErrorForThisPane(raw, ctx)) {
    return;
  }
  const {
    threadId,
    pendingSendRef,
    retryTimerRef,
    send,
    failSend,
    setMessages,
    setActivities,
    setStreaming,
    setAgentStatuses,
    setPendingToolConfirmations,
  } = ctx;
  const p = raw.payload as {
    sessionId: string;
    agentId?: string;
    runId?: string | null;
    kind?: SocketErrorMsg['payload']['kind'];
    message?: string;
  };
  const targetAgentId = p.agentId;
  const finishedAt = isoNow();

  // A run error (not an abort) shows a live `error:<agent>:<run>` bubble
  // without a refetch. The persisted run_error row supersedes it when it
  // lands, so the run never renders twice. Needs an agentId to render.
  if (raw.type === 'socket:error' && targetAgentId) {
    const runId = p.runId ?? 'default';
    const errorId = errorBubbleId(targetAgentId, runId);
    const summary = (p.message ?? '').trim() || 'Run failed';
    setMessages((prev) => {
      if (prev.some((m) => m.id === errorId)) return prev;
      // Don't stack a transient over an already-persisted error row for
      // this run (its message_created may have raced ahead of us).
      if (
        prev.some(
          (m) =>
            m.role === 'assistant' &&
            m.runId === runId &&
            m.agentId === targetAgentId &&
            m.runError != null
        )
      ) {
        return prev;
      }
      const errorMsg: ThreadMessage = {
        id: errorId,
        threadId,
        role: 'assistant',
        agentId: targetAgentId,
        runId,
        content: summary,
        createdAt: isoNow(),
        runError: { kind: p.kind ?? 'runtime', summary },
      };
      return [...prev, errorMsg];
    });
  }

  // Send-stage rejection (Session not found, Thread is compacting, …): a
  // socket:error with no agentId. Toast the reason, drop the optimistic
  // bubble, and hand the text back to the composer via lastSendError.
  // "Session not found" gets one silent re-resume and resend first.
  if (raw.type === 'socket:error' && !targetAgentId) {
    const reason = (p.message ?? '').trim() || 'Message failed to send';
    const pending = pendingSendRef.current;
    const isSessionNotFound = reason.startsWith('Session not found');

    if (pending && isSessionNotFound && !pending.retriedOnce) {
      // Re-resume the session and resend once session:created lands. Toast
      // and restore only if the retry also fails.
      pending.retriedOnce = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        // Fallback: resume produced no session:created in time.
        const stillPending = pendingSendRef.current;
        if (stillPending && stillPending.optimisticId === pending.optimisticId) {
          failSend(stillPending.optimisticId, stillPending.text, reason);
        }
      }, 4000);
      send({ type: 'socket:session:resume', payload: { threadId } });
    } else if (pending) {
      failSend(pending.optimisticId, pending.text, reason);
    } else {
      // No tracked send: still surface it so it isn't silent.
      showToast(reason, { durationMs: 6000 });
    }
    // The request started no run, so there is no run state to end: an
    // agent that is still running, or a compaction, keeps its indicators.
    return;
  }

  // The server closes a stopped run's parked tool confirmation with
  // socket:tool:confirmation_timeout. Clearing it on the abort frame too means
  // a missed frame can't leave the panel up with dead buttons.
  if (raw.type === 'socket:chat:aborted') {
    setPendingToolConfirmations((prev) => {
      const next = targetAgentId ? prev.filter((r) => r.agentId !== targetAgentId) : [];
      return next.length === prev.length ? prev : next;
    });
  }

  setActivities((prev) => {
    let mutated = false;
    const next = new Map(prev);
    for (const [runId, run] of prev) {
      if (run.status !== 'live') continue;
      if (targetAgentId && run.agentId !== targetAgentId) continue;
      const flushed = flushPendingThinking(run);
      next.set(runId, { ...flushed, status: 'complete', finishedAt });
      mutated = true;
    }
    return mutated ? next : prev;
  });
  setStreaming((prev) => {
    if (prev.size === 0) return prev;
    let mutated = false;
    const next = new Map(prev);
    for (const [key, s] of prev) {
      if (targetAgentId && s.agentId !== targetAgentId) continue;
      next.delete(key);
      mutated = true;
    }
    return mutated ? next : prev;
  });
  setAgentStatuses((prev) => {
    if (prev.size === 0) return prev;
    if (targetAgentId) {
      if (!prev.has(targetAgentId)) return prev;
      const next = new Map(prev);
      next.delete(targetAgentId);
      return next;
    }
    return new Map();
  });
}

export function handleThreadCleared(ctx: FrameHandlerCtx): void {
  const { setMessages, setActivities, setStreaming, setAgentStatuses, setOptimistic } = ctx;
  // The server hard-deleted this thread's messages: empty every surface. The
  // initiating client gets this frame too, so it needs no refetch.
  setMessages([]);
  setActivities(new Map());
  setStreaming(new Map());
  setAgentStatuses(new Map());
  setOptimistic([]);
}

/**
 * History was trimmed: the server deleted a range of messages and their runs.
 * Unlike a clear this can't be applied incrementally (the loaded window,
 * pagination cursors and activity map may all point at deleted rows), so the
 * history is re-read, centered on the server's `anchorMessageId` (the surviving
 * message nearest the cut). Without an anchor it loads the latest page.
 */
export function handleThreadTrimmed(raw: WsMessage, ctx: FrameHandlerCtx): void {
  const { setStreaming, setAgentStatuses, setOptimistic, reloadHistory } = ctx;
  const anchor = (raw.payload as { anchorMessageId?: unknown } | undefined)?.anchorMessageId;
  setStreaming(new Map());
  setAgentStatuses(new Map());
  setOptimistic([]);
  reloadHistory(typeof anchor === 'string' && anchor !== '' ? anchor : null);
}
