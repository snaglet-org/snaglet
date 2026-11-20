import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'git_verify',
  name: 'Git Verify',
  description:
    'Verify a git ref (SHA, branch, or tag) exists and return its real metadata. Always call before reporting a commit SHA — prevents fabricated git data.',
  type: 'builtin',
  // Standard (discoverable), not core: only relevant when working with code/git.
  // The filesystem/code section of the system prompt names it so code-working
  // agents still know to verify SHAs before reporting them.
  tier: 'standard',
  keywords: ['git', 'verify', 'commit', 'sha', 'branch', 'rev-parse', 'ground-truth'],
  parameters_schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description:
          'The git reference to verify. Can be a full or short SHA, branch name (local or remote like origin/main), tag, or symbolic ref like HEAD.',
      },
      cwd: {
        type: 'string',
        description:
          'Repository working directory. Defaults to the server process current working directory.',
      },
      checkRemote: {
        type: 'boolean',
        description:
          'If true, also fetch the remote and verify whether the SHA exists on origin. Use sparingly — adds a network call. Defaults to false.',
      },
    },
    required: ['ref'],
    additionalProperties: false,
    examples: [
      { ref: 'HEAD' },
      { ref: 'main' },
      { ref: 'origin/snaglet-agent-workspace', checkRemote: true },
      { ref: '1c383a5' },
    ],
  },
};

export default definition;
