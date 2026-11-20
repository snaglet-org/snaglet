import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WsMessage,
  ClarificationRequestPayload,
  ClarificationAnswer,
  ClarificationStatus,
  ToolConfirmationDecision,
  ToolConfirmationRequestPayload,
} from '@snaglet/shared/types';
import { useWs } from '@desktop/ws/useWs';
import { showToast } from '@desktop/utils/toast';
import { registerViewedThread } from '@desktop/components/AgentPopups/viewedThreads';
import { publishClarification } from '@desktop/components/AgentCursorOverlay/clarificationStore';
import type { ThreadMessage } from '@desktop/utils/api';
import { streamingToThreadMessage } from './chatStreamHelpers';
import { useChatSocketSession } from './useChatSocketSession';
import { useThreadHistory } from './useThreadHistory';
import { useToolCallCorrelation } from './useToolCallCorrelation';
import type { FrameHandlerCtx, PendingSend } from './chatStreamFrameContext';
import {
  handleDone,
  handleMessageCreated,
  handleMessageUpdated,
  handleAbortedOrError,
  handleThreadCleared,
  handleThreadTrimmed,
} from './chatStreamTranscriptHandlers';
import {
  handleAgentStatus,
  handleClarificationRequest,
  handleClarificationTimeout,
  handleCompactCompleteOrError,
  handleCompactProgress,
  handleCompactStarted,
  handleDelta,
  handleDispatchHint,
  handleMemoryExtraction,
  handleModelFallback,
  handleSessionCreated,
  handleStreamRetry,
  handleThinkingChunk,
  handleToolCall,
  handleToolConfirmationRequest,
  handleToolConfirmationTimeout,
  handleToolResult,
} from './chatStreamRunHandlers';
import type {
  AgentStatus,
  MemoryExtractionNotice,
  StreamingMessage,
  UseChatStreamResult,
} from './types';
import { isoNow } from '@snaglet/shared/utils';
import { byCreatedAt } from '@desktop/utils/chronology';

/**
 * useChatStream: the realtime contract for one thread. Composes
 * `useThreadHistory` (REST history and participants), `useChatSocketSession`
 * (subscribe and resume) and `useToolCallCorrelation`, and owns the local
 * streaming, status and optimistic state plus the send actions. Per-frame
 * bodies live in `chatStreamTranscriptHandlers` / `chatStreamRunHandlers`.
 * A frame that arrives before the REST fetch resolves is kept, because
 * `useThreadHistory` merges by id.
 */

interface UseChatStreamOpts {
  /**
   * When set, the message history loads a window centered on this id
   * instead of the most recent page. Forwarded to `useThreadHistory`.
   */
  focusMessageId?: string | null;
  /** Changes per message-focus navigation so a same-thread hit seeks again. */
  focusRequestId?: number | null;
}

export function useChatStream(threadId: string, opts: UseChatStreamOpts = {}): UseChatStreamResult {
  const { send, addMessageListener } = useWs();
  const {
    messages,
    setMessages,
    activities,
    setActivities,
    participantAgentIds,
    loading,
    refetchParticipants,
    hasMoreOlder,
    hasMoreNewer,
    paginating,
    pageError,
    loadOlder,
    loadNewer,
    initialFocusMessageId,
    initialFocusRequestId,
    initialFocusIsNavigation,
    reload: reloadHistory,
    refreshLatest,
    error: historyError,
    retry: retryHistory,
  } = useThreadHistory(threadId, {
    focusMessageId: opts.focusMessageId ?? null,
    focusRequestId: opts.focusRequestId ?? null,
  });
  const { sessionId, sessionIdRef, setSessionId } = useChatSocketSession(
    threadId,
    participantAgentIds.length,
    refetchParticipants
  );
  const correlation = useToolCallCorrelation(threadId);

  const [streaming, setStreaming] = useState<Map<string, StreamingMessage>>(new Map());
  const [agentStatuses, setAgentStatuses] = useState<Map<string, AgentStatus>>(new Map());
  // Optimistic user messages — added immediately on send so the input
  // doesn't appear to stall while we wait for the server's echo. Each
  // is dropped when the matching server-side message_created arrives
  // (matched FIFO by content).
  const [optimistic, setOptimistic] = useState<ThreadMessage[]>([]);
  const [pendingClarification, setPendingClarification] =
    useState<ClarificationRequestPayload | null>(null);
  const [pendingToolConfirmations, setPendingToolConfirmations] = useState<
    ToolConfirmationRequestPayload[]
  >([]);
  // Transient hint shown when the user sends a message in a group thread
  // without @mentioning any agent.
  const [dispatchHint, setDispatchHint] = useState<string | null>(null);
  // Ephemeral memory-extraction notices ("N memories saved · M proposed").
  // Pane-local by design: not persisted, gone on reload.
  const [memoryExtractions, setMemoryExtractions] = useState<MemoryExtractionNotice[]>([]);
  // Live wave number during a multi-wave dispatch (from socket:agent:continuing,
  // which only fires from wave 2 on). Null outside multi-wave runs.
  const [currentWave, setCurrentWave] = useState<number | null>(null);
  // The most recent send that failed at the send stage (server rejected
  // it before any run started, so it arrives as a socket:error with no
  // agentId). Surfaced to ChatView so the composer can restore the typed
  // text — the send never became a persisted message, so the text would
  // otherwise be lost. Cleared once ChatView has restored it.
  const [lastSendError, setLastSendError] = useState<{ text: string; message: string } | null>(
    null
  );

  // Mirror streaming state in a ref so the socket:done handler can read
  // the current entry synchronously when promoting it to a persisted
  // message. setStreaming's updater callback doesn't run inline, so
  // closing over `let stream = prev.get(key)` inside the updater would
  // race with the setMessages() call below.
  const streamingRef = useRef<Map<string, StreamingMessage>>(streaming);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // The last unconfirmed send, kept so a send-stage rejection (socket:error
  // with no agentId) can restore the typed text and fire one silent retry
  // for "Session not found". One slot is enough: a send is confirmed or has
  // failed before the user sends again.
  const pendingSendRef = useRef<PendingSend | null>(null);
  // Session ids the server issued this pane for the current thread; see
  // FrameHandlerCtx.ownSessionIdsRef.
  const ownSessionIdsRef = useRef<Set<string>>(new Set());
  // Bounds the auto-retry: if session:resume yields no session:created
  // (e.g. server down), still surface the failure instead of hanging.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    []
  );

  // Reset transient state on threadId change. The REST + correlation
  // resets are owned by their respective hooks.
  useEffect(() => {
    setStreaming(new Map());
    setAgentStatuses(new Map());
    setOptimistic([]);
    setPendingClarification(null);
    setPendingToolConfirmations([]);
    setMemoryExtractions([]);
    setDispatchHint(null);
    setCurrentWave(null);
    pendingSendRef.current = null;
    ownSessionIdsRef.current = new Set();
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setLastSendError(null);
  }, [threadId]);

  // Catch up on history missed while the socket was down. The re-fetched
  // page can hold user rows whose `message_created` never arrived; each
  // retires one matching optimistic echo (FIFO by content, as the live frame
  // does) so a send that did land is neither shown twice nor left pending.
  const resyncHistory = useCallback(() => {
    void refreshLatest().then((added) => {
      const persistedTexts = added.filter((m) => m.role === 'user').map((m) => m.content);
      if (persistedTexts.length === 0) return;
      setOptimistic((prev) => {
        const remaining = [...prev];
        for (const text of persistedTexts) {
          const idx = remaining.findIndex((m) => m.content === text);
          if (idx >= 0) remaining.splice(idx, 1);
        }
        return remaining.length === prev.length ? prev : remaining;
      });
      const pending = pendingSendRef.current;
      if (pending && persistedTexts.includes(pending.text)) {
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        pendingSendRef.current = null;
      }
    });
  }, [refreshLatest]);

  // Finalize a failed send: toast the reason, drop the dead optimistic
  // bubble, and hand the typed text back to the composer (via
  // lastSendError) so it's never lost. Clears the pending slot + retry
  // timer so a later successful send can't re-trigger any of this.
  const failSend = useCallback(
    (optimisticId: string, text: string, reason: string) => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      pendingSendRef.current = null;
      setOptimistic((prev) => prev.filter((m) => m.id !== optimisticId));
      showToast(reason, { durationMs: 6000 });
      setLastSendError({ text, message: reason });
    },
    [setOptimistic]
  );

  // One listener handles every frame type. The WS provider is app-wide, so
  // every open chat sees every frame: drop any whose `channel` isn't this
  // thread, so side-by-side chats sharing an agent don't render each other's
  // stream. Direct sends leave `channel` undefined and are scoped by the
  // payload's `threadId`. `ctx` hands the handlers this hook's setters and
  // refs, and is rebuilt only when a dependency (threadId) changes.
  useEffect(() => {
    const ctx: FrameHandlerCtx = {
      threadId,
      send,
      failSend,
      participantAgentIds,
      correlation,
      streamingRef,
      pendingSendRef,
      retryTimerRef,
      ownSessionIdsRef,
      setMessages,
      setActivities,
      setSessionId,
      setStreaming,
      setAgentStatuses,
      setOptimistic,
      setPendingClarification,
      setPendingToolConfirmations,
      setDispatchHint,
      setMemoryExtractions,
      setLastSendError,
      reloadHistory,
      resyncHistory,
    };
    const handle = (raw: WsMessage) => {
      if (raw.channel != null && raw.channel !== threadId) return;
      switch (raw.type) {
        case 'socket:session:created':
          handleSessionCreated(raw, ctx);
          break;
        case 'socket:chat:message_created':
          handleMessageCreated(raw, ctx);
          break;
        case 'socket:chat:message_updated':
          handleMessageUpdated(raw, ctx);
          break;
        case 'socket:delta':
          handleDelta(raw, ctx);
          break;
        case 'socket:agent:stream:retry':
          handleStreamRetry(raw, ctx);
          break;
        case 'socket:thinking:chunk':
          handleThinkingChunk(raw, ctx);
          break;
        case 'socket:tool:call':
          handleToolCall(raw, ctx);
          break;
        case 'socket:tool:result':
          handleToolResult(raw, ctx);
          break;
        case 'socket:done':
          handleDone(raw, ctx);
          break;
        case 'socket:chat:aborted':
        case 'socket:error':
          handleAbortedOrError(raw, ctx);
          break;
        // Mid-run queue ack: the server parked the send for the active run.
        // Not a "sent" signal: the optimistic bubble stays pending until the
        // persisted socket:chat:message_created lands.
        case 'socket:chat:queued':
          break;
        case 'socket:chat:dispatch_hint':
          handleDispatchHint(raw, ctx);
          break;
        case 'socket:agent:model:fallback':
          handleModelFallback(raw, ctx);
          break;
        case 'socket:agent:status':
          handleAgentStatus(raw, ctx);
          break;
        case 'socket:agent:continuing': {
          // Live wave indicator: the server stamps the 1-indexed wave on the
          // continuing frame. Monotonic per run (mid-wave joiners re-announce
          // earlier waves; keep the max).
          const wave = (raw.payload as { wave?: number } | undefined)?.wave;
          if (typeof wave === 'number') {
            setCurrentWave((prev) => (prev === null || wave > prev ? wave : prev));
          }
          break;
        }
        case 'socket:thread:compact:started':
          handleCompactStarted(raw, ctx);
          break;
        case 'socket:thread:compact:progress':
          handleCompactProgress(raw, ctx);
          break;
        case 'socket:thread:compact:complete':
        case 'socket:thread:compact:error':
          handleCompactCompleteOrError(raw, ctx);
          break;
        case 'socket:thread:memory-extraction':
          handleMemoryExtraction(raw, ctx);
          break;
        case 'socket:thread:cleared':
          handleThreadCleared(ctx);
          break;
        case 'socket:thread:trimmed':
          handleThreadTrimmed(raw, ctx);
          break;
        case 'socket:clarification:request':
          handleClarificationRequest(raw, ctx);
          break;
        case 'socket:clarification:timeout':
          handleClarificationTimeout(raw, ctx);
          break;
        case 'socket:tool:confirmation_request':
          handleToolConfirmationRequest(raw, ctx);
          break;
        case 'socket:tool:confirmation_timeout':
          handleToolConfirmationTimeout(raw, ctx);
          break;
      }
    };
    return addMessageListener(handle);
  }, [
    addMessageListener,
    threadId,
    correlation,
    setActivities,
    setMessages,
    setSessionId,
    participantAgentIds,
    failSend,
    send,
    reloadHistory,
    resyncHistory,
  ]);

  const sendMessage = useCallback(
    (text: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      setDispatchHint(null);
      // A fresh send supersedes any prior surfaced failure.
      setLastSendError(null);
      // Optimistic — the user's bubble appears instantly. The matching
      // server `socket:chat:message_created` will replace it (or rather
      // append the real row and remove this one) within a round-trip.
      const optimisticId = `optimistic:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const optimisticMsg: ThreadMessage = {
        id: optimisticId,
        threadId: threadId,
        role: 'user',
        agentId: null,
        content: text,
        createdAt: isoNow(),
        // Pending until the server's persisted ack (socket:chat:message_created)
        // lands. A socket:chat:queued response is not "sent": a queued message
        // can still be lost if its persist failed.
        pending: true,
      };
      setOptimistic((prev) => [...prev, optimisticMsg]);
      // Track this send so a send-stage rejection (socket:error, no agentId)
      // can restore the text and — for "Session not found" — retry once.
      pendingSendRef.current = { optimisticId, text, retriedOnce: false, resent: false };

      send({
        type: 'socket:chat:send',
        payload: { sessionId: sid, message: text },
      });
    },
    [send, threadId, sessionIdRef]
  );

  const stopGeneration = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    send({ type: 'socket:chat:abort', payload: { sessionId: sid } });
  }, [send, sessionIdRef]);

  const stopAgentGeneration = useCallback(
    (agentId: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      send({ type: 'socket:chat:abort', payload: { sessionId: sid, agent_id: agentId } });
    },
    [send, sessionIdRef]
  );

  const respondToClarification = useCallback(
    (callId: string, status: ClarificationStatus, answers: Record<string, ClarificationAnswer>) => {
      const sid = sessionIdRef.current;
      if (sid) {
        send({
          type: 'socket:clarification:response',
          payload: { sessionId: sid, callId, status, answers },
        });
      }
      setPendingClarification((prev) => (prev?.callId === callId ? null : prev));
    },
    [send, sessionIdRef]
  );

  // Offer the pending Ask to the cursor overlay, which may show it as a card
  // beside the asking agent's flower (the composer panel then stands down).
  useEffect(() => {
    if (!pendingClarification) return undefined;
    return publishClarification({
      request: pendingClarification,
      respond: respondToClarification,
    });
  }, [pendingClarification, respondToClarification]);

  // This thread's chat is on screen: its asks belong to the composer, not the popup stack.
  useEffect(() => registerViewedThread(threadId), [threadId]);

  const clearDispatchHint = useCallback(() => setDispatchHint(null), []);
  const clearSendError = useCallback(() => setLastSendError(null), []);

  const respondToToolConfirmation = useCallback(
    (callId: string, decision: ToolConfirmationDecision): void => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      send({
        type: 'socket:tool:confirm',
        payload: { sessionId: sid, callId, decision },
      });
      setPendingToolConfirmations((prev) => prev.filter((request) => request.callId !== callId));
    },
    [send, sessionIdRef]
  );

  // Combined display list. Sorting by ISO created_at keeps user/agent
  // bubbles interleaved correctly when multiple agents run in parallel.
  // Streaming projections with empty content (an accumulator that was
  // just finalized by its utterance's message_created, or reset at a tool
  // boundary) are filtered out — the gray transient preview should
  // disappear until the next iteration starts producing deltas.
  const combined = useMemo(() => {
    const arr: ThreadMessage[] = [...messages, ...optimistic];
    for (const s of streaming.values()) {
      if (s.content.length === 0) continue;
      arr.push(streamingToThreadMessage(s));
    }
    return arr.sort(byCreatedAt);
  }, [messages, optimistic, streaming]);

  // Working = any agent has a non-idle status OR we're holding any
  // streaming entries. The status map alone misses the window between
  // socket:done (which clears the status) and the next message_created;
  // the streaming map alone misses tool-only iterations where status
  // updates but no streaming entry exists yet.
  const working = agentStatuses.size > 0 || streaming.size > 0;

  // The wave indicator only means something while a run is live. Clearing is
  // debounced: between waves `working` flickers false, and an instant reset
  // would lose the wave number. A real ending stays idle past the delay.
  useEffect(() => {
    if (working) return;
    const timer = window.setTimeout(() => setCurrentWave(null), 2500);
    return () => window.clearTimeout(timer);
  }, [working]);

  return {
    messages: combined,
    activities,
    agentStatuses,
    memoryExtractions,
    ready: sessionId !== null,
    loading,
    historyError,
    retryHistory,
    working,
    participantCount: participantAgentIds.length,
    participantAgentIds,
    refetchParticipants,
    sendMessage,
    stopGeneration,
    stopAgentGeneration,
    pendingClarification,
    respondToClarification,
    pendingToolConfirmations,
    respondToToolConfirmation,
    hasMoreOlder,
    hasMoreNewer,
    paginating,
    pageError,
    loadOlder,
    loadNewer,
    initialFocusMessageId,
    initialFocusRequestId,
    initialFocusIsNavigation,
    dispatchHint,
    currentWave,
    clearDispatchHint,
    lastSendError,
    clearSendError,
  };
}
