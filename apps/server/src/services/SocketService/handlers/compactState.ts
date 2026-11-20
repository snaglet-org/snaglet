import { isoStamp } from '@snaglet/shared/utils';
/**
 * In-flight compaction tracking shared between the socket-driven and
 * REST-driven compact paths.
 *
 * - `compactingAgents` keys are `${threadId}::${agentId}` so a single agent on
 *   a thread can't be double-compacted (the button rejects re-clicks until
 *   complete), but different agents on the same thread can compact in
 *   parallel if a caller wants. Stores the start timestamp so the UI can
 *   show "compacting for Xs".
 *
 * Lives in its own module so `threads.routes.ts` doesn't have to import from
 * the socket-handlers tree (cleaner dependency direction).
 */

function key(threadId: string, agentId: string): string {
  return `${threadId}::${agentId}`;
}

const compactingAgents = new Map<string, { since: number }>();

export function markAgentCompacting(threadId: string, agentId: string): void {
  compactingAgents.set(key(threadId, agentId), { since: Date.now() });
}

export function clearAgentCompacting(threadId: string, agentId: string): void {
  compactingAgents.delete(key(threadId, agentId));
}

export function isAgentCompacting(threadId: string, agentId: string): boolean {
  return compactingAgents.has(key(threadId, agentId));
}

export function getAgentCompactingSince(threadId: string, agentId: string): string | null {
  const entry = compactingAgents.get(key(threadId, agentId));
  return entry ? isoStamp(entry.since) : null;
}
