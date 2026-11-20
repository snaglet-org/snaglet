import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import branch from '@server/services/ToolService/handlers/integrations/git/schemas/git-branch';
import checkout from '@server/services/ToolService/handlers/integrations/git/schemas/git-checkout';
import commit from '@server/services/ToolService/handlers/integrations/git/schemas/git-commit';
import diff from '@server/services/ToolService/handlers/integrations/git/schemas/git-diff';
import log from '@server/services/ToolService/handlers/integrations/git/schemas/git-log';
import pull from '@server/services/ToolService/handlers/integrations/git/schemas/git-pull';
import push from '@server/services/ToolService/handlers/integrations/git/schemas/git-push';
import stash from '@server/services/ToolService/handlers/integrations/git/schemas/git-stash';
import status from '@server/services/ToolService/handlers/integrations/git/schemas/git-status';
import verify from '@server/services/ToolService/handlers/integrations/git/schemas/git-verify';

const subcommands = [
  { operation: 'branch', definition: branch },
  { operation: 'checkout', definition: checkout },
  { operation: 'commit', definition: commit },
  { operation: 'diff', definition: diff },
  { operation: 'log', definition: log },
  { operation: 'pull', definition: pull },
  { operation: 'push', definition: push },
  { operation: 'stash', definition: stash },
  { operation: 'status', definition: status },
  { operation: 'verify', definition: verify },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'git',
  name: 'Git',
  description: `Run bounded Git operations through execFile without a shell. The canonical git tool participates in the same git:* command permission rules as shell execution. Before reporting any commit SHA or ref, resolve it with the verify subcommand — never quote a remembered SHA. ${describeOperationRequirements(subcommands)}.`,
  type: 'builtin',
  tier: 'standard',
  destructive: true,
  keywords: [
    'git',
    'branch',
    'checkout',
    'commit',
    'diff',
    'log',
    'pull',
    'push',
    'stash',
    'status',
    'verify',
    'version control',
  ],
  parameters_schema: buildFlatCapabilitySchema(subcommands, 'subcommand'),
};

export default definition;
