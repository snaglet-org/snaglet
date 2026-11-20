import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

type Action = 'list' | 'save' | 'pop' | 'apply' | 'drop';

function stashRef(input: unknown): string {
  const index =
    typeof input === 'number' && Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0;
  return `stash@{${index}}`;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const action = (asNonEmptyString(input.action) ?? 'list') as Action;

  const args: string[] = ['stash'];
  switch (action) {
    case 'list':
      args.push('list');
      break;
    case 'save': {
      args.push('push');
      if (input.includeUntracked === true) args.push('-u');
      const message = asNonEmptyString(input.message);
      if (message) args.push('-m', message);
      break;
    }
    case 'pop':
      args.push('pop', stashRef(input.index));
      break;
    case 'apply':
      args.push('apply', stashRef(input.index));
      break;
    case 'drop':
      args.push('drop', stashRef(input.index));
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  const result = await runExecFile('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git stash ${action} failed`);
  }

  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  if (output.length > 0) return output;
  return action === 'list' ? 'No stashes.' : `Stash ${action} complete.`;
};

export default tool;
