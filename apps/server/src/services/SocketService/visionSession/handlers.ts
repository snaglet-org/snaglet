import type {
  VisionCaptureResponsePayload,
  VisionSessionErrorPayload,
  VisionSessionSource,
  VisionSessionStartPayload,
  VisionSessionThreadPayload,
} from '@snaglet/shared/types';
import { Threads } from '@snaglet/db/tables/threads';
import { wsService } from '@server/services/WebSocketService';
import { visionThreadService } from '@server/services/vision/VisionThreadService';
import { getErrorMessage } from '@snaglet/shared/utils';
import { browserVisionCaptureService } from '@server/services/vision/BrowserVisionCaptureService';
import { emitVisionModeChangedEvent } from '@server/services/SocketService/threadEvents';

const SOURCES = new Set<VisionSessionSource>(['screen', 'camera', 'both']);

function sendError(clientId: string, threadId: string, message: string): void {
  const payload: VisionSessionErrorPayload = { threadId, message };
  wsService.sendToClient(clientId, {
    type: 'vision:session:error',
    channel: threadId || undefined,
    payload,
  });
}

async function validateThread(
  payload: VisionSessionThreadPayload | null | undefined,
  meta: { clientId: string; channel?: string }
): Promise<string | null> {
  const threadId = payload?.threadId;
  if (!threadId) {
    sendError(meta.clientId, '', 'Vision mode requires a chat thread.');
    return null;
  }
  if (meta.channel && meta.channel !== threadId) {
    sendError(meta.clientId, threadId, 'Vision request channel does not match the chat thread.');
    return null;
  }
  const thread = await Threads.findById(threadId).catch(() => null);
  if (!thread) {
    sendError(meta.clientId, threadId, `Thread not found: ${threadId}`);
    return null;
  }
  return threadId;
}

export function registerVisionHandlers(): void {
  wsService.registerHandler<VisionSessionStartPayload>(
    'vision:session:start',
    async (payload, meta) => {
      const threadId = await validateThread(payload, meta);
      if (!threadId) return;
      if (!SOURCES.has(payload.source)) {
        sendError(meta.clientId, threadId, 'Vision source must be screen, camera, or both.');
        return;
      }
      // Narration is driven from the two toggle CALL SITES (here and the
      // vision_mode tool) rather than from inside VisionThreadService, so the
      // service stays free of a database dependency and a server shutdown
      // (stopAll) does not narrate a revocation nobody performed.
      const before = visionThreadService.status(threadId).source;
      try {
        const started = await visionThreadService.start(threadId, payload.source, meta.clientId);
        void emitVisionModeChangedEvent(threadId, before, started.source);
      } catch (error) {
        sendError(meta.clientId, threadId, getErrorMessage(error));
      }
    }
  );

  wsService.registerHandler<VisionSessionThreadPayload>(
    'vision:session:stop',
    async (payload, meta) => {
      const threadId = await validateThread(payload, meta);
      if (!threadId) return;
      const before = visionThreadService.status(threadId).source;
      try {
        const stopped = await visionThreadService.stop(threadId);
        void emitVisionModeChangedEvent(threadId, before, stopped.source);
      } catch (error) {
        sendError(meta.clientId, threadId, getErrorMessage(error));
      }
    }
  );

  wsService.registerHandler<VisionSessionThreadPayload>(
    'vision:session:status',
    async (payload, meta) => {
      const threadId = await validateThread(payload, meta);
      if (!threadId) return;
      wsService.sendToClient(meta.clientId, {
        type: 'vision:session:state',
        channel: threadId,
        payload: visionThreadService.sessionState(threadId),
      });
    }
  );

  wsService.registerHandler<VisionCaptureResponsePayload>(
    'vision:capture:response',
    (payload, meta) => browserVisionCaptureService.respond(meta.clientId, payload)
  );
}
