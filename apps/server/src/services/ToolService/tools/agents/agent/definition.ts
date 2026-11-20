import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * agent(op): create, get, list, update, archive, restore, abort and activity
 * (old ids create_agent, get_agent, update_agent, abort_agent_run and
 * agent_activity map to their ops). Schema is flat (like doc/node/
 * container): each property says which op reads it. Each old id is an
 * op-pinned alias in toolAliases.ts, so an access rule naming one covers
 * exactly its op. No op is confirm-gated: archive is reversible (restore),
 * matching node(op:archive).
 */
const definition: BuiltinToolDefinition = {
  id: 'agent',
  name: 'Agent',
  type: 'builtin',
  tier: 'standard',
  contextRequirement: 'agent-optional',
  destructiveOps: [],
  description:
    'Manage Snaglet agents. op create (name, role, optional skills); get (agent id or name: the full ' +
    'record with complete system prompt; view:"runtime_self" for your own runtime); list (the ' +
    'roster); update (by agent_id: any subset of fields); archive / restore (by agent_id, ' +
    'reversible); abort (your own active run in thread_id); activity (view:"agent" with ' +
    'agent_name, or your own "self_recent"/"self_history"). ' +
    'scope:"self", tool_access_mode, add_skills/remove_skills/set_skills, include_archived and the ' +
    'activity filters are not listed: tool({op:"schema", name:"agent"}) returns them as unlisted_parameters.',
  keywords: [
    'agent',
    'create agent',
    'update agent',
    'get agent',
    'roster',
    'system prompt',
    'persona',
    'skills',
    'assign skill',
    'archive agent',
    'abort run',
    'activity',
    'run history',
    'tool access',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: ['create', 'get', 'list', 'update', 'archive', 'restore', 'abort', 'activity'],
      },
      agent_id: {
        type: 'string',
        description:
          'update/archive/restore/abort: the target agent id. get: same as `agent`. abort: agents may only abort their own run.',
      },
      agent: { type: 'string', description: 'get: agent id or name (case-insensitive).' },
      name: {
        type: 'string',
        description:
          'create (required)/update: display name; unique (case-insensitive), not reserved.',
      },
      role: { type: 'string', description: 'create (required)/update: role or title.' },
      system_prompt: {
        type: 'string',
        description: 'create/update: system prompt, shipped verbatim. Empty string clears.',
      },
      identity: { type: 'string', description: 'create/update: short identity/persona blurb.' },
      provider: {
        type: 'string',
        description: 'create/update: LLM provider id (create default "anthropic").',
      },
      model_id: { type: 'string', description: 'create/update: model id.' },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'create: default skills, by id or slug. Grants no permissions.',
      },
      view: {
        type: 'string',
        enum: ['record', 'runtime_self', 'agent', 'self_recent', 'self_history'],
        description:
          'get: "record" (default) or "runtime_self". activity: "agent" (default, needs agent_name), "self_recent" or "self_history".',
      },
      thread_id: {
        type: ['string', 'null'],
        description: 'abort (required): the thread with the active run. activity: filter.',
      },
      agent_name: { type: 'string', description: 'activity view "agent": the agent to inspect.' },
    },
  },
  // Admin fields (scope, tool access, skill edits, include_archived) and the
  // activity filters: accepted (the handlers read input directly; nothing
  // checks it against parameters_schema) but not advertised, to save tokens
  // on every turn. tool(op:schema) returns them as `unlisted_parameters`;
  // TOOL.md lists them.
  unlisted_params: {
    scope: {
      type: 'string',
      enum: ['agent', 'self'],
      default: 'agent',
      description: 'update: "self" edits only your own name/role/identity/system_prompt.',
    },
    tool_access_mode: {
      type: 'string',
      enum: ['all', 'allow_list', 'deny_list'],
      description: 'create/update: tool access policy.',
    },
    add_skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'update (scope agent): skill ids or slugs to add.',
    },
    remove_skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'update (scope agent): skill ids or slugs to remove.',
    },
    set_skills: {
      type: 'array',
      items: { type: 'string' },
      description:
        'update (scope agent): replace the whole set ([] clears); not combinable with add/remove.',
    },
    include_archived: { type: 'boolean', description: 'list: include archived agents.' },
    run_id: { type: 'string', description: 'activity: one run.' },
    last_n_runs: { type: 'number', description: 'activity: entries from the last N runs.' },
    limit: { type: 'number', description: 'activity: maximum entries.' },
    action_type: {
      type: 'string',
      enum: ['tool_call', 'thinking'],
      description: 'activity: only this kind of entry.',
    },
    tool: { type: 'string', description: 'activity: tool name; legacy names match too.' },
    all_threads: {
      type: 'boolean',
      description: 'activity: accepted for older callers; thread_id: null reads every thread.',
    },
    before: { type: 'string', description: 'activity: page before this cursor.' },
    include_input_preview: {
      type: 'boolean',
      description: 'activity view "agent": preview each tool input.',
    },
    include_outputs: {
      type: 'boolean',
      description: 'activity view "self_history": include tool outputs (default true).',
    },
    output_max_length: {
      type: 'number',
      description:
        'activity view "self_history": characters kept per output (100-10000, default 2000).',
    },
  },
};

export default definition;
