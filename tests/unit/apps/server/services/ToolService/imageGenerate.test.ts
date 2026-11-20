/**
 * image_generate unit tests — provider auto-pick order, gpt-image-1 →
 * DALL-E 3 fallback, Gemini payload parsing, workspace persistence with
 * TTL tags, and the inlineImageIds protocol. Network + DB mocked.
 */

const mockGetSecret = jest.fn();
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecret: (...args: unknown[]) => mockGetSecret(...args) },
}));

const mockResolveOpenAISecret = jest.fn();
jest.mock('@server/services/ToolService/handlers/_openai', () => ({
  resolveOpenAISecret: (...args: unknown[]) => mockResolveOpenAISecret(...args),
}));

const mockCreateImage = jest.fn();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: { createImage: (...args: unknown[]) => mockCreateImage(...args) },
}));

const mockFindThread = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => mockFindThread(...args) },
}));

// Persistence/concurrency is covered by agentImagePlacement integration tests.
jest.mock('@server/services/ToolService/lib/resolveAgentImageContainer', () => ({
  resolveAgentImageContainer: async (threadId?: string, explicit?: string) => {
    const project = explicit ?? (threadId ? (await mockFindThread(threadId))?.projectId : null);
    return `${project ?? 'root'}-images`;
  },
}));

import tool, { mapSize } from '@server/services/ToolService/tools/media/image-generate/tool';
import type { ToolHandlerContext, ToolHandlerRichResult } from '@server/services/ToolService/types';

// 1x1 transparent PNG — real bytes so mime sniffing works.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const fail = (status: number, body = 'denied') => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => body,
});

async function run(
  input: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<ToolHandlerRichResult> {
  const result = await tool(input, {} as never, context);
  if (typeof result === 'string') throw new Error('expected rich result');
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateImage.mockResolvedValue({});
  mockFindThread.mockResolvedValue({ id: 'thread-1', projectId: 'container-thread' });
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.TOGETHER_API_KEY;
});

describe('mapSize', () => {
  test('maps legacy DALL-E sizes onto each backend', () => {
    expect(mapSize('1792x1024', 'gpt-image-1')).toEqual({ size: '1536x1024' });
    expect(mapSize('256x256', 'gpt-image-1')).toEqual({ size: '1024x1024' });
    expect(mapSize('1792x1024', 'dall-e-3')).toEqual({ size: '1792x1024' });
    expect(mapSize('512x512', 'dall-e-3')).toEqual({ size: '1024x1024' });
    expect(mapSize('1024x1792', 'flux')).toEqual({ width: 1024, height: 1792 });
    expect(mapSize('512x512', 'flux')).toEqual({ width: 512, height: 512 });
  });
});

describe('provider resolution', () => {
  test('auto picks openai first when configured', async () => {
    mockResolveOpenAISecret.mockResolvedValue('sk-openai');
    fetchMock.mockResolvedValue(ok({ data: [{ b64_json: PNG_B64 }] }));

    const result = await run({ prompt: 'a heron' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.anything()
    );
    expect(result.output).toContain('openai/gpt-image-1');
  });

  test('auto falls through to gemini when openai has no credential', async () => {
    mockResolveOpenAISecret.mockResolvedValue(null);
    mockGetSecret.mockImplementation(async (id: string) => (id === 'gemini' ? 'gm-key' : null));
    fetchMock.mockResolvedValue(
      ok({ candidates: [{ content: { parts: [{ inlineData: { data: PNG_B64 } }] } }] })
    );

    const result = await run({ prompt: 'a heron' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
    expect(result.output).toContain('gemini/gemini-2.5-flash-image');
  });

  test('no credentials anywhere yields an actionable error', async () => {
    mockResolveOpenAISecret.mockResolvedValue(null);
    mockGetSecret.mockResolvedValue(null);
    await expect(run({ prompt: 'a heron' })).rejects.toThrow(/no image-capable provider/);
  });

  test('explicit provider without a credential fails rather than silently switching', async () => {
    mockGetSecret.mockResolvedValue(null);
    await expect(run({ prompt: 'x', provider: 'together' })).rejects.toThrow(
      /no credential configured for provider "together"/
    );
  });
});

describe('openai fallback', () => {
  test('falls back to dall-e-3 when gpt-image-1 is access-denied', async () => {
    mockResolveOpenAISecret.mockResolvedValue('sk-openai');
    fetchMock
      .mockResolvedValueOnce(fail(403, 'org not verified'))
      .mockResolvedValueOnce(ok({ data: [{ b64_json: PNG_B64, revised_prompt: 'revised' }] }));

    const result = await run({ prompt: 'a heron' });
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(secondBody.model).toBe('dall-e-3');
    expect(secondBody.response_format).toBe('b64_json');
    expect(result.output).toContain('openai/dall-e-3');
    expect(result.output).toContain('revised');
  });

  test('server errors (5xx) do not trigger the fallback', async () => {
    mockResolveOpenAISecret.mockResolvedValue('sk-openai');
    fetchMock.mockResolvedValue(fail(500, 'boom'));
    await expect(run({ prompt: 'a heron' })).rejects.toThrow(/gpt-image-1 failed \(500\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('persistence + inline protocol', () => {
  test('saves with TTL tags and returns inlineImageIds', async () => {
    mockResolveOpenAISecret.mockResolvedValue('sk-openai');
    fetchMock.mockResolvedValue(ok({ data: [{ b64_json: PNG_B64 }] }));

    const result = await run({ prompt: 'a heron at dawn!!' });
    expect(mockCreateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['tool-capture', 'generated'],
        containerId: 'root-images',
        mimeType: 'image/png',
      })
    );
    const raw = result.rawContent as { inlineImageIds?: string[] };
    expect(raw.inlineImageIds).toHaveLength(1);
    expect(result.output).toContain(`<image id="${raw.inlineImageIds![0]}"/>`);
    expect(result.output).toContain('kept permanently');
  });

  test('container_id files the image and reports it as kept', async () => {
    mockResolveOpenAISecret.mockResolvedValue('sk-openai');
    fetchMock.mockResolvedValue(ok({ data: [{ b64_json: PNG_B64 }] }));

    const result = await run({ prompt: 'a heron', container_id: 'container-keep' });
    expect(mockCreateImage).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-keep-images' })
    );
    expect(result.output).toContain('kept permanently');
  });

  test("defaults generated images to the active thread's project Images container", async () => {
    mockResolveOpenAISecret.mockResolvedValue('sk-openai');
    fetchMock.mockResolvedValue(ok({ data: [{ b64_json: PNG_B64 }] }));

    const result = await run({ prompt: 'a heron' }, { threadId: 'thread-1' });
    expect(mockFindThread).toHaveBeenCalledWith('thread-1');
    expect(mockCreateImage).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-thread-images' })
    );
    expect(result.output).toContain('Filed in the Images container `container-thread-images`');
  });
});
