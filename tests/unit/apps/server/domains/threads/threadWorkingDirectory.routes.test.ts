import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const findById = jest.fn();
const setWorkingDirectory = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById, setWorkingDirectory },
}));

const findProjectAncestor = jest.fn();
jest.mock('@server/services/ToolService/lib/findProjectAncestor', () => ({
  findProjectAncestor: (...args: unknown[]) => findProjectAncestor(...args),
}));

const describeAgentCwd = jest.fn();
jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  describeAgentCwd: (...args: unknown[]) => describeAgentCwd(...args),
}));

const validateThreadWorkingDirectory = jest.fn();
jest.mock('@server/services/ToolService/lib/threadWorkingDirectory', () => ({
  validateThreadWorkingDirectory: (...args: unknown[]) => validateThreadWorkingDirectory(...args),
}));

import { errorHandler } from '@server/middleware';
import { getPanelToken, mintChildDispatchToken } from '@server/middleware/panelAuth';
import { registerThreadWorkingDirectoryRoutes } from '@server/domains/threads/handlers/threadWorkingDirectory';

const thread = { id: 'thread-1' };
const project = { folderPath: '/project' };

function app() {
  const application = express();
  application.use(express.json());
  const router = express.Router();
  registerThreadWorkingDirectoryRoutes(router);
  application.use('/api/threads', router);
  application.use(errorHandler);
  return application;
}

beforeEach(() => {
  jest.clearAllMocks();
  findById.mockResolvedValue(thread);
  findProjectAncestor.mockResolvedValue(project);
  validateThreadWorkingDirectory.mockResolvedValue('/project/.snaglet/worktrees/one');
  setWorkingDirectory.mockResolvedValue({
    ...thread,
    workingDirectory: '/project/.snaglet/worktrees/one',
  });
});

describe('PUT /api/threads/:id/working-directory', () => {
  test('requires the real panel credential, ignoring actor attribution headers', async () => {
    const response = await request(app())
      .put('/api/threads/thread-1/working-directory')
      .set('X-Snaglet-Agent-Id', 'attacker-agent')
      .send({ working_directory: '/project/.snaglet/worktrees/one' });

    expect(response.status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
    expect(setWorkingDirectory).not.toHaveBeenCalled();
  });

  test('rejects a child-dispatch credential even when it is valid', async () => {
    const response = await request(app())
      .put('/api/threads/thread-1/working-directory')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ working_directory: '/project/.snaglet/worktrees/one' });

    expect(response.status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
  });

  test('validates and writes the normalized directory with panel auth', async () => {
    const response = await request(app())
      .put('/api/threads/thread-1/working-directory')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ working_directory: '/project/link-to-worktree' });

    expect(response.status).toBe(200);
    expect(validateThreadWorkingDirectory).toHaveBeenCalledWith(
      '/project/link-to-worktree',
      '/project'
    );
    expect(setWorkingDirectory).toHaveBeenCalledWith('thread-1', '/project/.snaglet/worktrees/one');
    expect(response.body.data).toEqual({
      id: 'thread-1',
      working_directory: '/project/.snaglet/worktrees/one',
    });
  });

  test('clears the directory on an explicit null without validation or project lookup', async () => {
    setWorkingDirectory.mockResolvedValue({ ...thread, workingDirectory: null });
    const response = await request(app())
      .put('/api/threads/thread-1/working-directory')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ working_directory: null });

    expect(response.status).toBe(200);
    expect(findProjectAncestor).not.toHaveBeenCalled();
    expect(validateThreadWorkingDirectory).not.toHaveBeenCalled();
    expect(setWorkingDirectory).toHaveBeenCalledWith('thread-1', null);
    expect(response.body.data).toEqual({ id: 'thread-1', working_directory: null });
  });

  test.each([
    ['missing', {}],
    ['empty', { working_directory: '' }],
    ['non-string', { working_directory: 42 }],
  ])('returns 400 and does not write for %s values', async (_name, body) => {
    validateThreadWorkingDirectory.mockRejectedValue(new Error('invalid working directory'));
    const response = await request(app())
      .put('/api/threads/thread-1/working-directory')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send(body);

    expect(response.status).toBe(400);
    if (_name === 'missing') {
      expect(JSON.stringify(response.body)).toContain(
        'working_directory is required (null clears)'
      );
      expect(validateThreadWorkingDirectory).not.toHaveBeenCalled();
    }
    expect(setWorkingDirectory).not.toHaveBeenCalled();
  });

  test('returns 400 when validation rejects and does not write', async () => {
    validateThreadWorkingDirectory.mockRejectedValue(new Error('outside project'));
    const response = await request(app())
      .put('/api/threads/thread-1/working-directory')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ working_directory: '/tmp' });

    expect(response.status).toBe(400);
    expect(setWorkingDirectory).not.toHaveBeenCalled();
  });

  test('returns 404 for a missing thread without looking up project or writing', async () => {
    findById.mockResolvedValue(null);
    const response = await request(app())
      .put('/api/threads/missing/working-directory')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ working_directory: '/project/.snaglet/worktrees/one' });

    expect(response.status).toBe(404);
    expect(findProjectAncestor).not.toHaveBeenCalled();
    expect(setWorkingDirectory).not.toHaveBeenCalled();
  });
});

describe('GET /api/threads/:id/working-directory', () => {
  test('reports the saved folder, the one agents start in and where it came from', async () => {
    findById.mockResolvedValue({ id: 'thread-1', workingDirectory: null });
    describeAgentCwd.mockResolvedValue({
      path: '/project',
      source: 'project',
      projectFolder: '/project',
      override: null,
      overrideProblem: null,
    });
    const response = await request(app()).get('/api/threads/thread-1/working-directory');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: 'thread-1',
      working_directory: null,
      effective: '/project',
      source: 'project',
      project_folder: '/project',
      inherited_override: null,
      override_problem: null,
    });
    expect(describeAgentCwd).toHaveBeenCalledWith('thread-1');
  });

  test('says a parent thread’s folder is inherited, and flags one that went stale', async () => {
    findById.mockResolvedValue({ id: 'thread-1', workingDirectory: null });
    describeAgentCwd.mockResolvedValue({
      path: '/project',
      source: 'project',
      projectFolder: '/project',
      override: '/project/.snaglet/worktrees/gone',
      overrideProblem: 'Thread working directory does not exist: /project/.snaglet/worktrees/gone',
    });
    const response = await request(app()).get('/api/threads/thread-1/working-directory');

    expect(response.body.data).toMatchObject({
      working_directory: null,
      inherited_override: '/project/.snaglet/worktrees/gone',
      override_problem: expect.stringContaining('does not exist'),
    });
  });

  test('needs no panel credential to read, and returns 404 for a missing thread', async () => {
    findById.mockResolvedValue(null);
    const response = await request(app()).get('/api/threads/missing/working-directory');

    expect(response.status).toBe(404);
    expect(describeAgentCwd).not.toHaveBeenCalled();
  });
});
