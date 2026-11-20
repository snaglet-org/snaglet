import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_branch',
  name: 'Git Branch',
  description:
    'List, create, or delete git branches. Defaults to listing local and remote branches with the current branch marked.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'branch', 'list', 'create', 'delete', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'delete'],
        description: 'Operation to perform. Defaults to `list`.',
      },
      name: {
        type: 'string',
        description: 'Branch name (required for `create` and `delete`).',
      },
      startPoint: {
        type: 'string',
        description: 'For `create`: the starting commit or branch. Defaults to HEAD.',
      },
      force: {
        type: 'boolean',
        description:
          'For `delete`: use `-D` to force-delete an unmerged branch. Defaults to false.',
      },
      cwd: {
        type: 'string',
        description: 'Repository working directory. Defaults to the server process cwd.',
      },
    },
    oneOf: [
      { properties: { action: { enum: ['list'] } } },
      { properties: { action: { enum: ['create'] } }, required: ['action', 'name'] },
      { properties: { action: { enum: ['delete'] } }, required: ['action', 'name'] },
    ],
    examples: [
      {},
      { action: 'list' },
      { action: 'create', name: 'feature/tool-overhaul' },
      { action: 'create', name: 'hotfix/x', startPoint: 'main' },
      { action: 'delete', name: 'old-branch', force: true },
    ],
  },
  sort_order: 24,
};

export default definition;
