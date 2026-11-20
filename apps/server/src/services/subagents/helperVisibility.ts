/**
 * Is this thread or agent a subagent helper? For server code that
 * filters by id rather than in SQL: hook dispatch, summaries, notifications
 * and embeddings. Queries that can join use the shared fragments in
 * `@snaglet/db/tables/threads/visibility` and `@snaglet/db/tables/agents/visibility`.
 *
 * `isHiddenThread` is the wider question the embedding gates ask: a helper
 * thread or a DM thread, per the shared `hiddenThreadRowSql`. It is
 * separate on purpose: notifications and subagent bookkeeping need the
 * helper-only answer (a DM still notifies).
 *
 * `threads.parent_thread_id`, `threads.kind` and `agents.parent_agent_id` are
 * set only when the row is created, and helper and thread ids are never
 * reused (`subagent-<uuid>`, generated thread ids), so every answer is cached
 * for the life of the process. Only an existing row is cached: an id with no
 * row yet answers "no" and is asked again next time. A failed lookup also
 * answers "no" (logged, not cached) — every caller treats that as the
 * ordinary path, which is what it was before helpers existed.
 */

import { getDb } from '@snaglet/db';
import { hiddenThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

type HelperKind = 'thread' | 'agent' | 'hiddenThread';

/** Per kind; the oldest answers are dropped first past this. */
const MAX_CACHED_IDS = 5000;

const LOOKUP_SQL: Readonly<Record<HelperKind, string>> = {
  thread: 'SELECT parent_thread_id IS NOT NULL AS helper FROM public.threads WHERE id = $1',
  agent: 'SELECT parent_agent_id IS NOT NULL AS helper FROM public.agents WHERE id = $1',
  hiddenThread: `SELECT ${hiddenThreadRowSql('t')} AS helper FROM public.threads t WHERE t.id = $1`,
};

const cached: Record<HelperKind, Map<string, boolean>> = {
  thread: new Map(),
  agent: new Map(),
  hiddenThread: new Map(),
};
const pending: Record<HelperKind, Map<string, Promise<boolean>>> = {
  thread: new Map(),
  agent: new Map(),
  hiddenThread: new Map(),
};

function remember(kind: HelperKind, id: string, helper: boolean): void {
  const cache = cached[kind];
  if (cache.size >= MAX_CACHED_IDS) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(id, helper);
}

async function lookup(kind: HelperKind, id: string): Promise<boolean> {
  try {
    const { rows } = await getDb().query<{ helper: boolean }>(LOOKUP_SQL[kind], [id]);
    const row = rows[0];
    if (!row) return false;
    const helper = row.helper === true;
    remember(kind, id, helper);
    return helper;
  } catch (err) {
    logger.warn(`[subagents] helper ${kind} lookup failed for ${id}: ${getErrorMessage(err)}`);
    return false;
  }
}

function isHelper(kind: HelperKind, id: string | null | undefined): Promise<boolean> {
  if (!id) return Promise.resolve(false);
  const known = cached[kind].get(id);
  if (known !== undefined) return Promise.resolve(known);
  const inFlight = pending[kind].get(id);
  if (inFlight) return inFlight;
  const answer = lookup(kind, id).finally(() => pending[kind].delete(id));
  pending[kind].set(id, answer);
  return answer;
}

/** True when `threadId` is a subagent helper thread. */
export function isHelperThread(threadId: string | null | undefined): Promise<boolean> {
  return isHelper('thread', threadId);
}

/**
 * True when `threadId` is hidden from search and embeddings: a subagent helper
 * thread or a DM thread. The live embedding gates use this; keep
 * {@link isHelperThread} for helper-only questions.
 */
export function isHiddenThread(threadId: string | null | undefined): Promise<boolean> {
  return isHelper('hiddenThread', threadId);
}

/** True when `agentId` is a subagent helper agent. */
export function isHelperAgent(agentId: string | null | undefined): Promise<boolean> {
  return isHelper('agent', agentId);
}

/**
 * Synchronous peek: true only when `threadId` is already known to be a
 * helper thread. For hot synchronous paths that cannot await.
 */
export function isKnownHelperThread(threadId: string | null | undefined): boolean {
  return !!threadId && cached.thread.get(threadId) === true;
}

/** Synchronous peek for agents; see {@link isKnownHelperThread}. */
export function isKnownHelperAgent(agentId: string | null | undefined): boolean {
  return !!agentId && cached.agent.get(agentId) === true;
}
