import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, gitOperand, optionalGitOperand } from './gitArgs';

const tool: ToolHandler = async (input, _settings, context) => {
  const rawRef = asNonEmptyString(input.ref);
  if (!rawRef) throw new Error('ref is required');
  const ref = gitOperand('ref', rawRef);

  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const create = input.create === true;
  const startPoint = optionalGitOperand('startPoint', asNonEmptyString(input.startPoint));

  // `-c` consumes the next argv entry as its value, so the new branch name
  // sits before the end-of-options marker and the start point after it.
  const args = create
    ? ['switch', '-c', ref, ...(startPoint ? [END_OF_OPTIONS, startPoint] : [])]
    : ['switch', END_OF_OPTIONS, ref];

  const result = await runExecFile('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git switch failed');
  }

  return result.stderr.trim() || result.stdout.trim() || `Switched to ${ref}.`;
};

export default tool;
