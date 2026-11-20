/**
 * Which subagent results an orchestrator's run actually saw.
 *
 * A helper's result is a persisted, agent-private thread_event row in the
 * parent thread. A run sees it one of two ways:
 *   1. replay — the run's context was assembled after the row was written;
 *   2. mid-run — the row was queued for the running agent and injected at a
 *      tool seam (peerInjection drains it).
 * Both are recorded here, in memory, and read once when that run ends: the
 * subagent service then marks the result delivered to that run and cleans up
 * the helpers the orchestrator is done with. Nothing here touches the DB, so
 * the hot paths that call it (context assembly, tool seams) stay cheap and
 * free of import cycles.
 */

interface SeenState {
  /** Epoch ms when the latest context assembly for this agent began. */
  contextAssemblyStartedAt: number | null;
  /** Persisted message ids injected mid-run. */
  injected: Set<string>;
}

const seenByThreadAgent = new Map<string, SeenState>();

function key(threadId: string, agentId: string): string {
  return `${threadId}:${agentId}`;
}

function stateFor(threadId: string, agentId: string): SeenState {
  const k = key(threadId, agentId);
  let state = seenByThreadAgent.get(k);
  if (!state) {
    state = { contextAssemblyStartedAt: null, injected: new Set() };
    seenByThreadAgent.set(k, state);
  }
  return state;
}

/** Context assembly for `agentId` in `threadId` is starting (before replay loads). */
export function noteContextAssemblyStarted(
  threadId: string,
  agentId: string,
  at = Date.now()
): void {
  stateFor(threadId, agentId).contextAssemblyStartedAt = at;
}

/**
 * A persisted message is in `agentId`'s context for its current (or next)
 * run: injected mid-run, or the seed of a wake that run was started for.
 */
export function noteMessageInjected(threadId: string, agentId: string, messageId: string): void {
  stateFor(threadId, agentId).injected.add(messageId);
}

/** Undo {@link noteMessageInjected} for a wake that did not start a run. */
export function forgetMessageInjected(threadId: string, agentId: string, messageId: string): void {
  seenByThreadAgent.get(key(threadId, agentId))?.injected.delete(messageId);
}

/**
 * What the run that just ended saw. The injected ids are consumed; the
 * assembly time stays, because a model-fallback run in the same turn reuses
 * that turn's context (every new turn records a fresh time).
 */
export function takeSeen(
  threadId: string,
  agentId: string
): { contextAssemblyStartedAt: number | null; injected: ReadonlySet<string> } {
  const state = seenByThreadAgent.get(key(threadId, agentId));
  if (!state) return { contextAssemblyStartedAt: null, injected: new Set() };
  const injected = state.injected;
  state.injected = new Set();
  return { contextAssemblyStartedAt: state.contextAssemblyStartedAt, injected };
}

/**
 * Rows written this close to the start of context assembly may not have been
 * committed when replay read the thread, so they only count as seen when
 * written at least this long before it.
 */
export const REPLAY_VISIBILITY_MARGIN_MS = 250;

/** Whether a run saw a result row written at `rowCreatedAt`. */
export function sawResult(
  seen: { contextAssemblyStartedAt: number | null; injected: ReadonlySet<string> },
  row: { id: string; createdAt: string }
): boolean {
  if (seen.injected.has(row.id)) return true;
  if (seen.contextAssemblyStartedAt === null) return false;
  const writtenAt = Date.parse(row.createdAt);
  return (
    Number.isFinite(writtenAt) &&
    writtenAt < seen.contextAssemblyStartedAt - REPLAY_VISIBILITY_MARGIN_MS
  );
}

export function resetResultVisibilityForTests(): void {
  seenByThreadAgent.clear();
}
