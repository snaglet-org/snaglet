/**
 * askFeed — mirrors every agent ask onto the global `asks` channel.
 *
 * An ask normally reaches only the clients subscribed to its thread (an open
 * chat pane). This feed lets the agent-popups surface show it with no chat
 * open: requests and settlements are broadcast here as well, and a client
 * (re)connecting asks for a snapshot of what is still pending.
 *
 * Kept free of clarification.ts / confirmation.ts imports so both can call it.
 */
import { ASK_EVENT_CHANNEL, ASK_SETTLED } from '@snaglet/shared/types';
import type { WsMessage } from '@snaglet/shared/types';
import { wsService } from '../WebSocketService';

const announced = new Set<string>();

/** Mirror a request frame (`socket:clarification:request` / `socket:tool:confirmation_request`). */
export function announceAsk(frame: WsMessage): void {
  const callId = (frame.payload as { callId?: string } | undefined)?.callId;
  if (callId) announced.add(callId);
  wsService.broadcastToChannel(ASK_EVENT_CHANNEL, frame);
}

/** The ask has settled (answered, denied, timed out, aborted or canceled). */
export function announceAskSettled(callId: string): void {
  // Only for asks that were announced: one stopped before it was ever shown has nothing to clear.
  if (!announced.delete(callId)) return;
  wsService.broadcastToChannel(ASK_EVENT_CHANNEL, {
    type: ASK_SETTLED,
    payload: { callId },
  });
}
