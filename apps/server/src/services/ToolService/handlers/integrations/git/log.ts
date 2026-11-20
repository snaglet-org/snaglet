import { asNonEmptyString, clamp } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, optionalGitOperand } from './gitArgs';

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const branch = optionalGitOperand('branch', asNonEmptyString(input.branch));
  const target = asNonEmptyString(input.path);
  const oneline = input.oneline !== false;

  const rawLimit = typeof input.limit === 'number' ? Math.floor(input.limit) : 20;
  const limit = clamp(rawLimit, 1, 500);

  const args = ['log', `-n${limit}`];
  if (oneline) {
    args.push('--oneline', '--decorate');
  } else {
    args.push('--pretty=format:%h %an %ad %s', '--date=short');
  }
  if (branch) args.push(END_OF_OPTIONS, branch);
  if (target) args.push('--', target);

  const result = await runExecFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git log failed');
  }

  const output = result.stdout.trim();
  return output.length > 0 ? output : 'No commits.';
};

export default tool;
