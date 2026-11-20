import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, optionalGitOperand } from './gitArgs';

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  // The `-` rejection is the real guard here: pull hands the remote to a
  // `git fetch` child without an end-of-options marker (see gitArgs.ts).
  const remote = optionalGitOperand('remote', asNonEmptyString(input.remote));
  const branch = optionalGitOperand('branch', asNonEmptyString(input.branch));
  const rebase = input.rebase === true;
  const ffOnly = input.ffOnly === true;

  const args = ['pull'];
  if (rebase) args.push('--rebase');
  if (ffOnly) args.push('--ff-only');
  const operands = [remote, branch].filter((value): value is string => value !== null);
  if (operands.length > 0) args.push(END_OF_OPTIONS, ...operands);

  const result = await runExecFile('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git pull failed');
  }

  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || 'Pulled.';
};

export default tool;
