import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_diff',
  name: 'Git Diff',
  description:
    'Show changes in the working tree. Defaults to unstaged changes; can show staged changes or a diff against a specific commit.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'diff', 'changes', 'staged', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged changes (git diff --cached) instead of unstaged.',
      },
      commit: {
        type: 'string',
        description:
          'Compare against a commit or ref (e.g. "HEAD~1", "main"). Ignored when `staged` is true.',
      },
      path: {
        type: 'string',
        description: 'Limit the diff to a specific file or directory path.',
      },
      stat: {
        type: 'boolean',
        description: 'Show a diff summary (--stat) instead of the full patch.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
    },
  },
  sort_order: 21,
};

export default definition;
