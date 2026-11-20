import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, gitOperand } from './gitArgs';

async function currentBranch(cwd: string): Promise<string> {
  const result = await runExecFile('git', ['branch', '--show-current'], { cwd });
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  throw new Error(result.stderr.trim() || 'Failed to resolve current branch');
}

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const remote = gitOperand('remote', asNonEmptyString(input.remote) ?? 'origin');
  const branch = gitOperand('branch', asNonEmptyString(input.branch) ?? (await currentBranch(cwd)));
  const setUpstream = input.setUpstream === true;
  const force = input.force === true;
  const tags = input.tags === true;

  const args = ['push'];
  if (setUpstream) args.push('-u');
  if (force) args.push('--force-with-lease');
  if (tags) args.push('--tags');
  args.push(END_OF_OPTIONS, remote, branch);

  const result = await runExecFile('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git push failed');
  }

  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return combined || `Pushed ${branch} to ${remote}.`;
};

export default tool;
