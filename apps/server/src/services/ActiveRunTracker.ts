/**
 * ActiveRunTracker — in-memory tracker for agent runs in progress. The SIGUSR2
 * (nodemon) handler uses it to defer restarts until runs complete, and it
 * holds one run lock per thread so multiple clients cannot start duplicate
 * runs. A message sent while a session is running is parked in a per-session
 * queue; the run's tool loop drains it between iterations (drainMessages) and
 * routes it into per-agent pending queues.
 */

import { emitThreadRunFinished, emitThreadRunStarted } from '@server/realtime/surfaces/threads';
import { activeWorkRegistry, type ThreadRunWorkInput } from './ActiveWorkRegistry';

interface QueuedMessage {
  id: string;
  content: string;
  /**
   * Optional persisted-injection payload (voice barge-in "heard up to" marker).
   * Carried alongside the clean content so the queue drain can persist it as
   * `metadata.persistedInjection` and fold it into the live mid-run injection —
   * the marker reaches the model without polluting the user's message content.
   */
  injection?: string;
  /**
   * Persist-first: true when chatHandlers already wrote this message's row to
   * the `messages` table before parking it here, so a wedged run that never
   * drains can delay delivery but never lose the words. Drain/flush sites must
   * skip `Messages.create` (and its embedding/broadcast) when this is set, or
   * they PK-collide on the already-persisted id.
   */
  persisted?: boolean;
}

interface HandoffReservation {
  expiresAt: number;
  reason: string;
}

/**
 * Why a thread is purge-reserved. A `fork` keeps the source thread, so a wake
 * that lands during it is deferred and re-dispatched after release; a `clear`
 * (or permanent delete) is about to wipe the thread, so such a wake is dropped.
 * It also decides the wording the composer shows for a send blocked by the
 * reservation ("Forking\u2026" vs "Clearing\u2026").
 */
export type ThreadPurgeReason = 'fork' | 'clear';

/**
 * What one agent's logical turn did, accumulated across its model attempts.
 *
 * A `runId` is one model attempt, so a turn that falls back to a second model
 * produces two runs. Keying this by (thread, agent) rather than by run makes
 * the run-ended narration one line per turn instead of one per attempt —
 * `startedAt` stays at the first attempt and `toolCalls` accumulates across all
 * of them.
 */
interface AgentTurnStats {
  agentName: string;
  startedAt: number;
  toolCalls: number;
}

interface AgentTurnSummary {
  agentName: string;
  durationMs: number;
  toolCalls: number;
}

/**
 * Short-lived reservation window covering the gap between an outgoing agent's
 * finishSession() and the incoming agent's startSession(). Long enough to cover
 * mention parse + new session creation; short enough that a crashed dispatcher
 * can't wedge compaction forever.
 */
const HANDOFF_RESERVATION_TTL_MS = 15_000;

export class ActiveRunTracker {
  private activeRuns = new Set<string>();
  private activeSessions = new Set<string>();
  /** Shutdown closes this gate before canceling runs, so a websocket or HTTP
   * dispatch already in flight cannot begin a replacement run during drain. */
  private acceptingSessions = true;
  private activeThreadBySession = new Map<string, string>();
  private activeSessionByThread = new Map<string, string>();
  /**
   * Short critical section held while a destructive thread operation purges
   * execution records and clears/deletes the thread. It is not an "active run"
   * signal (the UI must not glow), but startSession must refuse it so a new run
   * cannot enter between the idle check and the final node/message mutation.
   */
  private purgeReservedThreads = new Map<string, ThreadPurgeReason>();
  /**
   * Per-thread ids of messages persisted while a purge reservation held the
   * thread (e.g. a reminder that landed during a fork), saved but unanswered.
   * Only a fork defers them: the fork owner drains them with
   * takeDeferredPurgeMessages() after release and re-dispatches each once. A
   * clear/delete never defers (its rows are about to be wiped), and release
   * clears the set either way so it cannot leak.
   */
  private deferredPurgeMessages = new Map<string, Set<string>>();
  private sessionMessageQueues = new Map<string, QueuedMessage[]>();
  /**
   * Per-session record of tool-dispatch wakes that were skipped because this
   * session already held the thread's run lock. The seed message is already
   * persisted by the tool caller, so only its id is recorded here (the mid-run
   * queue would double-persist it). The dispatch finally re-dispatches the
   * thread once for these, so a wake that lands during the run's final
   * iteration (no further context rebuild) is not lost.
   */
  private skippedSeedsBySession = new Map<string, Set<string>>();
  /**
   * Per-session, per-skipped-seed set of agents the seed was also handed to
   * for in-run delivery (pendingAgentMessages → tool-result append). When
   * every one of them has actually had it injected, the seed is struck from
   * skippedSeedsBySession so the post-run re-dispatch does not wake them a
   * second time for a message they already saw. A seed with no entry here (or
   * with a target still waiting) keeps the post-run re-dispatch as backstop.
   */
  private seedInjectionTargetsBySession = new Map<string, Map<string, Set<string>>>();
  private handoffReservationsByThread = new Map<string, HandoffReservation>();
  private drainResolvers: Array<() => void> = [];
  /**
   * Reaper feed: last time each active session made observable
   * progress (session start, a completed model call, a completed tool call).
   * The zombie reaper force-ends sessions whose timestamp goes stale.
   */
  private lastProgressBySession = new Map<string, number>();
  /**
   * Per-logical-turn run stats, keyed `threadId:agentId`, plus the run→turn
   * index that lets a per-run signal (a tool call) find its turn. Consumed and
   * cleared by takeTurnSummary() at the guaranteed end-of-turn teardown.
   */
  private turnStatsByAgent = new Map<string, AgentTurnStats>();
  private turnKeyByRun = new Map<string, string>();
  /**
   * Run generation per active session. Socket session ids are reused across
   * sends, so a sessionId alone cannot tell "this run" from "a later run on the
   * same session". startSession mints a fresh token; owners that may outlive
   * their lock (a dispatch the reaper force-released, the reaper's own grace
   * timer) pass it to finishSession/takeSkippedSeeds so a late release can
   * never tear down a newer run's lock, queue, or skipped seeds.
   */
  private runTokenBySession = new Map<string, number>();
  private nextRunToken = 1;
  /** Told each time a thread's run lock is released (see onThreadReleased). */
  private threadReleasedListeners = new Set<(threadId: string) => void>();

  /**
   * Call `listener` each time a thread's session finishes and its run lock is
   * released: nothing runs on the thread any more. Subagent helpers use it to
   * notice a turn that ended without a run of its own (no run:end).
   * Listeners must not throw; one that does is skipped. Returns the
   * unsubscribe.
   */
  onThreadReleased(listener: (threadId: string) => void): () => void {
    this.threadReleasedListeners.add(listener);
    return () => {
      this.threadReleasedListeners.delete(listener);
    };
  }

  /**
   * Mark a run as in-flight. `work` (who is running, in which thread) feeds
   * the active-work registry so the status bar can show live agent activity;
   * registration rides this seam — the exact pairing the SIGUSR2 restart-defer
   * relies on — so an entry lives exactly as long as the run does: every end
   * path (completion, error, abort, and the dispatch teardown's leftover
   * flush) funnels through finish(), which removes it.
   */
  start(runId: string, work?: Omit<ThreadRunWorkInput, 'id'>): void {
    this.activeRuns.add(runId);
    if (work) {
      activeWorkRegistry.registerThreadRun({ id: runId, ...work });
      const key = this.turnKey(work.threadId, work.agentId);
      this.turnKeyByRun.set(runId, key);
      // Only the first attempt seeds the clock — a model fallback continues the
      // same logical turn, so its elapsed time must not restart.
      if (!this.turnStatsByAgent.has(key)) {
        this.turnStatsByAgent.set(key, {
          agentName: work.agentName,
          startedAt: Date.now(),
          toolCalls: 0,
        });
      }
    }
  }

  /** One completed tool call (success or failure) against a run's logical turn. */
  noteToolCall(runId: string | null | undefined): void {
    if (!runId) return;
    const key = this.turnKeyByRun.get(runId);
    if (!key) return;
    const stats = this.turnStatsByAgent.get(key);
    if (stats) stats.toolCalls += 1;
  }

  /**
   * Consume this agent's turn stats. Returns null when the turn never started a
   * run (e.g. context assembly threw before the first attempt), which is also
   * what makes a repeat call a no-op — so a double teardown cannot narrate the
   * same turn twice.
   */
  takeTurnSummary(threadId: string, agentId: string): AgentTurnSummary | null {
    const key = this.turnKey(threadId, agentId);
    const stats = this.turnStatsByAgent.get(key);
    if (!stats) return null;
    this.turnStatsByAgent.delete(key);
    for (const [runId, runKey] of this.turnKeyByRun) {
      if (runKey === key) this.turnKeyByRun.delete(runId);
    }
    return {
      agentName: stats.agentName,
      durationMs: Math.max(0, Date.now() - stats.startedAt),
      toolCalls: stats.toolCalls,
    };
  }

  finish(runId: string): void {
    this.activeRuns.delete(runId);
    activeWorkRegistry.unregister(runId);
    if (this.activeRuns.size === 0) {
      for (const resolve of this.drainResolvers) resolve();
      this.drainResolvers = [];
    }
  }

  /**
   * Mark a session as having an active run.
   * Returns false if either:
   *  - this exact session is already running, or
   *  - another session is already running on the same thread.
   */
  startSession(sessionId: string, threadId: string): boolean {
    if (!this.acceptingSessions) return false;
    if (this.activeSessions.has(sessionId)) return false;
    if (this.purgeReservedThreads.has(threadId)) return false; // a fork or clear holds it
    const existingSessionForThread = this.activeSessionByThread.get(threadId);
    if (existingSessionForThread && existingSessionForThread !== sessionId) return false;
    this.activeSessions.add(sessionId);
    this.activeThreadBySession.set(sessionId, threadId);
    this.activeSessionByThread.set(threadId, sessionId);
    this.sessionMessageQueues.set(sessionId, []);
    this.skippedSeedsBySession.set(sessionId, new Set());
    this.seedInjectionTargetsBySession.set(sessionId, new Map());
    this.lastProgressBySession.set(sessionId, Date.now());
    this.runTokenBySession.set(sessionId, this.nextRunToken++);
    emitThreadRunStarted(threadId);
    return true;
  }

  /** Stop new agent dispatches while the process drains existing sessions. */
  stopAcceptingSessions(): void {
    this.acceptingSessions = false;
  }

  /**
   * Record observable run progress for a session (a completed model call or
   * tool call). No-op for unknown/finished sessions. Feeds the zombie reaper.
   */
  noteProgress(sessionId: string): void {
    if (!this.activeSessions.has(sessionId)) return;
    this.lastProgressBySession.set(sessionId, Date.now());
  }

  /**
   * Record progress for whichever session currently holds a thread's run lock.
   * Used by the human-interactive waits (get_clarification / tool confirmation),
   * which key on threadId, not sessionId: a run parked for a human answer is
   * making progress in the sense the reaper cares about, so an intentional wait
   * never counts against the zombie-stall clock. No-op if the thread is idle.
   */
  noteProgressForThread(threadId: string): void {
    const sessionId = this.activeSessionByThread.get(threadId);
    if (sessionId) this.noteProgress(sessionId);
  }

  /**
   * Sessions with zero observable progress for at least `stallMs`. The reaper
   * treats these as wedged runs (blocked in a never-returning await) and
   * force-ends them.
   */
  listStalledSessions(stallMs: number): Array<{
    sessionId: string;
    threadId: string;
    stalledMs: number;
    runToken: number | undefined;
  }> {
    const now = Date.now();
    const stalled: Array<{
      sessionId: string;
      threadId: string;
      stalledMs: number;
      runToken: number | undefined;
    }> = [];
    for (const [sessionId, lastProgressAt] of this.lastProgressBySession) {
      const stalledFor = now - lastProgressAt;
      if (stalledFor < stallMs) continue;
      const threadId = this.activeThreadBySession.get(sessionId);
      if (!threadId) continue;
      stalled.push({
        sessionId,
        threadId,
        stalledMs: stalledFor,
        runToken: this.runTokenBySession.get(sessionId),
      });
    }
    return stalled;
  }

  /**
   * Thread ids with a live run right now: a session holds the run lock and has
   * made progress within `stallMs` (the reaper's own signal; pass
   * REAPER_STALL_DEFAULT_MS to match it). A wedged run is not live, and a
   * crashed server leaves this map empty, so a stale `runs.status='running'`
   * row is never surfaced as active. `filterThreadIds` scopes the check.
   */
  liveThreadIds(stallMs: number, filterThreadIds?: Iterable<string>): string[] {
    const stalledThreads = new Set(this.listStalledSessions(stallMs).map((s) => s.threadId));
    const filter = filterThreadIds ? new Set(filterThreadIds) : null;
    const live: string[] = [];
    for (const threadId of this.activeSessionByThread.keys()) {
      if (stalledThreads.has(threadId)) continue;
      if (filter && !filter.has(threadId)) continue;
      live.push(threadId);
    }
    return live;
  }

  /**
   * Snapshot (a copy, so callers can't mutate internal state) of the run ids
   * with an in-flight run right now — the same set the SIGUSR2 restart-defer and
   * shutdown drain wait on, populated by turnLoop's start(runId)/finish(runId).
   * Gates the active-thread name markers to the actually-live run/agent:
   * a live thread can carry stale sibling `runs.status='running'` DB rows from
   * crashed/reaped priors, and only the run id in this set is truly executing.
   */
  liveRunIds(): Set<string> {
    return new Set(this.activeRuns);
  }

  /**
   * Record a tool-dispatch wake that was skipped because `threadId` already had
   * an active run. `messageId` is the already-persisted seed message. Returns
   * true if it was recorded against the live session, false if no session is
   * active for the thread (caller should treat that as "start a fresh run").
   * Repeat calls with the same id collapse to one recorded seed (Set dedupe).
   */
  recordSkippedSeed(threadId: string, messageId: string): boolean {
    const sessionId = this.activeSessionByThread.get(threadId);
    if (!sessionId) return false;
    const seeds = this.skippedSeedsBySession.get(sessionId);
    if (!seeds) return false;
    seeds.add(messageId);
    return true;
  }

  /**
   * Mark a recorded skipped seed as also queued for in-run delivery to exactly
   * `agentIds`. Only call when every agent the seed should wake is one of them
   * (all running now); otherwise leave the seed to the post-run re-dispatch.
   * Returns false when no live session holds `threadId` or the seed is not
   * recorded (the caller then must not count on in-run delivery).
   */
  expectSeedInjection(threadId: string, messageId: string, agentIds: string[]): boolean {
    if (agentIds.length === 0) return false;
    const sessionId = this.activeSessionByThread.get(threadId);
    if (!sessionId) return false;
    if (!this.skippedSeedsBySession.get(sessionId)?.has(messageId)) return false;
    const targets = this.seedInjectionTargetsBySession.get(sessionId);
    if (!targets) return false;
    const set = targets.get(messageId) ?? new Set<string>();
    for (const id of agentIds) set.add(id);
    targets.set(messageId, set);
    return true;
  }

  /**
   * The seed `messageId` was injected into `agentId`'s live run. Once every
   * expected target has it, drop the seed from the post-run re-dispatch set:
   * the run saw it, so a re-wake would only make the agent answer it twice.
   * No-op for messages that were never recorded as skipped seeds.
   */
  markSeedInjected(threadId: string, messageId: string, agentId: string): void {
    const sessionId = this.activeSessionByThread.get(threadId);
    if (!sessionId) return;
    const targets = this.seedInjectionTargetsBySession.get(sessionId);
    const waiting = targets?.get(messageId);
    if (!targets || !waiting) return;
    waiting.delete(agentId);
    if (waiting.size > 0) return;
    targets.delete(messageId);
    this.skippedSeedsBySession.get(sessionId)?.delete(messageId);
  }

  /**
   * End a session and release its thread lock. Returns any messages still
   * parked in the session's mid-run queue, drained and deleted in one
   * synchronous step so a send that raced in during the caller's awaits is
   * handed back to persist rather than dropped. With `runToken`, release only
   * if the session is still the run that minted it (see runTokenBySession); a
   * stale owner gets a no-op and an empty return.
   */
  finishSession(sessionId: string, runToken?: number): QueuedMessage[] {
    if (runToken !== undefined && !this.isSessionRun(sessionId, runToken)) return [];
    const threadId = this.activeThreadBySession.get(sessionId);
    this.activeSessions.delete(sessionId);
    // Remove the thread→session mapping first so getActiveSessionForThread()
    // stops routing new sends into this queue; then capture + delete the queue.
    // All synchronous — nothing can interleave.
    this.activeThreadBySession.delete(sessionId);
    if (threadId) {
      const sessionForThread = this.activeSessionByThread.get(threadId);
      if (sessionForThread === sessionId) {
        this.activeSessionByThread.delete(threadId);
        emitThreadRunFinished(threadId);
        // Safety net for the active-work registry: every run of this dispatch
        // was already finish()ed (the teardown flush runs before
        // finishSession), so this only sweeps entries orphaned by an abnormal
        // unwind, e.g. a reaped zombie run whose teardown never executed.
        activeWorkRegistry.unregisterThreadRuns(threadId);
        this.clearTurnStatsForThread(threadId);
        for (const listener of this.threadReleasedListeners) {
          try {
            listener(threadId);
          } catch {
            // A listener's failure must never break the release itself.
          }
        }
      }
    }
    const straggling = this.sessionMessageQueues.get(sessionId) ?? [];
    this.sessionMessageQueues.delete(sessionId);
    // Skipped seeds are consumed via takeSkippedSeeds() before finishSession()
    // in the dispatch finally, but clear here too as a safety net so an early
    // exit that skips the take step can't leak the set.
    this.skippedSeedsBySession.delete(sessionId);
    this.seedInjectionTargetsBySession.delete(sessionId);
    this.lastProgressBySession.delete(sessionId);
    this.runTokenBySession.delete(sessionId);
    return straggling;
  }

  /**
   * Drain and return the ids of tool-dispatch seeds that were skipped while
   * this session held the run lock (see recordSkippedSeed). Clears the record —
   * each id is returned exactly once — so the dispatch finally re-dispatches the
   * thread a single time for wakes that arrived with no further context rebuild
   * coming. Call this before finishSession() (which also clears the record).
   */
  takeSkippedSeeds(sessionId: string, runToken?: number): string[] {
    if (runToken !== undefined && !this.isSessionRun(sessionId, runToken)) return [];
    const seeds = this.skippedSeedsBySession.get(sessionId);
    if (!seeds || seeds.size === 0) return [];
    const ids = Array.from(seeds);
    seeds.clear();
    return ids;
  }

  hasActiveSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /** The current run generation of an active session (undefined when idle). */
  sessionRunToken(sessionId: string): number | undefined {
    return this.runTokenBySession.get(sessionId);
  }

  /** True while `sessionId` is active and still the run that minted `runToken`. */
  isSessionRun(sessionId: string, runToken: number): boolean {
    return this.runTokenBySession.get(sessionId) === runToken;
  }

  hasActiveThread(threadId: string): boolean {
    return this.activeSessionByThread.has(threadId) || this.hasLiveHandoff(threadId);
  }

  /**
   * Atomically reserve an idle thread for a destructive thread operation.
   * Returns false when a run/handoff is active or another purge owns it. No
   * caller may delete anything until this succeeds. `reason` records whether a
   * fork or a clear/delete holds it (default 'clear'): the fork re-dispatches
   * wakes that land during it, a clear drops them, and the composer's blocked
   * send is worded from this.
   */
  reserveThreadPurge(threadId: string, reason: ThreadPurgeReason = 'clear'): boolean {
    if (this.purgeReservedThreads.has(threadId) || this.hasActiveThread(threadId)) return false;
    this.purgeReservedThreads.set(threadId, reason);
    return true;
  }

  releaseThreadPurge(threadId: string): void {
    this.purgeReservedThreads.delete(threadId);
    // Drop any deferred-send record as a safety net. A fork owner takes these
    // via takeDeferredPurgeMessages() before releasing; a Clear/delete owner
    // never takes them (its rows are gone), so clearing here keeps the map from
    // growing. Harmless no-op when the fork already drained it.
    this.deferredPurgeMessages.delete(threadId);
  }

  isThreadPurgeReserved(threadId: string): boolean {
    return this.purgeReservedThreads.has(threadId);
  }

  /** Why the thread is purge-reserved ('fork' | 'clear'), or undefined when it isn't. */
  threadPurgeReason(threadId: string): ThreadPurgeReason | undefined {
    return this.purgeReservedThreads.get(threadId);
  }

  /**
   * Record a persisted message that arrived while a purge reservation held the
   * thread, so the reservation owner can re-dispatch it after releasing.
   * No-op (returns false) when the thread is not purge-reserved — the caller
   * then handles the message on its normal path. Deduped per id.
   */
  deferMessageDuringPurge(threadId: string, messageId: string): boolean {
    // Only a fork re-dispatches these after release; a clear/delete wipes the
    // thread, so a wake landing mid-clear is dropped (caller reports it so).
    if (this.purgeReservedThreads.get(threadId) !== 'fork') return false;
    const set = this.deferredPurgeMessages.get(threadId) ?? new Set<string>();
    set.add(messageId);
    this.deferredPurgeMessages.set(threadId, set);
    return true;
  }

  /**
   * Drain and return the ids of messages deferred while this thread was
   * purge-reserved (see deferMessageDuringPurge). Clears the record — each id
   * is returned exactly once — so the fork owner re-dispatches the thread once
   * per deferred message. Call this before releaseThreadPurge (which also
   * clears the record as a safety net).
   */
  takeDeferredPurgeMessages(threadId: string): string[] {
    const set = this.deferredPurgeMessages.get(threadId);
    if (!set || set.size === 0) return [];
    const ids = Array.from(set);
    this.deferredPurgeMessages.delete(threadId);
    return ids;
  }

  /**
   * Reserve a handoff slot for a thread so the compact watcher treats the
   * thread as still active during the mention-dispatch gap. Races with
   * finishSession() would otherwise let compaction start between the outgoing
   * and incoming agent's sessions, breaking mention chains.
   */
  reserveHandoff(threadId: string, reason = 'mention-handoff'): void {
    this.handoffReservationsByThread.set(threadId, {
      expiresAt: Date.now() + HANDOFF_RESERVATION_TTL_MS,
      reason,
    });
  }

  clearHandoff(threadId: string): void {
    this.handoffReservationsByThread.delete(threadId);
  }

  private turnKey(threadId: string, agentId: string): string {
    return `${threadId}:${agentId}`;
  }

  /**
   * Drop any turn stats still held for a thread. Safety net only: the per-turn
   * teardown consumes them via takeTurnSummary(), so this fires just for turns
   * unwound abnormally (a reaped zombie whose teardown never ran) and keeps the
   * maps from growing across a long-lived process.
   */
  private clearTurnStatsForThread(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.turnStatsByAgent.keys()) {
      if (key.startsWith(prefix)) this.turnStatsByAgent.delete(key);
    }
    for (const [runId, key] of this.turnKeyByRun) {
      if (key.startsWith(prefix)) this.turnKeyByRun.delete(runId);
    }
  }

  private hasLiveHandoff(threadId: string): boolean {
    const r = this.handoffReservationsByThread.get(threadId);
    if (!r) return false;
    if (Date.now() > r.expiresAt) {
      this.handoffReservationsByThread.delete(threadId);
      return false;
    }
    return true;
  }

  getActiveSessionForThread(threadId: string): string | undefined {
    return this.activeSessionByThread.get(threadId);
  }

  /**
   * Enqueue a user message to be injected into the active run's context.
   * Returns true if the message was queued, false if no active session exists.
   */
  private enqueueMessage(
    sessionId: string,
    id: string,
    content: string,
    injection?: string,
    persisted?: boolean
  ): boolean {
    const queue = this.sessionMessageQueues.get(sessionId);
    if (!queue) return false;
    queue.push({
      id,
      content,
      ...(injection ? { injection } : {}),
      ...(persisted ? { persisted: true } : {}),
    });
    return true;
  }

  /**
   * Enqueue a user message by thread (useful when another client session
   * sends while the thread is already running under a different session).
   * `persisted` marks that chatHandlers already wrote the row —
   * the drain/flush sites then skip re-creating it.
   */
  enqueueMessageForThread(
    threadId: string,
    id: string,
    content: string,
    injection?: string,
    persisted?: boolean
  ): boolean {
    const sessionId = this.activeSessionByThread.get(threadId);
    if (!sessionId) return false;
    return this.enqueueMessage(sessionId, id, content, injection, persisted);
  }

  /**
   * Drain and return all pending messages for a session.
   * Clears the queue — each message is returned exactly once.
   */
  drainMessages(sessionId: string): QueuedMessage[] {
    const queue = this.sessionMessageQueues.get(sessionId);
    if (!queue || queue.length === 0) return [];
    const drained = queue.splice(0);
    return drained;
  }

  get count(): number {
    return this.activeRuns.size;
  }

  get isIdle(): boolean {
    return this.activeRuns.size === 0;
  }

  snapshot(): {
    activeRunCount: number;
    activeSessionCount: number;
    activeThreadCount: number;
    activeSessionsByThread: Array<{ threadId: string; sessionId: string }>;
  } {
    return {
      activeRunCount: this.activeRuns.size,
      activeSessionCount: this.activeSessions.size,
      activeThreadCount: this.activeSessionByThread.size,
      activeSessionsByThread: Array.from(this.activeSessionByThread.entries()).map(
        ([threadId, sessionId]) => ({ threadId, sessionId })
      ),
    };
  }

  /**
   * Resolve once no session holds the run-lock for `threadId` (or on timeout).
   * Used by voice barge-in mid-speech: after aborting the interrupted run, the
   * redispatch must wait for that run's finishSession() to release the thread
   * lock, or the new send would enqueue as a mid-run injection against the run
   * we just aborted instead of starting a fresh run.
   */
  waitForThreadRelease(threadId: string, timeoutMs: number): Promise<'released' | 'timeout'> {
    if (!this.activeSessionByThread.has(threadId)) return Promise.resolve('released');
    return new Promise((resolve) => {
      const start = Date.now();
      const check = (): void => {
        if (!this.activeSessionByThread.has(threadId)) return resolve('released');
        if (Date.now() - start >= timeoutMs) return resolve('timeout');
        setTimeout(check, 15);
      };
      check();
    });
  }

  waitForDrain(timeoutMs: number): Promise<'drained' | 'timeout'> {
    if (this.isIdle) return Promise.resolve('drained');

    return Promise.race([
      new Promise<'drained'>((resolve) => {
        this.drainResolvers.push(() => resolve('drained'));
      }),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  }
}

export const activeRunTracker = new ActiveRunTracker();
