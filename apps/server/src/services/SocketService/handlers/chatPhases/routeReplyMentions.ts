/**
 * routeReplyMentions — the one seam where an agent's spoken text (an interim
 * utterance or its final reply) wakes teammates.
 *
 * 1. Re-read the roster if an agent joined or left during the run
 *    (deps.refreshRoster, liveRoster.ts), so "add Nova, then @Nova" wakes her.
 * 2. Skip routing when the speaker itself is no longer in the thread: it left
 *    (thread op leave) or was removed, so its text is dropped
 *    (persistUtterance) and must not wake anyone, neither as an `all`-mode
 *    fan-out nor as "@Lead over to you" on a message that does not exist.
 * 3. Otherwise route as every utterance does (routeSpokenMentions).
 *
 * Returns whether the text was routed.
 */

import { LogsService } from '@server/services/LogsService';
import { routeSpokenMentions, type RouteSpokenMentionsInput } from './utteranceMessages';

export async function routeReplyMentions(input: RouteSpokenMentionsInput): Promise<boolean> {
  await input.deps.refreshRoster?.();
  if (!input.deps.participantAgentIds.includes(input.replyAgentId)) {
    LogsService.socket.event('reply not routed (the speaker left the thread)', {
      agentName: input.agent.name,
      threadName: input.deps.threadName,
      threadId: input.deps.session.threadId,
      logContext: input.logContext,
    });
    return false;
  }
  routeSpokenMentions(input);
  return true;
}
