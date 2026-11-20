/**
 * agentTurnTeardown — outer-wrapper exit paths for the per-agent turn.
 *
 * Two verbatim extractions from `runAgentTurnLoop`'s outer `try/catch/finally`
 * (in `turnLoop.ts`):
 *
 *  - `broadcastTurnSafetyNetError`: the safety-net `catch` that surfaces
 *    run-terminating failures escaping the per-attempt catch (context assembly /
 *    prepare throwing before a run row exists, or a throw from inside the attempt
 *    catch itself). Broadcasts one structured error and lets the caller re-throw.
 *  - `releaseTurnResources`: the `finally` teardown that runs on any exit
 *    (completion, break, abort, cap, crash) — releases the speaking floor
 *    belt-and-suspenders and clears this agent's per-wave running/queue state.
 *
 * Neither touches the turn-loop body (attempt loop, streaming, tool execution,
 * abort/fallback interplay). They run strictly on turn entry/exit and thread
 * only explicit args, so this module has no static dependency on `turnLoop.ts`
 * and the import graph stays acyclic. Module singletons (wsService,
 * pendingAgentMessages, floorArbiter) are imported directly — identical to
 * turnLoop — so any test that mocks those specifiers observes the same behavior.
 */
import { getErrorMessage } from '@snaglet/shared/utils';
import { wsService } from '@server/services/WebSocketService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { releaseGenerationFloor } from '@server/services/SocketService/voiceSession/floorArbiter';
import { logger } from '@server/config/logger';
import { visionThreadService } from '@server/services/vision/VisionThreadService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { emitAgentRunEndedEvent } from '@server/services/SocketService/threadEvents';

/**
 * Safety net for run-terminating failures that escape the per-attempt catch —
 * e.g. context assembly / prepare throwing before a run row exists, or a throw
 * from inside the attempt catch itself. These would otherwise propagate to the
 * dispatch layer silently (handleAgentDispatchError re-throws non-timeouts
 * without touching the thread), leaving the UI stuck in "Thinking…" until
 * refresh. Broadcast a structured error so every client clears state and sees
 * why the run died; the caller re-throws to preserve the existing dispatch
 * propagation. Timeouts reject the pausable wrapper (dispatch level), not this
 * body, so they never land here — no double-emit with handleAgentDispatchError's
 * own timeout broadcast. The per-attempt terminal path and the abort path both
 * `break` (never throw), so their frames don't reach this catch either. Aborts
 * are not errors: if one somehow escapes, unwind quietly.
 */
export function broadcastTurnSafetyNetError(
  turnErr: unknown,
  ctx: { readonly threadId: string; readonly sessionId: string; readonly replyAgentId: string }
): void {
  const isAbort =
    (turnErr instanceof DOMException && turnErr.name === 'AbortError') ||
    (turnErr instanceof Error && turnErr.name === 'AbortError');
  if (!isAbort) {
    wsService.broadcastToChannel(ctx.threadId, {
      type: 'socket:error',
      payload: {
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        agentId: ctx.replyAgentId,
        message: getErrorMessage(turnErr),
      },
    });
  }
}

/**
 * End-of-turn teardown, run in the outer `finally` on any exit (error, abort,
 * cap). Belt-and-suspenders: release the speaking floor so a crashed turn can
 * never wedge a parked peer. No-op if we don't hold it (already released after
 * tools / after-playback, or never acquired). Guarded by `usedFloor` so text
 * threads make zero floor calls. Then drop this agent's per-wave running/queue
 * state and clear any pending inbound messages parked for it on the thread.
 */
export async function releaseTurnResources(params: {
  readonly usedFloor: boolean;
  readonly threadId: string;
  readonly replyAgentId: string;
  readonly triggerMessageId?: string;
  readonly runningAgents: Set<string>;
  readonly agentMentionQueues: Map<string, string[]>;
  /**
   * Ownership check: true when a newer turn for this agent has taken over the
   * agent's live-turn slot (this turn timed out, was abandoned by the
   * dispatch, and only settled later). Every step below is keyed by
   * (thread, agent) rather than by turn, so a superseded turn must touch none
   * of it — the newer turn's own teardown owns that state.
   */
  readonly isSuperseded?: () => boolean;
}): Promise<void> {
  const { usedFloor, threadId, replyAgentId, triggerMessageId, runningAgents, agentMentionQueues } =
    params;
  // The frames pinned for this turn are keyed by its trigger message, so they
  // are released even when the turn has been superseded.
  if (triggerMessageId) {
    await visionThreadService
      .releaseTurnFrames(threadId, replyAgentId, triggerMessageId)
      .catch((error: unknown) => {
        logger.warn(
          `[vision] turn cleanup failed thread=${threadId} agent=${replyAgentId}: ${getErrorMessage(error)}`
        );
      });
  }
  // Checked after the await: a newer turn can take the agent's slot while the
  // frame release is in flight, and everything below is (thread, agent)-keyed.
  if (params.isSuperseded?.()) {
    logger.warn(
      `[turn] stale turn teardown skipped — a newer turn owns thread=${threadId} agent=${replyAgentId}`
    );
    return;
  }
  // Acknowledge the vision access this agent was shown, exactly once per
  // logical turn. This is the only guaranteed-on-every-exit-path hook, which
  // is what makes it the right place: consuming inside context assembly would
  // mark a transition seen once per model attempt, so a fallback would burn a
  // notice the agent never actually received.
  visionThreadService.markAccessSeen(threadId, replyAgentId);
  // Narrate what this turn did (duration + tool calls) for the peers still
  // running. Same once-per-logical-turn guarantee as markAccessSeen above, and
  // takeTurnSummary consumes the stats, so a fallback across two runs — or a
  // double teardown — cannot produce a second line. Returns null when the turn
  // never opened a run, which is exactly when there is nothing to report.
  //
  // Deliberately fire-and-forget: teardown must not wait on (or fail from) a
  // narration write. By here this agent's own run is already unregistered from
  // the active-work registry, so it is not a target of its own mid-run
  // injection — only genuinely-still-running peers are.
  const turnSummary = activeRunTracker.takeTurnSummary(threadId, replyAgentId);
  if (turnSummary) {
    void emitAgentRunEndedEvent(threadId, turnSummary).catch((error: unknown) => {
      logger.warn(
        `[thread-events] run-ended narration failed thread=${threadId} agent=${replyAgentId}: ${getErrorMessage(error)}`
      );
    });
  }
  if (usedFloor) releaseGenerationFloor(threadId, replyAgentId);
  runningAgents.delete(replyAgentId);
  agentMentionQueues.delete(replyAgentId);
  pendingAgentMessages.clearAgent(threadId, replyAgentId);
}
