import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, gitOperand, optionalGitOperand } from './gitArgs';

type Action = 'list' | 'create' | 'delete';

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const action = (asNonEmptyString(input.action) ?? 'list') as Action;

  if (action === 'list') {
    const result = await runExecFile('git', ['branch', '--all', '-v'], { cwd });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git branch failed');
    }
    const output = result.stdout.trim();
    return output.length > 0 ? output : 'No branches.';
  }

  const rawName = asNonEmptyString(input.name);
  if (!rawName) {
    throw new Error(`name is required for action "${action}"`);
  }
  const name = gitOperand('name', rawName);

  if (action === 'create') {
    const startPoint = optionalGitOperand('startPoint', asNonEmptyString(input.startPoint));
    const args = ['branch', END_OF_OPTIONS, name];
    if (startPoint) args.push(startPoint);
    const result = await runExecFile('git', args, { cwd });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git branch create failed');
    }
    return `Created branch ${name}${startPoint ? ` from ${startPoint}` : ''}.`;
  }

  if (action === 'delete') {
    const force = input.force === true;
    const result = await runExecFile('git', ['branch', force ? '-D' : '-d', END_OF_OPTIONS, name], {
      cwd,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git branch delete failed');
    }
    return result.stdout.trim() || `Deleted branch ${name}.`;
  }

  throw new Error(`Unknown action: ${action}`);
};

export default tool;
