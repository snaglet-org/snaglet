// Shared cache of the agent roster for `@` mentions, read by the mention
// popover and typed-mention autocomplete. Hot paths call `ensureAgents()`
// (free once warm); the popover calls `refreshAgents()` to pick up new agents.
// Loads retry a few times, keep the last good roster on failure, and back off
// for a cooldown before hot paths retry. `agent.updated` events call
// `invalidateAgentRoster()`; `subscribeAgentRoster` listeners hear any change
// to which agents exist or their names.

import { agentsApi } from '@desktop/utils/api';
import { agentLookupHandle } from '@desktop/utils/agentMentionMarkdown';
import type { SnagletAgent } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';

/** Tries per load before it gives up. */
export const AGENT_LOAD_ATTEMPTS = 3;
/** The wait before each retry within one load. */
export const AGENT_LOAD_RETRY_DELAYS_MS = [500, 1500] as const;
/** How long the hot paths leave a failed load alone before trying again. */
export const AGENT_LOAD_COOLDOWN_MS = 30_000;
/** How long an agent event waits for the rest of its burst before the refetch. */
export const AGENT_INVALIDATE_DELAY_MS = 150;

let cache: SnagletAgent[] | null = null;
let pending: Promise<SnagletAgent[]> | null = null;
/** When the last load gave up; null once one succeeds. */
let failedAt: number | null = null;
let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** What a parse reads from the roster: which ids exist and their names. */
function rosterKey(agents: readonly SnagletAgent[]): string {
  return agents
    .map((agent) => `${agent.id}\u0000${agent.name}`)
    .sort()
    .join('\u0001');
}

function storeRoster(next: SnagletAgent[]): void {
  const changed = cache === null || rosterKey(cache) !== rosterKey(next);
  cache = next;
  failedAt = null;
  if (!changed) return;
  // One listener's error must neither skip the others nor fail the load.
  for (const listener of listeners) {
    try {
      listener();
    } catch (err: unknown) {
      console.error('[agentMentionCache] a roster listener failed', getErrorMessage(err));
    }
  }
}

/** Synchronous read — returns null when the cache hasn't hydrated yet. */
export function getAgentsCached(): SnagletAgent[] | null {
  return cache;
}

/**
 * True when the roster could not be loaded and there is none to show: the
 * last load used up its tries and nothing was ever cached.
 */
export function agentsLoadFailed(): boolean {
  return failedAt !== null && cache === null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Single-flighted load with bounded retries. On failure it keeps and
 *  resolves with the last good roster; a failure is never cached. */
function fetchAgents(): Promise<SnagletAgent[]> {
  if (!pending) {
    pending = (async () => {
      for (let attempt = 1; ; attempt += 1) {
        let next: SnagletAgent[];
        try {
          next = (await agentsApi.list()) ?? [];
        } catch (error: unknown) {
          if (attempt >= AGENT_LOAD_ATTEMPTS) {
            console.error(
              `[agentMentionCache] loading the agent roster failed ${attempt} times`,
              error
            );
            failedAt = Date.now();
            return cache ?? [];
          }
          await wait(AGENT_LOAD_RETRY_DELAYS_MS[attempt - 1] ?? AGENT_LOAD_COOLDOWN_MS);
          continue;
        }
        storeRoster(next);
        return next;
      }
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Load the roster once; concurrent callers share the request. Returns the
 * cache without a network hit once warm, so it is safe on hot paths. During
 * the cooldown after a failed load it resolves with what it has.
 */
export function ensureAgents(): Promise<SnagletAgent[]> {
  if (cache) return Promise.resolve(cache);
  if (failedAt !== null && Date.now() - failedAt < AGENT_LOAD_COOLDOWN_MS) {
    return pending ?? Promise.resolve([]);
  }
  return fetchAgents();
}

/**
 * Always refetch (single-flighted) and update the cache. Call when a roster
 * surface such as the mention popover opens.
 */
export function refreshAgents(): Promise<SnagletAgent[]> {
  return fetchAgents();
}

/**
 * An agent changed on the server: refetch the roster once the burst settles.
 * Several events inside the wait share one refetch, and a load already in
 * flight may predate the change, so the refetch starts after it. A roster
 * nobody has loaded yet is left alone; its first load reads the new one.
 */
export function invalidateAgentRoster(): void {
  if (cache === null && failedAt === null && !pending) return;
  if (invalidateTimer) return;
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null;
    const inFlight: Promise<unknown> = pending ?? Promise.resolve();
    void inFlight.then(() => fetchAgents());
  }, AGENT_INVALIDATE_DELAY_MS);
}

/**
 * Hear every load that changes the roster's agents or their names (not a
 * load that returns the same ones). Returns the unsubscribe.
 */
export function subscribeAgentRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Find an agent by exact (case-insensitive) name or normalized handle. */
export function findAgentByHandle(agents: SnagletAgent[], typed: string): SnagletAgent | null {
  const lower = typed.trim().toLowerCase();
  for (const agent of agents) {
    const handle = agentLookupHandle(agent.name);
    if (handle === lower || agent.name.trim().toLowerCase() === lower) {
      return agent;
    }
  }
  return null;
}
