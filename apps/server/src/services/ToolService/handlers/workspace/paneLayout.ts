/**
 * get_user_pane_layout — reads the user's current split-pane state.
 *
 * Sends a request to the user's active client via the addressed UI
 * transport and returns the live pane layout. Degrades gracefully when
 * no client is connected or the request times out.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { requestPaneLayout, resolveAnyConnectedUserId } from '@server/realtime/surfaces/ui';

const tool: ToolHandler = async (_input, _settings, context) => {
  const agentId = context?.agentId ?? 'unknown';
  const agentName = context?.runtime?.agentName;

  // Resolve the connected client directly from the registry — no DB lookup.
  const userId = resolveAnyConnectedUserId();
  if (!userId) {
    return JSON.stringify({
      viewable: false,
      reason: 'no_active_client',
      message: 'No browser client is currently connected.',
    });
  }

  // Request the layout from the client (times out after 3s by default).
  const result = await requestPaneLayout({
    userId,
    actor: {
      actorId: agentId,
      actorKind: 'agent' as const,
      actorName: agentName,
    },
  });

  if (!result.viewable) {
    return JSON.stringify({
      viewable: false,
      reason: result.reason,
      message:
        result.reason === 'layout_timeout'
          ? 'Layout request timed out — the client may not be responding.'
          : 'No browser client is currently connected.',
    });
  }

  return JSON.stringify({
    viewable: true,
    panes: result.layout.panes,
  });
};

export default tool;
