import path from 'path';
import { asStringArray, asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, optionalGitOperand } from './gitArgs';

async function currentBranch(cwd: string): Promise<string> {
  const branchResult = await runExecFile('git', ['branch', '--show-current'], { cwd });
  if (branchResult.code === 0 && branchResult.stdout.trim()) {
    return branchResult.stdout.trim();
  }

  const symbolicRefResult = await runExecFile(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    {
      cwd,
    }
  );
  if (symbolicRefResult.code === 0 && symbolicRefResult.stdout.trim()) {
    return symbolicRefResult.stdout.trim();
  }

  throw new Error(
    branchResult.stderr.trim() ||
      symbolicRefResult.stderr.trim() ||
      'Failed to resolve current git branch'
  );
}

const tool: ToolHandler = async (input, _settings, context) => {
  const message = asNonEmptyString(input.message);
  if (!message) throw new Error('message is required');

  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const requestedBranch = optionalGitOperand('branch', asNonEmptyString(input.branch));
  const files = asStringArray(input.files);

  const beforeBranch = await currentBranch(cwd);
  if (requestedBranch && requestedBranch !== beforeBranch) {
    const switchResult = await runExecFile('git', ['switch', END_OF_OPTIONS, requestedBranch], {
      cwd,
    });
    if (switchResult.code !== 0) {
      throw new Error(
        switchResult.stderr.trim() || `Failed to switch to branch ${requestedBranch}`
      );
    }
  }

  const addResult =
    files.length > 0
      ? await runExecFile('git', ['add', '--', ...files], { cwd })
      : await runExecFile('git', ['add', '-A'], { cwd });

  if (addResult.code !== 0) {
    throw new Error(addResult.stderr.trim() || 'git add failed');
  }

  const stagedCheck = await runExecFile('git', ['diff', '--cached', '--quiet'], { cwd });
  if (stagedCheck.code === 0) {
    return `No staged changes to commit on ${await currentBranch(cwd)}.`;
  }

  if (stagedCheck.code !== 1) {
    throw new Error(stagedCheck.stderr.trim() || 'Failed to inspect staged changes');
  }

  const commitResult = await runExecFile('git', ['commit', '-m', message], { cwd });
  if (commitResult.code !== 0) {
    throw new Error(commitResult.stderr.trim() || 'git commit failed');
  }

  const hashResult = await runExecFile('git', ['rev-parse', 'HEAD'], { cwd });
  const branch = await currentBranch(cwd);
  const hash = hashResult.code === 0 ? hashResult.stdout.trim() : '(unknown)';

  return [`Committed ${hash} on ${branch}.`, commitResult.stdout.trim() || null]
    .filter(Boolean)
    .join('\n');
};

export default tool;
