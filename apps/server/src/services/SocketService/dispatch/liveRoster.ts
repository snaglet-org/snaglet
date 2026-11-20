/**
 * liveRoster — the agent roster a running dispatch routes @-mentions against.
 *
 * A dispatch reads the thread's agents once, when it starts (chatHandlers /
 * buildDispatchDeps). An agent can join or leave while the run goes on: an
 * agent brings a specialist in with the thread tool and @-mentions them in the
 * same turn, or takes one out. Each of those bumps the thread's roster version
 * (rosterVersion.ts). Before the run resolves mentions it calls
 * `refreshIfChanged`, which re-reads the roster from the database only when the
 * version moved, with the same rules the start used: archived agents never
 * dispatch, and the tool path's sender stays out. So a just-added agent is
 * woken by a mention in the same turn, and a just-removed one is not.
 *
 * `ids` is updated in place, so every holder of the array sees the current
 * roster. Names and roles are added for agents that join; a name that leaves
 * stays in the map, so a mention of a removed agent is reported as skipped
 * (not a participant) instead of vanishing.
 */

import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { agentService } from '@server/services/AgentService';
import { LogsService } from '@server/services/LogsService';
import { partitionArchivedParticipants } from './partitionArchivedParticipants';
import { threadRosterVersion } from './rosterVersion';

export interface LiveRoster {
  /** The agents a mention can reach now (updated in place). */
  readonly ids: string[];
  /** More than one agent in the roster. */
  readonly isGroup: boolean;
  /** The participant id a mentioned id names (case-insensitive), if any. */
  resolve(mentionedId: string): string | undefined;
  /** Re-read the roster when the thread's roster changed since the last read. */
  refreshIfChanged(): Promise<void>;
}

export interface CreateLiveRosterInput {
  threadId: string;
  threadName?: string;
  /** The roster the dispatch started with (copied, not mutated). */
  ids: readonly string[];
  /** The dispatch's name and role maps; joiners are added to them. */
  names: Map<string, string>;
  roles: Map<string, string>;
  /** The tool path leaves its sender out of the roster; kept out on refresh. */
  excludeAgentId?: string | null;
  /**
   * The thread's roster version taken just BEFORE `ids` was read, so a change
   * that lands between that read and the dispatch start is still picked up.
   * Defaults to the version now.
   */
  version?: number;
}

export function createLiveRoster(input: CreateLiveRosterInput): LiveRoster {
  const { threadId, names, roles } = input;
  const ids = [...input.ids];
  let seenVersion = input.version ?? threadRosterVersion(threadId);
  let inflight: Promise<boolean> | null = null;

  /** True when the roster was read; the version advances only then. */
  async function reload(version: number): Promise<boolean> {
    try {
      const rows = await ThreadParticipants.listByThread(threadId);
      const raw = [
        ...new Set(
          rows
            .map((row) => row.agentId)
            .filter((id): id is string => Boolean(id) && id !== input.excludeAgentId)
        ),
      ];
      const { liveIds } = await partitionArchivedParticipants(raw);
      for (const id of liveIds) {
        if (names.has(id)) continue;
        // A failed lookup leaves the agent unnamed (labels fall back to the id),
        // as the dispatch start does; it never fails the read.
        const agent = await agentService.get(id).catch((err: unknown) => {
          LogsService.warn('failed to load a joining agent for the name map', {
            threadName: input.threadName,
            threadId,
            agentId: id,
            error: getErrorMessage(err),
          });
          return undefined;
        });
        if (!agent) continue;
        names.set(agent.id, agent.name);
        if (agent.role) roles.set(agent.id, agent.role);
      }
      ids.splice(0, ids.length, ...liveIds);
      seenVersion = version;
      LogsService.socket.event('roster re-read after a participant change', {
        threadName: input.threadName,
        threadId,
        agents: liveIds.map((id) => names.get(id) ?? id).join(', '),
      });
      return true;
    } catch (err) {
      // Keep the roster we have (a failed read must not empty it mid-run) and
      // the version we had, so the next refresh tries again.
      LogsService.warn('roster re-read failed; keeping the previous roster', {
        threadName: input.threadName,
        threadId,
        error: getErrorMessage(err),
      });
      return false;
    }
  }

  return {
    ids,
    get isGroup() {
      return ids.length > 1;
    },
    resolve(mentionedId) {
      const lc = mentionedId.toLowerCase();
      return ids.find((id) => id.toLowerCase() === lc);
    },
    async refreshIfChanged() {
      // Parallel turns share one read; a change that lands during a read is
      // picked up by the next pass of the loop. A failed read stops here and
      // is retried by the next call.
      while (threadRosterVersion(threadId) !== seenVersion) {
        inflight ??= reload(threadRosterVersion(threadId)).finally(() => {
          inflight = null;
        });
        if (!(await inflight)) return;
      }
    },
  };
}
