/**
 * ExportService orchestrator — the decisions that are not about file format.
 *
 * Models are mocked here on purpose: what this file pins is provenance,
 * authorization, and whether the filesystem is touched at all. Snapshot
 * completeness of the memory read is proven for real against PostgreSQL in
 * tests/integration/apps/server/db/memoryListAllByAgent.test.ts — it cannot be
 * demonstrated against a stub.
 */

import path from 'path';
import os from 'os';
import { createHmac } from 'crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, realpath, writeFile } from 'fs/promises';
import { jest } from '@jest/globals';

const docs = { findById: jest.fn() };
const threads = { findById: jest.fn() };
const messages = {
  listByThreadId: jest.fn(),
  listRecentByThreadId: jest.fn(),
  countByThreadId: jest.fn(),
};
const memories = { listAllByAgent: jest.fn() };
const agents = { findById: jest.fn(), findByIds: jest.fn() };
const images = { findImageById: jest.fn() };
const summaries = { getHistoryByThread: jest.fn() };
const currentActor = jest.fn();
const exportContainer = jest.fn();

jest.mock('@snaglet/db/tables/docs', () => ({ Docs: docs }));
jest.mock('@snaglet/db/tables/threads', () => ({ Threads: threads }));
jest.mock('@snaglet/db/tables/messages', () => ({ Messages: messages }));
jest.mock('@snaglet/db/tables/memories', () => ({ Memories: memories }));
jest.mock('@snaglet/db/tables/agents', () => ({ Agents: agents }));
jest.mock('@snaglet/db/tables/thread_summaries', () => ({ ThreadSummaries: summaries }));
jest.mock('@snaglet/db/tables/images', () => ({ Images: images }));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => currentActor(),
}));
jest.mock('@server/services/ExportService/containerExport', () => ({
  exportContainer: (...args: unknown[]) => exportContainer(...args),
}));

import {
  buildExportPayload,
  currentProvenance,
  EXTERNAL_EXPORT_KINDS,
  mayOverwrite,
  runExport,
} from '@server/services/ExportService';
import { canonicalPayload, resetSpentNonces } from '@server/services/ExportService/overwriteGrant';

let root: string;
let dest: string;

const HUMAN = { actorId: 'member-1', actorKind: 'user', actorName: 'Test User' };
const AGENT = { actorId: 'agent-1', actorKind: 'agent', actorName: 'Clio' };
const EXTERNAL = { actorId: 'member-9', actorKind: 'external', actorName: 'Partner' };

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'snaglet-export-svc-')));
  dest = path.join(root, 'Desktop');
  await mkdir(dest);

  jest.clearAllMocks();
  currentActor.mockReturnValue(HUMAN);
  docs.findById.mockResolvedValue({
    id: 'doc-1',
    title: 'Release notes',
    content: 'Body.',
    containerId: 'container-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  messages.listByThreadId.mockResolvedValue([]);
  messages.listRecentByThreadId.mockResolvedValue([]);
  messages.countByThreadId.mockResolvedValue(0);
  summaries.getHistoryByThread.mockResolvedValue([]);
  agents.findByIds.mockResolvedValue([]);
  exportContainer.mockResolvedValue({
    directoryName: 'Planning',
    path: '/Users/test-user/Desktop/Planning',
    manifestPath: '/Users/test-user/Desktop/Planning/export-manifest.json',
    bytes: 100,
    report: {
      summary: { containers: 1, docs: 0, skipped: 0, failed: 0 },
    },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('provenance is derived, never supplied', () => {
  it('names the ambient human actor', () => {
    expect(currentProvenance('2026-08-03T00:00:00.000Z')).toMatchObject({
      exportedBy: 'Test User',
    });
  });

  it('names an agent actor', () => {
    currentActor.mockReturnValue(AGENT);
    expect(currentProvenance()).toMatchObject({ exportedBy: 'Clio' });
  });

  it('falls back to the actor id when there is no name', () => {
    currentActor.mockReturnValue({ actorId: 'member-3', actorKind: 'user' });
    expect(currentProvenance()).toMatchObject({ exportedBy: 'member-3' });
  });

  it('says "unknown" rather than guessing when there is no actor', () => {
    currentActor.mockReturnValue(undefined);
    expect(currentProvenance()).toMatchObject({ exportedBy: 'unknown' });
  });

  it('stamps the real actor into the file, not anything the caller asked for', async () => {
    currentActor.mockReturnValue(AGENT);
    const { data } = await buildExportPayload({ kind: 'doc', id: 'doc-1' });
    expect(data.toString('utf8')).toContain('exported_by: "Clio"');
  });
});

describe('overwrite needs both a human actor and a path-bound grant', () => {
  const KEY = 'a'.repeat(64);
  const TARGET = '/Users/test-user/Desktop/Notes.md';

  /** Mint the way the Rust shell does. */
  const grantFor = (target: string, nonce = 'deadbeef00000000000000000000dead') => {
    const expiry = Date.now() + 60_000;
    const mac = createHmac('sha256', KEY)
      .update(canonicalPayload(expiry, nonce, target), 'utf8')
      .digest('hex');
    return `${expiry}.${nonce}.${mac}`;
  };

  beforeEach(() => {
    resetSpentNonces();
    process.env.SNAGLET_EXPORT_GRANT_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.SNAGLET_EXPORT_GRANT_KEY;
  });

  it('is allowed for a human presenting a grant for that exact path', () => {
    expect(mayOverwrite({ overwriteGrant: grantFor(TARGET) }, TARGET)).toBe(true);
  });

  it('is refused for a human with no grant', () => {
    // Actor kind alone is not authority: any browser request carrying a
    // session could set a boolean.
    expect(mayOverwrite({}, TARGET)).toBe(false);
    expect(mayOverwrite(undefined, TARGET)).toBe(false);
  });

  it('is refused for a human whose grant names a different path', () => {
    expect(
      mayOverwrite({ overwriteGrant: grantFor('/Users/test-user/Desktop/Other.md') }, TARGET)
    ).toBe(false);
  });

  it('is refused for an agent even with a perfectly valid grant', () => {
    // Both conditions are required; a leaked grant does not promote a
    // non-human caller.
    currentActor.mockReturnValue(AGENT);
    expect(mayOverwrite({ overwriteGrant: grantFor(TARGET) }, TARGET)).toBe(false);
  });

  it('is refused for an external MCP client even with a valid grant', () => {
    currentActor.mockReturnValue(EXTERNAL);
    expect(mayOverwrite({ overwriteGrant: grantFor(TARGET) }, TARGET)).toBe(false);
  });

  it('an agent export does not clobber a human file of the same name', async () => {
    await writeFile(path.join(dest, 'Release notes.md'), 'the human version');
    currentActor.mockReturnValue(AGENT);

    const { result } = await runExport({
      kind: 'doc',
      id: 'doc-1',
      destDir: dest,
      options: { overwriteGrant: grantFor(path.join(dest, 'Release notes.md')) },
    });

    expect(result.fileName).toBe('Release notes (2).md');
    await expect(readFile(path.join(dest, 'Release notes.md'), 'utf8')).resolves.toBe(
      'the human version'
    );
  });

  it('a human without a grant also cannot clobber, end to end', async () => {
    await writeFile(path.join(dest, 'Release notes.md'), 'the original');

    const { result } = await runExport({ kind: 'doc', id: 'doc-1', destDir: dest });

    expect(result.fileName).toBe('Release notes (2).md');
    await expect(readFile(path.join(dest, 'Release notes.md'), 'utf8')).resolves.toBe(
      'the original'
    );
  });

  it('a human with a grant for the resolved target does clobber, end to end', async () => {
    await writeFile(path.join(dest, 'Release notes.md'), 'the original');

    const { result } = await runExport({
      kind: 'doc',
      id: 'doc-1',
      destDir: dest,
      options: { overwriteGrant: grantFor(path.join(dest, 'Release notes.md')) },
    });

    expect(result.fileName).toBe('Release notes.md');
    expect(result.overwritten).toBe(true);
    await expect(readFile(path.join(dest, 'Release notes.md'), 'utf8')).resolves.toContain(
      'snaglet_kind: "doc"'
    );
  });
});

describe('no destDir means no write', () => {
  it('returns bytes and touches the filesystem zero times', async () => {
    const before = await readdir(dest);

    const { result, payload } = await runExport({ kind: 'doc', id: 'doc-1' });

    expect(result.downloaded).toBe(true);
    expect(result.path).toBeUndefined();
    expect(payload.data.toString('utf8')).toContain('snaglet_kind: "doc"');
    expect(await readdir(dest)).toEqual(before);
  });

  it('ignores an overwrite grant on the download path', async () => {
    const { result } = await runExport({
      kind: 'doc',
      id: 'doc-1',
      options: { overwriteGrant: 'anything' },
    });
    expect(result.downloaded).toBe(true);
    expect(result.path).toBeUndefined();
  });
});

describe('recursive container export', () => {
  it('is intentionally absent from external MCP export kinds', () => {
    expect(EXTERNAL_EXPORT_KINDS).toEqual(['doc', 'thread', 'image']);
    expect(EXTERNAL_EXPORT_KINDS).not.toContain('container');
    // Agent memories stay out for the reason the tool layer documents.
    expect(EXTERNAL_EXPORT_KINDS).not.toContain('agent_memories');
  });

  it('requires a destination and delegates the whole subtree once', async () => {
    await expect(runExport({ kind: 'container', id: 'container-1' })).rejects.toThrow(
      /destination folder/i
    );
    expect(exportContainer).not.toHaveBeenCalled();

    const { result, payload } = await runExport({
      kind: 'container',
      id: 'container-1',
      destDir: dest,
    });

    expect(exportContainer).toHaveBeenCalledTimes(1);
    expect(exportContainer).toHaveBeenCalledWith(
      'container-1',
      dest,
      expect.objectContaining({ exportedBy: 'Test User' })
    );
    expect(payload).toBeUndefined();
    expect(result).toMatchObject({
      kind: 'container',
      fileName: 'Planning',
      path: '/Users/test-user/Desktop/Planning',
      downloaded: false,
      manifestPath: '/Users/test-user/Desktop/Planning/export-manifest.json',
    });
  });
});

describe('destination guard applies to the service, not just the helper', () => {
  it('refuses a destination that does not exist', async () => {
    await expect(
      runExport({ kind: 'doc', id: 'doc-1', destDir: path.join(root, 'nope') })
    ).rejects.toThrow(/does not exist/i);
  });

  it('refuses a relative destination', async () => {
    await expect(runExport({ kind: 'doc', id: 'doc-1', destDir: './rel' })).rejects.toThrow(
      /absolute/i
    );
  });
});

describe('agent memories are bound to a resolved identity', () => {
  beforeEach(() => {
    agents.findById.mockResolvedValue({ id: 'agent-1', name: 'Clio' });
    memories.listAllByAgent.mockResolvedValue([
      {
        id: 'memory-1',
        key: 'deploys',
        content: 'Deploys run from main.',
        sourceThreadId: 'thread-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('exports when the requested agent is the allowed one', async () => {
    const { data } = await buildExportPayload({
      kind: 'agent_memories',
      id: 'agent-1',
      allowedAgentId: 'agent-1',
    });
    expect(data.toString('utf8')).toContain('Deploys run from main.');
  });

  it('refuses another agent’s memories rather than narrowing to the allowed one', async () => {
    // Silently substituting the caller's own memories would be worse than
    // failing: the file would carry a name that does not match its contents.
    await expect(
      buildExportPayload({ kind: 'agent_memories', id: 'agent-2', allowedAgentId: 'agent-1' })
    ).rejects.toThrow(/may not export another agent/i);
    expect(memories.listAllByAgent).not.toHaveBeenCalled();
  });

  it('refuses when no identity was resolved at all', async () => {
    await expect(buildExportPayload({ kind: 'agent_memories', id: 'agent-1' })).rejects.toThrow(
      /resolved agent identity/i
    );
    expect(memories.listAllByAgent).not.toHaveBeenCalled();
  });

  it('refuses an explicitly null identity', async () => {
    await expect(
      buildExportPayload({ kind: 'agent_memories', id: 'agent-1', allowedAgentId: null })
    ).rejects.toThrow(/resolved agent identity/i);
  });

  it('reads through the snapshot-safe model method, never the paged admin view', async () => {
    await buildExportPayload({
      kind: 'agent_memories',
      id: 'agent-1',
      allowedAgentId: 'agent-1',
    });
    // listByAgent defaults to 50 rows; using it here would silently truncate.
    expect(memories.listAllByAgent).toHaveBeenCalledWith('agent-1');
  });
});

describe('thread window selection', () => {
  beforeEach(() => {
    threads.findById.mockResolvedValue({
      id: 'thread-1',
      title: 'Design review',
      projectId: 'container-project',
      dispatchMode: 'mentioned',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastMessageAt: '2026-01-02T00:00:00.000Z',
    });
    messages.countByThreadId.mockResolvedValue(4132);
  });

  it('reads all messages when no limit is given', async () => {
    await buildExportPayload({ kind: 'thread', id: 'thread-1' });
    expect(messages.listByThreadId).toHaveBeenCalledWith('thread-1');
    expect(messages.listRecentByThreadId).not.toHaveBeenCalled();
  });

  it('uses the recent-window query for a limit', async () => {
    await buildExportPayload({ kind: 'thread', id: 'thread-1', options: { messageLimit: 500 } });
    expect(messages.listRecentByThreadId).toHaveBeenCalledWith('thread-1', 500);
    expect(messages.listByThreadId).not.toHaveBeenCalled();
  });

  it('declares truncation honestly in the header', async () => {
    messages.listRecentByThreadId.mockResolvedValue([
      {
        id: 'm-1',
        role: 'user',
        agentId: null,
        content: 'hi',
        createdAt: '2026-01-02T00:00:00.000Z',
        messageType: 'message',
        runId: null,
      },
    ]);
    const { data } = await buildExportPayload({
      kind: 'thread',
      id: 'thread-1',
      options: { messageLimit: 1 },
    });
    const text = data.toString('utf8');
    expect(text).toContain('truncated: true');
    expect(text).toContain('messages_available: 4132');
    expect(text).toContain('message_count: 1');
    expect(text).toContain('message_selection: "last_1"');
  });

  it('names the file with the title and the id', async () => {
    const { fileName } = await buildExportPayload({ kind: 'thread', id: 'thread-1' });
    expect(fileName).toBe('Design review (thread-1).md');
  });

  it('records the project scope, not a folder, in the frontmatter', async () => {
    const { data } = await buildExportPayload({ kind: 'thread', id: 'thread-1' });
    const text = data.toString('utf8');
    expect(text).toMatch(/project_id: "?container-project"?/);
    expect(text).not.toContain('container_id');
  });
});

describe('image export', () => {
  it('copies stored bytes and takes its extension from the stored MIME type', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    images.findImageById.mockResolvedValue({
      id: 'image-1',
      name: 'shot',
      mimeType: 'image/png',
      data: bytes,
    });

    const { result } = await runExport({
      kind: 'image',
      id: 'image-1',
      destDir: dest,
      // The user typed a .txt name for a PNG.
      fileName: 'my shot.txt',
    });

    expect(result.fileName).toBe('my shot.png');
    await expect(readFile(result.path as string)).resolves.toEqual(bytes);
  });

  it('reports missing bytes rather than writing an empty file', async () => {
    images.findImageById.mockResolvedValue({
      id: 'gone',
      name: 'x',
      mimeType: 'image/png',
      data: Buffer.alloc(0),
    });
    await expect(runExport({ kind: 'image', id: 'gone', destDir: dest })).rejects.toThrow(
      /bytes are missing/i
    );
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('missing rows', () => {
  it('reports a missing doc', async () => {
    docs.findById.mockResolvedValue(null);
    await expect(buildExportPayload({ kind: 'doc', id: 'nope' })).rejects.toThrow(/Doc not found/);
  });

  it('reports a missing thread', async () => {
    threads.findById.mockResolvedValue(null);
    await expect(buildExportPayload({ kind: 'thread', id: 'nope' })).rejects.toThrow(
      /Thread not found/
    );
  });

  it('rejects an unsupported kind', async () => {
    await expect(buildExportPayload({ kind: 'file' as never, id: 'file-1' })).rejects.toThrow(
      /Unsupported export kind/
    );
  });
});

describe('caller-supplied filename', () => {
  it('keeps the stem and imposes the serializer’s extension', async () => {
    const { result } = await runExport({
      kind: 'doc',
      id: 'doc-1',
      destDir: dest,
      fileName: 'my notes.txt',
    });
    expect(result.fileName).toBe('my notes.md');
  });

  it('cannot escape the destination folder', async () => {
    const { result } = await runExport({
      kind: 'doc',
      id: 'doc-1',
      destDir: dest,
      fileName: '../../escape.md',
    });
    expect(path.dirname(result.path as string)).toBe(dest);
    expect(result.fileName).not.toContain('..');
  });
});
