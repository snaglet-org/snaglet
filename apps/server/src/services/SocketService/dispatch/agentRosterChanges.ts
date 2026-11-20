/**
 * agentRosterChanges — roster bumps for changes that touch every thread an
 * agent is in at once: a subagent helper retired or swept (its participant rows
 * go) and an agent archived (it stops being dispatchable). A run going on in
 * one of those threads then re-reads its roster (liveRoster.ts) and stops
 * routing mentions to the agent.
 *
 * Read the thread ids BEFORE the rows are deleted, bump AFTER the change is
 * committed, so a run cannot re-read the old roster and call it current.
 */

import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { markThreadsRosterChanged } from './rosterVersion';

/** The threads the agent is a participant of now. Never throws (a bump is best-effort). */
export async function agentThreadIds(agentId: string): Promise<string[]> {
  try {
    return (await ThreadParticipants.listByAgent(agentId)).map((row) => row.threadId);
  } catch (err) {
    logger.warn(
      `[roster] could not list threads of agent ${agentId} for a roster bump: ${getErrorMessage(err)}`
    );
    return [];
  }
}

export { markThreadsRosterChanged };
