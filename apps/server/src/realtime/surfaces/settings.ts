/**
 * Settings surface: `settings:changed` on the `settings` channel, payload
 * {@link SettingsChangedEvent} (`{ category, key }`), after every setting
 * write or revert. It follows the settings service's own change event, so
 * every path that changes a setting is covered: the settings routes (a Theme
 * view save in another window), agent tools (`change_color_theme`), jobs.
 * The value stays out of the frame; clients re-read what they show over REST.
 * Its own channel, so a window that only follows settings (the overlays) is
 * not sent every workspace event.
 */
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_EVENT_CHANNEL,
  type SettingsChangedEvent,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { wsService } from '@server/services/WebSocketService';
import { settingsService } from '@server/services/settings';

let stop: (() => void) | null = null;

/** Start broadcasting setting changes. Idempotent; returns the unsubscribe. */
export function initSettingsSurface(): () => void {
  stop ??= settingsService.onChange(({ category, key }) => {
    const payload: SettingsChangedEvent = { category, key };
    try {
      wsService.broadcastToChannel(SETTINGS_EVENT_CHANNEL, {
        type: SETTINGS_CHANGED_EVENT,
        payload,
      });
    } catch (error) {
      logger.warn('[settings] failed to broadcast settings:changed', {
        error: getErrorMessage(error),
      });
    }
  });
  return () => {
    stop?.();
    stop = null;
  };
}
