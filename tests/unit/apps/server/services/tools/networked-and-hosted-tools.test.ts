import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

const runProcessMock = jest.fn();
const runExecFileMock = jest.fn();
const resolvePathOrDownloadMock = jest.fn();
const runSwiftScriptMock = jest.fn();
const requireOpenAISecretMock = jest.fn();
const resolveOpenAISecretMock = jest.fn();
const createImageMock = jest.fn();
const emitTreeNodeCreatedMock = jest.fn();
const snapshotFromImageMock = jest.fn();
const isToolSupportedOnPlatformMock = jest.fn();

jest.mock('@server/services/ToolService/handlers/_shared.js', () => ({
  requireString: (input: Record<string, unknown>, key: string) => {
    const value = input[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${key} is required`);
    }
    return value.trim();
  },
  runProcess: (...args: unknown[]) => runProcessMock(...args),
  runExecFile: (...args: unknown[]) => runExecFileMock(...args),
  resolvePathOrDownload: (...args: unknown[]) => resolvePathOrDownloadMock(...args),
  runSwiftScript: (...args: unknown[]) => runSwiftScriptMock(...args),
}));

jest.mock('@server/services/ToolService/handlers/_openai.js', () => ({
  requireOpenAISecret: (...args: unknown[]) => requireOpenAISecretMock(...args),
  resolveOpenAISecret: (...args: unknown[]) => resolveOpenAISecretMock(...args),
}));

jest.mock('@snaglet/db/tables/images', () => ({
  Images: {
    createImage: (...args: unknown[]) => createImageMock(...args),
  },
}));

// image-generate publishes the created node through the realtime tree
// surface (see media/image-generate/tool.ts) — stub it so this coverage
// stays focused on the tool's own behavior, not the realtime chokepoint.
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: (...args: unknown[]) => emitTreeNodeCreatedMock(...args),
  snapshotFromImage: (...args: unknown[]) => snapshotFromImageMock(...args),
}));

jest.mock('@server/services/ToolAvailabilityService', () => ({
  isToolSupportedOnPlatform: (...args: unknown[]) => isToolSupportedOnPlatformMock(...args),
}));

import imageGenerateTool from '@server/services/ToolService/tools/media/image-generate/tool';
import textToSpeechTool from '@server/services/ToolService/tools/media/text-to-speech/tool';
import ocrImageTool from '@server/services/ToolService/tools/media/ocr-image/tool';

function makeJsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    arrayBuffer: jest.fn(),
  };
}

describe('networked and hosted tool-local unit coverage', () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isToolSupportedOnPlatformMock.mockReturnValue(true);
  });

  it('image-generate saves the generated image and returns an inline marker', async () => {
    resolveOpenAISecretMock.mockResolvedValue('sk-test');
    createImageMock.mockResolvedValue({
      id: 'image-mock-id',
      containerId: null,
      name: 'generated-draw-a-robot.png',
      description: null,
      tags: ['tool-capture', 'generated'],
      mimeType: 'image/png',
      sizeBytes: 17,
      sortOrder: 1,
      createdAt: '2026-07-06T00:00:00Z',
      updatedAt: '2026-07-06T00:00:00Z',
    });
    (global.fetch as jest.Mock).mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            b64_json: Buffer.from('fake-image-bytes').toString('base64'),
            revised_prompt: 'prompt refined',
          },
        ],
      })
    );

    const result = (await imageGenerateTool({ prompt: 'draw a robot' }, {}, undefined)) as {
      output: string;
      rawContent?: { inlineImageIds?: string[] };
    };

    expect(result.output).toContain('Generated image saved as');
    expect(result.output).toContain('prompt refined');
    expect(result.rawContent?.inlineImageIds).toHaveLength(1);
    expect(createImageMock).toHaveBeenCalledTimes(1);
  });

  it('text-to-speech returns base64 audio when outputPath is omitted', async () => {
    requireOpenAISecretMock.mockResolvedValue('sk-test');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4]).buffer),
      text: jest.fn().mockResolvedValue(''),
    });

    const result = await textToSpeechTool(
      {
        text: 'hello world',
        format: 'mp3',
      },
      {},
      undefined
    );
    const parsed = JSON.parse(result) as { format: string; base64: string };

    expect(parsed.format).toBe('mp3');
    expect(parsed.base64).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
  });

  it('ocr-image returns recognized text from the Swift runner', async () => {
    const cleanup = jest.fn().mockResolvedValue(undefined);
    resolvePathOrDownloadMock.mockResolvedValue({
      path: '/tmp/mock-image.png',
      source: 'path',
      cleanup,
    });
    runSwiftScriptMock.mockResolvedValue({
      code: 0,
      stdout: 'recognized text\n',
      stderr: '',
      timedOut: false,
    });

    const result = await ocrImageTool(
      {
        source: '/tmp/mock-image.png',
        language: 'en',
      },
      {}
    );

    expect(result).toBe('recognized text');
    expect(cleanup).toHaveBeenCalled();
  });

  it('ocr-image rejects unsupported platforms before resolving or downloading the source', async () => {
    isToolSupportedOnPlatformMock.mockReturnValue(false);

    await expect(ocrImageTool({ source: 'https://example.test/image.png' }, {})).rejects.toThrow(
      'only available on macOS'
    );
    expect(resolvePathOrDownloadMock).not.toHaveBeenCalled();
    expect(runSwiftScriptMock).not.toHaveBeenCalled();
  });
});
