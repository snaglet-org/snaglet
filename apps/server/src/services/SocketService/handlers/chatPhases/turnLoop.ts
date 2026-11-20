/**
 * turnLoop — per-agent turn lifecycle orchestration.
 *
 * Executes a single agent's turn: build context, call LLM, process tool calls,
 * emit results, update state. All per-session state comes through `deps`;
 * mutable wave state (dispatch counters, mention queues) comes through `shared`.
 * Module singletons (wsService, activeRunTracker) are imported directly.
 */

import { randomUUID } from 'crypto';
import { Runs } from '@snaglet/db/tables/runs';
import { Messages, type MessageRow } from '@snaglet/db/tables/messages';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import type { SnagletAgent } from '@server/services/AgentService';
import type { Message } from '@server/services/SocketService/types';
import { emitAgentStatus, emitAgentTyping, stripThinkingTags } from '../chatHelpers';
import { LogsService } from '@server/services/LogsService';
import { logger } from '@server/config/logger';
import { elapsedMs, getErrorMessage } from '@snaglet/shared/utils';
import {
  persistRunErrorMessage,
  classifyRunError,
} from '@server/services/SocketService/persistRunErrorMessage';

// Module singletons used directly inside the turn body.
import { wsService } from '@server/services/WebSocketService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { hooks } from '@server/services/HookService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { readAgentAbortReason } from '@server/services/SocketService/abortStore';
import { isAgentTurnTimeoutAbort } from '@server/services/SocketService/dispatch/turnTimeoutAbort';

import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';
import { routeAllModeMidRunMessage, applyAllModeFanoutEffects } from './routeAllModeMidRunMessage';
import { assembleAgentTurnContext, prepareModelAttemptContext } from './contextAssembly';
import { visionThreadService } from '@server/services/vision/VisionThreadService';
import { handleFinalReply } from './finalReply';
import { streamModelCall } from './llmStream';
import { isProviderStreamStallError } from './streamIdleWatchdog';
import {
  isProviderRetryHandledError,
  isTransientProviderError,
} from '@server/services/ProviderChatService/errors';
import { drainToolLoopMidRunMessages } from './midRunMessages';
import { isOutputLimitStop, OUTPUT_LIMIT_CONTINUE_PROMPT } from './outputLimit';
import { requestMaxOutputTokens } from '@server/services/ContextWindowService';
import {
  buildAssistantContentBlocks,
  buildCutOffTurnBlocks,
  buildPromptMessagesForIteration,
  stripThinkingFromMessages,
  withoutThinkingBlocks,
} from './promptBuilder';
import { createRunCompactor } from './runCompactor';
import { createHistoryCompactor } from './historyCompactor';
import { scheduleHistoryCompactionMemoryExtraction } from '@server/services/summary/scheduleCompactionMemoryExtraction';
import { dispatchToolCalls } from './toolDispatch';
import { runInOwnChainScope } from '@server/realtime/runContext';
import { createRepeatCallGuard } from './repeatCallGuard';
import { decideFallback } from './fallbackPolicy';
import { estimateAbandonedCacheTokens, recordCacheFootprint } from './cacheFootprintTracker';
import { createRunTokenMeter, type RunTokenMeter, type RunTokenTotals } from './runTokenMeter';
import { persistUtterance } from './utteranceMessages';
import { routeReplyMentions } from './routeReplyMentions';
import { lintWorkspaceReferencesInMessage } from '@server/services/SocketService/outboundMessageLinter';
import { isThreadVoiceActive } from '@server/services/SocketService/voiceSession/voiceSessionRegistry';
import { emitVoiceDelta } from '@server/services/SocketService/voiceSession/voiceStreamEvents';
import {
  acquireGenerationFloor,
  releaseGenerationFloor,
  releaseGenerationFloorAfterPlayback,
  type FloorAcquireOutcome,
} from '@server/services/SocketService/voiceSession/floorArbiter';
import { buildVoiceCatchUpBlocks, type VoiceCatchUpCursor } from './voiceCatchUp';
import {
  transientProviderRetryDelayMs,
  waitForTransientProviderRetry,
} from './providerRetryPolicy';
import { broadcastTurnSafetyNetError, releaseTurnResources } from './agentTurnTeardown';
import { helperTurnHeld } from '@server/services/subagents/turnGate';
import { noteHelperTurnFailure } from '@server/services/subagents/turnFailures';

/** Why a turn that ends before its first run could not start, in a subagent helper's words. */
const PRE_RUN_FAILURE = {
  agent_not_found: 'its agent record was not found',
  agent_archived: 'its agent is archived',
  no_model: 'it has no model configured',
} as const;

/**
 * Record a run that ended without a reply (an abort or any error) and
 * unregister it. The write comes first because the shutdown drain waits on the
 * unregister before closing the database; the unregister runs even when the
 * write throws, so a failed write never leaves the run looking live.
 */
async function endFailedRun(runId: string, reason: string, totals: RunTokenTotals): Promise<void> {
  try {
    await Runs.markFailed(runId, reason, {
      inputTokens: totals.billedInputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      providerCalls: totals.providerCalls,
    });
  } finally {
    activeRunTracker.finish(runId);
  }
}

export async function runAgentTurnLoop(
  deps: RunAgentTurnDeps,
  shared: RunAgentTurnSharedState,
  inputReplyAgentId: string,
  abortController: AbortController = deps.abortController
): Promise<void> {
  // Destructure deps/shared so the turn body can reference them without prefix.
  const {
    session,
    sessionId,
    threadName,
    meta,
    isGroup,
    participantAgentIds,
    activeRunIds,
    previewMessage,
    toToolText,
    triggerMessageId,
    wokenByMention,
    startAgent,
    HARD_DISPATCH_CEILING,
    dispatchSet,
    agentNameMap,
    effectiveParallelDispatch,
    dispatchMode,
  } = deps;

  // Reference-typed shared fields are safe to destructure once: mutations to
  // the underlying Set/Map/Array via these aliases are visible to the
  // orchestrator. Primitive shared fields (e.g. `conversationRound`) are
  // intentionally not destructured here — they must be read fresh on every
  // invocation as `shared.x`, since the orchestrator mutates them between
  // waves and a one-shot destructure would freeze the value.
  const { runningAgents, agentMentionQueues, agentDispatchCount, passedAgents } = shared;
  // `currentWaveResults` is intentionally not destructured: the orchestrator
  // assigns a fresh array to `shared.currentWaveResults` at the top of every
  // wave, and the body must observe each wave's current array. Read via
  // `shared.currentWaveResults` at call time.

  const runTurn = async (replyAgentId: string): Promise<void> => {
    const statusContext = {
      agentName: agentNameMap.get(replyAgentId),
      threadId: session.threadId,
    };
    // Clears the agent's bubble (a `queued` announced for this turn) when the
    // turn ends without a run; a no-op when the thread shows nothing for it.
    const sendTurnIdle = (): void =>
      emitAgentStatus(meta.clientId, sessionId, replyAgentId, 'idle', statusContext);
    if (abortController.signal.aborted) {
      sendTurnIdle();
      return;
    }
    // A paused or removed subagent helper's queued turn never reaches the model.
    if (await helperTurnHeld(replyAgentId, triggerMessageId)) {
      LogsService.socket.event('subagent turn dropped: paused or removed', {
        threadName,
        threadId: session.threadId,
        agentId: replyAgentId,
        triggerMessageId: triggerMessageId ?? null,
      });
      sendTurnIdle();
      return;
    }
    runningAgents.add(replyAgentId);
    agentMentionQueues.set(replyAgentId, []);
    agentDispatchCount.set(replyAgentId, (agentDispatchCount.get(replyAgentId) ?? 0) + 1);
    // Set true the moment this turn touches the speaking floor (voice threads
    // only), so the finally can release it belt-and-suspenders. Stays false on
    // text threads → zero floor calls there (the zero-touch invariant).
    let usedFloor = false;
    // Set once a run is registered: from then on the run's own exit paths send
    // the agent's idle, and the finally leaves the status to them.
    let runRegistered = false;
    try {
      // The bubble shows from the moment the turn starts: context assembly
      // (history, prompt, memory recall) runs before the run is registered.
      emitAgentStatus(meta.clientId, sessionId, replyAgentId, 'thinking', {
        ...statusContext,
        beforeRun: true,
      });

      // Notify client that the agent is continuing with another round
      // so it can create a new pending message bubble. `wave` (1-indexed)
      // drives the live wave indicator in the chat header.
      if (shared.conversationRound > 0) {
        wsService.broadcastToChannel(session.threadId, {
          type: 'socket:agent:continuing',
          payload: { sessionId, agentId: replyAgentId, wave: shared.conversationRound + 1 },
        });
      }

      const turnContext = await assembleAgentTurnContext({ deps, shared, replyAgentId });
      // A subagent helper whose turn ends here never starts a run, so no
      // run:end reports it: its orchestrator learns why from this note.
      if (turnContext.status !== 'ready') {
        noteHelperTurnFailure(session.threadId, replyAgentId, PRE_RUN_FAILURE[turnContext.status]);
      }
      if (turnContext.status === 'agent_not_found') {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: {
            sessionId,
            threadId: session.threadId,
            message: `Agent not found: ${replyAgentId}`,
          },
        });
        return;
      }
      if (turnContext.status === 'agent_archived') {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: {
            sessionId,
            threadId: session.threadId,
            message: `Agent ${turnContext.agent.name} is archived — restore it before sending`,
          },
        });
        return;
      }
      if (turnContext.status === 'no_model') {
        // Run-terminating config failure: broadcast so every tab on the thread
        // (not just the sender) clears the agent's pending state and sees why it
        // won't answer, instead of a stuck "Thinking…" bubble until refresh.
        // The `no_model` kind lets the chat offer a link to the agent's page;
        // the persisted row keeps the notice after a reload. No run started, so
        // neither carries a run id.
        const summary = `Pick a provider and model for ${turnContext.agent.name} to answer.`;
        wsService.broadcastToChannel(session.threadId, {
          type: 'socket:error',
          payload: {
            sessionId,
            threadId: session.threadId,
            agentId: turnContext.agent.id,
            kind: 'no_model',
            message: summary,
          },
        });
        await persistRunErrorMessage({
          threadId: session.threadId,
          agentId: turnContext.agent.id,
          agentName: turnContext.agent.name,
          runId: null,
          kind: 'no_model',
          rawError: summary,
        });
        return;
      }

      const {
        agent,
        agentTools,
        executionTools,
        advertisedTools,
        threadBlockedTools,
        toolAccess,
        lookupMissingTool,
        modelCandidates,
        runtimeAgentTemplate,
        systemBlocks,
        turnContextData,
      } = turnContext;

      const t0 = turnContext.startedAt;
      let runtimeAgent: SnagletAgent = runtimeAgentTemplate;
      let modelHandled = false;

      for (let attemptIndex = 0; attemptIndex < modelCandidates.length; attemptIndex++) {
        const modelCandidate = modelCandidates[attemptIndex]!;
        let runId: string | null = null;
        let latestThinking = '';
        // Accumulators hoisted so the catch handler can record partial usage on failure.
        // `totalInputTokens` is deliberately the last call's prompt size (see the
        // assignment below); the run's billed input lives on the token meter.
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        // Live per-run token counter. Null until the run row exists, because a
        // frame without a runId can't be attributed to a bubble. The catch
        // handlers read its totals for the partial usage they persist.
        let tokenMeter: RunTokenMeter | null = null;
        const meterTotals = (): RunTokenTotals =>
          tokenMeter?.totals() ?? {
            billedInputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            providerCalls: 0,
            promptTokens: 0,
            reported: false,
          };
        // One turn-level recovery per model candidate, shared across every
        // tool-loop iteration. A second transient failure flows through the
        // existing fallback policy below.
        let sameModelRetryUsed = false;
        // A stalled model stream (no bytes for streamIdleTimeoutMs) is retried
        // once, separately from the transient-error retry; a second stall
        // fails the turn with a clear "Model stream stalled" notice.
        let stallRetryUsed = false;
        // Visible text streamed by the current iteration, accumulated from the
        // socket:delta stream (already thinking-stripped). Reset each iteration
        // and read by the abort catch to persist a partial utterance when the
        // user barges in mid-sentence — see the AbortError branch below.
        let partialIterationVisibleText = '';

        runtimeAgent = {
          ...runtimeAgentTemplate,
          provider: modelCandidate.provider_id,
          modelId: modelCandidate.model_id,
          credentialId: modelCandidate.credential_id,
        };

        const fanOutAllModeMidRunMessage = (
          midRunContent: string,
          targetAgentIds?: readonly string[],
          meta?: {
            senderAgentId?: string | null;
            senderUserId?: string | null;
            senderName?: string;
            sourceMessageId?: string;
          }
        ) => {
          const fanout = routeAllModeMidRunMessage({
            replyAgentId,
            participantAgentIds,
            targetAgentIds,
            runningAgents,
            agentDispatchCount,
            dispatchSet,
            passedAgents,
            wokenByMention,
            hardDispatchCeiling: HARD_DISPATCH_CEILING,
            effectiveParallelDispatch,
            content: midRunContent,
            startAgent,
            queuePendingMessage: (targetAgentId) => {
              pendingAgentMessages.enqueue({
                threadId: session.threadId,
                targetAgentId,
                senderAgentId: meta?.senderAgentId ?? agent.id,
                senderUserId: meta?.senderUserId ?? null,
                senderName: meta?.senderName ?? agent.name,
                content: midRunContent,
                reason: 'all-mode-thread-message',
                sourceMessageId: meta?.sourceMessageId,
              });
            },
          });

          applyAllModeFanoutEffects(fanout, {
            agentName: agent.name,
            modelName: runtimeAgent.modelId ?? 'unknown',
            threadName,
            threadId: session.threadId,
            sessionId,
            agentNameMap,
            agentDispatchCount,
            broadcastToChannel: (channel, msg) => deps.wsService.broadcastToChannel(channel, msg),
          });

          return fanout;
        };

        LogsService.socket.event('chat.send', {
          agentName: agent.name,
          modelName: runtimeAgent.modelId,
          threadName,
          threadId: session.threadId,
          sessionId,
          provider: runtimeAgent.provider,
          modelId: runtimeAgent.modelId,
          attempt: attemptIndex + 1,
          source: modelCandidate.source,
        });

        // Notify client which model is being used (updates live on fallback)
        wsService.sendToClient(meta.clientId, {
          type: 'socket:agent:model',
          payload: {
            sessionId,
            agentId: agent.id,
            providerId: runtimeAgent.provider,
            modelId: runtimeAgent.modelId ?? '',
            source: modelCandidate.source,
          },
        });

        try {
          // Start run
          runId = randomUUID();
          await Runs.create({
            id: runId,
            threadId: session.threadId,
            agentId: agent.id,
            providerId: runtimeAgent.provider,
            model: runtimeAgent.modelId ?? '',
          });
          // The work descriptor feeds the active-work registry (status-bar
          // "agents working" surface); unregistration is handled by the same
          // finish() calls / teardown flush that end the run itself.
          activeRunTracker.start(runId, {
            agentId: agent.id,
            agentName: agent.name,
            threadId: session.threadId,
            threadTitle: threadName,
          });
          activeRunIds.add(runId);
          runRegistered = true;
          // Announced after registration, so the session handshake
          // (liveRunStatuses) already reports this run to any view that has
          // seen this frame.
          emitAgentStatus(meta.clientId, sessionId, agent.id, 'thinking', {
            agentName: agent.name,
            modelName: runtimeAgent.modelId,
            threadId: session.threadId,
          });

          // Live token counter for this run. Broadcast (not send-to-client) so
          // every tab watching the thread sees the same number climb, matching
          // how the rest of the run's chrome is delivered.
          const meterRunId = runId;
          tokenMeter = createRunTokenMeter({
            emit: (payload) => {
              wsService.broadcastToChannel(session.threadId, {
                type: 'socket:run:usage',
                payload: {
                  ...payload,
                  sessionId,
                  threadId: session.threadId,
                  agentId: agent.id,
                  runId: meterRunId,
                },
              });
            },
          });

          const {
            toolRows,
            toolMap,
            threadBlockedToolMap,
            visibleToolIds,
            budget,
            agentMessages,
            historyFold,
            maxToolIterations,
            shouldStreamThinking,
            compactionCarryForward,
            contextWatermark,
            currentRunBoundary: attemptRunBoundary,
            visionAccessCandidate,
          } = await prepareModelAttemptContext({
            deps,
            agent,
            runtimeAgent,
            agentTools,
            executionTools,
            advertisedTools,
            threadBlockedTools,
            toolAccess,
            turnContextData,
            // Created above, so the prior-run hint looks past it.
            currentRunId: runId,
          });

          // Everything the loop appends to agentMessages from here on is this
          // run's own working state; when it outgrows the budget the compactor
          // folds its oldest part in place (see runCompactor).
          // A history fold removes messages from the front of agentMessages; both indexes below
          // follow it (see onHistoryFolded).
          let currentRunBoundary = attemptRunBoundary;
          const runCompactor = createRunCompactor({
            threadId: session.threadId,
            agentId: agent.id,
            agentName: agent.name,
            runId: meterRunId,
            sessionId,
            currentRunBoundary,
            runStartIndex: agentMessages.length,
            abortSignal: abortController.signal,
            broadcast: (message) => wsService.broadcastToChannel(session.threadId, message),
          });
          // Folds the replayed history into a persisted compaction when compression would cut
          // it. Absent where a caller supplies no replay spans.
          const historyCompactor = historyFold
            ? createHistoryCompactor({
                threadId: session.threadId,
                agentId: agent.id,
                agentName: agent.name,
                runId: meterRunId ?? null,
                abortSignal: abortController.signal,
              })
            : undefined;

          let iterations = 0;
          // A reply cut off at the output limit is continued once per attempt.
          let continuedAfterCutOff = false;
          // Thinking goes back with the turn the run continues from until the
          // provider refuses replayed thinking once; then the run stops sending it.
          let replayThinking = true;
          // Per-run guard against byte-identical repeat tool calls. Scoped to
          // this model attempt (one run/runId), reset on fallback to a fresh
          // attempt; not persisted.
          const repeatGuard = createRepeatCallGuard();
          // Floor-gated generation (voice threads only). Before each model call
          // the agent must hold the thread's speaking floor; on acquire it first
          // catches up on everything said while it was parked. Captured once per
          // model attempt (the whole block is inert on text threads).
          const voiceGated = isThreadVoiceActive(session.threadId);
          // Watermark = newest thread row already folded into this attempt's
          // context. Seeded from the same read the context assembly consumed
          // (contextWatermark = max (created_at,id) of the rows buildReplayPayload
          // read), so context and catch-up are provably contiguous — a row that
          // lands after assembly is folded, one already perceived never is. Only
          // when the context contained zero messages (watermark null) do we fall
          // back to a head read to anchor the cursor near "now". Advances per fold.
          let catchUpCursor: VoiceCatchUpCursor | null = null;
          if (voiceGated) {
            usedFloor = true;
            if (contextWatermark) {
              catchUpCursor = contextWatermark;
            } else {
              const head = await Messages.getLastByThread(session.threadId).catch(() => null);
              catchUpCursor = head ? { createdAt: head.createdAt, id: head.id } : null;
            }
          }
          // Fold everything after the watermark into the tail (append-only,
          // cache-safe). Pages until the backlog is drained under a hard bound so
          // a long absence (a burst of peer utterances) is caught up in full, not
          // silently truncated at one page. Best-effort — a read failure never
          // breaks the turn.
          const CATCH_UP_PAGE = 50;
          const CATCH_UP_MAX_PAGES = 5; // hard bound: 250 rows / turn
          const foldVoiceCatchUp = async (): Promise<void> => {
            if (!catchUpCursor) return;
            const allBlocks: string[] = [];
            let drained = false;
            let pages = 0;
            while (pages < CATCH_UP_MAX_PAGES) {
              pages++;
              const rows = await Messages.listAfter(session.threadId, {
                afterCreatedAt: catchUpCursor.createdAt,
                afterId: catchUpCursor.id,
                limit: CATCH_UP_PAGE,
              }).catch(() => [] as MessageRow[]);
              if (rows.length === 0) {
                drained = true;
                break;
              }
              const { blocks, cursor } = buildVoiceCatchUpBlocks(rows, {
                selfAgentId: agent.id,
                agentNameMap,
              });
              // Cursor advances to the last row seen each page (strictly-after
              // keyset), so the loop always makes forward progress and can't refold.
              if (cursor) catchUpCursor = cursor;
              allBlocks.push(...blocks);
              if (rows.length < CATCH_UP_PAGE) {
                drained = true;
                break;
              }
            }
            if (!drained) {
              LogsService.warn('voice catch-up not fully drained within page bound', {
                agentName: agent.name,
                threadName,
                threadId: session.threadId,
                pages,
              });
            }
            if (allBlocks.length === 0) return;
            agentMessages.push({ role: 'user', content: allBlocks.join('\n\n') } as Message);
            LogsService.socket.event('voice catch-up injected', {
              agentName: agent.name,
              threadName,
              threadId: session.threadId,
              count: allBlocks.length,
            });
          };
          // Whether this iteration currently holds the floor (vs. proceeding
          // without it after a backstop / teardown / no-session).
          let holdsFloor = false;

          while (iterations < maxToolIterations) {
            iterations++;
            partialIterationVisibleText = '';

            // Stop pressed mid-tool-loop: don't start another model call after a
            // tool returns. streamModelCall would reject on the aborted signal
            // anyway, but bailing here avoids building the next prompt first and
            // makes Stop feel immediate. Throw the same AbortError the stream
            // path throws so the unified abort cleanup below runs.
            if (abortController.signal.aborted) {
              throw new DOMException('run aborted between tool iterations', 'AbortError');
            }

            if (voiceGated) {
              // Acquire the speaking floor before generating. If a peer holds it
              // (speaking or synthesizing) this parks until the floor frees, the
              // run aborts, the backstop fires, or the session ends. Parked time
              // must not count against the dispatch turn timeout — pause it around
              // the wait.
              deps.pauseTurnTimeout?.(agent.id);
              let acquireOutcome: FloorAcquireOutcome;
              try {
                acquireOutcome = await acquireGenerationFloor(session.threadId, agent.id, {
                  signal: abortController.signal,
                });
              } finally {
                deps.resumeTurnTimeout?.(agent.id);
              }
              if (acquireOutcome === 'aborted') {
                // Barge-in / disconnect while parked → unwind through the normal
                // abort path (clean cleanup below): markFailed + status reset +
                // socket:chat:aborted. No partial utterance — nothing streamed yet.
                throw new DOMException('voice run aborted while parked on the floor', 'AbortError');
              }
              // 'acquired' → we hold it; 'backstop'/'teardown'/'no-session' → we
              // proceed without it rather than wedge (never release what we don't hold).
              holdsFloor = acquireOutcome === 'acquired';
              // Catch up first: fold everything said while we were away.
              await foldVoiceCatchUp();
            }

            const messagesForAgent = await buildPromptMessagesForIteration({
              agent,
              runtimeAgent,
              agentMessages,
              budget,
              isGroup,
              threadName,
              threadId: session.threadId,
              systemBlocks,
              toolRows,
              iteration: iterations,
              compactionCarryForward,
              currentRunBoundary,
              runCompactor,
              historyCompactor,
              historyFold,
              onHistoryFolded: (folded, removed) => {
                currentRunBoundary -= removed;
                runCompactor.shiftIndexes(removed);
                scheduleHistoryCompactionMemoryExtraction({
                  threadId: session.threadId,
                  agentId: agent.id,
                  foldedUnitIds: folded.foldedUnitIds,
                  agentNameMap,
                  onResult: (result) => {
                    wsService.broadcastToChannel(session.threadId, {
                      type: 'socket:thread:memory-extraction',
                      payload: { threadId: session.threadId, agentId: agent.id, ...result },
                    });
                  },
                });
              },
            });

            const streamResult = await (async () => {
              while (true) {
                try {
                  // A retry re-sends the same prompt, so it IS another provider
                  // call and is counted as one — the in-flight estimate from the
                  // abandoned attempt is dropped rather than double-counted.
                  tokenMeter?.beginCall();
                  return await streamModelCall({
                    onUsage: (usage) => tokenMeter?.observe(usage),
                    streamIdleTimeoutMs: deps.streamIdleTimeoutMs ?? 0,
                    agent,
                    runtimeAgent,
                    messagesForAgent,
                    toolRows,
                    budget,
                    systemBlocks,
                    abortController,
                    sessionId,
                    clientId: meta.clientId,
                    threadId: session.threadId,
                    threadName,
                    runId,
                    iteration: iterations,
                    latestThinking,
                    shouldStreamThinking,
                    previewMessage,
                    onVisibleDelta: (chunk) => {
                      partialIterationVisibleText += chunk;
                      // Streaming TTS (voice threads only): feed the visible-text delta
                      // to the TTS pipeline as it streams so the agent starts speaking on
                      // the first completed sentence, not at persist. Guarded by
                      // voiceGated so text threads never emit (zero-touch invariant); the
                      // synthetic utterance id is keyed off (runId, iteration).
                      if (voiceGated && runId) {
                        emitVoiceDelta({
                          threadId: session.threadId,
                          agentId: agent.id,
                          runId,
                          iteration: iterations,
                          text: chunk,
                        });
                      }
                    },
                  });
                } catch (streamErr) {
                  const isStall = isProviderStreamStallError(streamErr);
                  const canRetrySameModel =
                    !abortController.signal.aborted &&
                    (isStall
                      ? !stallRetryUsed
                      : !sameModelRetryUsed &&
                        !isProviderRetryHandledError(streamErr) &&
                        isTransientProviderError(streamErr));
                  if (!canRetrySameModel) throw streamErr;

                  if (isStall) stallRetryUsed = true;
                  else sameModelRetryUsed = true;
                  const delayMs = isStall ? 0 : transientProviderRetryDelayMs();
                  const discardedPartialCharacters = partialIterationVisibleText.length;
                  LogsService.warn(
                    isStall ? 'stream retry after stall' : 'stream retry after transient abort',
                    {
                      agentName: agent.name,
                      modelName: runtimeAgent.modelId,
                      provider: runtimeAgent.provider,
                      threadName,
                      threadId: session.threadId,
                      sessionId,
                      runId,
                      iteration: iterations,
                      delayMs,
                      discardedPartialCharacters,
                      error: getErrorMessage(streamErr),
                    }
                  );

                  // The first attempt may already have painted deltas into the
                  // pending bubble. Clear that run-scoped transient accumulator
                  // before re-sending so the successful retry starts from an
                  // empty surface. No assistant row has been persisted yet.
                  wsService.broadcastToChannel(session.threadId, {
                    type: 'socket:agent:stream:retry',
                    payload: {
                      sessionId,
                      agentId: agent.id,
                      runId,
                      delayMs,
                    },
                  });
                  partialIterationVisibleText = '';
                  await waitForTransientProviderRetry(abortController.signal, delayMs);
                }
              }
            })();
            const { result, emittedTyping } = streamResult;
            // The provider accepted this attempt's payload and answered (text
            // or tool calls). That — not assembling the payload — is the moment
            // the agent can be said to have perceived the vision context, so it
            // is the only place the attempt's candidate may be confirmed. An
            // attempt that never gets here leaves the transition pending, and a
            // fallback that succeeds confirms its own snapshot rather than the
            // failed attempt's.
            visionThreadService.confirmAccessDelivered(
              session.threadId,
              agent.id,
              visionAccessCandidate
            );
            latestThinking = streamResult.latestThinking;
            // Reaper feed: a completed model call is run progress.
            activeRunTracker.noteProgress(sessionId);
            if (result.thinkingDropped && replayThinking) {
              // Edits to earlier turns (condensed tool results, a compaction)
              // invalidated the replayed thinking: drop it for the rest of the run.
              replayThinking = false;
              stripThinkingFromMessages(agentMessages);
            }
            const keepThinking = (blocks: ReturnType<typeof buildAssistantContentBlocks>) =>
              replayThinking ? blocks : withoutThinkingBlocks(blocks);

            // totalInputTokens is the last iteration's value only: the message
            // badge shows "how full is the context", and MessageList infers a
            // compaction when it drops, so summing would break both. It is not a
            // cost figure. totalOutputTokens is summed. The run's billed input
            // (Σ over calls) is the token meter's job, committed from
            // `result.usage` so the live counter matches what `runs` persists.
            totalInputTokens = result.usage?.inputTokens ?? totalInputTokens;
            totalOutputTokens += result.usage?.outputTokens ?? 0;
            tokenMeter?.commitCall(result.usage);
            // Remember the warm-cache footprint so a later fallback can
            // report how much cache it abandons.
            recordCacheFootprint(session.threadId, agent.id, result.usage);

            // Persist this iteration's thinking block to the activity log so the
            // ChatView activity bubble can replay it after the run completes.
            // One row per provider iteration matches the natural reading
            // granularity (thought → did → thought → did).
            const thinkingBlock = (result.thinkingContent ?? latestThinking ?? '').trim();
            if (thinkingBlock.length > 0 && runId) {
              AgentActivityLog.logActivity({
                agentId: agent.id,
                runId,
                actionType: 'thinking',
                triggerType: 'chat_nudge',
                content: thinkingBlock,
                tokenEstimate: result.usage?.thinkingTokens ?? 0,
              }).catch((err) =>
                LogsService.warn('Failed to log thinking activity', { error: err })
              );
            }
            // A reply that stopped at the output limit (thinking can use the
            // whole budget before any text) gets one more call asking the model
            // to continue. Its tool calls never run: the last may be truncated.
            const cutOff = isOutputLimitStop(result.stopReason);
            const continueCutOff =
              cutOff && !continuedAfterCutOff && iterations < maxToolIterations;
            // A non-terminal iteration is one that ends in tool calls — the
            // model spoke, then acted — or a cut-off reply being continued. The
            // terminal iteration's reply becomes the final posted message
            // (handleFinalReply owns it, including its mention routing), so only
            // the interim iterations persist here.
            const isTerminalIteration =
              !continueCutOff &&
              (!result.toolCalls ||
                result.toolCalls.length === 0 ||
                result.stopReason !== 'tool_use');

            // Persist this iteration's spoken text as a first-class assistant
            // message row. A mention that appears only in private reasoning
            // summons no one — agents must say the summon out loud. The
            // persisted utterance row is the routing substrate, so it routes
            // its own @-mentions exactly once, through the same policy
            // handleFinalReply uses for the terminal reply.
            if (!isTerminalIteration && runId) {
              const spokenText = stripThinkingTags(result.reply ?? '').reply.trim();
              if (spokenText.length > 0) {
                // Unverified workspace ids are logged only (observability). No
                // correction is injected and the row is not marked: agents may
                // write incorrect ids on purpose (examples, hypotheticals).
                // Cache safety: the row keeps the agent's original text; the
                // rewritten form from the lint is never persisted.
                const utteranceContent = spokenText;
                try {
                  const lint = await lintWorkspaceReferencesInMessage(spokenText);
                  if (lint.issues.length > 0) {
                    LogsService.warn('interim utterance failed integrity lint', {
                      agentName: agent.name,
                      threadName,
                      threadId: session.threadId,
                      runId,
                      lintKind: 'unverified_workspace_ids',
                      unverifiedIds: [...new Set(lint.issues.map((issue) => issue.id))],
                    });
                  }
                } catch (err) {
                  // Fail open: an infrastructure fault must never drop an
                  // agent's utterance.
                  LogsService.warn('interim utterance linter failed', {
                    threadName,
                    threadId: session.threadId,
                    error: getErrorMessage(err),
                  });
                }
                const utteranceId = await persistUtterance({
                  threadId: session.threadId,
                  threadName,
                  agentId: agent.id,
                  runId,
                  content: utteranceContent,
                  previewMessage,
                  logLabel: 'interim utterance persisted',
                });
                // This iteration's spoken text is now a persisted row. Clear the
                // barge-in accumulator so an AbortError raised during this
                // iteration's tool execution can't re-persist the same text as a
                // partial utterance (which would duplicate the row + bubble).
                partialIterationVisibleText = '';
                // Null return = the agent was removed from the thread mid-run
                // and the utterance was dropped. Skip mention routing so a
                // removed agent cannot wake teammates on its way out.
                if (utteranceId !== null) {
                  // Re-reads the roster first if an agent joined or left.
                  await routeReplyMentions({
                    deps,
                    shared,
                    agent,
                    runtimeAgent,
                    replyAgentId,
                    content: utteranceContent,
                    fanOutAllModeMidRunMessage,
                    logContext: 'utterance',
                  });
                }
              }
            }
            // Reset the sliding-window display accumulator so the next
            // iteration's thinking is captured cleanly.
            latestThinking = '';

            if (continueCutOff) {
              continuedAfterCutOff = true;
              LogsService.warn('reply cut off at the output limit; asking the model to continue', {
                agentName: agent.name,
                modelName: runtimeAgent.modelId,
                threadName,
                threadId: session.threadId,
                runId,
                iteration: iterations,
                maxOutputTokens: requestMaxOutputTokens(budget),
              });
              const cutOffTurn = keepThinking(buildCutOffTurnBlocks(result));
              if (cutOffTurn.length > 0) {
                agentMessages.push({ role: 'assistant', content: cutOffTurn } as Message);
              }
              agentMessages.push({
                role: 'user',
                content: OUTPUT_LIMIT_CONTINUE_PROMPT,
              } as Message);
              // The next call acquires the speaking floor again (voice threads),
              // and acquiring is not re-entrant.
              if (holdsFloor) {
                releaseGenerationFloor(session.threadId, agent.id);
                holdsFloor = false;
              }
              continue;
            }

            // If no tool calls, we're done
            if (isTerminalIteration) {
              await handleFinalReply({
                deps,
                shared,
                replyAgentId,
                agent,
                runtimeAgent,
                agentMessages,
                result,
                runId,
                budget,
                startedAt: t0,
                totalInputTokens,
                totalOutputTokens,
                runTokens: meterTotals(),
                iterations,
                runCompactions: runCompactor.count(),
                fanOutAllModeMidRunMessage,
                ...(cutOff
                  ? { cutOff: { maxOutputTokens: requestMaxOutputTokens(budget) ?? null } }
                  : {}),
              });
              // End of the speaking turn: free the floor on playback completion of
              // this final utterance so the next speaker naturally
              // pauses until this one finishes playing (handleFinalReply already
              // persisted it → its audio job is enqueued on the same floor).
              if (holdsFloor) {
                releaseGenerationFloorAfterPlayback(session.threadId, agent.id);
                holdsFloor = false;
              }
              break;
            }

            if (emittedTyping) {
              emitAgentTyping(meta.clientId, sessionId, agent.id, false, {
                agentName: agent.name,
                modelName: runtimeAgent.modelId,
                threadId: session.threadId,
              });
            }
            emitAgentStatus(meta.clientId, sessionId, agent.id, 'tool_running', {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadId: session.threadId,
            });

            // Model requested tool use — build assistant message with content blocks
            const assistantContent = keepThinking(buildAssistantContentBlocks(result));
            agentMessages.push({ role: 'assistant', content: assistantContent } as Message);

            // Dropping into silent tool execution: release the floor immediately
            // so a parked peer may generate while this agent works —
            // its just-spoken interim utterance keeps playing on the audio floor
            // independently. Re-acquired at the top of the next iteration.
            if (holdsFloor) {
              releaseGenerationFloor(session.threadId, agent.id);
              holdsFloor = false;
            }

            const toolDispatchResult = await dispatchToolCalls({
              result,
              agent,
              runtimeAgent,
              agentMessages,
              toolMap,
              threadBlockedToolMap,
              visibleToolIds,
              lookupMissingTool,
              toolAccess,
              session,
              sessionId,
              threadName,
              runId,
              triggerMessageId,
              latestThinking,
              toToolText,
              dispatchMode,
              repeatGuard,
              // socket:chat:abort must reach inside in-flight tool
              // executions, not just the space between iterations.
              abortSignal: abortController.signal,
              wakeOrigin: deps.wakeOrigin,
              unattended: deps.unattended,
              contextBudget: budget,
            });
            latestThinking = toolDispatchResult.latestThinking;
            // The advertised tools never change mid-run: a tool fetched with
            // tool(op:schema) arrives as that call's result and is invoked
            // through the `action` gateway, so the cached prefix (tools,
            // system, history) stays warm instead of being rewritten.
            // Mentions in this iteration's spoken text were already routed when
            // the interim utterance was persisted above — the utterance row is
            // the single routing substrate for an agent's spoken text.

            await drainToolLoopMidRunMessages({
              deps,
              shared,
              replyAgentId,
              agent,
              runtimeAgent,
              agentMessages,
              fanOutAllModeMidRunMessage,
            });

            emitAgentStatus(meta.clientId, sessionId, agent.id, 'thinking', {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadId: session.threadId,
            });
          }

          if (iterations >= maxToolIterations) {
            const errMsg = `Agent exceeded maximum tool iterations (${maxToolIterations})`;
            LogsService.warn(errMsg, {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadName,
              threadId: session.threadId,
            });
            throw new Error(errMsg);
          }

          modelHandled = true;
          break;
        } catch (err) {
          const attributedAbort = readAgentAbortReason(abortController.signal);
          const isAbort =
            attributedAbort !== null ||
            (err instanceof DOMException && err.name === 'AbortError') ||
            (err instanceof Error && err.name === 'AbortError');

          if (isAbort) {
            // A per-agent timeout aborts this turn's controller too (the
            // dispatch already surfaced the timeout error) — label it honestly.
            const abortedByLabel = attributedAbort
              ? attributedAbort.abortedBy.actorName?.trim() ||
                (attributedAbort.abortedBy.actorKind === 'system'
                  ? 'watchdog'
                  : attributedAbort.abortedBy.actorId)
              : isAgentTurnTimeoutAbort(abortController.signal)
                ? 'timeout'
                : 'user';
            // A targeted abort ends this agent's participation in the current
            // dispatch. Without this, the next wave could immediately wake the
            // same agent again while its peers continue.
            passedAgents.add(agent.id);
            shared.passKinds.set(agent.id, 'abort');
            LogsService.socket.event('chat aborted', {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadName,
              threadId: session.threadId,
              sessionId,
              abortedBy: abortedByLabel,
            });
            // Barge-in: persist whatever the agent had spoken in the current
            // iteration before the abort as a final partial utterance row, so
            // the transcript reflects what was actually heard (voice) / said
            // (text) instead of vanishing. Non-empty only; not mention-routed —
            // the user interrupted, so a cut-off sentence must not summon peers.
            // Strip thinking tags to match the interim-utterance path exactly: a
            // model emitting literal <thinking> text inline must not persist raw
            // tags on barge-in. Persist only if non-empty after stripping.
            const partialUtterance = stripThinkingTags(partialIterationVisibleText).reply.trim();
            if (runId && partialUtterance.length > 0) {
              // Best-effort: a transient DB failure here must not skip the run
              // cleanup below (markFailed / tracker.finish / status reset /
              // socket:chat:aborted) — otherwise the thread wedges as "run
              // already in progress". Log and continue regardless.
              try {
                await persistUtterance({
                  threadId: session.threadId,
                  threadName,
                  agentId: agent.id,
                  runId,
                  content: partialUtterance,
                  previewMessage,
                  logLabel: 'partial utterance persisted (aborted mid-utterance)',
                });
              } catch (persistErr) {
                LogsService.warn('partial utterance persist failed during abort', {
                  agentName: agent.name,
                  threadName,
                  threadId: session.threadId,
                  error: getErrorMessage(persistErr),
                });
              }
            }
            try {
              if (runId) {
                // Partial usage on an abort is still real spend: persist the
                // billed total (Σ across the calls that completed), matching the
                // completed-run path so `runs` never mixes the two meanings.
                const abortedTotals = meterTotals();
                await endFailedRun(runId, `Aborted by ${abortedByLabel}`, abortedTotals);
                hooks.emit('run:end', {
                  runId,
                  agentId: agent.id,
                  threadId: session.threadId,
                  status: 'aborted',
                });
              }
            } finally {
              emitAgentTyping(meta.clientId, sessionId, agent.id, false, {
                agentName: agent.name,
                modelName: runtimeAgent.modelId,
                threadId: session.threadId,
              });
              emitAgentStatus(meta.clientId, sessionId, agent.id, 'idle', {
                agentName: agent.name,
                modelName: runtimeAgent.modelId,
                threadId: session.threadId,
              });
            }
            // Attributed aborts are emitted immediately by AbortRunService;
            // unattributed (parent-signal) aborts are announced here.
            if (!attributedAbort) {
              wsService.broadcastToChannel(session.threadId, {
                type: 'socket:chat:aborted',
                payload: { sessionId, agentId: agent.id },
              });
            }
            // Break out of the model-candidate loop — do not fallback on abort
            modelHandled = true;
            break;
          }

          const errMsg = getErrorMessage(err) || (err instanceof Error ? err.name : '');
          LogsService.socket.error(err, {
            agentName: agent.name,
            modelName: runtimeAgent.modelId,
            threadName,
            threadId: session.threadId,
            provider: runtimeAgent.provider,
            modelId: runtimeAgent.modelId,
            sessionId,
          });

          try {
            if (runId) {
              await endFailedRun(runId, errMsg, meterTotals());
              hooks.emit('run:end', {
                runId,
                agentId: agent.id,
                threadId: session.threadId,
                status: 'failed',
              });
            }
          } finally {
            emitAgentTyping(meta.clientId, sessionId, agent.id, false, {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadId: session.threadId,
            });
            emitAgentStatus(meta.clientId, sessionId, agent.id, 'idle', {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadId: session.threadId,
            });
          }

          // A user-pinned override (set on thread_participants OR
          // threads.config_json.agents[agentId].model) must not silently fall
          // through to a different model. Both override stores produce the
          // candidate `source: 'thread_override'` (see modelCandidates.ts).
          // Agents with config_json.disableModelFallback opt out entirely:
          // a provider error fails the turn loudly instead of
          // abandoning the warm cache for a different provider.
          const userPinnedModel = modelCandidate.source === 'thread_override';
          const hasNextModel = attemptIndex < modelCandidates.length - 1;
          const fallbackDisabled = agent.disableModelFallback;
          const compactReason = errMsg.replace(/\s+/g, ' ').trim();
          const decision = decideFallback({ hasNextModel, userPinnedModel, fallbackDisabled });

          if (decision.fallback) {
            const nextCandidate = modelCandidates[attemptIndex + 1]!;
            // Cache transparency: switching provider abandons the
            // warm prompt cache built on the failing one — surface the size.
            const estWastedCacheTokens = estimateAbandonedCacheTokens(session.threadId, agent.id);
            LogsService.warn('model fallback', {
              agentName: agent.name,
              modelName: runtimeAgent.modelId,
              threadName,
              threadId: session.threadId,
              sessionId,
              from: `${runtimeAgent.provider}/${runtimeAgent.modelId}`,
              to: `${nextCandidate.provider_id}/${nextCandidate.model_id}`,
              attempt: attemptIndex + 1,
              reason: compactReason,
              estWastedCacheTokens,
            });
            logger.info(
              `[fallback_cost] thread_id=${session.threadId} agent_id=${agent.id} ` +
                `from=${runtimeAgent.provider}/${runtimeAgent.modelId} ` +
                `to=${nextCandidate.provider_id}/${nextCandidate.model_id} ` +
                `est_wasted_cache_tokens=${estWastedCacheTokens}`
            );
            // Surface the fallback to the client so the user sees
            // "Gemma 3 failed: <reason>, retrying with <next>" in the UI
            // instead of a silent model swap.
            wsService.broadcastToChannel(session.threadId, {
              type: 'socket:agent:model:fallback',
              payload: {
                sessionId,
                agentId: agent.id,
                fromProviderId: runtimeAgent.provider,
                fromModelId: runtimeAgent.modelId ?? '',
                toProviderId: nextCandidate.provider_id,
                toModelId: nextCandidate.model_id,
                reason: compactReason,
                cacheReset: true,
                estWastedCacheTokens,
              },
            });
            continue;
          }

          // No retry: the user pinned a specific model, the agent opted out
          // of fallback (disableModelFallback), or the chain is
          // exhausted. Surface the actual provider error to the client and
          // stop the run — loudly, with the no-fallback reason attached.
          const failureSuffix =
            decision.reason === 'disabled'
              ? ' (model fallback is disabled for this agent)'
              : decision.reason === 'pinned'
                ? ' (model pinned by thread override — no fallback)'
                : '';
          // Run-terminating failure: broadcast (not send-to-client) so every
          // participant on the thread channel — not only the originating tab —
          // clears its streaming/typing indicators and sees the run died live,
          // instead of the pending bubble hanging until a manual refresh. Carry
          // `runId` so the client can scope the failure to the exact run.
          // markFailed already ran above; the persisted error bubble
          // (persistRunErrorMessage) + socket:done follow and supersede the
          // transient error bubble this frame paints.
          wsService.broadcastToChannel(session.threadId, {
            type: 'socket:error',
            payload: {
              sessionId,
              threadId: session.threadId,
              agentId: agent.id,
              runId,
              message: `[${agent.name}] ${errMsg}${failureSuffix}`,
            },
          });
          // Persist a chat-visible error message + broadcast to the
          // thread so every participant (UI + other agents on the next
          // turn) sees what went wrong instead of a silent dead bubble.
          await persistRunErrorMessage({
            threadId: session.threadId,
            agentId: agent.id,
            agentName: agent.name,
            runId,
            kind: classifyRunError(err),
            rawError: err,
            provider: runtimeAgent.provider,
            modelId: runtimeAgent.modelId,
          });
          // Clear the pending bubble so the UI doesn't sit in "Thinking…".
          wsService.broadcastToChannel(session.threadId, {
            type: 'socket:done',
            payload: {
              sessionId,
              runId,
              reply: '',
              durationMs: elapsedMs(t0),
              agentId: agent.id,
            },
          });
          break;
        } finally {
          // Flush the terminal usage frame and drop the coalescing timer on
          // every exit from this attempt — completed, aborted, failed, or
          // falling back to the next model. A fallback starts a new run id and
          // therefore a new meter, so this one must stop emitting.
          tokenMeter?.finalize();
        }
      }

      if (!modelHandled) {
        return;
      }
    } catch (turnErr) {
      // Safety net for run-terminating failures that escape the per-attempt
      // catch above (rationale + broadcast semantics live in
      // broadcastTurnSafetyNetError). Re-throw to preserve the existing dispatch
      // propagation.
      noteHelperTurnFailure(session.threadId, replyAgentId, getErrorMessage(turnErr));
      broadcastTurnSafetyNetError(turnErr, {
        threadId: session.threadId,
        sessionId,
        replyAgentId,
      });
      throw turnErr;
    } finally {
      const isSuperseded = (): boolean =>
        deps.isTurnSuperseded?.(replyAgentId, abortController) ?? false;
      // A turn that ends before its run registers (agent missing or archived,
      // no model, a failure or abort during context assembly) has no run exit
      // to clear the bubble shown since the turn started. A superseded turn
      // leaves the agent's status to the newer turn.
      if (!runRegistered && !isSuperseded()) sendTurnIdle();
      // End-of-turn teardown on any exit (error, abort, cap): release the
      // speaking floor belt-and-suspenders and drop this agent's per-wave
      // running/queue state (see releaseTurnResources).
      await releaseTurnResources({
        usedFloor,
        threadId: session.threadId,
        replyAgentId,
        triggerMessageId,
        runningAgents,
        agentMentionQueues,
        isSuperseded,
      });
    }
  };

  // The turn gets its own copy of the chain context: an injected hook message
  // raises this run's depth (see peerInjection), never the wave's or a
  // sibling agent's.
  await runInOwnChainScope(() => runTurn(inputReplyAgentId));
}
