/**
 * navigate_user_pane — end-to-end through the real UI surface.
 *
 * Exercises the full server path: a client registers with the real `ui` surface,
 * the agent calls the real tool handler, and we assert the navigate command is
 * delivered to that client with the correctly-mapped wire target. Only the
 * lowest-level WS transport (and the DB-backed layout recorder) are stubbed —
 * the registry, target mapping, and emit are all real.
 */

const mockSendToClient = jest.fn(() => true);
const mockHandlers: Record<string, (payload: unknown, meta: unknown) => void> = {};
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    registerHandler: (eventType: string, handler: (payload: unknown, meta: unknown) => void) => {
      mockHandlers[eventType] = handler;
    },
    sendToClient: (...args: unknown[]) => mockSendToClient(...args),
    onDisconnect: () => {},
  },
}));
// The target node exists and matches the requested kind (the existence check is
// unit-tested separately; here we exercise the delivery path with a valid target).
jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: { findById: (id: string) => Promise.resolve({ id, type: 'doc' }) },
}));

import { initUiSurface } from '@server/realtime/surfaces/ui';
import navigateUserPane from '@server/services/ToolService/handlers/workspace/navigatePane';

describe('navigate_user_pane — end to end through the real UI surface', () => {
  test('a registered client receives the navigate command with the mapped wire target', async () => {
    initUiSurface();
    // Simulate the browser registering itself with the UI surface.
    mockHandlers['ui.register_client']({ userId: '5' }, { clientId: 'client-1' });

    const out = JSON.parse(
      (await navigateUserPane(
        { pane_key: 'root.0', target: { kind: 'doc', id: 'doc-42' } },
        {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { agentId: 'agent-7' } as any
      )) as string
    );

    expect(out.success).toBe(true);
    expect(out.clientsReached).toBe(1);

    expect(mockSendToClient).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [clientId, message] = mockSendToClient.mock.calls[0] as [string, any];
    expect(clientId).toBe('client-1');
    expect(message.type).toBe('ui.navigate_pane');
    expect(message.payload.paneKey).toBe('root.0');
    expect(message.payload.target).toEqual({ kind: 'doc', docId: 'doc-42' });
    expect(message.payload.actor.actorId).toBe('agent-7');
  });
});
