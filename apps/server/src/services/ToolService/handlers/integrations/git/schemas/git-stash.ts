import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_stash',
  name: 'Git Stash',
  description: 'Save, list, pop, apply, or drop git stashes. Defaults to listing current stashes.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'stash', 'shelve', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'save', 'pop', 'apply', 'drop'],
        description: 'Operation to perform. Defaults to `list`.',
      },
      message: {
        type: 'string',
        description: 'Optional message for `save`.',
      },
      index: {
        type: 'number',
        description: 'Stash index for `pop`, `apply`, or `drop`. Defaults to 0 (most recent).',
      },
      includeUntracked: {
        type: 'boolean',
        description: 'For `save`: also stash untracked files (`-u`). Defaults to false.',
      },
      cwd: {
        type: 'string',
        description: 'Repository working directory. Defaults to the server process cwd.',
      },
    },
    oneOf: [
      {
        description: 'list — no extra fields needed',
        properties: { action: { const: 'list' } },
      },
      {
        description: 'save — accepts message + includeUntracked',
        properties: { action: { const: 'save' } },
        required: ['action'],
      },
      {
        description: 'pop — accepts optional index',
        properties: { action: { const: 'pop' } },
        required: ['action'],
      },
      {
        description: 'apply — accepts optional index',
        properties: { action: { const: 'apply' } },
        required: ['action'],
      },
      {
        description: 'drop — accepts optional index',
        properties: { action: { const: 'drop' } },
        required: ['action'],
      },
      {
        description: 'no action specified → defaults to list',
        not: { required: ['action'] },
      },
    ],
    examples: [
      {},
      { action: 'list' },
      { action: 'save', message: 'WIP: tool overhaul', includeUntracked: true },
      { action: 'pop' },
      { action: 'apply', index: 1 },
      { action: 'drop', index: 0 },
    ],
  },
  sort_order: 28,
};

export default definition;
