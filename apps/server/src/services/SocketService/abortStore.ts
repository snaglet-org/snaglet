/**
 * abortStore.ts — In-memory AbortController registry keyed by sessionId + threadId.
 *
 * Propagates `socket:chat:abort` signals to in-flight LLM streaming
 * requests. Each session has at most one active controller at a time.
 * A thread can have one or more sessions; abort by thread cancels them all.
 */

import type { Actor } from '@snaglet/shared/types';

const controllersBySession = new Map<string, AbortController>();
const threadBySession = new Map<string, string>();
const sessionsByThread = new Map<string, Set<string>>();

interface AgentAbortReason {
  kind: 'agent_run_abort';
  targetAgentId: string;
  abortedBy: Actor;
}

interface AgentControllerEntry {
  sessionId: string;
  controller: AbortController;
  detachParent: () => void;
}

/** Live turn controllers, scoped independently within a thread-wide dispatch. */
const agentControllersByThread = new Map<string, Map<string, AgentControllerEntry>>();

function deleteAgentController(threadId: string, agentId: string, owner?: AbortController): void {
  const threadControllers = agentControllersByThread.get(threadId);
  if (!threadControllers) return;
  const entry = threadControllers.get(agentId);
  if (!entry) return;
  // A previous run may finish after a replacement has already registered.
  // Only the controller that owns this cleanup may remove the live entry.
  if (owner && entry.controller !== owner) return;
  entry.detachParent();
  threadControllers.delete(agentId);
  if (threadControllers.size === 0) agentControllersByThread.delete(threadId);
}

function unlinkSession(sessionId: string): void {
  const threadId = threadBySession.get(sessionId);
  if (!threadId) return;
  threadBySession.delete(sessionId);

  const threadSessions = sessionsByThread.get(threadId);
  if (!threadSessions) return;
  threadSessions.delete(sessionId);
  if (threadSessions.size === 0) {
    sessionsByThread.delete(threadId);
  }
}

/** Create and register a new AbortController for a session. Aborts any existing one first. */
export function createAbortController(sessionId: string, threadId: string): AbortController {
  // If there's already an active controller, abort it before replacing.
  abortSession(sessionId);

  const controller = new AbortController();
  controllersBySession.set(sessionId, controller);
  threadBySession.set(sessionId, threadId);

  let threadSessions = sessionsByThread.get(threadId);
  if (!threadSessions) {
    threadSessions = new Set<string>();
    sessionsByThread.set(threadId, threadSessions);
  }
  threadSessions.add(sessionId);
  return controller;
}

/** Abort the active controller for a session (if any). Returns true if one was found. */
function abortSession(sessionId: string, reason?: unknown): boolean {
  const controller = controllersBySession.get(sessionId);
  if (!controller) return false;
  controller.abort(reason);
  controllersBySession.delete(sessionId);
  unlinkSession(sessionId);
  return true;
}

/**
 * Abort every active session for a thread.
 * Returns the number of sessions that were aborted.
 *
 * `reason` (optional) is attached as the AbortSignal.reason — attributed
 * callers (AbortRunService) pass a structured AgentAbortReason so the
 * dispatch loop can tell a watchdog/reaper release from a user Stop when it
 * records the conversation stop reason. Plain callers (voice barge-in) omit
 * it → attributed as a user abort.
 */
export function abortThread(threadId: string, reason?: unknown): number {
  const threadSessions = sessionsByThread.get(threadId);
  if (!threadSessions || threadSessions.size === 0) return 0;
  const sessionIds = Array.from(threadSessions);
  let abortedCount = 0;
  for (const sessionId of sessionIds) {
    if (abortSession(sessionId, reason)) {
      abortedCount++;
    }
  }
  return abortedCount;
}

/**
 * Register the controller for one live agent turn. The parent conversation
 * signal preserves the existing thread-wide Stop behavior while allowing a
 * targeted abort to cancel only this child controller.
 */
export function createAgentAbortController(
  sessionId: string,
  threadId: string,
  agentId: string,
  parentSignal: AbortSignal
): AbortController {
  const existing = agentControllersByThread.get(threadId)?.get(agentId);
  if (existing) {
    existing.controller.abort(parentSignal.reason);
    deleteAgentController(threadId, agentId);
  }

  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  let threadControllers = agentControllersByThread.get(threadId);
  if (!threadControllers) {
    threadControllers = new Map<string, AgentControllerEntry>();
    agentControllersByThread.set(threadId, threadControllers);
  }
  threadControllers.set(agentId, {
    sessionId,
    controller,
    detachParent: () => parentSignal.removeEventListener('abort', abortFromParent),
  });
  return controller;
}

/** Abort one agent's live turn without canceling its peers. */
export function abortAgentRun(
  threadId: string,
  agentId: string,
  abortedBy: Actor
): { aborted: boolean; sessionId?: string } {
  const entry = agentControllersByThread.get(threadId)?.get(agentId);
  if (!entry) return { aborted: false };
  const reason: AgentAbortReason = {
    kind: 'agent_run_abort',
    targetAgentId: agentId,
    abortedBy,
  };
  entry.controller.abort(reason);
  const sessionId = entry.sessionId;
  deleteAgentController(threadId, agentId);
  return { aborted: true, sessionId };
}

export function clearAgentAbortController(
  threadId: string,
  agentId: string,
  owner: AbortController
): void {
  deleteAgentController(threadId, agentId, owner);
}

/**
 * True when a DIFFERENT controller now owns this agent's live-turn slot — i.e.
 * a newer turn for the same agent has registered since `controller`'s turn
 * started. A turn abandoned by the dispatch (timed out and never unwound
 * within the drain bound) uses this at teardown so it cannot clear the newer
 * turn's running/pending state. An empty slot is not superseded: nobody newer
 * holds it, so the settling turn may still clean up after itself.
 */
export function isAgentTurnSuperseded(
  threadId: string,
  agentId: string,
  controller: AbortController
): boolean {
  const entry = agentControllersByThread.get(threadId)?.get(agentId);
  return entry !== undefined && entry.controller !== controller;
}

export function listActiveAgentRuns(
  threadId: string
): Array<{ agentId: string; sessionId: string }> {
  const entries = agentControllersByThread.get(threadId);
  if (!entries) return [];
  return Array.from(entries, ([agentId, entry]) => ({ agentId, sessionId: entry.sessionId }));
}

export function readAgentAbortReason(signal: AbortSignal): AgentAbortReason | null {
  const reason: unknown = signal.reason;
  if (!reason || typeof reason !== 'object') return null;
  const candidate = reason as Partial<AgentAbortReason>;
  return candidate.kind === 'agent_run_abort' &&
    typeof candidate.targetAgentId === 'string' &&
    candidate.abortedBy?.actorKind != null
    ? (candidate as AgentAbortReason)
    : null;
}

/**
 * Remove the controller for a session without aborting (called on normal
 * completion). Socket session ids are reused across runs, so when `owner` is
 * given only that exact controller is removed: a stale dispatch (e.g. one the
 * reaper force-released) finishing late must not unregister the controller of
 * a newer run on the same session, which would make that run un-stoppable.
 */
export function clearAbortController(sessionId: string, owner?: AbortController): void {
  if (owner && controllersBySession.get(sessionId) !== owner) return;
  controllersBySession.delete(sessionId);
  unlinkSession(sessionId);
}
