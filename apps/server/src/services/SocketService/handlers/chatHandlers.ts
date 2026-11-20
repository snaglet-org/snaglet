import { generateId, getErrorMessage, isoNow } from '@snaglet/shared/utils';
import { dispatchToThreadInternal, redispatchPersistedMessage } from '../dispatch/dispatchToThread';
import { partitionArchivedParticipants } from '../dispatch/partitionArchivedParticipants';
import { threadRosterVersion } from '../dispatch/rosterVersion';
import { Messages, type MessageRole } from '@snaglet/db/tables/messages';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { wsService } from '@server/services/WebSocketService';
import { agentService } from '@server/services/AgentService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { syncMessageEmbedding } from '@server/services/EmbeddingService';
import { syncMessageEntities } from '@server/services/NlpEntityService';
import { getSession, setSessionParticipants } from '../store';
import { isThreadCompacting } from './compactHandlers';
import {
  getSummaryHalt,
  isThreadSummaryHalted,
  summaryHaltRefusal,
} from '@server/services/summary/summaryHalt';
import { liftSummaryHaltAndReplayWakes } from '../dispatch/summaryHaltedWakes';
import { createAbortController, clearAbortController } from '../abortStore';
import { parseMentions } from '@server/services/MentionParser';
import { LogsService } from '@server/services/LogsService';
import { hooks } from '@server/services/HookService';
import {
  resolveThreadRuntimeConfig,
  type ThreadRuntimeConfig,
} from '@server/services/ConfigResolverService';
import { computePersistedInjection } from './chatPhases/computePersistedInjection';
import { persistInboundMidRunMessage } from './chatPhases/persistInboundMidRunMessage';
import { previewMessage } from './chatHandlers/formatters';
import { buildDispatchSet } from './chatHandlers/buildDispatchSet';
import { emitUnresolvedMentionDiagnostics } from './chatHandlers/emitUnresolvedMentionDiagnostics';
import { resolveFromSender } from './chatHandlers/resolveFromSender';
import { validateMentionFanOut } from '@server/services/groupChat/safety';

// Re-export secondary handlers so the barrel import in SocketService/index.ts still works
export {
  registerToolConfirmHandler,
  registerClarificationResponseHandler,
  registerAskSyncHandler,
  registerChatAbortHandler,
} from './chatSecondaryHandlers';

import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './chatPhases/types';

/** Inbound `socket:chat:send` payload (voice sends reuse it too). */
export interface ChatSendPayload {
  sessionId: string;
  message: string;
  isRetry?: boolean;
  parallelDispatch?: boolean;
  source?: 'user' | 'mention-handoff';
  /**
   * Voice: when true, the persisted user message is stamped
   * `metadata.source = 'voice'` (an honest transcript mark). Does not change
   * dispatch — a voice send is an ordinary user send.
   */
  voiceOriginated?: boolean;
  /**
   * Voice barge-in: the "heard up to" marker, delivered via the same
   * persisted-injection channel as a project-lineage opener
   * (`metadata.persistedInjection`, folded into model context by
   * `effectiveContent`) instead of concatenated into `message`. Keeps the user's
   * chat bubble clean (just their words) while the model still receives the
   * marker adjacent to the message on both the replay path and, for a mid-tool
   * barge-in, the live mid-run injection. Never a display/pill string.
   */
  persistedInjection?: string;
  /**
   * Explicit sender provenance for this one message, resolved by
   * resolveFromSender (agent -> member/user -> external; see that module).
   * Lets an MCP/API caller stamp a real per-message identity instead of
   * baking "[from:x]" into `message`. Nullable/omittable: absent `from`
   * leaves attribution exactly as before this param existed (the connection's
   * `meta.externalCaller`, if any, plus the local user).
   */
  from?: string | null;
}

/**
 * The socket:chat:send body, exported so the voice layer can reuse the exact
 * typed-user-message path (persist → dispatch) instead of re-implementing it.
 * VoiceSessionService calls this with the voice session's own chat sessionId.
 */
export async function processChatSend(
  payload: ChatSendPayload,
  meta: {
    clientId: string;
    channel?: string;
    messageId?: string;
    externalCaller?: { memberId: string; name: string };
    /**
     * Voice: invoked with the persisted user-message id right after it lands
     * (before dispatch), so the voice layer can populate voice:final.messageId.
     * Not called when the send is queued mid-run (no new row) or on retry.
     */
    onUserMessagePersisted?: (messageId: string) => void;
  }
): Promise<void> {
  {
    const { sessionId, message, isRetry, parallelDispatch, source, voiceOriginated, from } =
      payload ?? ({} as ChatSendPayload);
    const session = await getSession(sessionId);

    if (!session) {
      wsService.sendToClient(meta.clientId, {
        type: 'socket:error',
        payload: { sessionId, message: `Session not found: ${sessionId}` },
      });
      return;
    }

    // Mention-handoffs are continuation of an already-running conversation, not
    // new user intent. Compaction would block the chain silently; letting the
    // handoff through is safe because the receiving agent resolves its context
    // at run-time (post-compaction).
    if (isThreadCompacting(session.threadId) && source !== 'mention-handoff') {
      wsService.sendToClient(meta.clientId, {
        type: 'socket:error',
        payload: {
          sessionId,
          threadId: session.threadId,
          message: 'Thread is compacting — try again in a moment.',
        },
      });
      return;
    }

    // A thread whose compaction path is broken is not usable: its next turn
    // would run on a context nobody can compact. The block is lifted lazily,
    // here — one resolver pass proves a working summary model was set (and, for
    // a model that failed at call time, that it is a different model), so a
    // repaired thread unblocks on the very send that repairs it. Unlike the
    // compaction latch above this applies to mention-handoffs too: the
    // continuation is exactly what must not proceed.
    if (isThreadSummaryHalted(session.threadId)) {
      const proceed = await liftSummaryHaltAndReplayWakes(session.threadId);
      if (!proceed) {
        const halt = getSummaryHalt(session.threadId);
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: {
            sessionId,
            threadId: session.threadId,
            message: halt
              ? summaryHaltRefusal(halt)
              : 'This thread is blocked until a working summary model is set.',
          },
        });
        return;
      }
    }

    const thread = await Threads.findById(session.threadId).catch(() => null);
    if (!thread) {
      wsService.sendToClient(meta.clientId, {
        type: 'socket:error',
        payload: {
          sessionId,
          threadId: session.threadId,
          message: `Thread not found: ${session.threadId}`,
        },
      });
      return;
    }
    const threadName = thread?.title?.trim() || 'Untitled Thread';
    LogsService.user.message({
      threadName,
      threadId: session.threadId,
      sessionId,
      text: previewMessage(message),
    });

    // Deduplication guard: if a run is already active for this thread (possibly
    // from another client/session), queue the message for mid-run injection
    // instead of starting a second concurrent run.
    const activeSessionForThread = activeRunTracker.getActiveSessionForThread(session.threadId);
    if (activeSessionForThread) {
      const queuedId = generateId('message');
      // Persist-first: write the row to the DB now, before it goes
      // in the in-memory injection queue. A run wedged in a never-returning tool
      // call never drains and never ends, so a memory-only queue would silently
      // lose this message. Persisting on receipt makes the queue a reference —
      // delivery can be delayed by a frozen run, never lost. On a persist failure
      // we fall back to the in-memory enqueue (persisted=false) so the drain
      // path still creates the row rather than dropping the message.
      const persistedNow = await persistInboundMidRunMessage({
        id: queuedId,
        threadId: session.threadId,
        content: payload.message,
        injection: payload.persistedInjection,
        threadName,
      });
      const didQueue = activeRunTracker.enqueueMessageForThread(
        session.threadId,
        queuedId,
        payload.message,
        // Voice barge-in mid-tool: carry the "heard up to" marker on the queue so
        // the tool-loop drain can persist it as metadata.persistedInjection and
        // fold it into the live mid-run injection (see midRunMessages), keeping
        // the persisted content clean.
        payload.persistedInjection,
        persistedNow
      );
      if (didQueue) {
        LogsService.socket.event('message queued mid-run', {
          threadName,
          threadId: session.threadId,
          sessionId,
          messageId: queuedId,
          persisted: persistedNow,
        });
        wsService.sendToClient(meta.clientId, {
          type: 'socket:chat:queued',
          payload: { sessionId, messageId: queuedId },
        });
      } else if (persistedNow) {
        // Race: the run's session released the thread lock between the active
        // check and the enqueue. The row is already durably persisted, so it is
        // not lost — it just missed this run's injection queue. Actively wake
        // the thread for it (the lock is free, or the skip is re-recorded for a
        // guaranteed post-run re-dispatch) instead of hoping a future send
        // rebuilds context over it.
        LogsService.socket.event('message persisted but queue closed — re-dispatching', {
          threadName,
          threadId: session.threadId,
          sessionId,
          messageId: queuedId,
        });
        wsService.sendToClient(meta.clientId, {
          type: 'socket:chat:queued',
          payload: { sessionId, messageId: queuedId },
        });
        void redispatchPersistedMessage({
          threadId: session.threadId,
          threadName,
          messageId: queuedId,
          undeliveredCount: 1,
          reason: 'mid-run persist raced run end',
        });
      } else {
        // Persist failed and the queue closed — the message truly has no home.
        // Tell the sending client so the composer surfaces a retry (UI
        // contract: no silent drops).
        LogsService.warn('message dropped — no active queue and persist failed', {
          threadName,
          threadId: session.threadId,
          sessionId,
        });
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: {
            sessionId,
            threadId: session.threadId,
            message: 'Message could not be saved — please retry.',
          },
        });
      }
      return;
    }

    if (!activeRunTracker.startSession(sessionId, session.threadId)) {
      // A purge reservation (a fork or a Clear in flight) also blocks the start,
      // but with no active run — "a run is already in progress" would be wrong.
      // Name the real reason (fork vs clear) so the composer can retry in a moment.
      const purgeReason = activeRunTracker.threadPurgeReason(session.threadId);
      const lockHolderSession = activeRunTracker.getActiveSessionForThread(session.threadId);
      wsService.sendToClient(meta.clientId, {
        type: 'socket:error',
        payload: {
          sessionId,
          threadId: session.threadId,
          message: purgeReason
            ? purgeReason === 'fork'
              ? 'Forking this thread, try again in a moment.'
              : 'Clearing this thread, try again in a moment.'
            : lockHolderSession && lockHolderSession !== sessionId
              ? 'A run is already in progress for this thread.'
              : 'A run is already in progress for this session.',
        },
      });
      return;
    }
    const lockSnapshot = activeRunTracker.snapshot();
    LogsService.socket.event('run lock acquired', {
      threadName,
      threadId: session.threadId,
      sessionId,
      activeThreads: lockSnapshot.activeThreadCount,
      activeRuns: lockSnapshot.activeRunCount,
    });

    // Every exit between here and dispatch must release the run lock, or the
    // thread refuses sends ("A run is already in progress") until the reaper.
    const endSendBeforeDispatch = async (errorMessage: string): Promise<void> => {
      wsService.sendToClient(meta.clientId, {
        type: 'socket:error',
        payload: { sessionId, threadId: session.threadId, message: errorMessage },
      });
      const { finishSessionAndPersistStragglers } = await import('./chatPhases/midRunMessages');
      await finishSessionAndPersistStragglers(sessionId, {
        threadId: session.threadId,
        threadName,
      });
    };

    // Taken before the read: a run notices a change that lands in between.
    const rosterVersion = threadRosterVersion(session.threadId);
    const latestParticipants = await ThreadParticipants.listByThread(session.threadId).catch(
      () => []
    );
    if (latestParticipants.length > 0) {
      session.participantAgentIds = Array.from(
        new Set(latestParticipants.map((p) => p.agentId).filter((id): id is string => Boolean(id)))
      );
      // Best-effort persist of the refreshed list. A failure must not abort the
      // send (which would leak the run lock and wedge the thread): the in-memory
      // session already carries these ids and dispatch reads from it below.
      await setSessionParticipants(session.id, session.participantAgentIds).catch((err) => {
        LogsService.warn('failed to persist refreshed session participants', {
          threadName,
          threadId: session.threadId,
          sessionId,
          error: getErrorMessage(err),
        });
      });
    }

    const rawParticipantIds = Array.from(
      new Set(
        (session.participantAgentIds.length > 0
          ? session.participantAgentIds
          : [session.agentId]
        ).filter(Boolean)
      )
    );

    // Tombstone filter — archived agents keep their thread_participants
    // row (history) but are dropped from the dispatch roster so the wave loop
    // never gives them a turn, mention routing never targets them, and they are
    // never woken. Shared with buildDispatchDeps so the socket and tool paths
    // apply the identical rule. session.participantAgentIds is left intact —
    // participant membership outlives dispatch eligibility.
    let partitioned: Awaited<ReturnType<typeof partitionArchivedParticipants>>;
    try {
      partitioned = await partitionArchivedParticipants(rawParticipantIds);
    } catch (err) {
      LogsService.error('failed to load participants for dispatch', err, {
        threadName,
        threadId: session.threadId,
        sessionId,
      });
      await endSendBeforeDispatch("Could not load this thread's participants — please retry.");
      return;
    }
    const { liveIds: participantAgentIds, archivedIds } = partitioned;
    if (archivedIds.length > 0) {
      LogsService.warn('chat send: skipping archived participants', {
        threadName,
        threadId: session.threadId,
        archivedIds,
      });
    }

    if (participantAgentIds.length === 0) {
      await endSendBeforeDispatch('Thread has no active participants');
      return;
    }

    const isGroup = participantAgentIds.length > 1;

    let triggerMessageId: string | undefined;

    // Persist the user message to DB (skip on retry — message already exists)
    try {
      if (!isRetry) {
        const messageId = generateId('message');
        triggerMessageId = messageId;
        // `messages.role = 'user'` requires a users-row author. External caller
        // identity is the surfaced attribution, stored separately in metadata.
        const localUser = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());

        // Resolve an explicit `from` label (messages.external_sender).
        // Order: agent -> member(user) -> external — see resolveFromSender.ts.
        // With no `from`, the defaults below write an ordinary local-user row.
        let sendRole: MessageRole = 'user';
        let sendAgentId: string | null = null;
        let sendUserId: string | null = localUser.id;
        let externalSenderLabel: string | null = null;
        if (typeof from === 'string' && from.trim().length > 0) {
          const resolved = await resolveFromSender(from);
          if (resolved.kind === 'agent') {
            // Attributed normally, like any other agent-authored message —
            // messages_role_matches_author requires role='assistant' whenever
            // agent_id is set.
            sendRole = 'assistant';
            sendAgentId = resolved.agentId;
            sendUserId = null;
          } else if (resolved.kind === 'user') {
            // Attributed normally to the resolved member/user (still role='user').
            sendUserId = resolved.userId;
          } else {
            // Nothing resolved: keep the default local-user author (so the
            // create() role/author guard still passes) and carry the raw
            // label separately for display/rendering.
            externalSenderLabel = resolved.label;
          }
        }
        // Compute before insert: the emptiness gate (count === 0) must see
        // the thread before this first message lands.
        const computedInjection = await computePersistedInjection(session.threadId);
        // Fold optional metadata: retrieval opener pack (computedInjection, the
        // empty-thread project lineage) + a caller-supplied injection (voice
        // barge-in "heard up to" marker) + the voice-origin stamp. The two
        // injection sources never coexist in practice — the lineage opener only
        // stamps message 1, a barge-in is never message 1 — but they combine
        // deterministically if they ever did, preserving the cached prefix.
        // `metadata.source = 'voice'` is a raw (non-surfaced) key — the honest
        // transcript mark.
        const injections = [computedInjection, payload.persistedInjection].filter(
          (s): s is string => typeof s === 'string' && s.length > 0
        );
        const userMetadata: Record<string, unknown> = {};
        if (injections.length > 0) userMetadata.persistedInjection = injections.join('\n\n');
        if (voiceOriginated) userMetadata.source = 'voice';
        if (meta.externalCaller) userMetadata.externalSender = meta.externalCaller;
        await Messages.create({
          id: messageId,
          threadId: session.threadId,
          role: sendRole,
          content: message,
          agentId: sendAgentId,
          userId: sendUserId,
          externalSenderLabel,
          metadata: Object.keys(userMetadata).length > 0 ? userMetadata : null,
        });
        // Lifecycle hook — this is the primary inbound-message chokepoint
        // (the live socket send path; `persistUtterance` is the analogous
        // chokepoint for agent-spoken replies). `chars` remains generic
        // metadata for user-authored lifecycle hooks. Fire-and-forget, never
        // blocks.
        hooks.emit('message:create', {
          id: messageId,
          threadId: session.threadId,
          role: sendRole === 'assistant' ? 'agent' : 'user',
          ...(sendAgentId ? { agentId: sendAgentId } : {}),
          text: message,
          chars: message.length,
        });
        void syncMessageEmbedding(messageId, message).catch((err) => {
          LogsService.warn('message embedding sync failed', {
            threadName,
            threadId: session.threadId,
            messageId,
            error: getErrorMessage(err),
          });
        });
        // Fire-and-forget NLP entity enrichment (see NlpEntityService) — zero
        // added latency on the response path, exact same shape as the
        // embedding sync above. Never throws internally, but the catch here
        // is defense-in-depth for the DB write (Messages.updateSearchText).
        void syncMessageEntities(messageId, message).catch((err) => {
          LogsService.warn('message entity sync failed', {
            threadName,
            threadId: session.threadId,
            messageId,
            error: getErrorMessage(err),
          });
        });
        wsService.broadcastToChannel(session.threadId, {
          type: 'socket:chat:message_created',
          payload: {
            id: messageId,
            threadId: session.threadId,
            role: sendRole,
            content: message,
            user_id: sendUserId,
            agent_id: sendAgentId,
            external_sender: meta.externalCaller ?? null,
            external_sender_label: externalSenderLabel,
            created_at: isoNow(),
            message_type: 'message',
          },
        });
        // Hand the persisted id back (voice:final.messageId).
        meta.onUserMessagePersisted?.(messageId);
      }
    } catch (err) {
      const errMsg = getErrorMessage(err);
      // Log server-side too — without this, a persistent insert failure is
      // invisible in the server logs and looks like "the agent just never woke up".
      LogsService.error('failed to persist user message', err, {
        threadName,
        threadId: session.threadId,
        sessionId,
      });
      await endSendBeforeDispatch(errMsg);
      return;
    }

    // Build agent name + role lookups for group threads
    const agentNameMap = new Map<string, string>();
    const agentRoleMap = new Map<string, string>();
    if (isGroup) {
      for (const pid of participantAgentIds) {
        // Guard each lookup: a single failed fetch must not abort the send
        // (which would leak the run lock). Fall back to the bare id downstream.
        const peer = await agentService.get(pid).catch((err) => {
          LogsService.warn('failed to load participant agent for name map', {
            threadName,
            threadId: session.threadId,
            agentId: pid,
            error: getErrorMessage(err),
          });
          return undefined;
        });
        if (peer) {
          agentNameMap.set(peer.id, peer.name);
          if (peer.role) agentRoleMap.set(peer.id, peer.role);
        }
      }
    }

    const threadRuntimeConfig: ThreadRuntimeConfig | null = await resolveThreadRuntimeConfig(
      session.threadId
    ).catch((err) => {
      LogsService.warn('thread runtime config resolution failed', {
        threadId: session.threadId,
        error: getErrorMessage(err),
      });
      return null;
    });

    const mentions = isGroup
      ? parseMentions(message, agentNameMap)
      : { mentionedAgentIds: [], hasMentions: false, rawMentions: [] as string[] };

    // API-boundary safety: reject messages that fan out to
    // too many agents. The orchestrator's wave loop also defends against an
    // over-large dispatch set, but the user deserves a clean error here rather
    // than an opaque truncation deep in the run.
    const mentionFanOutError = validateMentionFanOut(mentions.mentionedAgentIds);
    if (mentionFanOutError) {
      await endSendBeforeDispatch(mentionFanOutError);
      return;
    }

    // Diagnostic: if the parser found @tokens that didn't resolve to any agent,
    // surface them so typos like `@paty` aren't silently dropped. Best-effort —
    // a diagnostics failure must never abort the send or leak the run lock.
    try {
      emitUnresolvedMentionDiagnostics({
        mentions,
        isGroup,
        agentNameMap,
        threadId: session.threadId,
        threadName,
      });
    } catch (err) {
      LogsService.warn('mention diagnostics emit failed', {
        threadName,
        threadId: session.threadId,
        sessionId,
        error: getErrorMessage(err),
      });
    }

    // Dispatch routing: read from the first-class threads.dispatch_mode
    // column. The thread row is fetched
    // best-effort above (line 75), so null-coalesce to 'mentioned' when it
    // didn't load.
    const dispatchRouting = thread?.dispatchMode ?? 'mentioned';
    // Cadence is implicit in the routing mode (no separate sequential knob):
    //   - 'all'         → everyone fires in parallel
    //   - 'mentioned'   → mentioned agents fire in parallel (multi-mention OK)
    // `parallelDispatch` from the socket payload still wins when supplied
    // (lets a caller force parallel for one-off scripted dispatch).
    const effectiveParallelDispatch = isGroup ? true : Boolean(parallelDispatch);

    const routedMentions = mentions;

    let dispatchSet: Set<string>;
    // Normalize mention-target IDs for case-insensitive matching against participants.
    // Some agent IDs in the DB use uppercase UUIDs; participant IDs and mention-resolved
    // IDs may disagree on case, which would silently drop the mention. We match in lowercase
    // and preserve the canonical participant ID in the dispatch set.
    //
    // Helper closes over participantAgentIds so every mention-skip decision in this handler
    // uses the same case-insensitive rule.
    const resolveParticipantId = (mentionedId: string): string | undefined => {
      const lc = mentionedId.toLowerCase();
      return participantAgentIds.find((pid) => pid.toLowerCase() === lc);
    };
    const isParticipantMention = (mentionedId: string): boolean =>
      resolveParticipantId(mentionedId) !== undefined;
    const mentionedIdSetLC = new Set(
      routedMentions.mentionedAgentIds.map((id) => id.toLowerCase())
    );
    dispatchSet = buildDispatchSet({
      mentions: routedMentions,
      dispatchRouting,
      participantAgentIds,
      mentionedIdSetLC,
    });

    if (dispatchSet.size === 0) {
      LogsService.socket.event('message produced empty dispatch set', {
        threadName,
        threadId: session.threadId,
        sessionId,
        dispatchRouting,
        rawMentions: routedMentions.rawMentions,
        isGroup,
        hasMentions: routedMentions.hasMentions,
      });

      if (isGroup && !routedMentions.hasMentions && dispatchRouting === 'mentioned') {
        // 'mentioned' mode group thread, no @mention — message is saved but no agents woken.
        // Send a soft hint rather than an error so the user knows how to act.
        const agentNames = Array.from(agentNameMap.values());
        const example = agentNames.length > 0 ? `@${agentNames[0]}` : '@agent-name';
        wsService.sendToClient(meta.clientId, {
          type: 'socket:chat:dispatch_hint',
          payload: {
            sessionId,
            threadId: session.threadId,
            message: `This is a group thread — use ${example} to address an agent. Your message was saved but no one was notified.`,
          },
        });
      } else {
        const noDispatchMessage =
          routedMentions.rawMentions.length > 0 && routedMentions.mentionedAgentIds.length === 0
            ? 'No agents responded because none of those @mentions matched participants in this thread.'
            : 'No agents were dispatched for this message.';
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { sessionId, threadId: session.threadId, message: noDispatchMessage },
        });
      }

      const { finishSessionAndPersistStragglers } = await import('./chatPhases/midRunMessages');
      await finishSessionAndPersistStragglers(sessionId, {
        threadId: session.threadId,
        threadName,
      });
      return;
    }

    const dispatchOutcome = await dispatchToThreadInternal({
      session,
      sessionId,
      threadName,
      isGroup,
      meta,
      message,
      triggerMessageId,
      participantAgentIds,
      agentNameMap,
      agentRoleMap,
      resolveParticipantId,
      isParticipantMention,
      rosterVersion,
      mentions: routedMentions,
      dispatchSet,
      dispatchRouting,
      effectiveParallelDispatch,
      thread,
      threadRuntimeConfig,
    });

    // Socket-path: behavior preserved. The dispatch result is informational only —
    // all WS frames for the wave-loop lifecycle were emitted from inside dispatchToThreadInternal
    // (which already had wsService in its dep bag). We log the outcome so debugging
    // socket sessions can correlate handler entry/exit to dispatch terminal state.
    LogsService.socket.event('dispatch outcome', {
      threadName,
      threadId: session.threadId,
      sessionId,
      ok: dispatchOutcome.ok,
      reason: dispatchOutcome.reason,
      wakeCount: dispatchOutcome.ok ? dispatchOutcome.wakeCount : 0,
      capHit: dispatchOutcome.ok ? dispatchOutcome.capHit : false,
    });
  }
}

export function registerChatSendHandler(): void {
  wsService.registerHandler<ChatSendPayload>('socket:chat:send', processChatSend);
}
