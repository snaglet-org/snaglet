/**
 * screenshot tool unit tests — capture-to-temp-then-ingest-bytes, the
 * inlineImageIds protocol, pathless output text, auto-placement into the
 * calling thread's project Images folder, the live tree-emit, and the
 * Playwright-unavailable text fallback. The Playwright CLI child process,
 * the filesystem, the threads table, the images table, and the realtime
 * tree surface are all mocked so no real browser, disk, DB, or socket I/O
 * happens.
 */

const execFileMock = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

type ExecFileCallback = (err: Error | null) => void;

// The login-shell PATH lookup, settled to a known PATH without running a shell.
const mockLoginPath = '/login-shell/bin:/usr/bin:/bin:/usr/sbin:/sbin';
jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  resolveLoginShellPath: () => Promise.resolve(),
  shellPath: () => mockLoginPath,
}));

const readFileMock = jest.fn();
const unlinkMock = jest.fn();
jest.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  unlink: (...args: unknown[]) => unlinkMock(...args),
}));

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

// Persistence/concurrency is covered by agentImagePlacement integration tests.
jest.mock('@server/services/ToolService/lib/resolveAgentImageContainer', () => ({
  resolveAgentImageContainer: async (threadId?: string, explicit?: string) => {
    const project = explicit ?? (threadId ? (await findThreadByIdMock(threadId))?.projectId : null);
    return `${project ?? 'root'}-images`;
  },
}));

import { tmpdir } from 'os';
import tool from '@server/services/ToolService/tools/web/screenshot/tool';
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

beforeEach(() => {
  jest.clearAllMocks();
  createImageMock.mockImplementation(async (row: Record<string, unknown>) => ({
    id: row.id,
    containerId: row.containerId ?? null,
    name: row.name,
    description: null,
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
  unlinkMock.mockResolvedValue(undefined);
  readFileMock.mockResolvedValue(Buffer.from(PNG_B64, 'base64'));
  // Default: the Playwright CLI "succeeds" (no error passed to the execFile callback).
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null);
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('screenshot tool', () => {
  it('returns inlineImageIds + pathless output text on a successful capture', async () => {
    const result = await run({ url: 'https://example.com' });

    expect(result.output).toMatch(/^captured, image id image-/);
    // Contract: no filesystem path anywhere in the output text.
    expect(result.output).not.toContain('/');
    expect(result.output).not.toContain(tmpdir());

    const raw = result.rawContent as { inlineImageIds?: string[]; note?: string };
    expect(raw.inlineImageIds).toHaveLength(1);
    expect(result.output).toContain(raw.inlineImageIds![0]);
  });

  it('mints the captured image tagged tool-capture, unplaced when there is no thread context', async () => {
    await run({ url: 'https://example.com' });

    expect(findThreadByIdMock).not.toHaveBeenCalled();
    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 'root-images',
        tags: ['tool-capture'],
        mimeType: 'image/png',
      })
    );
  });

  it("auto-places the captured image into the calling thread's project Images folder", async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-1', projectId: 'container-1' });

    await run({ url: 'https://example.com' }, { threadId: 'thread-1' });

    expect(findThreadByIdMock).toHaveBeenCalledWith('thread-1');
    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'container-1-images' })
    );
  });

  it('uses root Images (null) when the calling thread is flat (no project)', async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-2', projectId: null });

    await run({ url: 'https://example.com' }, { threadId: 'thread-2' });

    expect(createImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: 'root-images' })
    );
  });

  it('publishes the new image node through the realtime tree surface so the tree updates live', async () => {
    findThreadByIdMock.mockResolvedValue({ id: 'thread-1', projectId: 'container-1' });

    const result = await run({ url: 'https://example.com' }, { threadId: 'thread-1' });
    const imageId = (result.rawContent as { inlineImageIds: string[] }).inlineImageIds[0];

    expect(snapshotFromImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: imageId, containerId: 'container-1-images' })
    );
    expect(emitTreeNodeCreatedMock).toHaveBeenCalledTimes(1);
    expect(emitTreeNodeCreatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: imageId, kind: 'image' })
    );
  });

  it('never leaks a filesystem path through rawContent.note either', async () => {
    const result = await run({ url: 'https://example.com' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toMatch(/snaglet-screenshot-/);
  });

  it('always cleans up the temp file, even on success', async () => {
    await run({ url: 'https://example.com' });
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('passes the requested viewport size through to the Playwright CLI argv', async () => {
    await run({ url: 'https://example.com', width: 640, height: 480 });
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('npx');
    expect(args).toContain('--viewport-size=640,480');
  });

  it('runs npx with the login-shell PATH, not the inherited one', async () => {
    await run({ url: 'https://example.com' });
    const [, , opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(opts.env?.PATH).toBe(mockLoginPath);
  });

  it('hands a URL containing shell syntax to Playwright as one literal argv entry', async () => {
    // URL serialization leaves `$()`, `;` and `&` intact in the query string;
    // with no shell in between they must stay inert text.
    const url = 'https://example.com/?q=$(touch /tmp/snaglet-pwned)&x=`id`;echo';
    await run({ url });
    const [file, args, opts] = execFileMock.mock.calls[0] as [string, string[], object];
    expect(file).toBe('npx');
    expect(args).toContain(new URL(url).href);
    expect(args.filter((arg) => arg.includes('$('))).toHaveLength(1);
    expect(opts).not.toHaveProperty('shell');
  });

  it('falls back to default viewport sizes for non-numeric input', async () => {
    await run({ url: 'https://example.com', width: '1;rm -rf /', height: -5 });
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--viewport-size=1280,800');
  });

  it('rejects a missing url', async () => {
    await expect(run({})).rejects.toThrow(/url is required/);
    expect(createImageMock).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) url without ever shelling out', async () => {
    await expect(run({ url: 'file:///etc/passwd' })).rejects.toThrow(/not an http\(s\) URL/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects an unparseable url', async () => {
    await expect(run({ url: 'not a url' })).rejects.toThrow(/not a valid URL/);
  });

  it('falls back to a text summary when Playwright is unavailable, without minting an image', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(new Error('spawn npx ENOENT'));
      }
    );
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><title>Example</title><body>Hello world</body></html>',
    });

    const result = await run({ url: 'https://example.com' });

    expect(result.output).toContain('Could not capture screenshot');
    expect(result.output).toContain('Title: Example');
    expect(result.rawContent).toBeUndefined();
    expect(createImageMock).not.toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it('throws when both Playwright and the HTML fallback fail', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(new Error('spawn npx ENOENT'));
      }
    );
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '' });

    await expect(run({ url: 'https://example.com/missing' })).rejects.toThrow(/Failed to fetch/);
  });
});
