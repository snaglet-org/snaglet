import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateThreadWorkingDirectory } from '@server/services/ToolService/lib/threadWorkingDirectory';

describe('validateThreadWorkingDirectory', () => {
  let root: string;
  let project: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'thread-cwd-'));
    project = path.join(root, 'project');
    await mkdir(path.join(project, '.snaglet', 'worktrees', 'one'), { recursive: true });
    await mkdir(path.join(project, 'other', 'worktrees', 'two'), { recursive: true });
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test('accepts a worktree below .snaglet/worktrees', async () => {
    const { realpath } = await import('node:fs/promises');
    const resolvedProject = await realpath(project);
    await expect(
      validateThreadWorkingDirectory(path.join(project, '.snaglet/worktrees/one'), project)
    ).resolves.toBe(path.join(resolvedProject, '.snaglet/worktrees/one'));
  });

  test('rejects a worktree outside .snaglet/worktrees', async () => {
    await expect(
      validateThreadWorkingDirectory(path.join(project, 'other/worktrees/two'), project)
    ).rejects.toThrow('below .snaglet/worktrees');
  });

  test.each([
    [undefined, 'non-empty'],
    ['', 'non-empty'],
    ['relative/path', 'absolute'],
    [null, 'non-empty'],
  ])('rejects invalid input %p', async (value, message) => {
    await expect(validateThreadWorkingDirectory(value, project)).rejects.toThrow(message);
  });

  test('rejects project root and worktree roots', async () => {
    await expect(validateThreadWorkingDirectory(project, project)).rejects.toThrow();
    await expect(
      validateThreadWorkingDirectory(path.join(project, '.snaglet', 'worktrees'), project)
    ).rejects.toThrow();
  });

  test('rejects missing paths and files', async () => {
    await expect(
      validateThreadWorkingDirectory(
        path.join(project, '.snaglet', 'worktrees', 'missing'),
        project
      )
    ).rejects.toThrow('does not exist');
    const file = path.join(project, '.snaglet', 'worktrees', 'file');
    await writeFile(file, 'x');
    await expect(validateThreadWorkingDirectory(file, project)).rejects.toThrow('directory');
  });

  test('rejects sibling directories and symlink escapes', async () => {
    const sibling = path.join(root, 'project-other');
    await mkdir(sibling);
    await expect(validateThreadWorkingDirectory(sibling, project)).rejects.toThrow();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    const escaped = path.join(project, '.snaglet', 'worktrees', 'escape');
    await symlink(outside, escaped);
    await expect(validateThreadWorkingDirectory(escaped, project)).rejects.toThrow();
  });

  test('rejects a symlinked worktree root that escapes the project', async () => {
    const outside = path.join(root, 'outside-root');
    await mkdir(path.join(outside, 'child'), { recursive: true });
    await rm(path.join(project, '.snaglet', 'worktrees'), { recursive: true });
    await symlink(path.join(outside), path.join(project, '.snaglet', 'worktrees'));
    await expect(
      validateThreadWorkingDirectory(path.join(outside, 'child'), project)
    ).rejects.toThrow();
  });
});
