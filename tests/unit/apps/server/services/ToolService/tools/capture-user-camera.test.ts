const captureOnDemandMock = jest.fn();
jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: {
    captureOnDemand: (...args: unknown[]) => captureOnDemandMock(...args),
  },
}));
const findModelMock = jest.fn();
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: (...args: unknown[]) => findModelMock(...args) },
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { findById: jest.fn(async () => ({ userId: 'user-1', threadId: 'thread-1' })) },
}));

import tool from '@server/services/ToolService/tools/media/capture-user-camera/tool';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

const context: ToolHandlerContext = {
  threadId: 'thread-1',
  agentId: 'agent-1',
  triggerMessageId: 'message-1',
  runtime: {
    provider: 'openai',
    modelId: 'vision-model',
    credentialId: null,
    agentName: 'Vision Agent',
    apiKey: null,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  findModelMock.mockResolvedValue({ supportsVision: true });
  captureOnDemandMock.mockResolvedValue({
    frameId: 'frame-camera',
    sessionId: 'session-1',
    source: 'camera',
    capturedAt: '2026-07-19T12:00:00.000Z',
    mediaType: 'image/jpeg',
    byteLength: 3,
    base64: 'BAUG',
    reused: false,
  });
});

it('returns one temporary camera frame through the ephemeral image protocol', async () => {
  const result = await tool({}, {}, context);
  if (typeof result === 'string') throw new Error('expected rich result');

  expect(captureOnDemandMock).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'camera',
      turnId: 'message-1',
      ownerUserId: 'user-1',
    })
  );
  expect(result.rawContent).toEqual({
    ephemeralInlineImages: [{ id: 'frame-camera', mediaType: 'image/jpeg', data: 'BAUG' }],
  });
});
