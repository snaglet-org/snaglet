import { Automations } from '@snaglet/db/tables/automations';
import type { WakeOrigin } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { composeAutomationWakeNote } from '@server/services/SystemPromptComposer/composeTurnContextTail';

/**
 * The turn-context note for a turn an automation started, or null. Only the
 * agent the automation wakes gets it: the marker rides every turn of the
 * dispatch, and a teammate it @-mentions was woken by a message. Best-effort:
 * a failed lookup leaves the note out.
 */
export async function buildAutomationWakeNote(
  wakeOrigin: WakeOrigin | undefined,
  agentId: string
): Promise<string | null> {
  if (wakeOrigin?.kind !== 'automation') return null;
  try {
    const row = await Automations.findById(wakeOrigin.automationId);
    if (!row || row.agentId !== agentId) return null;
    return composeAutomationWakeNote({
      name: row.name,
      scheduledByYou: row.createdByAgentId === agentId,
    });
  } catch (err) {
    logger.warn(
      `[automations] wake note lookup failed for ${wakeOrigin.automationId}: ${getErrorMessage(err)}`
    );
    return null;
  }
}
