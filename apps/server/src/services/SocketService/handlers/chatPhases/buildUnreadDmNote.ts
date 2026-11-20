import { Members } from '@snaglet/db/tables/members';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { DmService } from '@server/services/dm/DmService';
import { composeUnreadDmNote } from '@server/services/SystemPromptComposer/composeTurnContextTail';

/**
 * The turn-context note naming who has DMed the agent, or null. It rides the
 * per-turn tail only, never the system prompt. Skipped without a query when
 * the agent has DMs turned off. When the turn runs in a thread, that thread is
 * first marked read for the agent if (and only if) it is a DM thread, so an
 * agent answering in its own DM thread does not find those messages unread on
 * its next run elsewhere. Best-effort: a failed lookup leaves the note out.
 */
export async function buildUnreadDmNote(
  agentId: string,
  opts: { dmEnabled: boolean; currentThreadId?: string }
): Promise<string | null> {
  if (!opts.dmEnabled) return null;
  try {
    const member = await Members.findByAgent(agentId);
    if (!member) return null;
    if (opts.currentThreadId) await DmService.markReadIfDm(opts.currentThreadId, member.id);
    return composeUnreadDmNote(await DmService.unreadSummary(member.id));
  } catch (err) {
    logger.warn(`[dm] unread note lookup failed for ${agentId}: ${getErrorMessage(err)}`);
    return null;
  }
}
