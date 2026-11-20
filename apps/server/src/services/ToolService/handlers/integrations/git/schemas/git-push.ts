import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_push',
  name: 'Git Push',
  description:
    'Push the current (or specified) branch to a remote. **Verify the remote exists and the branch is correct before pushing — this writes to a shared remote and cannot be easily undone.** Use `git_status` and `git_log` to confirm local state first. Force pushes use `--force-with-lease` only; plain `--force` is not supported.',
  type: 'builtin',
  tier: 'standard',
  // Writes to a shared remote and cannot be easily undone — panel
  // confirm-gates it.
  destructive: true,
  keywords: ['git', 'push', 'remote', 'publish', 'vcs'],
  parameters_schema: {
    type: 'object',
    properties: {
      remote: {
        type: 'string',
        description:
          'Remote to push to. Defaults to `origin`. Verify the remote exists with `git remote -v` via `shell` before pushing.',
      },
      branch: {
        type: 'string',
        description:
          'Branch to push. Defaults to the current HEAD branch. Verify intended branch with `git_status` first.',
      },
      setUpstream: {
        type: 'boolean',
        description: 'Set the upstream tracking reference (`-u`). Defaults to false.',
      },
      force: {
        type: 'boolean',
        description:
          'Use `--force-with-lease` for a safer force push — fails if the remote has commits you have not fetched. Defaults to false. Plain `--force` is not supported.',
      },
      tags: {
        type: 'boolean',
        description: 'Also push tags (`--tags`). Defaults to false.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the current server process directory.',
      },
    },
  },
  sort_order: 27,
};

export default definition;
