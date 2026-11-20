import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_commit',
  name: 'Git Commit',
  description:
    'Stage files and create a git commit in the current repository. **Destructive — cannot be undone without a revert commit.** Omitting `files` stages ALL tracked changes. Always verify staged state with `git_status` before committing.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'commit', 'save', 'version', 'push', 'stage', 'vcs'],
  parameters_schema: {
    type: 'object',
    required: ['message'],
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'string',
        },
        description:
          'Specific file paths to stage before committing. If omitted, ALL currently tracked changes are staged and committed — use with caution.',
      },
      branch: {
        type: 'string',
        description:
          'Branch to commit on. The tool will checkout this branch before committing. Stays on the current branch if omitted.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
      message: {
        type: 'string',
        description:
          'Commit message. Use the imperative mood (e.g. "Fix login bug", not "Fixed login bug").',
      },
    },
  },
  sort_order: 23,
};

export default definition;
