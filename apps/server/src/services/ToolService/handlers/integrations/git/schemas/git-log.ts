import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_log',
  name: 'Git Log',
  description:
    'Show recent commits. Supports limit, branch/ref, path filtering, and a compact oneline format.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'log', 'commits', 'history', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of commits to return. Defaults to 20.',
      },
      branch: {
        type: 'string',
        description: 'Branch or ref to show the log for (e.g. "main", "origin/dev").',
      },
      path: {
        type: 'string',
        description: 'Limit history to commits that touched a specific file or directory.',
      },
      oneline: {
        type: 'boolean',
        description: 'Use compact one-line-per-commit format. Defaults to true.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
    },
  },
  sort_order: 22,
};

export default definition;
