import type { ToolHandler } from '@server/services/ToolService/types';
import abortAgentRun from '@server/services/ToolService/handlers/agents/abortAgentRun';
import agentActivity from '@server/services/ToolService/handlers/agents/agentActivity';
import agentGet from '@server/services/ToolService/handlers/agents/agentGet';
import agentUpdate from '@server/services/ToolService/handlers/agents/agentUpdate';
import createAgent from '@server/services/ToolService/handlers/agents/createAgent';
import {
  archiveAgent,
  restoreAgent,
} from '@server/services/ToolService/handlers/agents/agentLifecycle';

type Input = Record<string, unknown>;

/**
 * agent(op) — one tool for the agent entity, verb as `op`:
 * create | get | list | update | archive | restore | abort | activity.
 *
 * Each op hands its fields to its handler; the old ids (create_agent,
 * get_agent, update_agent, abort_agent_run, agent_activity) map to op-pinned
 * aliases in toolAliases.ts. Fields that belong only to other ops are refused
 * before any handler runs, so a call never half-means another op.
 */
const SHARED_FIELDS = ['op', 'agent_id'];
const OP_FIELDS: Record<string, readonly string[]> = {
  create: [
    'name',
    'role',
    'system_prompt',
    'identity',
    'provider',
    'model_id',
    'tool_access_mode',
    'skills',
  ],
  // listAll/includeArchived: the get_agent roster form, still accepted.
  get: ['agent', 'view', 'listAll', 'includeArchived'],
  list: ['include_archived', 'includeArchived'],
  update: [
    'scope',
    'name',
    'role',
    'system_prompt',
    'identity',
    'provider',
    'model_id',
    'tool_access_mode',
    'add_skills',
    'remove_skills',
    'set_skills',
  ],
  archive: [],
  restore: [],
  abort: ['thread_id'],
  activity: [
    'view',
    'agent_name',
    'run_id',
    'last_n_runs',
    'limit',
    'action_type',
    'tool',
    'thread_id',
    'all_threads',
    'before',
    'include_input_preview',
    'include_outputs',
    'output_max_length',
  ],
};

export const AGENT_OPS = Object.keys(OP_FIELDS);

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set([...SHARED_FIELDS, ...OP_FIELDS[op]]);
  for (const [otherOp, fields] of Object.entries(OP_FIELDS)) {
    if (otherOp === op) continue;
    for (const field of fields) {
      if (!own.has(field) && input[field] !== undefined) {
        throw new Error(
          `agent ${op}: \`${field}\` belongs to op ${otherOp}, not ${op}. Nothing was changed.`
        );
      }
    }
  }
}

const strip = ({ op: _op, ...rest }: Input): Input => rest;

const OPS: Record<string, ToolHandler> = {
  create: (input, settings, context) => createAgent(strip(input), settings, context),
  // get: one record by `agent` (id or name) or view:"runtime_self". agent_id is
  // accepted as a synonym for `agent`, matching every other op.
  get: (input, settings, context) => {
    const { agent_id, ...rest } = strip(input);
    const agent = rest.agent ?? agent_id;
    return agentGet({ ...rest, ...(agent !== undefined ? { agent } : {}) }, settings, context);
  },
  list: (input, settings, context) => {
    const rest = strip(input);
    const includeArchived = rest.include_archived ?? rest.includeArchived;
    return agentGet(
      { listAll: true, ...(includeArchived !== undefined ? { includeArchived } : {}) },
      settings,
      context
    );
  },
  update: (input, settings, context) => agentUpdate(strip(input), settings, context),
  archive: archiveAgent,
  restore: restoreAgent,
  abort: (input, settings, context) => abortAgentRun(strip(input), settings, context),
  activity: (input, settings, context) => agentActivity(strip(input), settings, context),
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
