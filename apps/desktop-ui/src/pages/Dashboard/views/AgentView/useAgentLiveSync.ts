/**
 * Keeps one open agent pane in step with the server while it is mounted.
 *
 * Listens on the agent bus (fed by the workspace event bridge) for this
 * agent's `agent.updated` and for `agents.invalidated` after a reconnect, and
 * refetches the agent row. No polling: nothing happens without an event.
 *
 * - Echo: an event whose revision (`updatedAt`) the pane already holds is its
 *   own save coming back, so there is nothing to fetch.
 * - Saves first: while the pane has a save in flight the refetch waits for it,
 *   and a refetch that a save overtook is thrown away and redone, so an older
 *   copy never replaces a newer save.
 * - Bursts: events inside the short delay share one refetch; events that land
 *   during a refetch queue exactly one more.
 * - Incoming: an event that is not an echo is reported at once (`onIncoming`)
 *   with the keys it names, and `onIdle` follows once its refetch has landed
 *   (or failed) and nothing else is queued. The pane holds saves of a named
 *   text field in between, so a save cannot overwrite the change before the
 *   pane knows about it.
 * - Deleted: the `deleted` marker, or a 404 on refetch, reports the agent gone.
 * - Skills: `skills` alone leaves the row alone; the Skills section refetches
 *   its own list, so this hook does not.
 */

import { useEffect, useRef } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import { agentsApi } from '@desktop/utils/api';
import { subscribeAgentEvents } from '@desktop/utils/agentEvents';
import { isNotFound, isRowIndependentKey } from './agentLiveFields';

/** How long an event waits for the rest of its burst before the refetch. */
const AGENT_LIVE_REFRESH_MS = 150;

/** The pane's own saves, as the sync needs to see them. */
export interface AgentSaveTracker {
  /** Counts saves started; a change means a save overtook a refetch. */
  started: () => number;
  /** Resolves once no save is in flight. */
  settled: () => Promise<void>;
}

interface UseAgentLiveSyncOptions {
  agentId: string;
  /** The revision the pane holds (`updatedAt` of its copy). */
  heldRevision: () => string | undefined;
  saves: AgentSaveTracker;
  /** A fresh row, with who changed which server key since the last one. */
  onFresh: (fresh: SnagletAgent, actors: ReadonlyMap<string, Actor>) => void;
  /** The agent was deleted. */
  onGone: () => void;
  /** A change is on its way: the server keys it names, or 'all' after a reconnect. */
  onIncoming: (keys: readonly string[] | 'all') => void;
  /** Every reported change has been applied (or its refetch failed). */
  onIdle: () => void;
}

export function useAgentLiveSync(options: UseAgentLiveSyncOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { agentId } = options;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let again = false;
    // What the queued events ask for: a fetch (any event without a revision,
    // or a reconnect) or only the revisions to compare with the held one.
    let needFetch = false;
    const revisions = new Set<string>();
    const actors = new Map<string, Actor>();

    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, AGENT_LIVE_REFRESH_MS);
    };

    const run = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        for (;;) {
          await optionsRef.current.saves.settled();
          if (disposed) return;
          const held = optionsRef.current.heldRevision();
          if (!needFetch && [...revisions].every((revision) => revision === held)) {
            // Every queued event was a revision this pane already holds.
            revisions.clear();
            actors.clear();
            return;
          }
          needFetch = false;
          revisions.clear();
          const savesBefore = optionsRef.current.saves.started();
          const fresh = await agentsApi.get(agentId);
          if (disposed) return;
          if (optionsRef.current.saves.started() !== savesBefore) {
            // A save started while this copy was in flight: it may predate it.
            needFetch = true;
            continue;
          }
          const credited = new Map(actors);
          actors.clear();
          optionsRef.current.onFresh(fresh, credited);
          return;
        }
      } catch (err: unknown) {
        if (disposed) return;
        if (isNotFound(err)) optionsRef.current.onGone();
        else console.error('AgentView: failed to refresh the agent', err);
      } finally {
        running = false;
        if (!disposed) {
          if (again) {
            again = false;
            schedule();
          } else if (!timer) {
            optionsRef.current.onIdle();
          }
        }
      }
    };

    const stop = subscribeAgentEvents((event) => {
      if (event.type === 'agents.invalidated') {
        needFetch = true;
        optionsRef.current.onIncoming('all');
        if (running) again = true;
        else schedule();
        return;
      }
      if (event.agentId !== agentId) return;
      if (event.changed.includes('deleted')) {
        optionsRef.current.onGone();
        return;
      }
      const rowKeys = event.changed.filter((key) => !isRowIndependentKey(key));
      if (rowKeys.length === 0) return;
      // A revision the pane already holds is its own save's echo.
      if (event.updatedAt && event.updatedAt === optionsRef.current.heldRevision()) return;
      optionsRef.current.onIncoming(rowKeys);
      for (const key of rowKeys) actors.set(key, event.actor);
      if (event.updatedAt) revisions.add(event.updatedAt);
      else needFetch = true;
      if (running) again = true;
      else schedule();
    });

    return () => {
      disposed = true;
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [agentId]);
}
