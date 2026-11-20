/**
 * Automations surface: `automations:changed` on the workspace channel,
 * payload {@link AutomationsChangedEvent} (`{ automationId? }`), after every
 * automation write and wake. Clients refetch the Automations grid. The
 * calendar gets its own `calendar:changed` (kind 'automation').
 */
import type { AutomationsChangedEvent } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { wsService } from '@server/services/WebSocketService';

const AUTOMATIONS_CHANGED_FRAME = 'automations:changed';

export function emitAutomationsChanged(event: AutomationsChangedEvent = {}): void {
  try {
    wsService.broadcastToChannel(WORKSPACE_EVENT_CHANNEL, {
      type: AUTOMATIONS_CHANGED_FRAME,
      payload: event.automationId ? { automationId: event.automationId } : {},
    });
  } catch (error) {
    logger.warn('[automations] failed to broadcast automations:changed', {
      error: getErrorMessage(error),
    });
  }
}
