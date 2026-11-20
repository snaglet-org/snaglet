import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_pull',
  name: 'Git Pull',
  description:
    'Fetch and integrate changes from a remote into the current branch. Supports merge or rebase strategies. **Verify the remote exists and you are on the correct local branch before pulling** — an unexpected merge can introduce conflicts or overwrite local work. Use `git_status` to confirm clean state before pulling.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['git', 'pull', 'fetch', 'remote', 'rebase', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      remote: {
        type: 'string',
        description:
          'Remote to pull from. Defaults to `origin`. Verify the remote exists with `git remote -v` via `shell` before pulling.',
      },
      branch: {
        type: 'string',
        description:
          'Branch to pull from the remote. Defaults to the tracking branch for the current local branch.',
      },
      rebase: {
        type: 'boolean',
        description:
          'Use `--rebase` instead of a merge commit. Rewrites local commits on top of the fetched commits. Defaults to false.',
      },
      ffOnly: {
        type: 'boolean',
        description:
          'Only allow fast-forward updates (`--ff-only`). Fails if a merge would be required, preventing accidental merge commits. Defaults to false.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
    },
  },
  sort_order: 26,
};

export default definition;
