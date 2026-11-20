import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const findProjectAncestor = jest.fn();
const findById = jest.fn();
const logger = { debug: jest.fn(), warn: jest.fn() };
const mkdir = jest.fn();

jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => findById(...args) },
}));
jest.mock('@server/services/ToolService/lib/findProjectAncestor', () => ({
  findProjectAncestor: (...args: unknown[]) => findProjectAncestor(...args),
}));
jest.mock('@server/config/logger', () => ({ logger }));
jest.mock('@server/services/snagletHome', () => ({ SNAGLET_HOME: '/tmp/test-snaglet-home' }));
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  mkdir: (...args: unknown[]) => mkdir(...args),
}));

import {
  describeAgentCwd,
  resolveAgentCwd,
} from '@server/services/ToolService/lib/resolveAgentCwd';

describe('resolveAgentCwd', () => {
  let root: string;
  let project: string;
  let worktree: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'resolve-agent-cwd-'));
    project = path.join(root, 'project');
    worktree = path.join(project, '.snaglet', 'worktrees', 'thread');
    mkdirSync(worktree, { recursive: true });
    project = realpathSync(project);
    worktree = realpathSync(worktree);
    findProjectAncestor.mockReset();
    findById.mockReset();
    logger.debug.mockReset();
    logger.warn.mockReset();
    mkdir.mockReset();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('nested helpers inherit the live parent override', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    const rows: Record<string, unknown> = {
      helper: { parentThreadId: 'child' },
      child: { parentThreadId: 'owner' },
      owner: { workingDirectory: worktree },
    };
    findById.mockImplementation(async (id: string) => rows[id]);
    await expect(resolveAgentCwd('helper')).resolves.toBe(worktree);
    expect(findById.mock.calls.map(([id]) => id)).toEqual(['helper', 'child', 'owner']);
  });
  test('inherited path is revalidated against helper project', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: path.join(root, 'other') });
    findById.mockImplementation(async (id: string) =>
      id === 'helper' ? { parentThreadId: 'owner' } : { workingDirectory: worktree }
    );
    await expect(resolveAgentCwd('helper')).resolves.toBe(path.join(root, 'other'));
    expect(logger.warn).toHaveBeenCalled();
  });
  test('stale inherited override logs and falls back', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockImplementation(async (id: string) =>
      id === 'helper'
        ? { parentThreadId: 'owner' }
        : { workingDirectory: path.join(worktree, 'missing') }
    );
    await expect(resolveAgentCwd('helper')).resolves.toBe(project);
    expect(logger.warn).toHaveBeenCalled();
  });
  test('cycles terminate without repeated reads', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockResolvedValue({ parentThreadId: 'helper' });
    await expect(resolveAgentCwd('helper')).resolves.toBe(project);
    expect(findById).toHaveBeenCalledTimes(1);
  });

  test('acyclic ancestry is capped at 32 reads', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockImplementation(async (id: string) => ({ parentThreadId: `${id}-parent` }));
    await expect(resolveAgentCwd('helper')).resolves.toBe(project);
    expect(findById).toHaveBeenCalledTimes(32);
  });

  test('override wins over the project folder', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockResolvedValue({ workingDirectory: worktree });

    await expect(resolveAgentCwd('thread-1')).resolves.toBe(worktree);
    expect(findById).toHaveBeenCalledWith('thread-1');
  });

  test('without an override, resolves to the project folder', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockResolvedValue({ workingDirectory: null });

    await expect(resolveAgentCwd('thread-1')).resolves.toBe(project);
  });

  test('without a project, falls back to SNAGLET_HOME', async () => {
    findProjectAncestor.mockResolvedValue(null);
    findById.mockResolvedValue({ workingDirectory: null });

    await expect(resolveAgentCwd('thread-1')).resolves.toBe('/tmp/test-snaglet-home');
    expect(mkdir).toHaveBeenCalledWith('/tmp/test-snaglet-home', { recursive: true });
  });

  test('invalid override logs and falls back to the project folder', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockResolvedValue({ workingDirectory: path.join(root, 'outside') });

    await expect(resolveAgentCwd('thread-1')).resolves.toBe(project);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid thread working directory'),
      expect.objectContaining({ threadId: 'thread-1' })
    );
  });

  test('stale or missing override falls back to the project folder', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockResolvedValue({
      workingDirectory: path.join(project, '.snaglet', 'worktrees', 'missing'),
    });

    await expect(resolveAgentCwd('thread-1')).resolves.toBe(project);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('database lookup errors fall back to the project folder', async () => {
    findProjectAncestor.mockResolvedValue({ folderPath: project });
    findById.mockRejectedValue(new Error('database unavailable'));

    await expect(resolveAgentCwd('thread-1')).resolves.toBe(project);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to read thread working directory'),
      expect.objectContaining({ threadId: 'thread-1' })
    );
  });

  describe('describeAgentCwd (what the settings screen shows)', () => {
    test('a saved, valid thread folder wins and says it is the thread’s', async () => {
      findProjectAncestor.mockResolvedValue({ folderPath: project });
      findById.mockResolvedValue({ workingDirectory: worktree });
      await expect(describeAgentCwd('thread')).resolves.toEqual({
        path: worktree,
        source: 'thread',
        projectFolder: project,
        override: worktree,
        overrideProblem: null,
      });
    });

    test('without a saved folder, a project with a linked folder is the default', async () => {
      findProjectAncestor.mockResolvedValue({ folderPath: project });
      findById.mockResolvedValue({ workingDirectory: null });
      await expect(describeAgentCwd('thread')).resolves.toMatchObject({
        path: project,
        source: 'project',
        projectFolder: project,
        override: null,
      });
    });

    test('a thread with no project folder falls to Snaglet home, creating nothing', async () => {
      findProjectAncestor.mockResolvedValue(null);
      findById.mockResolvedValue({ workingDirectory: null });
      await expect(describeAgentCwd('thread')).resolves.toMatchObject({
        path: '/tmp/test-snaglet-home',
        source: 'home',
        projectFolder: null,
      });
      expect(mkdir).not.toHaveBeenCalled();
      // Running an agent is what creates it.
      await expect(resolveAgentCwd('thread')).resolves.toBe('/tmp/test-snaglet-home');
      expect(mkdir).toHaveBeenCalledWith('/tmp/test-snaglet-home', { recursive: true });
    });

    test('a saved folder that no longer validates falls back and says why', async () => {
      findProjectAncestor.mockResolvedValue({ folderPath: project });
      const gone = path.join(worktree, 'missing');
      findById.mockResolvedValue({ workingDirectory: gone });
      const described = await describeAgentCwd('thread');
      expect(described).toMatchObject({ path: project, source: 'project', override: gone });
      expect(described.overrideProblem).toMatch(/does not exist/);
    });
  });
});
