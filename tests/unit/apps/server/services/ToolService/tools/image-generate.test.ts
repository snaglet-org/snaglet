/**
 * image_generate tool unit tests — placement resolution (explicit
 * `container_id` wins, else auto-place into the calling thread's project
 * container via `resolveAgentImageContainer`, else unplaced) and the live
 * tree-emit through `surfaces/tree.ts`. Companion to screenshot.test.ts —
 * both tools share the same placement + realtime-emit contract. The provider network call, the threads
 * table, the images table, and the realtime tree surface are all mocked so
 * no real network, DB, or socket I/O happens.
 */

const createImageMock = jest.fn();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: { createImage: (...args: unknown[]) => createImageMock(...args) },
}));

const findThreadByIdMock = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => findThreadByIdMock(...args) },
}));

const emitTreeNodeCreatedMock = jest.fn();
const snapshotFromImageMock = jest.fn();
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: (...args: unknown[]) => emitTreeNodeCreatedMock(...args),
  snapshotFromImage: (...args: unknown[]) => snapshotFromImageMock(...args),
}));

const getSecretMock = jest.fn();
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecret: (...args: unknown[]) => getSecretMock(...args) },
}));

// Persistence/concurrency is covered by agentImagePlacement integration tests.
jest.mock('@server/services/ToolService/lib/resolveAgentImageContainer', () => ({
  resolveAgentImageContainer: async (threadId?: string, explicit?: string) => {
    const project = explicit ?? (threadId ? (await findThreadByIdMock(threadId))?.projectId : null);
    return `${project ?? 'root'}-images`;
  },
}));

import tool from '@server/services/ToolService/tools/media/image-generate/tool';
import type { ToolHandlerContext, ToolHandlerRichResult } from '@server/services/ToolService/types';

// 1x1 transparent PNG — real bytes so magic-byte mime sniffing succeeds.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function run(
  input: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<ToolHandlerRichResult> {
  const result = await tool(input, {}, context);
  if (typeof result === 'string') throw new Error('expected rich result, got a plain string');
  return result;
}

const fetchMock = jest.fn();
const originalFetch = global.fetch;
const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Deterministic provider auto-pick regardless of the host env: clear every
  // env-var fallback so only the mocked `together` credential resolves.
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.TOGETHER_API_KEY;
  // Force the `together` provider path (simplest network shape) by only
  // configuring a `together` credential — openai/gemini resolveSecret calls
  // return null so provider auto-pick falls through to together.
  getSecretMock.mockImplementation(async (provider: string) =>
    provider === 'together' ? 'fake-together-secret' : null
  );
  createImageMock.mockImplementation(async (row: Record<string, unknown>) => ({
    id: row.id,
    containerId: row.containerId ?? null,
    name: row.name,
    description: row.description ?? null,
    tags: row.tags ?? [],
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sortOrder: 1,
    createdAt: '2026-07-06T00:00:00Z',
    updatedAt: '2026-07-06T00:00:00Z',
  }));
  findThreadByIdMock.mockResolvedValue(null);
  snapshotFromImageMock.mockImplementation((image: Record<string, unknown>) => ({
    id: image.id,
    kind: 'image',
  }));
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('image_generate tool — placement + realtime emit', () => {
  it("auto-places into the calling thread's project Images folder when no container_id is given", async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-1', projectId: 'container-1' });

    await run({ prompt: 'a watercolor heron' }, { threadId: 'thread-1' });

    expect(findThreadByIdMock).toHaveBeenCalledWith('thread-1');
    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-1-images' })
    );
  });

  it('an explicit container_id wins over thread auto-placement', async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-1', projectId: 'container-1' });

    await run(
      { prompt: 'a watercolor heron', container_id: 'container-explicit' },
      { threadId: 'thread-1' }
    );

    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-explicit-images' })
    );
  });

  it('uses root Images (null) when the thread is flat (no project)', async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-2', projectId: null });

    await run({ prompt: 'a watercolor heron' }, { threadId: 'thread-2' });

    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'root-images' })
    );
  });

  it('uses root Images (null) when there is no thread context at all', async () => {
    await run({ prompt: 'a watercolor heron' });

    expect(findThreadByIdMock).not.toHaveBeenCalled();
    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'root-images' })
    );
  });

  it('publishes the new image node through the realtime tree surface so the tree updates live', async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-1', projectId: 'container-1' });

    const result = await run({ prompt: 'a watercolor heron' }, { threadId: 'thread-1' });
    const imageId = (result.rawContent as { inlineImageIds: string[] }).inlineImageIds[0];

    expect(snapshotFromImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: imageId, containerId: 'container-1-images' })
    );
    expect(emitTreeNodeCreatedMock).toHaveBeenCalledTimes(1);
    expect(emitTreeNodeCreatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: imageId, kind: 'image' })
    );
  });
});
