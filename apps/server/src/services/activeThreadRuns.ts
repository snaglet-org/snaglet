/**
 * activeThreadRuns — activity markers for threads with a LIVE agent run.
 *
 * Orchestrating agents read the workspace through tools (workspace_search,
 * workspace_tree / workspace_project_tree, workspace_get_node) and otherwise
 * have to open each thread to see whether an agent is working in it. These
 * helpers stamp a compact `▶ running (<agent>)` marker onto thread results so
 * activity is visible at a glance.
 *
 * Liveness reuses the existing in-memory signal (ActiveRunTracker) — the same
 * source the RunReaperService acts on — rather than the DB `runs.status` flag,
 * which can read 'running' long after the owning process died. A thread is only
 * marked live when a session holds its run lock AND that session has made
 * observable progress within the reaper's zombie window, so a crashed or wedged
 * (soon-to-be-reaped) run is never reported as active.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { Runs } from '@snaglet/db/tables/runs';
import { logger } from '@server/config/logger';
import { activeRunTracker } from './ActiveRunTracker';
import { REAPER_STALL_DEFAULT_MS } from './RunReaperService';

export interface ThreadActivity {
  /** Display names of the agent(s) with a live run in this thread. */
  agentNames: string[];
}

/**
 * Batched active-run lookup for a set of thread ids. Returns a map keyed by
 * thread id; a thread is present only when it has a live run (so
 * `map.has(id)` === "an agent is running here"). Threads that are idle, or
 * whose run is stale/dead, are absent.
 *
 * Efficiency: liveness is resolved entirely in memory first, so an idle
 * workspace costs zero DB round-trips. When at least one requested thread is
 * live, exactly ONE batched `runs ⋈ agents` query resolves every agent name —
 * never one query per thread.
 */
export async function getThreadActivity(
  threadIds: Iterable<string>
): Promise<Map<string, ThreadActivity>> {
  const result = new Map<string, ThreadActivity>();
  const liveThreadIds = activeRunTracker.liveThreadIds(REAPER_STALL_DEFAULT_MS, threadIds);
  if (liveThreadIds.length === 0) return result;

  // Seed every live thread so the marker shows even if its DB row already
  // flipped to completed (race) or its agent was deleted — liveness comes from
  // the tracker, the name is best-effort enrichment on top.
  for (const threadId of liveThreadIds) result.set(threadId, { agentNames: [] });

  // The tracker enforces ONE live session per thread, but a thread's DB can hold
  // several `runs.status='running'` rows — the truly-live run PLUS stale siblings
  // from crashed/reaped priors that never flipped status. Gate names to the run
  // ids the tracker still considers in-flight so those stale rows don't leak
  // extra agent names into the marker (e.g. `▶ running (A, B)` when only B is live).
  const liveRunIds = activeRunTracker.liveRunIds();
  try {
    const rows = await Runs.getRunningAgentNamesByThread(liveThreadIds);
    for (const { runId, threadId, agentName } of rows) {
      const entry = result.get(threadId);
      // Ignore rows for threads the tracker doesn't consider live (defensive)
      // and rows whose run the tracker no longer considers in-flight (stale).
      if (!entry || !agentName || !liveRunIds.has(runId)) continue;
      if (!entry.agentNames.includes(agentName)) entry.agentNames.push(agentName);
    }
  } catch (err) {
    // Fail soft — surface liveness without a name rather than dropping the
    // marker or failing the whole tool render.
    logger.warn(`[active-thread-runs] agent-name lookup failed: ${getErrorMessage(err)}`);
  }
  return result;
}

/**
 * The inline marker for a running thread, e.g. `▶ running (Clio)` — or a bare
 * `▶ running` when no agent can be named. Returns '' for an idle thread (no
 * `activity` entry), so call sites can append it unconditionally.
 */
export function activeRunMarker(activity: ThreadActivity | undefined): string {
  if (!activity) return '';
  return activity.agentNames.length > 0
    ? `▶ running (${activity.agentNames.join(', ')})`
    : '▶ running';
}
