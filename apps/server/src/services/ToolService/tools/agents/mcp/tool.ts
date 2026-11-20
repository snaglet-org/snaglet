import type { ToolHandler } from '@server/services/ToolService/types';
import {
  createServer,
  deleteServer,
  getServer,
  listServers,
  restoreServer,
  setServerCredential,
  testServer,
  updateServer,
} from '@server/services/ToolService/handlers/agents/mcp';

type Input = Record<string, unknown>;

/**
 * mcp(op) — MCP servers as one entity tool:
 * list | get | create | update | delete | restore | test | set_credential.
 * Fields that belong only to other ops are refused before any handler runs.
 */
const CONFIG_FIELDS = [
  'name',
  'transport',
  'command',
  'command_args',
  'url',
  'env',
  'headers',
  'scope',
  'enabled',
  'autoload',
  'requires_confirmation',
  'provider_id',
];
const OP_FIELDS: Record<string, readonly string[]> = {
  list: [],
  get: [],
  create: CONFIG_FIELDS,
  update: CONFIG_FIELDS,
  delete: [],
  restore: [],
  test: [],
  set_credential: ['secret', 'bundle'],
};
const SHARED_FIELDS = ['op', 'id'];

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set([...SHARED_FIELDS, ...OP_FIELDS[op]]);
  for (const [otherOp, fields] of Object.entries(OP_FIELDS)) {
    if (otherOp === op) continue;
    for (const field of fields) {
      if (!own.has(field) && input[field] !== undefined) {
        throw new Error(
          `mcp ${op}: \`${field}\` belongs to op ${otherOp}, not ${op}. Nothing was changed.`
        );
      }
    }
  }
}

const OPS: Record<string, ToolHandler> = {
  list: listServers,
  get: getServer,
  create: createServer,
  update: updateServer,
  delete: deleteServer,
  restore: restoreServer,
  test: testServer,
  set_credential: setServerCredential,
};

const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!op || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(', ')}.`);
  }
  refuseForeignFields(op, input);
  return handler(input, settings, context);
};

export default tool;
