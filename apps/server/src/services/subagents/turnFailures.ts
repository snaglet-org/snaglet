/**
 * Why a subagent helper's turn ended without a run of its own to report on.
 *
 * Most helper failures end a run, and the run's end (`run:end`, its error on
 * the `runs` row) tells SubagentService what happened. A few never get that
 * far: the helper's agent row is gone or archived, it has no model, the turn
 * threw while its context was being built, or Snaglet could not start the turn at
 * all. The turn loop and the dispatch callback note the reason here, in
 * memory, keyed by the helper's thread (it holds only the helper);
 * SubagentService takes it when it writes the helper's next result.
 *
 * Pure and dependency-free so the hot turn loop can call it without pulling
 * in the service (helpers carry the `subagent-` agent id prefix, so every
 * other agent returns at once).
 */

const noted = new Map<string, string>();

/** Note why helper `agentId`'s turn in `threadId` could not run (ignored for other agents). */
export function noteHelperTurnFailure(threadId: string, agentId: string, reason: string): void {
  if (!agentId.startsWith('subagent-')) return;
  const text = reason.trim();
  if (text) noted.set(threadId, text);
}

/** The reason noted for this helper thread, if any; reading it clears it. */
export function takeHelperTurnFailure(threadId: string): string | null {
  const reason = noted.get(threadId) ?? null;
  noted.delete(threadId);
  return reason;
}

/** Forget a noted reason (a new task starts the helper afresh). */
export function clearHelperTurnFailure(threadId: string): void {
  noted.delete(threadId);
}

export function resetHelperTurnFailuresForTests(): void {
  noted.clear();
}
