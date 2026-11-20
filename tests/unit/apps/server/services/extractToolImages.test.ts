/**
 * extractToolImages + postImageCaptureMessage, with the images/messages tables
 * and WebSocketService mocked. Covers MCP-shape and Anthropic-style nested
 * image blocks, the `[image saved: <id>]` placeholder, the image cap, malformed
 * input, placement into the thread's project Images folder (unplaced only for
 * a flat thread), and the base64 guarantee: `cleanedOutput` is always scrubbed
 * and `hadImageBlocks` reports detection whether or not anything persisted.
 */

const createImageMock = jest.fn();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: { createImage: (...args: unknown[]) => createImageMock(...args) },
}));

const messagesCreateMock = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { create: (...args: unknown[]) => messagesCreateMock(...args) },
}));

const broadcastMock = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => broadcastMock(...args) },
}));

// Drives the real resolveAgentImageContainer helper (which extractToolImages
// calls to place captures), so we exercise the actual placement resolution.
const findThreadByIdMock = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => findThreadByIdMock(...args) },
}));

// Persistence/concurrency is covered by agentImagePlacement integration tests.
jest.mock('@server/services/ToolService/lib/resolveAgentImageContainer', () => ({
  resolveAgentImageContainer: async (threadId?: string, explicit?: string) => {
    const project = explicit ?? (threadId ? (await findThreadByIdMock(threadId))?.projectId : null);
    return `${project ?? 'root'}-images`;
  },
}));

import {
  extractToolImages,
  postImageCaptureMessage,
} from '../../../../../apps/server/src/services/SocketService/handlers/chatPhases/extractToolImages';

const CTX = {
  threadId: 't1',
  agentId: 'a1',
  runId: 'r1',
  toolName: 'mcp__playwright__browser_take_screenshot',
};

// 1x1 transparent PNG
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeEach(() => {
  jest.clearAllMocks();
  createImageMock.mockResolvedValue(undefined);
  messagesCreateMock.mockResolvedValue(undefined);
  // Default: thread is flat -> captures fall back to
  // unplaced (containerId: 'root-images'). Placement tests override this per-case.
  findThreadByIdMock.mockResolvedValue(null);
});

describe('extractToolImages', () => {
  it('extracts MCP-shape image content blocks', async () => {
    const exec = {
      content: [
        { type: 'text', text: 'Screenshot saved' },
        { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
      ],
    };
    const result = await extractToolImages(exec, CTX);
    expect(result.hasImages).toBe(true);
    expect(result.hadImageBlocks).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(createImageMock).toHaveBeenCalledTimes(1);
    expect(result.cleanedOutput).toContain(`[image saved: ${result.images[0].id}]`);
    expect(result.cleanedOutput).not.toContain(TINY_PNG_B64);
  });

  it('extracts Anthropic-style nested source blocks', async () => {
    const exec = {
      content: [{ type: 'image', source: { data: TINY_PNG_B64, media_type: 'image/jpeg' } }],
    };
    const result = await extractToolImages(exec, CTX);
    expect(result.hasImages).toBe(true);
    expect(result.images[0].mediaType).toBe('image/jpeg');
    expect(result.cleanedOutput).not.toContain(TINY_PNG_B64);
  });

  it('returns hasImages=false and stringifies for non-image results', async () => {
    const exec = { content: [{ type: 'text', text: 'just text' }] };
    const result = await extractToolImages(exec, CTX);
    expect(result.hasImages).toBe(false);
    expect(result.hadImageBlocks).toBe(false);
    expect(result.images).toHaveLength(0);
    expect(createImageMock).not.toHaveBeenCalled();
    expect(result.cleanedOutput).toContain('just text');
  });

  it('caps at 3 images per tool call, notes dropped count, and still reports hadImageBlocks', async () => {
    const exec = {
      content: Array.from({ length: 5 }, () => ({
        type: 'image',
        data: TINY_PNG_B64,
        mimeType: 'image/png',
      })),
    };
    const result = await extractToolImages(exec, CTX);
    expect(result.images).toHaveLength(3);
    expect(createImageMock).toHaveBeenCalledTimes(3);
    expect(result.cleanedOutput).toContain('2 additional image(s) dropped');
    expect(result.hadImageBlocks).toBe(true);
    // The two dropped-over-cap blocks are still scrubbed, not merely omitted.
    expect(result.cleanedOutput).not.toContain(TINY_PNG_B64);
  });

  it('does not throw on malformed input', async () => {
    await expect(extractToolImages(null, CTX)).resolves.toMatchObject({
      hasImages: false,
      hadImageBlocks: false,
    });
    await expect(extractToolImages('a string', CTX)).resolves.toMatchObject({ hasImages: false });
    await expect(extractToolImages({ content: 'not-an-array' }, CTX)).resolves.toMatchObject({
      hasImages: false,
    });
  });

  it('unwraps a top-level { result: ... } envelope', async () => {
    const exec = {
      result: {
        content: [{ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' }],
      },
    };
    const result = await extractToolImages(exec, CTX);
    expect(result.hasImages).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  describe('project placement (resolveAgentImageContainer)', () => {
    it("auto-places captured images into the calling thread's project Images folder", async () => {
      findThreadByIdMock.mockResolvedValue({ id: 't1', projectId: 'container-xyz' });
      const exec = {
        content: [{ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' }],
      };
      await extractToolImages(exec, CTX);
      expect(findThreadByIdMock).toHaveBeenCalledWith('t1');
      expect(createImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ containerId: 'container-xyz-images', tags: ['tool-capture'] })
      );
    });

    it('resolves the thread project at most once even for multiple captured images', async () => {
      findThreadByIdMock.mockResolvedValue({ id: 't1', projectId: 'container-xyz' });
      const exec = {
        content: [
          { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
          { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
        ],
      };
      await extractToolImages(exec, CTX);
      expect(findThreadByIdMock).toHaveBeenCalledTimes(1);
      expect(createImageMock).toHaveBeenCalledTimes(2);
      expect(createImageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ containerId: 'container-xyz-images' })
      );
    });

    it('uses root Images when the thread is flat', async () => {
      findThreadByIdMock.mockResolvedValue({ id: 't1', projectId: null });
      const exec = {
        content: [{ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' }],
      };
      await extractToolImages(exec, CTX);
      expect(createImageMock).toHaveBeenCalledWith(
        expect.objectContaining({ containerId: 'root-images', tags: ['tool-capture'] })
      );
    });

    it('does not resolve a project for non-image tool results (no wasted lookup)', async () => {
      const exec = { content: [{ type: 'text', text: 'just text' }] };
      await extractToolImages(exec, CTX);
      expect(findThreadByIdMock).not.toHaveBeenCalled();
      expect(createImageMock).not.toHaveBeenCalled();
    });
  });

  describe('base64 guarantee', () => {
    it('scrubs image blocks even when nothing was persisted (Images.createImage threw)', async () => {
      createImageMock.mockRejectedValueOnce(new Error('db unavailable'));
      const exec = {
        content: [{ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' }],
      };
      const result = await extractToolImages(exec, CTX);
      expect(result.hasImages).toBe(false); // nothing was actually saved
      expect(result.hadImageBlocks).toBe(true); // but it was detected
      expect(result.cleanedOutput).not.toContain(TINY_PNG_B64);
      expect(result.cleanedOutput).toContain('[image dropped]');
    });

    it('scrubs an image block even under an unrecognized top-level shape (deep nesting)', async () => {
      // Does not match collectBlocks's expected { content: [...] } envelope,
      // so nothing is queued for persistence — but the base64 must still
      // never survive into cleanedOutput (the unconditional replacer scan).
      const exec = {
        someWrapper: {
          deeplyNested: [{ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' }],
        },
      };
      const result = await extractToolImages(exec, CTX);
      expect(result.hadImageBlocks).toBe(false); // not a shape we persist from
      expect(result.hasImages).toBe(false);
      expect(result.cleanedOutput).not.toContain(TINY_PNG_B64);
      expect(result.cleanedOutput).toContain('[image dropped]');
      expect(createImageMock).not.toHaveBeenCalled();
    });

    it('is a no-op passthrough for ordinary non-image results (no scrubbing)', async () => {
      const exec = { success: true, output: 'plain text result', durationMs: 12 };
      const result = await extractToolImages(exec, CTX);
      expect(result.cleanedOutput).toContain('plain text result');
      expect(result.hadImageBlocks).toBe(false);
    });
  });
});

describe('postImageCaptureMessage', () => {
  it('posts a 📸 chat message with an <image id/> marker per id and broadcasts thread:message', async () => {
    await postImageCaptureMessage({
      threadId: 't1',
      agentId: 'a1',
      runId: 'r1',
      toolName: 'view_image',
      imageIds: ['image-abc', 'image-def'],
    });

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const created = messagesCreateMock.mock.calls[0][0];
    expect(created.threadId).toBe('t1');
    expect(created.role).toBe('assistant');
    expect(created.agentId).toBe('a1');
    expect(created.runId).toBe('r1');
    expect(created.content).toContain('📸 Captured 2 image(s) from view_image');
    expect(created.content).toContain('<image id="image-abc"/>');
    expect(created.content).toContain('<image id="image-def"/>');

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [channel, message] = broadcastMock.mock.calls[0];
    expect(channel).toBe('t1');
    expect(message.type).toBe('thread:message');
    expect(message.payload.content).toBe(created.content);
  });

  it('no-ops for an empty id list', async () => {
    await postImageCaptureMessage({
      threadId: 't1',
      agentId: 'a1',
      runId: null,
      toolName: 'view_image',
      imageIds: [],
    });
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
