/**
 * MemoryStatusRegistry — no silent memory state, ever.
 *
 * An in-process registry of the LAST memory-generation outcome per
 * thread+agent. There is deliberately no DB column for this (no suitable
 * column exists) — the registry is rebuilt
 * naturally as generation attempts happen, and the API surfaces it so the
 * UI can show `memory: active via <model>` / `inactive: <reason>` instead
 * of the historical silent nulls.
 *
 * Logging discipline: an INACTIVE state logs once per thread per boot (not
 * per turn); transitions back to active clear the latch.
 */

import { logger } from '@server/config/logger';

export interface MemoryStatus {
  state: 'active' | 'inactive';
  /** Set when state === 'active' (and for provenance on the last success). */
  providerId?: string;
  modelId?: string;
  source?: string;
  /** Set when state === 'inactive'. */
  reason?: string;
  detail?: string;
  updatedAt: string;
}

const threadStatuses = new Map<string, MemoryStatus>();
const inactiveLogged = new Set<string>();

function key(threadId: string, agentId?: string | null): string {
  return `${threadId}:${agentId ?? 'shared'}`;
}

export function setThreadMemoryStatus(
  threadId: string,
  agentId: string | null | undefined,
  status: Omit<MemoryStatus, 'updatedAt'>
): void {
  const k = key(threadId, agentId);
  threadStatuses.set(k, { ...status, updatedAt: new Date().toISOString() });
  if (status.state === 'inactive') {
    if (!inactiveLogged.has(k)) {
      inactiveLogged.add(k);
      logger.info(
        `[summary] memory inactive for thread ${threadId}` +
          (agentId ? ` (agent ${agentId})` : '') +
          `: ${status.reason ?? 'unknown'}${status.detail ? ` — ${status.detail}` : ''}`
      );
    }
  } else {
    inactiveLogged.delete(k);
  }
}

/**
 * Read the recorded status for a thread+agent; falls back to the shared
 * (agent-less) slot, then null (no attempt recorded since boot).
 */
export function getThreadMemoryStatus(
  threadId: string,
  agentId?: string | null
): MemoryStatus | null {
  return (
    threadStatuses.get(key(threadId, agentId)) ??
    (agentId ? (threadStatuses.get(key(threadId, null)) ?? null) : null)
  );
}

/** All recorded agent statuses for a thread (UI thread-settings surface). */
export function listThreadMemoryStatuses(
  threadId: string
): Array<{ agentId: string | null; status: MemoryStatus }> {
  const out: Array<{ agentId: string | null; status: MemoryStatus }> = [];
  const prefix = `${threadId}:`;
  for (const [k, status] of threadStatuses) {
    if (!k.startsWith(prefix)) continue;
    const agentPart = k.slice(prefix.length);
    out.push({ agentId: agentPart === 'shared' ? null : agentPart, status });
  }
  return out;
}

/** Test-only. */
export function resetMemoryStatusRegistryForTests(): void {
  threadStatuses.clear();
  inactiveLogged.clear();
}
