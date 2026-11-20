import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_status',
  name: 'Git Status',
  description:
    'Show the working tree status: current branch, staged changes, unstaged changes, and untracked files.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'status', 'branch', 'changes', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
    },
  },
  sort_order: 20,
};

export default definition;
