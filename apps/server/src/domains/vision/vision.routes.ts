import { Router } from 'express';
import { getCurrentActor } from '@server/realtime/actorContext';
import { visionThreadService } from '@server/services/vision/VisionThreadService';

export const visionRoutes = Router();

const OPAQUE_ID = /^[A-Za-z0-9_-]+$/;

visionRoutes.get('/frames/:threadId/:sessionId/:frameId', (req, res) => {
  const actor = getCurrentActor();
  if (actor?.actorKind !== 'user') {
    res.status(401).setHeader('Cache-Control', 'no-store').end();
    return;
  }
  const { threadId, sessionId, frameId } = req.params;
  if (
    !threadId ||
    !sessionId ||
    !frameId ||
    !OPAQUE_ID.test(sessionId) ||
    !OPAQUE_ID.test(frameId)
  ) {
    res.status(404).setHeader('Cache-Control', 'no-store').end();
    return;
  }
  const result = visionThreadService.getFrameForDelivery({
    threadId,
    sessionId,
    frameId,
    userId: actor.actorId,
  });
  res.setHeader('Cache-Control', 'no-store');
  if (result.status !== 'ok') {
    res.status(result.status === 'expired' ? 410 : 404).end();
    return;
  }
  res.setHeader('Content-Type', result.frame.mimeType);
  res.setHeader('Content-Length', String(result.data.byteLength));
  res.send(result.data);
});
