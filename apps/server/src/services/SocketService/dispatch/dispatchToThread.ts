/**
 * dispatchToThread — wave-loop and mention-routing core.
 *
 * Owns the per-wave dispatch loop: resolves which agents to wake, runs their
 * turns in parallel or sequence, and routes @mentions. Called by the socket
 * chat path and tool wakeups.
 *
 * `dispatchToThreadInternal` does the work; `dispatchToThread` is the public
 * entry point that wraps it for non-socket callers and returns a DispatchResult.
 */

import { wsService } from '@server/services/WebSocketService';
import { getErrorMessage } from '@snaglet/shared/utils';
import { agentService } from '@server/services/AgentService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { settingsService } from '@server/services/settings';
import { dispatchSettings } from '@server/services/settings/categories/dispatch';
import { agentSettings } from '@server/services/settings/categories/agent';
import {
  createAbortController,
  createAgentAbortController,
  clearAgentAbortController,
  isAgentTurnSuperseded,
} from '../abortStore';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { enqueueSeedForRunningTargets, type SeedSender } from './seedInjection';
import type { WaveTurnResult } from '../handlers/chatHelpers';
import type { MentionContext } from '@server/services/PerceptionService';
import { LogsService } from '@server/services/LogsService';
import { handleAgentDispatchError } from './handleAgentDispatchError';
import { previewMessage, toToolText } from '../handlers/chatHandlers/formatters';
import { buildConversationBudget } from '../handlers/chatHandlers/buildConversationBudget';
import type { ConversationBudgetSeed } from '@server/services/ConversationBudget';
import type {
  ConversationPassKind,
  ConversationStopReason,
  UnattendedWake,
  WakeOrigin,
} from '@snaglet/shared/types';
import { readAgentAbortReason } from '../abortStore';
import {
  currentHookChain,
  getRunContext,
  runAtChainDepth,
  runCappedUnattended,
  runWithUnattended,
} from '@server/realtime/runContext';
import { getCurrentActor } from '@server/realtime/actorContext';
import { resolveUnattendedWake } from './unattendedWake';
import {
  chainStampMetadata,
  mergeChainStamps,
  readChainStamp,
  unknownChainStamp,
} from '@server/services/customHooks/chainStamp';
import { createRunAgentTurn } from '../handlers/chatPhases/runAgentTurn';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from '../handlers/chatPhases/types';
import { Threads } from '@snaglet/db/tables/threads';
import { AGENT_ABORT_DRAIN_MS, DEFAULT_AGENT_TIMEOUT_MS } from '../constants';
import {
  AgentTurnTimeoutAbort,
  isAgentTurnTimeoutAbort,
  settleWithin,
  waitForAbort,
} from './turnTimeoutAbort';
import { emitThreadStartedEvent } from '../threadEvents';
import { createPausableAgentTimeout } from './pausableAgentTimeout';
import { isThreadSummaryHalted } from '@server/services/summary/summaryHalt';
import { holdWakeForSummaryHalt, liftSummaryHaltAndReplayWakes } from './summaryHaltedWakes';
import { finalizeDispatchRun } from './dispatchRunTeardown';
import { createLiveRoster } from './liveRoster';
import type { DispatchResult, InternalDispatchDeps } from './dispatchTypes';

// `createPausableAgentTimeout`, `DispatchResult` and `InternalDispatchDeps` live
// in focused modules and are re-exported here for importers of this file.
export { createPausableAgentTimeout };
export type { DispatchResult, InternalDispatchDeps };

export async function dispatchToThreadInternal(
  deps: InternalDispatchDeps
): Promise<DispatchResult> {
  // Result accumulator — mutated inside the function and returned at the end.
  // Named `dispatchResult` to avoid collision with the existing `result` name
  // already in use inside the wave loop (`for (const result of currentWaveResults)`).
  // Default is 'completed'; specific code paths overwrite reason/capHit.
  const dispatchResult: {
    wakeCount: number;
    capHit: boolean;
    reason: 'completed' | 'cap_hit' | 'cancelled' | 'no_dispatch';
  } = {
    wakeCount: 0,
    capHit: false,
    reason: 'completed',
  };
  // This run's lock generation, captured synchronously before any await (the
  // caller acquired the lock immediately before calling us). The teardown uses
  // it to tell "release my lock" from "a reaper already released it and a newer
  // run on the same reused session id now holds it".
  const runToken = activeRunTracker.sessionRunToken(deps.sessionId);
  // Why the conversation ended (stop-reason taxonomy). Set at every loop
  // exit; the teardown treats a propagating exception (holder still null) as
  // 'error'. Attached to the DispatchResult and emitted by finalizeDispatchRun.
  let stopReason: ConversationStopReason | null = null;
  const {
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
    mentions,
    dispatchSet,
    dispatchRouting,
    effectiveParallelDispatch,
    thread,
    threadRuntimeConfig,
  } = deps;

  if (isGroup && mentions.hasMentions) {
    const mentionedNames = mentions.mentionedAgentIds
      .map((id) => agentNameMap.get(id) ?? id)
      .join(', ');
    LogsService.socket.event('@mentions resolved', {
      threadName,
      threadId: session.threadId,
      mentionedNames,
    });
  }

  // Build mention context for each agent's system prompt
  const mentionedAgentNames = mentions.mentionedAgentIds
    .map((id) => agentNameMap.get(id))
    .filter((n): n is string => Boolean(n));

  // A DM / home thread: one agent, no routing. Fixed for the thread's life.
  const isDm = thread?.kind === 'dm';

  // The roster mentions resolve against. It starts as the snapshot above and is
  // re-read only when an agent joins or leaves the thread during the run
  // (liveRoster.ts), so "add them, then @-mention them" wakes them in the same
  // turn and a removed agent is not woken. Everything else keeps the snapshot.
  const roster = createLiveRoster({
    threadId: session.threadId,
    threadName,
    ids: participantAgentIds,
    names: agentNameMap,
    roles: agentRoleMap,
    excludeAgentId: deps.rosterExcludeAgentId,
    version: deps.rosterVersion,
  });

  const buildMentionContext = (agentId: string): MentionContext | undefined => {
    if (!isGroup) return undefined;
    return {
      isMentioned: mentions.mentionedAgentIds.includes(agentId),
      mentionedAgentNames,
      isOpenFloor: !mentions.hasMentions,
    };
  };

  // Both callers (socket path and the tool entry below) hold the
  // thread run lock by the time we run, and the wave loop's finally owns the
  // release — so anything that throws before that try/finally must release
  // the lock itself, or the thread wedges with "A run is already in
  // progress" until restart. These settings/budget reads are the only
  // awaits in that window.
  let convBudget: Awaited<ReturnType<typeof buildConversationBudget>>;
  let SOFT_DISPATCH_THRESHOLD: number;
  try {
    convBudget = await buildConversationBudget({
      isGroup,
      threadRuntimeConfig,
      seed: deps.budgetSeed,
    });
    // Per-agent dispatch soft threshold: always the settings-registry
    // default. `thread.maxAgentDispatches` is deliberately ignored: the wave
    // cap already bounds every agent (at most one dispatch per wave), so a
    // per-thread override is redundant. The column is unused.
    SOFT_DISPATCH_THRESHOLD = await settingsService.read(dispatchSettings.softThreshold);
  } catch (err) {
    // A caller that already ack'd "queued" to a client must not have that
    // message silently dropped just because this prelude threw before the
    // wave loop's own try/finally (which owns the straggler-persist path)
    // ever started — route finishSession's return through the same helper.
    const { finishSessionAndPersistStragglers } =
      await import('../handlers/chatPhases/midRunMessages');
    await finishSessionAndPersistStragglers(sessionId, { threadId: session.threadId, threadName });
    throw err;
  }
  const HARD_DISPATCH_CEILING = SOFT_DISPATCH_THRESHOLD * 2;

  const passedAgents = new Set<string>();
  // How each agent left the conversation (last write wins) — shared with the
  // turn machinery via sharedState.passKinds; read by the teardown for the
  // stop-reason attribution + structured log. Declared here (not inside the
  // try) so the finally can see it.
  const passKinds = new Map<string, ConversationPassKind>();

  // Recent replies per agent (window) for stagnation/similarity detection
  const recentRepliesByAgent = new Map<string, string[]>();

  // Agents explicitly @mentioned by other agents during the current wave.
  // Only these agents should be re-dispatched in the next wave — everyone
  // else who already responded auto-passes to prevent self-reply loops.
  const wokenByMention = new Set<string>();

  // Track which agents are currently running within a wave (for parallel dispatch).
  // If a running agent is @mentioned, inject the message into their tool loop
  // instead of re-queuing them for another wave.
  const runningAgents = new Set<string>();
  const agentMentionQueues = new Map<string, string[]>();

  // Track how many times each agent has been dispatched. A soft threshold
  // (resolved in the guarded prelude above: dispatch.soft_threshold from the
  // settings registry, default 5) injects discernment guidance; the hard
  // ceiling (2x soft) is the safety net.
  const agentDispatchCount = new Map<string, number>();
  const agentSoftThresholdNotified = new Set<string>();

  // Safety net: track all run IDs started in this conversation so we can
  // flush any that were never finished (hung streams, unexpected throws, etc.)
  const activeRunIds = new Set<string>();

  // Create an AbortController for this conversation — the abort handler
  // can call controller.abort() to cancel in-flight LLM requests.
  const abortController = createAbortController(sessionId, session.threadId);

  // Turn-zero narration: the first time a thread dispatches, persist
  // one "[thread started …]" event capturing the opening roster + dispatch mode.
  // Idempotent (no-op if already emitted) and awaited before the wave loop so it
  // lands in this turn's replay. Best-effort — never blocks dispatch on failure.
  await emitThreadStartedEvent(session.threadId, {
    participants: participantAgentIds.map((agentId) => ({
      agentId,
      name: agentNameMap.get(agentId),
    })),
    // A DM / home thread has no routing: its start line names no mode.
    dispatchMode: isDm ? null : dispatchRouting,
  });

  try {
    // The client creates pending bubbles for all participants when a
    // message is sent. If @mentions narrowed the dispatch set, send
    // socket:done with passed=true for non-dispatched agents so the
    // client removes their stuck "Thinking…" bubbles.
    if (isGroup && mentions.hasMentions) {
      for (const agentId of participantAgentIds) {
        if (!dispatchSet.has(agentId)) {
          wsService.broadcastToChannel(session.threadId, {
            type: 'socket:done',
            payload: {
              sessionId,
              reply: '',
              durationMs: 0,
              agentId,
              passed: true,
            },
          });
        }
      }
    }

    // Build the per-session turn runner once; reuse it across every wave.
    // 0 = unlimited (the default): no wall-clock timer is armed for the turn;
    // hung model calls are caught by the stream-idle watchdog in llmStream.
    const agentTimeoutMs = await settingsService
      .read(agentSettings.timeoutSeconds)
      .then((s) => s * 1000)
      .catch(() => DEFAULT_AGENT_TIMEOUT_MS);
    const streamIdleTimeoutMs = await settingsService
      .read(agentSettings.streamIdleTimeoutSeconds)
      .then((s) => s * 1000)
      .catch(() => agentSettings.streamIdleTimeoutSeconds.default * 1000);

    const sharedState: RunAgentTurnSharedState = {
      runningAgents,
      agentMentionQueues,
      agentDispatchCount,
      agentSoftThresholdNotified,
      passedAgents,
      recentRepliesByAgent,
      stagnationStrikes: new Map<string, number>(),
      currentWaveResults: [],
      tokenTotals: { input: 0, output: 0 },
      passKinds,
      // Synced per-wave from the unified counter (ConversationBudget.waveCount);
      // stays 0-indexed for downstream consumers (continuation frames,
      // isContinuationRound, logs). A seeded budget starts past 0 — its turns
      // are continuation rounds by construction.
      conversationRound: Math.max(0, convBudget.currentWave() - 1),
    };

    // Natural (everyone-passed) endings are attributed 'stagnation' when at
    // least one agent's final pass was a repetition auto-pass.
    const resolveNaturalStopReason = (): ConversationStopReason => {
      for (const kind of sharedState.passKinds.values()) {
        if (kind === 'stagnation') return 'stagnation';
      }
      return 'all-passed';
    };

    // Late-bound reference to the wave loop's local `startAgent`. The
    // factory body needs to call `startAgent` for mid-wave
    // mention-triggered dispatch, but `startAgent` is declared inside
    // the wave loop's block scope (below). The wave loop assigns
    // `startAgentHolder.current = startAgent` once it constructs the
    // local one each wave; the dep thunk delegates through the holder.
    const startAgentHolder: { current: ((id: string) => void) | null } = {
      current: null,
    };

    // Per-live-turn pausable timeout controllers, keyed by agent id (one live
    // turn per agent — `runningAgents` guards). The turn loop calls
    // deps.pause/resumeTurnTimeout to stop the clock while it parks on the voice
    // speaking floor, so parked time is not charged against the per-agent
    // timeout (floor-gated generation). Registered by the
    // dispatch branches below, torn down when the turn settles.
    const turnTimeouts = new Map<string, { pause: () => void; resume: () => void }>();

    const turnDeps: RunAgentTurnDeps = {
      session,
      sessionId,
      threadId: session.threadId,
      threadName,
      clientId: meta.clientId,
      meta,
      // Live: read through the roster, so a turn that starts or routes after an
      // agent joined or left sees the thread as it is now.
      get isGroup() {
        return roster.isGroup;
      },
      participantAgentIds: roster.ids,
      softDispatchThreshold: SOFT_DISPATCH_THRESHOLD,
      hardDispatchCeiling: HARD_DISPATCH_CEILING,
      agentTimeoutMs: agentTimeoutMs,
      streamIdleTimeoutMs,
      threadRuntimeConfig,
      activeRunIds,
      previewMessage,
      toToolText,
      triggerMessageId,
      wokenByMention,
      isParticipantMention: (mentionedId) => roster.resolve(mentionedId) !== undefined,
      startAgent: (id) => startAgentHolder.current?.(id),
      HARD_DISPATCH_CEILING,
      dispatchSet,
      wsService,
      agentService,
      abortController,
      convBudget,
      agentNameMap,
      agentRoleMap,
      resolveParticipantId: (mentionedId) => roster.resolve(mentionedId),
      refreshRoster: () => roster.refreshIfChanged(),
      buildMentionContext,
      effectiveParallelDispatch,
      dispatchMode: dispatchRouting,
      isDm,
      isHelperThread: Boolean(thread?.parentThreadId),
      pauseTurnTimeout: (agentId) => turnTimeouts.get(agentId)?.pause(),
      resumeTurnTimeout: (agentId) => turnTimeouts.get(agentId)?.resume(),
      isTurnSuperseded: (agentId, controller) =>
        isAgentTurnSuperseded(session.threadId, agentId, controller),
      ...(deps.wakeOrigin ? { wakeOrigin: deps.wakeOrigin } : {}),
      ...(deps.unattended ? { unattended: deps.unattended } : {}),
    };

    const runAgentTurn = createRunAgentTurn(turnDeps, sharedState);

    /**
     * A turn that failed — timed out, errored before replying, or returned
     * without a wave result (agent missing/archived, no model, terminal model
     * failure) — is passed for the rest of this dispatch, so later waves do not
     * keep re-dispatching it (the post-wave auto-pass loop does not see these
     * turns). A later explicit @mention can still re-summon it (mentionRouter
     * clears passedAgents).
     */
    const markTurnFailed = (id: string): void => {
      passedAgents.add(id);
      sharedState.passKinds.set(id, 'error');
    };

    /**
     * Run one agent turn under the per-agent timeout. On timeout or Stop the
     * turn's own controller is aborted (rejecting the
     * wrapper alone would leave the turn running, able to post late and ignore
     * Stop), then the dispatch waits up to AGENT_ABORT_DRAIN_MS for it to unwind
     * before releasing its slot. A turn that outlives the bound is abandoned and
     * passed; its eventual teardown is ownership-checked (isTurnSuperseded) so it
     * cannot clobber a newer turn. Resolves on success, timeout and abort;
     * re-throws non-timeout errors.
     */
    const runGatedAgentTurn = async (id: string): Promise<void> => {
      const agentLabel = agentNameMap.get(id) ?? id;
      const waveResults = sharedState.currentWaveResults;
      const resultsBefore = waveResults.filter((r) => r.agentId === id).length;
      const agentAbortController = createAgentAbortController(
        sessionId,
        session.threadId,
        id,
        abortController.signal
      );
      // The pausable wrapper subscribes to both outcomes of `turn`, so a late
      // rejection after a timeout is always observed (never unhandled).
      const turn = runAgentTurn(id, agentAbortController);
      const gated = createPausableAgentTimeout(turn, agentTimeoutMs, agentLabel, () =>
        agentAbortController.abort(new AgentTurnTimeoutAbort(id, agentTimeoutMs))
      );
      turnTimeouts.set(id, { pause: gated.pause, resume: gated.resume });
      // Stop / targeted abort must not wait on the turn: a turn that ignores
      // its abort (a tool that never checks the signal) would otherwise hold
      // this slot — and the whole dispatch — until the per-agent timeout.
      // Race the gated turn against the controller's abort, then give the
      // turn a bounded window to unwind. The pausable timeout itself is
      // untouched, so voice-floor pauses still stop the countdown.
      const abortWait = waitForAbort(agentAbortController.signal);
      let abandoned = false;
      try {
        try {
          const outcome = await Promise.race([
            gated.promise.then(() => 'settled' as const),
            abortWait.promise,
          ]);
          // A timeout aborts the controller too, but its wrapper has already
          // rejected by now — `await gated.promise` below routes it to the
          // timeout handling (which drains on its own).
          if (outcome === 'aborted' && !isAgentTurnTimeoutAbort(agentAbortController.signal)) {
            const settled = await settleWithin([turn], AGENT_ABORT_DRAIN_MS);
            if (!settled) {
              abandoned = true;
              LogsService.warn('aborted agent turn did not unwind within the drain bound', {
                threadName,
                threadId: session.threadId,
                agentName: agentLabel,
                drainMs: AGENT_ABORT_DRAIN_MS,
              });
              if (!passedAgents.has(id)) {
                passedAgents.add(id);
                sharedState.passKinds.set(id, 'abort');
              }
              return;
            }
          }
          await gated.promise;
        } catch (err) {
          // Timeout -> log + notify client + persist the error line.
          // Non-timeout -> re-throws inside the helper.
          await handleAgentDispatchError(err, {
            agentId: id,
            agentLabel,
            threadName,
            threadId: session.threadId,
            sessionId,
            clientId: meta.clientId,
          });
          const settled = await settleWithin([turn], AGENT_ABORT_DRAIN_MS);
          if (!settled) {
            abandoned = true;
            LogsService.warn('timed-out agent turn did not unwind within the drain bound', {
              threadName,
              threadId: session.threadId,
              agentName: agentLabel,
              drainMs: AGENT_ABORT_DRAIN_MS,
            });
          }
          waveResults.push({ agentId: id, passed: true, replyLength: 0 });
          markTurnFailed(id);
          return;
        }
        // Completed without recording a wave result → it never replied or
        // passed (early return / terminal model failure). Unless an abort
        // already passed it (the abort path adds it to passedAgents itself),
        // treat it as failed so it is not re-dispatched every wave.
        const resultsAfter = waveResults.filter((r) => r.agentId === id).length;
        if (
          resultsAfter === resultsBefore &&
          !passedAgents.has(id) &&
          !agentAbortController.signal.aborted
        ) {
          markTurnFailed(id);
          LogsService.socket.event('auto-passed (turn ended without a reply)', {
            threadName,
            threadId: session.threadId,
            agentName: agentLabel,
            wave: convBudget.currentWave(),
          });
        }
      } finally {
        abortWait.dispose();
        // Disarm a still-pending timeout (an abandoned Stop leaves the turn,
        // and so its timer, unsettled); a no-op once the wrapper has settled.
        gated.pause();
        turnTimeouts.delete(id);
        // Evaluated before our controller is unregistered: a reaper release
        // plus a newer run can hand this agent's slot to a newer turn while
        // we drained, and the thread-wide pending queue is then that turn's.
        const superseded = isAgentTurnSuperseded(session.threadId, id, agentAbortController);
        clearAgentAbortController(session.threadId, id, agentAbortController);
        if (abandoned) {
          // The abandoned turn's own teardown is now either a no-op (a newer
          // turn owns the slot) or late; clear this dispatch's view of it so
          // mentions start a fresh turn instead of queueing into a dead one.
          runningAgents.delete(id);
          agentMentionQueues.delete(id);
          if (!superseded) pendingAgentMessages.clearAgent(session.threadId, id);
        }
      }
    };

    while (true) {
      // Conversation wave cap — the unified counter (ConversationBudget owns
      // it; the effective limit is min(threadMaxWaves ?? settingsDefault,
      // serverCeiling), all finite). Checked explicitly at the loop top so a
      // wave-cap ending is attributable, distinct from token/iteration
      // exhaustion. Distinct from the per-agent HARD_DISPATCH_CEILING (which
      // limits how many times any single agent can fire): this limits the
      // conversation as a whole regardless of how many agents remain eligible.
      if (convBudget.waveLimitReached()) {
        LogsService.socket.event('conversation ending — wave cap reached', {
          threadName,
          threadId: session.threadId,
          wave: convBudget.currentWave(),
          limit: convBudget.waveLimit(),
        });
        dispatchResult.capHit = true;
        dispatchResult.reason = 'cap_hit';
        stopReason = 'wave-cap';
        break;
      }

      // Non-wave budgets (output tokens / tool iterations) exhausted — the
      // real spend limits. Also the only loop-exit a seeded continuation
      // budget can hit before dispatching anyone.
      if (convBudget.exhaustedNonWave()) {
        const summary = convBudget.summary();
        LogsService.socket.event('conversation budget exhausted', {
          threadName,
          threadId: session.threadId,
          reason: summary.exhaustedReason,
          wave: convBudget.currentWave(),
        });
        stopReason = convBudget.nonWaveExhaustionKind() ?? 'token-budget';
        break;
      }

      // An agent removed from the thread during the run gets no further wave.
      await roster.refreshIfChanged();

      // Build base candidates (all non-passed, non-ceiling agents)
      const baseCandidates =
        convBudget.currentWave() === 0
          ? [...dispatchSet].filter((id) => roster.ids.includes(id))
          : [...dispatchSet].filter((id) => {
              if (passedAgents.has(id)) return false;
              if (!roster.ids.includes(id)) return false;
              const dispatches = agentDispatchCount.get(id) ?? 0;

              // Hard ceiling (2x soft threshold) — absolute safety net
              if (dispatches >= HARD_DISPATCH_CEILING) {
                passedAgents.add(id);
                sharedState.passKinds.set(id, 'ceiling');
                LogsService.socket.event('auto-passed (hard ceiling)', {
                  threadName,
                  threadId: session.threadId,
                  agentName: agentNameMap.get(id) ?? id,
                  dispatches,
                  limit: HARD_DISPATCH_CEILING,
                });
                return false;
              }

              // Soft threshold — mark for discernment injection, don't filter out
              if (dispatches >= SOFT_DISPATCH_THRESHOLD) {
                agentSoftThresholdNotified.add(id);
                LogsService.socket.event('soft dispatch threshold reached', {
                  threadName,
                  threadId: session.threadId,
                  agentName: agentNameMap.get(id) ?? id,
                  dispatches,
                  threshold: SOFT_DISPATCH_THRESHOLD,
                });
              }
              return true;
            });

      // 'all' or 'mentioned' — dispatch everyone in baseCandidates this wave.
      const waveAgents: string[] = baseCandidates;
      if (waveAgents.length === 0) {
        stopReason = resolveNaturalStopReason();
        break;
      }

      convBudget.incrementWave();
      // Sync per-wave state into the shared object the runAgentTurn
      // factory reads from. The factory was constructed once before this
      // loop; per-wave deltas (fresh results array, current round number)
      // travel via sharedState. conversationRound stays 0-indexed: during
      // wave N (1-indexed on the budget counter) the round is N-1.
      const currentWaveResults: WaveTurnResult[] = [];
      sharedState.currentWaveResults = currentWaveResults;
      sharedState.conversationRound = convBudget.currentWave() - 1;

      // `inflight` holds a promise per currently-running agent in this
      // wave. Unlike a frozen `waveAgents`, the set can grow while the
      // wave is running: if an agent is @mentioned mid-wave (by another
      // agent's reply or by a mid-run user message), `startAgent` is
      // called to kick them off immediately and their promise joins the
      // set. The wave does not close until `inflight` drains.
      const inflight = new Map<string, Promise<void>>();

      // A non-timeout failure in a parallel wave: recorded (first one wins) so
      // the wave can drain every sibling turn before the error ends the
      // dispatch — rethrowing mid-wave would release the thread lock while
      // sibling turns are still running.
      const parallelWaveFailure: { failed: boolean; err: unknown } = {
        failed: false,
        err: undefined,
      };

      const startAgent = (id: string): void => {
        if (inflight.has(id)) return;
        if (passedAgents.has(id)) return;
        const dispatches = agentDispatchCount.get(id) ?? 0;
        if (dispatches >= HARD_DISPATCH_CEILING) return;
        if (abortController.signal.aborted) return;
        // A sibling failed hard: the wave is winding down, start nobody new.
        if (parallelWaveFailure.failed) return;
        // In-wave budget gate: once the conversation's spend limits (output
        // tokens / tool iterations) are gone, no new turns may start — this
        // is what bounds the all-mode fan-out ping-pong, whose wakes all
        // funnel through here mid-wave, between the wave-boundary checks.
        if (convBudget.exhaustedNonWave()) return;

        // Agent is about to be dispatched — count it for the result.
        dispatchResult.wakeCount += 1;

        // Never rejects: a non-timeout failure is parked in parallelWaveFailure
        // and re-thrown once the whole wave has drained.
        const p = runGatedAgentTurn(id)
          .catch((err: unknown) => {
            if (parallelWaveFailure.failed) return;
            parallelWaveFailure.failed = true;
            parallelWaveFailure.err = err;
          })
          .finally(() => {
            inflight.delete(id);
          });
        inflight.set(id, p);
      };

      // Bind the forward holder so the runAgentTurn factory's lazy thunk
      // resolves to this wave's startAgent closure.
      startAgentHolder.current = startAgent;

      // Dispatch: parallel or sequential
      if (effectiveParallelDispatch && isGroup) {
        for (const id of waveAgents) startAgent(id);

        // Wait for the whole in-flight set to drain. Late joiners spawned
        // via `startAgent` from inside a running agent's wake path will be
        // picked up on the next race iteration. On abort, every turn's
        // controller is already aborted (parent signal) — give them a bounded
        // window to unwind rather than finalizing the dispatch (and releasing
        // the lock) while they are still executing.
        while (inflight.size > 0) {
          if (abortController.signal.aborted) {
            const drained = await settleWithin(inflight.values(), AGENT_ABORT_DRAIN_MS);
            if (!drained) {
              LogsService.warn('aborted wave: turns did not unwind within the drain bound', {
                threadName,
                threadId: session.threadId,
                agents: [...inflight.keys()].map((id) => agentNameMap.get(id) ?? id),
                drainMs: AGENT_ABORT_DRAIN_MS,
              });
            }
            break;
          }
          // Wake on Stop too, not only when some turn settles: a turn that
          // ignores its abort must not delay the bounded drain above.
          const stopWait = waitForAbort(abortController.signal);
          try {
            await Promise.race([...inflight.values(), stopWait.promise]);
          } finally {
            stopWait.dispose();
          }
        }
        if (parallelWaveFailure.failed) throw parallelWaveFailure.err;
      } else {
        for (const id of waveAgents) {
          if (abortController.signal.aborted) break;
          // Mid-wave spend gate only: the wave was already admitted at the
          // loop top, so wave-count is not rechecked here. incrementWave
          // precedes the turn, so rechecking would make maxWaves=1 dispatch
          // nobody.
          if (convBudget.exhaustedNonWave()) break;
          // Sequential branch — each loop iteration is one agent dispatch.
          dispatchResult.wakeCount += 1;
          // Non-timeout errors propagate and end the dispatch (fail fast).
          await runGatedAgentTurn(id);
        }
      }

      // If the run was aborted, stop the conversation loop. A watchdog/reaper
      // abort carries an attributed system actor on the signal reason; a plain
      // Stop (or an unattributed abort) is the user's.
      if (abortController.signal.aborted) {
        dispatchResult.reason = 'cancelled';
        const attributedAbort = readAgentAbortReason(abortController.signal);
        // A summary halt aborts this same controller (summaryHalt), and it has
        // already narrated its own actionable line — attribute it honestly
        // rather than logging a Stop nobody pressed.
        stopReason = isThreadSummaryHalted(session.threadId)
          ? 'summary-model-unavailable'
          : attributedAbort?.abortedBy.actorKind === 'system'
            ? 'reaper'
            : 'user-abort';
        break;
      }

      // Auto-pass agents that just responded unless another agent
      // explicitly @mentioned them during this wave. This prevents
      // agents from looping — responding to their own previous message
      // indefinitely. An agent only gets re-dispatched if someone
      // specifically asked for their input.
      for (const result of currentWaveResults) {
        if (result.passed) continue; // already passed
        if (wokenByMention.has(result.agentId)) continue; // someone asked for them
        passedAgents.add(result.agentId);
        sharedState.passKinds.set(result.agentId, 'auto');
        LogsService.socket.event('auto-passed (no mention, already responded)', {
          threadName,
          threadId: session.threadId,
          agentName: agentNameMap.get(result.agentId) ?? result.agentId,
          wave: convBudget.currentWave(),
        });
      }
      // Solo chats normally stop after one wave (the inner tool loop handles
      // multi-turn tool use within a dispatch). Exception: a user message that
      // arrived during the agent's final zero-tool LLM call re-wakes it —
      // finalReply's terminal drain persists the message and adds the agent to
      // wokenByMention — so run one more wave to answer it instead of ending
      // idle with the message unread. Capture the signal before the clear.
      const soloReWoken = !isGroup && [...wokenByMention].some((id) => dispatchSet.has(id));

      // Reset for next wave
      wokenByMention.clear();

      if (!isGroup && !soloReWoken) {
        LogsService.socket.event('solo dispatch complete', {
          threadName,
          threadId: session.threadId,
          wave: convBudget.currentWave(),
        });
        stopReason = 'all-passed';
        break;
      }
      if (soloReWoken) {
        LogsService.socket.event('solo re-wake (mid-run message during final LLM call)', {
          threadName,
          threadId: session.threadId,
          wave: convBudget.currentWave(),
        });
      }

      const pendingDispatch = [...dispatchSet].filter((id) => {
        if (passedAgents.has(id)) return false;
        if (!roster.ids.includes(id)) return false;
        const dispatches = agentDispatchCount.get(id) ?? 0;
        return dispatches < HARD_DISPATCH_CEILING;
      });
      if (pendingDispatch.length === 0) {
        LogsService.socket.event('conversation ending — all agents passed', {
          threadName,
          threadId: session.threadId,
          wave: convBudget.currentWave(),
        });
        stopReason = resolveNaturalStopReason();
        break;
      }

      // Budget exhaustion (waves or spend) is handled by the loop-top checks
      // on the next iteration, where each dimension gets an attributable
      // ending. No duplicate bottom-of-wave break.

      LogsService.socket.event(`wave ${convBudget.currentWave()} complete`, {
        threadName,
        threadId: session.threadId,
        activeAgents: dispatchSet.size - passedAgents.size,
        passedAgents: passedAgents.size,
        tokensUsed: convBudget.summary().totalOutputTokens,
      });
    }
  } finally {
    // End-of-run teardown (abort-controller cleanup, run flush, budget-summary
    // log, stop-reason emission, straggler persistence, lock release, and the
    // undelivered re-dispatch) lives in finalizeDispatchRun. Awaited here so it
    // runs on every exit path; `redispatchPersistedMessage` is threaded in as a
    // callback to keep this module's import graph acyclic. A propagating
    // exception reaches here with the stop-reason holder unset → 'error'.
    stopReason = stopReason ?? 'error';
    await finalizeDispatchRun({
      sessionId,
      threadId: session.threadId,
      threadName,
      isGroup,
      activeRunIds,
      convBudget,
      stopReason,
      passKinds,
      wakeCount: dispatchResult.wakeCount,
      redispatch: redispatchPersistedMessage,
      abortController,
      runToken,
    });
  }

  // If the wave loop never ran (no dispatch set, no mentions, etc.),
  // surface that explicitly so callers can distinguish "completed naturally"
  // from "never dispatched anyone".
  if (dispatchResult.wakeCount === 0 && dispatchResult.reason === 'completed') {
    dispatchResult.reason = 'no_dispatch';
  }

  return { ok: true, ...dispatchResult, stopReason };
}

/**
 * Re-dispatch a thread for an already-persisted message a finished run never
 * processed (a tool wake skipped because the run held the thread lock, or a
 * mid-run user message the run never drained). Runs after the lock is released.
 * Loads the row for its real sender + content, then calls `dispatchToThread`
 * (source:'tool'), which only wakes agents and never re-persists. Best-effort:
 * failures are logged, not thrown. If the thread is busy again, this repeats on
 * that run's finish, at most once per message per run it outlives.
 */
export async function redispatchPersistedMessage({
  threadId,
  threadName,
  messageId,
  undeliveredCount,
  reason,
  budgetSeed,
  coveredMessageIds,
}: {
  threadId: string;
  threadName: string;
  messageId: string;
  /**
   * Every undelivered message this one wake covers (may include `messageId`).
   * Their @mentions are unioned into the wake set — the seed alone only
   * names whoever the newest message mentioned.
   */
  coveredMessageIds?: readonly string[];
  undeliveredCount: number;
  reason: string;
  /**
   * Consumption snapshot of the run whose leftovers we are re-dispatching.
   * Present when the dispatch finally triggers the redispatch (the common
   * self-healing path) — the continuation shares the ended conversation's
   * budget, so a wedge→redispatch cycle cannot restart the meters. Absent for
   * the reaper's direct call (a force-reaped run has no in-memory budget to
   * snapshot; reaps are one-shot per run, so a fresh budget there is bounded).
   */
  budgetSeed?: ConversationBudgetSeed;
}): Promise<void> {
  try {
    const { Messages } = await import('@snaglet/db/tables/messages');
    const seed = await Messages.findById(messageId);
    if (!seed) {
      LogsService.warn('undelivered-message re-dispatch: message not found', {
        threadName,
        threadId,
        messageId,
      });
      return;
    }
    const senderId = seed.agentId ?? seed.userId;
    if (!senderId) {
      LogsService.warn('undelivered-message re-dispatch: message has no sender', {
        threadName,
        threadId,
        messageId,
      });
      return;
    }
    LogsService.socket.event('re-dispatching undelivered message at run end', {
      threadName,
      threadId,
      messageId,
      undeliveredCount,
      reason,
    });
    const routingMessages: string[] = [];
    const stamps = [readChainStamp(seed.metadata)];
    const unloadedIds: string[] = [];
    // A person's message in the wave caps it: their words must not ride on a
    // hook's or an automation's approval (an unloadable row counts as one).
    let personCovered = isPersonMessage(seed);
    for (const id of new Set(coveredMessageIds ?? [])) {
      if (id === messageId) continue;
      const row = await Messages.findById(id).catch(() => null);
      if (!row) {
        // Its stamp is unknown, not absent: it may be a hook's message at any
        // depth, so it must not read as a person's depth 0.
        unloadedIds.push(id);
        personCovered = true;
        continue;
      }
      if (isPersonMessage(row)) personCovered = true;
      if (row.content) routingMessages.push(row.content);
      stamps.push(readChainStamp(row.metadata));
    }
    if (unloadedIds.length > 0) {
      stamps.push(unknownChainStamp());
      LogsService.warn(
        're-dispatch: covered message row(s) failed to load; wave runs as a hook-caused depth',
        { threadName, threadId, messageId, unloadedIds, chainDepth: 1 }
      );
    }
    // The wave runs in the queued messages' chain context, never the finishing
    // run's: deepest stamp wins; unstamped = a person's, depth 0;
    // an unloadable row = depth 1 (hook-caused, unknown depth).
    const chain = mergeChainStamps(stamps);
    // An automation's seed (metadata.automation) keeps its wake marker
    // when it is delivered after the run that held the thread.
    const wakeOrigin = automationWakeOrigin(seed.metadata);
    const redispatch = () =>
      dispatchToThread({
        threadId,
        senderId,
        messageId,
        message: seed.content,
        source: 'tool',
        budgetSeed,
        ...(routingMessages.length > 0 ? { routingMessages } : {}),
        ...(wakeOrigin ? { wakeOrigin } : {}),
      });
    const result = await runAtChainDepth(
      chain?.depth ?? 0,
      // Capped when a covered message was sent capped (an agent started or
      // caused the hook run that sent it, or an agent sent it), or when a
      // person's message rides in a wave that would otherwise be unattended
      // (a hook's or an automation's message is in it). A person-only wave
      // stays attended.
      () =>
        chain?.capped ||
        (personCovered && ((chain?.hooks.length ?? 0) > 0 || wakeOrigin !== undefined))
          ? runCappedUnattended(redispatch)
          : redispatch(),
      undefined,
      chain?.hooks ?? []
    );
    if (!result.ok || result.wakeCount === 0) {
      LogsService.socket.event('undelivered-message re-dispatch woke no one', {
        threadName,
        threadId,
        messageId,
        reason: result.reason,
      });
    }
  } catch (err) {
    LogsService.warn('undelivered-message re-dispatch failed', {
      threadName,
      threadId,
      messageId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Public entry point for non-socket callers (tool wakeups).
 *
 * Builds the full dep bag from a minimal `{threadId, senderId, messageId, message}`
 * input, then runs the same dispatch core the socket path uses. Caller is
 * responsible for persisting the message + broadcasting it to the thread
 * before calling this — dispatch only wakes agents; it does not persist.
 */
export async function dispatchToThread(input: {
  threadId: string;
  senderId: string;
  /**
   * Persisted seed-message id. Tool callers pass the id of the message they
   * already wrote.
   */
  messageId?: string;
  message: string;
  source: 'tool';
  parallelDispatch?: boolean;
  /**
   * Optional exact participant wake: an automation's agent, a shell job's
   * waiting agent, a subagent's orchestrator.
   */
  targetAgentId?: string;
  /**
   * Continuation-budget seed for self-healing redispatches only (see
   * redispatchPersistedMessage). Genuinely new dispatches must omit it.
   */
  budgetSeed?: ConversationBudgetSeed;
  /**
   * Self-healing redispatch only: texts of the other undelivered messages
   * this wake covers. Their @mentions also pick who wakes, so a peer named
   * only in an earlier undelivered message is not dropped.
   */
  routingMessages?: readonly string[];
  /**
   * Who authored the seed, for in-run delivery when the thread is busy (see
   * enqueueSeedForRunningTargets). `user` = a human/external member (always
   * injected, like a socket send); `agent` = a peer agent (mode-gated). Omitted
   * → no in-run delivery; the post-run re-dispatch alone covers the seed.
   */
  sender?: SeedSender;
  /**
   * What started this wake, when not a message (an automation). Every
   * turn of this dispatch in this thread carries it into its tool context:
   * those runs cannot create or change automations.
   */
  wakeOrigin?: WakeOrigin;
  /**
   * Set only on a replay of a wake held by a summary halt: the unattended
   * marker resolved when the wake first arrived. Every other caller leaves it
   * out and it is resolved here (see unattendedWake.ts).
   */
  unattended?: UnattendedWake;
}): Promise<DispatchResult> {
  // Nobody is there to confirm a tool call in a run an automation or a hook
  // started. Resolved once, now, from the wake marker, the hook chain this
  // dispatch runs in, or the unattended dispatch it starts from, and carried
  // to every turn it starts; a held wake keeps it. Any start an agent
  // triggered (its tool call is running this) or that the context caps is
  // `skip` whatever is stored (see unattendedWake.ts).
  const ambient = getRunContext();
  const unattended =
    input.unattended ??
    (await resolveUnattendedWake({
      wakeOrigin: input.wakeOrigin,
      hookChain: currentHookChain(),
      enclosing: ambient?.unattended,
      capped: ambient?.unattendedCap === true || getCurrentActor()?.actorKind === 'agent',
    }));
  const thread = await Threads.findById(input.threadId);
  if (!thread) {
    return { ok: true, reason: 'no_dispatch', wakeCount: 0, capHit: false };
  }
  // A summary-halted thread refuses agent/tool wakes for the same reason it
  // refuses user sends: no turn may run on a context that cannot be compacted.
  // The wake's seed is already persisted, so it is held and replayed when the
  // halt lifts rather than left unanswered.
  if (isThreadSummaryHalted(input.threadId)) {
    const proceed = await liftSummaryHaltAndReplayWakes(input.threadId);
    if (!proceed) {
      holdWakeForSummaryHalt(unattended ? { ...input, unattended } : input);
      LogsService.socket.event('dispatch held — summary model unavailable', {
        threadId: input.threadId,
        source: input.source,
        senderId: input.senderId,
        messageId: input.messageId ?? null,
      });
      return { ok: true, reason: 'held_for_summary_halt', wakeCount: 0, capHit: false };
    }
  }
  // Dynamic import to avoid a circular dep (buildDispatchDeps imports DispatchResult types from this file).
  const { buildDispatchDeps } = await import('./buildDispatchDeps');
  const built = await buildDispatchDeps({
    threadId: input.threadId,
    senderId: input.senderId,
    messageId: input.messageId,
    message: input.message,
    parallelDispatch: input.parallelDispatch,
    targetAgentId: input.targetAgentId,
    budgetSeed: input.budgetSeed,
    routingMessages: input.routingMessages,
  });
  if (!built.ok) {
    if (built.reason === 'fanout_exceeded') {
      return { ok: false, reason: 'fanout_exceeded', wakeCount: 0, capHit: false };
    }
    // thread_not_found / no_participants — nothing to dispatch, surface as no_dispatch
    return { ok: true, reason: 'no_dispatch', wakeCount: 0, capHit: false };
  }
  // Take the per-thread run lock, like the socket path (chatHandlers), so tool
  // dispatches never run concurrent wave loops and stay visible to the
  // busy-policy / run-status / abort layer. The internal finally releases it.
  //
  // Busy thread → skip rather than queue: the seed is already persisted, and
  // queueing it would double-persist it. The active run may not rebuild its
  // context again (e.g. on its final iteration), so the skipped seed id is
  // recorded against the live session and re-dispatched once, deduped by id,
  // when that run finishes.
  if (!activeRunTracker.startSession(built.deps.sessionId, input.threadId)) {
    // Record only when we have a persisted seed id to re-dispatch on. A skip
    // with no message id (rare) has nothing to reprocess, so stays no_dispatch.
    const recorded =
      input.messageId != null &&
      activeRunTracker.recordSkippedSeed(input.threadId, input.messageId);
    // startSession also refuses while a purge reservation (a fork, a Clear)
    // holds the thread, with no active session to re-dispatch on run end. A
    // fork keeps the source thread, so deferMessageDuringPurge records the
    // message for the fork owner to re-dispatch after releasing. A Clear/delete
    // wipes the thread, so it declines (returns false) and this reports
    // no_dispatch. Only tried when recordSkippedSeed recorded nothing.
    const deferredDuringPurge =
      !recorded &&
      input.messageId != null &&
      activeRunTracker.deferMessageDuringPurge(input.threadId, input.messageId);
    // Also hand the seed to every target agent that is running right now, so
    // it lands in their next tool-result turn instead of only after the run
    // ends (when a run finishing on its final reply has already talked past
    // it). The skipped-seed record above stays the backstop; it is struck only
    // once every target has actually had the message injected.
    const injectedInto =
      recorded && input.messageId != null && input.sender
        ? enqueueSeedForRunningTargets({
            threadId: input.threadId,
            messageId: input.messageId,
            message: input.message,
            senderId: input.senderId,
            sender: input.sender,
            agentNameMap: built.deps.agentNameMap,
            dispatchSet: built.deps.dispatchSet,
            mentionedAgentIds: built.deps.mentions.mentionedAgentIds,
            resolveParticipantId: built.deps.resolveParticipantId,
            // The sender's chain context, as stamped on the seed row: a run
            // that acts on the injected copy acts at its depth.
            chain: chainStampMetadata()?.chain ?? null,
          })
        : [];
    LogsService.socket.event('dispatch skipped — thread run already active', {
      threadId: input.threadId,
      source: input.source,
      senderId: input.senderId,
      messageId: input.messageId ?? null,
      // true → the seed is registered for a guaranteed post-run re-dispatch,
      // rather than relying on the active run's next (possibly absent) rebuild.
      queuedForPostRun: recorded,
      deferredDuringPurge,
      injectedInto,
    });
    return {
      ok: true,
      reason: recorded || deferredDuringPurge ? 'queued_for_post_run' : 'no_dispatch',
      wakeCount: 0,
      capHit: false,
    };
  }
  const deps = {
    ...built.deps,
    ...(input.wakeOrigin ? { wakeOrigin: input.wakeOrigin } : {}),
    ...(unattended ? { unattended } : {}),
  };
  // Bound for the whole wave, so a dispatch started from inside it (a helper,
  // a thread send, a result wake) knows it is downstream of an unattended run.
  return unattended
    ? runWithUnattended(unattended, () => dispatchToThreadInternal(deps))
    : dispatchToThreadInternal(deps);
}

/**
 * A person's message (the app or an external member), not an automation's
 * wake (posted as the local user too) nor narration. A wave covering one may
 * not auto-approve.
 */
function isPersonMessage(row: {
  role: string;
  messageType?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean {
  return (
    row.role === 'user' &&
    (row.messageType ?? 'message') === 'message' &&
    !(row.metadata && 'automation' in row.metadata)
  );
}

/** The wake marker an automation's seed message carries in `metadata.automation`. */
function automationWakeOrigin(metadata: Record<string, unknown> | null | undefined) {
  const automation = metadata?.automation;
  if (!automation || typeof automation !== 'object') return undefined;
  const { id, agentStarted } = automation as { id?: unknown; agentStarted?: unknown };
  return typeof id === 'string' && id
    ? ({
        kind: 'automation',
        automationId: id,
        ...(agentStarted === true ? { agentStarted: true as const } : {}),
      } satisfies WakeOrigin)
    : undefined;
}
