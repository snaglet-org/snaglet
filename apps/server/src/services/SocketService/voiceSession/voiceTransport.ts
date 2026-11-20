/**
 * voiceSession/voiceTransport — the S→C frame plumbing shared by every voice
 * seam, so the buffering / open-mic / dispatch helpers can emit without a reference to the service instance; the
 * service keeps thin private wrappers that delegate here (single source of truth).
 */

import { wsService } from '@server/services/WebSocketService';

/**
 * S→C voice frames ride the thread channel (channel === threadId) so the
 * client filters them exactly like chat events.
 */
export function toThread(threadId: string, type: string, payload: unknown): void {
  wsService.broadcastToChannel(threadId, { type, payload });
}

/** Direct-to-client — only for errors raised before a thread is bound. */
export function toClient(clientId: string, type: string, payload: unknown): void {
  wsService.sendToClient(clientId, { type, payload });
}

/** `requestId` tags an error that answers a voice:session:start (handshake failure). */
export function voiceError(
  threadId: string,
  message: string,
  speakable: boolean,
  requestId?: string
): void {
  toThread(threadId, 'voice:error', { message, speakable, ...(requestId ? { requestId } : {}) });
}
