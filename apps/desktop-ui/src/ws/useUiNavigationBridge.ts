/**
 * UI navigation bridge for agent-driven pane navigation, over the addressed
 * `ui` WebSocket channel:
 *   - `ui.register_client` (on (re)connect) maps this connection to the
 *     active user so the server can unicast to it;
 *   - `ui.request_pane_layout` is answered with `ui.pane_layout_response`
 *     (same `requestId`) carrying the serialized layout;
 *   - `ui.navigate_pane` resolves the target to a selection and opens it.
 * Unlike the broadcast `workspace` channel, `ui` is unicast, so one user's
 * navigation never moves another user's panes.
 */
import { useEffect, useRef } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import {
  UI_EVENT_CHANNEL,
  type UiEvent,
  type PaneNavigationTarget,
  type PaneNavigationMode,
  type PaneSplitZone,
} from '@snaglet/shared/types';
import { ACTIVE_USER_CHANGED_EVENT, ACTIVE_USER_ID_KEY, getActiveUserId } from '@desktop/config';
import { serializePaneLayout, type LayoutNode } from '@desktop/pages/Dashboard/layout/paneTree';
import { resolveNavigationTarget } from '@desktop/pages/Dashboard/selection/resolveNavigationTarget';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';
import { useWs } from './useWs';

interface UiNavigationBridgeArgs {
  /** Live layout tree (read fresh on each layout request via a ref). */
  layout: LayoutNode;
  /** Thread the user is actively chatting in — never replaced unless explicit. */
  activeThreadId: string | null;
  /** Apply a resolved selection to a pane by key (stale-key safe). */
  navigatePaneByKey: (
    paneKey: string | null | undefined,
    selection: DetailSelection,
    activeThreadId?: string | null,
    options?: {
      mode?: PaneNavigationMode;
      splitZone?: PaneSplitZone;
      newPaneRatio?: number;
    }
  ) => string | null;
}

/**
 * Narrow a raw `WsMessage` to a `UiEvent`.
 *
 * Mirrors `useWorkspaceEventBridge`: filter by channel, then read the event off
 * `payload` (whose own `type` discriminates the UI event).
 */
function uiEventFromMessage(msg: WsMessage): UiEvent | null {
  if (msg.channel !== UI_EVENT_CHANNEL) return null;
  const payload = msg.payload as UiEvent | undefined;
  if (!payload || typeof payload !== 'object' || !('type' in payload)) return null;
  return payload;
}

/**
 * Debounce window for pane-layout change pushes. The user may resize / split /
 * navigate panes in quick succession; we coalesce bursts into a single push so
 * the server doesn't take a row-write per drag-frame.
 */

export function useUiNavigationBridge({
  layout,
  activeThreadId,
  navigatePaneByKey,
}: UiNavigationBridgeArgs): void {
  const { connectionState, subscribe, unsubscribe, addMessageListener, send } = useWs();

  // Keep the latest layout / activeThreadId / navigator in refs so the message
  // listener (registered once) always sees current values without re-binding.
  const layoutRef = useRef(layout);
  const activeThreadIdRef = useRef(activeThreadId);
  const navigateRef = useRef(navigatePaneByKey);
  layoutRef.current = layout;
  activeThreadIdRef.current = activeThreadId;
  navigateRef.current = navigatePaneByKey;

  // 1. Subscribe to the `ui` channel + register this client on every (re)connect.
  useEffect(() => {
    if (connectionState !== 'open') return;
    subscribe(UI_EVENT_CHANNEL);
    const register = () => {
      const userId = getActiveUserId();
      if (userId) {
        send({
          type: 'ui.register_client',
          channel: UI_EVENT_CHANNEL,
          payload: { userId },
        });
      }
    };
    register();
    // Identity loads asynchronously in App; an already-open socket must register
    // when it arrives, and re-register when the selected profile changes.
    window.addEventListener(ACTIVE_USER_CHANGED_EVENT, register);
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_USER_ID_KEY) register();
    };
    window.addEventListener('storage', onStorage);
    // Balanced release — the provider's channel registry is holder-counted.
    return () => {
      window.removeEventListener(ACTIVE_USER_CHANGED_EVENT, register);
      window.removeEventListener('storage', onStorage);
      unsubscribe(UI_EVENT_CHANNEL);
    };
  }, [connectionState, subscribe, unsubscribe, send]);

  // 2 + 3. Handle inbound UI events.
  useEffect(() => {
    const off = addMessageListener((msg) => {
      const event = uiEventFromMessage(msg);
      if (!event) return;

      switch (event.type) {
        case 'ui.request_pane_layout': {
          const snapshot = serializePaneLayout(layoutRef.current, activeThreadIdRef.current);
          send({
            type: 'ui.pane_layout_response',
            channel: UI_EVENT_CHANNEL,
            payload: { requestId: event.requestId, layout: snapshot },
          });
          break;
        }
        case 'ui.navigate_pane': {
          const target = event.target as PaneNavigationTarget;
          void resolveNavigationTarget(target).then((selection) => {
            if (!selection) return; // unsupported / unresolved target — no-op
            navigateRef.current(event.paneKey ?? null, selection, activeThreadIdRef.current, {
              mode: event.mode,
              splitZone: event.splitZone,
              newPaneRatio: event.newPaneRatio,
            });
          });
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, [addMessageListener, send]);
}
