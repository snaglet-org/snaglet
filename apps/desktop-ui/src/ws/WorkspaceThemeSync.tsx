/**
 * Keeps this window's colors in step with the saved theme. It re-reads and
 * applies the theme when the server reports `appearance.colors` changed
 * (`settings:changed` on the `settings` channel) and on every socket open,
 * since frames sent while the socket was down are lost and a failed first
 * load should recover. refreshWorkspaceTheme waits for this window's own
 * saves to settle, so a pick in progress never flickers back.
 *
 * Mount once inside each window's WebSocketProvider (app, ask and cursor overlays).
 */
import { useEffect } from 'react';
import {
  SETTINGS_CHANGED_EVENT,
  SETTINGS_EVENT_CHANNEL,
  type SettingsChangedEvent,
} from '@snaglet/shared/types';
import { refreshWorkspaceTheme } from '@desktop/utils/workspaceTheme';
import { useWs } from './useWs';

function isThemeChange(payload: unknown): boolean {
  const change = payload as Partial<SettingsChangedEvent> | null;
  return change?.category === 'appearance' && change.key === 'colors';
}

export function WorkspaceThemeSync(): null {
  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();

  useEffect(() => {
    subscribe(SETTINGS_EVENT_CHANNEL);
    return () => unsubscribe(SETTINGS_EVENT_CHANNEL);
  }, [subscribe, unsubscribe]);

  useEffect(
    () =>
      addMessageListener((message) => {
        if (
          message.channel === SETTINGS_EVENT_CHANNEL &&
          message.type === SETTINGS_CHANGED_EVENT &&
          isThemeChange(message.payload)
        ) {
          void refreshWorkspaceTheme();
        }
      }),
    [addMessageListener]
  );

  useEffect(() => {
    if (connectionState === 'open') void refreshWorkspaceTheme();
  }, [connectionState]);

  return null;
}
