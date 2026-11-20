/**
 * `agent.thread_summary_model_overrides` is keyed by thread id, and deleting a
 * thread does not touch settings, so entries for hard-deleted threads pile up.
 * These prunes edit the JSONB in place so they can run inside the deleting
 * transaction (pass its runner) or on their own.
 *
 * Thread hard-deletes all go through `withThreadExecutionPurge`
 * (services/ThreadExecutionPurgeService.ts), which calls
 * `pruneDeletedThreadSummaryModelOverrides` inside the deleting transaction.
 * That service also backs thread *clears*, where the thread survives, so the
 * prune only removes ids whose thread row is gone. Deletes that bypass it are
 * caught up by `pruneOrphanedThreadSummaryModelOverrides` whenever the map is
 * edited.
 */

import { getDb, type DbQueryable } from '@snaglet/db';
import { agentSettings } from './categories/agent';
import { settingsService } from './settingsService';

const def = agentSettings.threadSummaryModelOverrides;

/** Remove every entry for `threadIds`. True when the map changed. */
export async function pruneThreadSummaryModelOverrides(
  threadIds: readonly string[],
  runner: DbQueryable = getDb()
): Promise<boolean> {
  const ids = [...new Set(threadIds.filter((id) => id.length > 0))];
  if (ids.length === 0) return false;
  const { rows } = await runner.query<{ key: string }>(
    `UPDATE public.settings
        SET value = value - $3::text[], updated_at = now()
      WHERE category = $1 AND key = $2
        AND jsonb_typeof(value) = 'object'
        AND value ?| $3::text[]
      RETURNING key`,
    [def.category, def.key, ids]
  );
  if (rows.length === 0) return false;
  settingsService.invalidate(def.category, def.key);
  return true;
}

/**
 * Remove the entries of those `threadIds` whose thread no longer exists, as
 * seen by `runner` — pass the deleting transaction, after its delete. True
 * when the map changed; call `forgetCachedThreadSummaryModelOverrides` once
 * that transaction commits.
 */
export async function pruneDeletedThreadSummaryModelOverrides(
  threadIds: readonly string[],
  runner: DbQueryable = getDb()
): Promise<boolean> {
  if (threadIds.length === 0) return false;
  const { rows } = await runner.query<{ id: string }>(
    `SELECT id FROM public.threads WHERE id = ANY($1::text[])`,
    [[...threadIds]]
  );
  const surviving = new Set(rows.map((row) => row.id));
  return pruneThreadSummaryModelOverrides(
    threadIds.filter((id) => !surviving.has(id)),
    runner
  );
}

/**
 * Drop the cached map. A prune inside a transaction invalidates before commit,
 * so a read in that window can re-cache the old map; call this after commit.
 */
export function forgetCachedThreadSummaryModelOverrides(): void {
  settingsService.invalidate(def.category, def.key);
}

/** Remove entries for threads that no longer exist. Returns the pruned thread ids. */
export async function pruneOrphanedThreadSummaryModelOverrides(
  runner: DbQueryable = getDb()
): Promise<string[]> {
  const { rows } = await runner.query<{ id: string }>(
    `SELECT k AS id
       FROM public.settings s,
            jsonb_object_keys(
              CASE WHEN jsonb_typeof(s.value) = 'object' THEN s.value ELSE '{}'::jsonb END
            ) AS k
      WHERE s.category = $1 AND s.key = $2
        AND NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = k)`,
    [def.category, def.key]
  );
  const orphaned = rows.map((row) => row.id);
  await pruneThreadSummaryModelOverrides(orphaned, runner);
  return orphaned;
}
