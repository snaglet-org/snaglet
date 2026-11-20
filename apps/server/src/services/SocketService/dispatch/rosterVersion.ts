/**
 * rosterVersion: a counter per thread that goes up whenever an agent joins or
 * leaves it (the thread tool's add_agents / remove_agents / leave, and the
 * app's Add and Remove). A running dispatch compares it with the version it
 * last read (liveRoster.ts) and re-reads the roster only when it moved, so a
 * run with no roster change never queries again.
 *
 * In memory on purpose: a run never outlives the process, and a fresh dispatch
 * reads the roster from the database anyway. No imports, so the domain and
 * tool code that bump it pull in nothing from the dispatch layer.
 */

const versions = new Map<string, number>();

/** An agent joined or left `threadId`: running dispatches re-read its roster. */
export function markThreadRosterChanged(threadId: string): void {
  versions.set(threadId, (versions.get(threadId) ?? 0) + 1);
}

/** Several threads at once (an agent archived or retired from all its threads). */
export function markThreadsRosterChanged(threadIds: Iterable<string>): void {
  for (const threadId of new Set(threadIds)) markThreadRosterChanged(threadId);
}

/** The thread's current roster version (0 until its roster first changes). */
export function threadRosterVersion(threadId: string): number {
  return versions.get(threadId) ?? 0;
}
