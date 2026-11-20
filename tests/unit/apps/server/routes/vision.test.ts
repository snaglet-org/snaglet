import express from 'express';
import request from 'supertest';
import { runWithActor } from '@server/realtime/actorContext';
import { visionRoutes } from '@server/domains/vision/vision.routes';
import { visionThreadService } from '@server/services/vision/VisionThreadService';

jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: { getFrameForDelivery: jest.fn() },
}));

const getFrame = visionThreadService.getFrameForDelivery as jest.Mock;
const app = express();
app.use((req, _res, next) =>
  runWithActor({ actorKind: 'user', actorId: 'user-1', actorName: 'User' }, next)
);
app.use('/api/vision', visionRoutes);

beforeEach(() => getFrame.mockReset());

describe('vision frame delivery', () => {
  it('delivers the captured bytes with no-store for the owning user', async () => {
    const bytes = Buffer.from('ffd8ffe0010203', 'hex');
    getFrame.mockReturnValue({
      status: 'ok',
      frame: { mimeType: 'image/jpeg' },
      data: bytes,
    });
    const response = await request(app).get('/api/vision/frames/thread-1/session-1/frame-1');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(bytes);
    expect(getFrame).toHaveBeenCalledWith({
      threadId: 'thread-1',
      sessionId: 'session-1',
      frameId: 'frame-1',
      userId: 'user-1',
    });
  });

  it.each([
    ['missing', 404],
    ['expired', 410],
  ] as const)('returns %s frames as %s without cache', async (status, expected) => {
    getFrame.mockReturnValue({ status });
    const response = await request(app).get('/api/vision/frames/thread-1/session-1/frame-1');
    expect(response.status).toBe(expected);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('blocks traversal-shaped identifiers', async () => {
    const response = await request(app).get('/api/vision/frames/thread-1/session%2F..%2Fx/frame-1');
    expect(response.status).toBe(404);
    expect(getFrame).not.toHaveBeenCalled();
  });
});
