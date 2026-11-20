import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { HOOK_EVENT_NAMES } from '@server/services/ToolService/customTools/vendorSdk';

const definition: BuiltinToolDefinition = {
  id: 'hook',
  name: 'Hook',
  description:
    'Manage lifecycle hooks with op create/run/update/enable/disable/run_as. ' +
    'create scaffolds a hook.ts in the hooks home and waits for the build; it is registered DISABLED and never replaces an existing hook. ' +
    'run executes a saved hook now through its script page’s test console (disabled hooks need force:true). People see hooks as scripts in the Automations view, where they turn them on. ' +
    'update replaces a hook’s hook.ts and rebuilds it; its enabled state stays. ' +
    'enable/disable set activation idempotently, never running it or changing code or triggers. ' +
    'run_as sets the agent the hook acts as (only yourself; "" clears it to the system actor). ' +
    'create, run, update, enable and run_as ask the user first (they stage or execute code that runs as the user). ' +
    'run’s mock-event fields (event_name, message_id, thread_id, table_id, entry_id, agent_id, run_id, payload) and force are not listed: tool({op:"schema", name:"hook"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'core',
  // create writes agent-authored Node code into the hooks home; run executes a
  // saved hook's code now; update puts new code live on a hook that is already
  // enabled; enable puts a hook's code on the event bus; run_as hands a hook's
  // code an agent's tool access. All of these run (or stage) code that acts as
  // the user, so a guarded agent asks first. disable only turns a hook off, and
  // get/list read, so they stay ungated.
  destructiveOps: ['create', 'run', 'update', 'enable', 'run_as'],
  keywords: [
    'hook',
    'create hook',
    'run hook',
    'test hook',
    'enable hook',
    'disable hook',
    'lifecycle',
    'scaffold',
    'trigger hook',
    'automation',
    'typescript',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: ['create', 'run', 'update', 'enable', 'disable', 'run_as'],
        description: 'Hook action.',
      },
      name: {
        type: 'string',
        description:
          'Hook name, e.g. notify-on-task-done. Required by create, update, enable, disable, run_as.',
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        maxLength: 64,
      },
      description: {
        type: 'string',
        description: 'create: what this hook is for (scaffold header comment). Required.',
      },
      events: {
        type: 'array',
        description:
          'create: lifecycle events the scaffolded hook observes (the `on` array). Required unless hook_source is supplied; ignored when it is.',
        items: { type: 'string', enum: [...HOOK_EVENT_NAMES] },
      },
      hook_source: {
        type: 'string',
        description:
          'create: optional complete hook.ts (default-export defineHook with `on` and/or `schedule`). update: the complete replacement hook.ts (required).',
      },
      hook_id_or_name: {
        type: 'string',
        description: 'run: registered hook name or durable registration ID. Required.',
      },
      run_as: {
        type: 'string',
        description:
          'run_as (required): the agent (id or name) the hook acts as, with its tool access and name. Only yourself; "" clears it (the event\'s agent, else the system actor).',
      },
    },
  },
  // run's mock-entity fields and force: accepted (the handlers read input
  // directly; nothing checks it against parameters_schema) but not
  // advertised, to save tokens on every turn. tool(op:schema) returns them as
  // `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    event_name: {
      type: 'string',
      description:
        'run: lifecycle event to mock. Required for agent_id (agent:create/update/delete). Inferred for message_id, thread_id and run_id; table_id + entry_id default to table_entry:update (also table_entry:create, :delete, :occurrence).',
    },
    message_id: { type: 'string', description: 'run: message to resolve as message:create.' },
    thread_id: { type: 'string', description: 'run: thread to resolve as thread:create.' },
    table_id: {
      type: 'string',
      description: 'run: database table id (table-…) of the entry to resolve; pair with entry_id.',
    },
    entry_id: { type: 'string', description: 'run: entry UUID in table_id.' },
    agent_id: {
      type: 'string',
      description: 'run: agent to resolve; pair with agent:create, agent:update or agent:delete.',
    },
    run_id: { type: 'string', description: 'run: past run to resolve as run:end.' },
    payload: {
      type: 'object',
      description:
        'run: explicit event payload for events without a mock entity. Mutually exclusive with entity-ID parameters.',
    },
    force: {
      type: 'boolean',
      description: 'run: allow an on-demand run of a disabled hook. Default false.',
    },
  },
  sort_order: 13,
};

export default definition;
