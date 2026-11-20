/**
 * resolveRunParams — the per-run substitution values for the Operating-context
 * block, with the DB seams mocked.
 *
 * Guarantees under test:
 *   - a flat thread still gets a `thread_path` ("workspace (no project)") and
 *     no project_* keys,
 *   - a thread in a nested project gets `project_name` from the nearest
 *     project and `parent_project_name` from the one it nests in, with
 *     `thread_path` as the root → leaf lineage,
 *   - a missing thread row leaves `thread_path` unset,
 *   - a lookup failure degrades to "no project info" instead of throwing.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import type { ThreadCoordinates } from '@server/services/ToolService/lib/threadCoordinates';

const findProjectAncestorChain = jest.fn<(threadId: string) => Promise<ProjectAncestor[]>>();
const loadThreadCoordinates = jest.fn<(threadId: string) => Promise<ThreadCoordinates>>();
const resolveAgentCwd = jest.fn<(threadId?: string) => Promise<string>>();
const cwdSource = { current: 'project' as 'thread' | 'project' | 'home' };
const warn = jest.fn();

jest.mock('@server/services/ToolService/lib/findProjectAncestor', () => ({
  findProjectAncestorChain: (threadId: string) => findProjectAncestorChain(threadId),
}));

jest.mock('@server/services/ToolService/lib/threadCoordinates', () => ({
  // Keep the real path formatter — the flat-thread label is what is under test.
  ...jest.requireActual<object>('@server/services/ToolService/lib/threadCoordinates'),
  loadThreadCoordinates: (threadId: string) => loadThreadCoordinates(threadId),
}));

jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  resolveAgentCwdWithSource: async (threadId?: string) => ({
    path: await resolveAgentCwd(threadId),
    source: cwdSource.current,
  }),
}));

jest.mock('@server/config/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => warn(...args),
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  },
}));

import { resolveRunParams } from '@server/services/SystemPromptComposer/resolveRunParams';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const PARENT_ID = 'container-1111111111111-aaaaaaaaa';
const SUB_ID = 'container-2222222222222-bbbbbbbbb';

function ancestor(
  over: Partial<ProjectAncestor> & Pick<ProjectAncestor, 'projectId' | 'projectName'>
) {
  return {
    projectDescription: null,
    folderPath: null,
    githubUrl: null,
    ...over,
  } satisfies ProjectAncestor;
}

function coords(over: Partial<ThreadCoordinates> = {}): ThreadCoordinates {
  return {
    threadFound: true,
    threadTitle: 'Rollout planning',
    dispatchMode: 'mentioned',
    isDm: false,
    projectId: null,
    breadcrumb: [],
    participants: [],
    ...over,
  };
}

describe('resolveRunParams', () => {
  beforeEach(() => {
    findProjectAncestorChain.mockReset();
    loadThreadCoordinates.mockReset();
    resolveAgentCwd.mockReset();
    warn.mockReset();
    resolveAgentCwd.mockResolvedValue('/host/path');
  });

  it('resolves only host_path without a thread', async () => {
    const params = await resolveRunParams({});
    expect(params).toEqual({ host_path: '/host/path', host_path_source: 'project' });
    expect(findProjectAncestorChain).not.toHaveBeenCalled();
    expect(loadThreadCoordinates).not.toHaveBeenCalled();
  });

  it('flat thread: thread_path is "workspace (no project)" and no project keys are set', async () => {
    findProjectAncestorChain.mockResolvedValue([]);
    loadThreadCoordinates.mockResolvedValue(coords({ breadcrumb: [] }));

    const params = await resolveRunParams({ threadId: THREAD_ID });

    expect(params.thread_path).toBe('workspace (no project)');
    expect(params.thread_title).toBe('Rollout planning');
    expect(params.thread_routing).toBe('mentioned');
    expect(params).not.toHaveProperty('project_name');
    expect(params).not.toHaveProperty('parent_project_name');
    expect(params).not.toHaveProperty('thread_participants');
  });

  it('nested project: project_name is the nearest project, parent_project_name the one it nests in', async () => {
    findProjectAncestorChain.mockResolvedValue([
      ancestor({
        projectId: SUB_ID,
        projectName: 'Sub Project',
        folderPath: '/repos/sub',
        githubUrl: 'git@example.com:org/sub.git',
      }),
      ancestor({ projectId: PARENT_ID, projectName: 'Parent Project' }),
    ]);
    loadThreadCoordinates.mockResolvedValue(
      coords({
        projectId: SUB_ID,
        breadcrumb: [
          { id: PARENT_ID, name: 'Parent Project' },
          { id: SUB_ID, name: 'Sub Project' },
        ],
        participants: [
          { id: 'agent-a', name: 'test-agent-a', role: 'reviewer' },
          { id: 'agent-b', name: 'test-agent-b', role: null },
        ],
      })
    );

    const params = await resolveRunParams({ threadId: THREAD_ID });

    expect(params).toMatchObject({
      host_path: '/host/path',
      host_path_source: 'project',
      project_name: 'Sub Project',
      parent_project_name: 'Parent Project',
      project_folder_path: '/repos/sub',
      project_gitrepo: 'git@example.com:org/sub.git',
      thread_path: 'Parent Project / Sub Project',
      thread_participants: 'test-agent-a (reviewer), test-agent-b',
    });
  });

  it('top-level project: no parent_project_name', async () => {
    findProjectAncestorChain.mockResolvedValue([
      ancestor({ projectId: PARENT_ID, projectName: 'Parent Project' }),
    ]);
    loadThreadCoordinates.mockResolvedValue(
      coords({ projectId: PARENT_ID, breadcrumb: [{ id: PARENT_ID, name: 'Parent Project' }] })
    );

    const params = await resolveRunParams({ threadId: THREAD_ID });

    expect(params.project_name).toBe('Parent Project');
    expect(params).not.toHaveProperty('parent_project_name');
    expect(params.thread_path).toBe('Parent Project');
  });

  it('missing thread row: no thread_path at all', async () => {
    findProjectAncestorChain.mockResolvedValue([]);
    loadThreadCoordinates.mockResolvedValue(
      coords({ threadFound: false, threadTitle: null, dispatchMode: null })
    );

    const params = await resolveRunParams({ threadId: THREAD_ID });

    expect(params).not.toHaveProperty('thread_path');
    expect(params).not.toHaveProperty('thread_title');
  });

  it('degrades to no project info when the lineage lookup fails', async () => {
    findProjectAncestorChain.mockRejectedValue(new Error('db down'));
    loadThreadCoordinates.mockResolvedValue(coords());

    const params = await resolveRunParams({ threadId: THREAD_ID });

    expect(params).not.toHaveProperty('project_name');
    expect(params.thread_path).toBe('workspace (no project)');
    expect(warn).toHaveBeenCalledWith(
      '[SystemPromptComposer] resolveRunParams failed',
      expect.objectContaining({ threadId: THREAD_ID, err: 'db down' })
    );
  });

  it('DM / home thread: no routing mode reaches the turn context', async () => {
    findProjectAncestorChain.mockResolvedValue([]);
    loadThreadCoordinates.mockResolvedValue(coords({ isDm: true, dispatchMode: 'mentioned' }));

    const params = await resolveRunParams({ threadId: THREAD_ID });

    expect(params).not.toHaveProperty('thread_routing');
    expect(params.thread_is_dm).toBe('true');
    expect(params.thread_title).toBe('Rollout planning');
  });
});
