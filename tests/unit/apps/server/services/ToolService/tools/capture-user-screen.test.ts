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

import tool from '@server/services/ToolService/tools/media/capture-user-screen/tool';
import type { ToolHandlerContext, ToolHandlerRichResult } from '@server/services/ToolService/types';

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
    frameId: 'frame-screen',
    sessionId: 'session-1',
    source: 'screen',
    capturedAt: '2026-07-19T12:00:00.000Z',
    mediaType: 'image/jpeg',
    byteLength: 3,
    base64: 'AQID',
    reused: false,
  });
});

async function run(input: Record<string, unknown>, ctx = context): Promise<ToolHandlerRichResult> {
  const result = await tool(input, {}, ctx);
  if (typeof result === 'string') throw new Error('expected rich result');
  return result;
}

describe('capture_user_screen tool', () => {
  it('requests one on-demand frame and returns current-turn pixels without a workspace image id', async () => {
    const result = await run({});

    expect(captureOnDemandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        agentId: 'agent-1',
        turnId: 'message-1',
        source: 'screen',
        ownerUserId: 'user-1',
      })
    );
    expect(JSON.parse(result.output)).toMatchObject({
      temporary_frame_id: 'frame-screen',
      retention: 'temporary_until_turn_end',
    });
    expect(result.rawContent).toEqual({
      ephemeralInlineImages: [{ id: 'frame-screen', mediaType: 'image/jpeg', data: 'AQID' }],
    });
    expect(JSON.stringify(result)).not.toContain('inlineImageIds');
  });

  it('requires an active chat turn and a vision-capable model', async () => {
    await expect(run({}, {})).rejects.toThrow(/active agent turn/);
    findModelMock.mockResolvedValueOnce({ supportsVision: false });
    await expect(run({})).rejects.toThrow(/cannot inspect images/);
  });
});
