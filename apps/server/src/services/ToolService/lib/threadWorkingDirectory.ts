import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Validate an agent thread's working directory.
 *
 * Worktrees are deliberately restricted to a real worktree child below one of
 * the project's supported worktree roots.  All comparisons use real paths so
 * symlinks cannot escape the project or worktree root.
 */
export async function validateThreadWorkingDirectory(
  value: unknown,
  projectFolder: string | null
): Promise<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Thread working directory must be a non-empty absolute path');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('Thread working directory must be an absolute path');
  }
  if (!projectFolder || !path.isAbsolute(projectFolder)) {
    throw new Error('A project folder is required to validate the thread working directory');
  }

  let projectReal: string;
  try {
    projectReal = await realpath(projectFolder);
  } catch {
    throw new Error(`Project folder does not exist: ${projectFolder}`);
  }

  const protectedRoots = [
    path.join(homedir(), '.snaglet'),
    path.join(homedir(), '.snaglet-dev'),
    process.env.SNAGLET_HOME,
  ].filter((root): root is string => Boolean(root));

  let protectedReal: string[] = [];
  await Promise.all(
    protectedRoots.map(async (root) => {
      try {
        protectedReal.push(await realpath(root));
      } catch {
        // A non-existent protected root cannot contain a candidate.
      }
    })
  );

  const isWithin = (child: string, parent: string, includeParent = true): boolean => {
    const relative = path.relative(parent, child);
    return (
      (includeParent && relative === '') ||
      (relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  };

  let candidateReal: string;
  try {
    candidateReal = await realpath(value);
  } catch {
    throw new Error(`Thread working directory does not exist: ${value}`);
  }

  let candidateStats: Awaited<ReturnType<typeof stat>>;
  try {
    candidateStats = await stat(candidateReal);
  } catch {
    throw new Error(`Unable to inspect thread working directory: ${value}`);
  }
  if (!candidateStats.isDirectory()) {
    throw new Error(`Thread working directory must be a directory: ${value}`);
  }
  if (!isWithin(candidateReal, projectReal)) {
    throw new Error('Thread working directory must be inside the project folder');
  }
  if (protectedReal.some((root) => isWithin(candidateReal, root))) {
    throw new Error('Thread working directory may not be inside a protected Snaglet directory');
  }

  const outsideWorktrees = new Error(
    'Thread working directory must be an existing directory below .snaglet/worktrees'
  );
  let baseReal: string;
  try {
    baseReal = await realpath(path.join(projectReal, '.snaglet/worktrees'));
    const baseStats = await stat(baseReal);
    if (!baseStats.isDirectory() || !isWithin(baseReal, projectReal, false)) throw outsideWorktrees;
  } catch {
    throw outsideWorktrees;
  }

  // The root itself is not a worktree; at least one child component is required.
  if (isWithin(candidateReal, baseReal, false)) return candidateReal;
  throw outsideWorktrees;
}
