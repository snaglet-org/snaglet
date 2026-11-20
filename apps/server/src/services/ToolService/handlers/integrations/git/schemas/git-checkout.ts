import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_checkout',
  name: 'Git Checkout',
  description:
    'Switch to an existing branch or create a new branch and switch to it. Uses `git switch` under the hood.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'checkout', 'switch', 'branch', 'vcs'],
  parameters_schema: {
    type: 'object',
    required: ['ref'],
    properties: {
      ref: {
        type: 'string',
        description: 'Branch name or ref to switch to.',
      },
      create: {
        type: 'boolean',
        description: 'Create the branch if it does not exist (git switch -c). Defaults to false.',
      },
      startPoint: {
        type: 'string',
        description: 'Starting commit or branch when creating a new branch. Defaults to HEAD.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
    },
  },
  sort_order: 25,
};

export default definition;
