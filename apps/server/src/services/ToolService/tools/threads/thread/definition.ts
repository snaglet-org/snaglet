import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const nullableString = { type: ['string', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;
const nullablePositiveInteger = { type: ['integer', 'null'], minimum: 1 } as const;
const nullableStringArray = {
  type: ['array', 'null'],
  items: { type: 'string' },
} as const;
const nullableToolAccessMode = {
  type: ['string', 'null'],
  enum: ['all', 'allow_list', 'deny_list', null],
} as const;

/**
 * thread(op): read, create, update, add_agents, remove_agents, delete, leave
 * and send for workspace threads (the old ids thread_read, thread_create,
 * thread_update, thread_delete and thread_send are op-pinned aliases; ops
 * leave_thread and remove_me mean leave). Who is in a thread changes only
 * through add_agents, remove_agents and leave, never update, so a settings
 * change cannot take an agent out by accident.
 * get_clarification (pauses the run) is a separate tool. thread is core so
 * send is always at hand.
 *
 * Schema is flat (like `file`): each property says which op reads it. The
 * dispatcher strips `op` before handing off, so each handler sees exactly the
 * input it validates. The thread prompt changes only through
 * update (thread.system_prompt): access to thread is access to its prompt.
 */
const definition: BuiltinToolDefinition = {
  id: 'thread',
  name: 'Thread',
  description:
    'Workspace threads. op: read (recent messages, or a window around message_id with mode:"message_context"), ' +
    'create (new thread, optionally with a project, agents and a kickoff message), ' +
    'update (title, project, routing, working folder, model/budget/tool-access settings), ' +
    'add_agents / remove_agents (agent_ids; never yourself: use leave), ' +
    'delete (permanent; explicit id and confirm:true). ' +
    'leave (take yourself out). ' +
    'send (post into another thread; content required; in your own thread, just reply). ' +
    'dm_*: private DMs (snaglet-dms skill). ' +
    'Ops other than create/delete default to your thread. ' +
    'Update\'s fields and create\'s system_prompt are unlisted: tool({op:"schema", name:"thread"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'standard',
  // Per-op destructiveness: only delete is confirm-gated.
  destructiveOps: ['delete'],
  // The old ids' alternate names stay findable via tool(op:search/schema);
  // each is also an op-pinned alias in toolAliases.ts.
  aliases: [
    'create_thread',
    'new_thread',
    'start_thread',
    'update_thread',
    'configure_thread',
    'thread_settings_update',
  ],
  keywords: [
    'thread',
    'read',
    'messages',
    'history',
    'journal',
    'message context',
    'create',
    'new',
    'start',
    'begin',
    'spawn',
    'conversation',
    'chat',
    'participants',
    'collaboration',
    'group_chat',
    'subthread',
    'new thread',
    'start thread',
    'create thread',
    'create a new thread',
    'start a thread',
    'new conversation',
    'update',
    'configure',
    'settings',
    'routing',
    'dispatch',
    'budget',
    'prompt',
    'model',
    'project',
    'move',
    'system prompt',
    'instructions',
    'replace',
    'agent',
    'participant',
    'add',
    'invite',
    'collaborate',
    'mention',
    'specialist',
    'leave',
    'leave thread',
    'add agent',
    'remove agent',
    'delete',
    'remove',
    'permanent',
    'send',
    'post',
    'message',
    'reply',
    'append',
    'dm',
    'direct message',
    'inbox',
    'private message',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: [
          'send',
          'read',
          'create',
          'update',
          'add_agents',
          'remove_agents',
          'delete',
          'leave',
          'dm_send',
          'dm_list',
          'dm_read',
        ],
      },
      id: {
        type: 'string',
        description:
          'Thread id. Omit for the thread you are in (all ops but create; delete requires it).',
      },
      // read
      mode: {
        type: 'string',
        enum: ['thread', 'message_context'],
        default: 'thread',
        description: 'read: recent messages (thread) or a window around message_id.',
      },
      message_id: {
        type: 'string',
        description: 'read message_context: anchor message id (required in that mode).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'read: maximum messages to return (default 50).',
      },
      before: {
        description:
          'read: ISO timestamp cursor (thread mode) or preceding messages 0-49 (message_context, default 10).',
      },
      after: {
        type: 'integer',
        minimum: 0,
        maximum: 49,
        description: 'read message_context: following messages (default 10).',
      },
      // create
      title: { type: 'string', description: 'create: display title (required).' },
      project_id: {
        type: ['string', 'null'],
        description:
          "create: project container id to scope the thread to (defaults to the calling thread's project; null = flat). delete: optional scope assertion — the thread must be in this project.",
      },
      dispatch_mode: {
        type: 'string',
        enum: ['all', 'mention', 'mentioned'],
        description:
          "create: how messages route to participants. 'all' = broadcast (every participant hears every message); 'mention' (alias 'mentioned') = only agents tagged with @Name wake. Defaults to 'mentioned'.",
      },
      agent_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'create, add_agents: agents to add (ones already in are skipped; the caller only if listed; create adds every local user automatically). remove_agents: agents to take out.',
      },
      initial_message: {
        type: 'string',
        description:
          'create: optional first message to post in the new thread, authored by the calling agent. When you call from inside a thread, a footer is appended naming you and the origin thread and giving the exact reply call (op:"send" with the origin thread id), so do not add your own return address. Useful for kicking off a thread with teammates; for a self-contained task of your own, use subagent instead.',
      },
      // send
      content: {
        type: 'string',
        description: 'send: message text (required).',
      },
      sender_agent_id: {
        type: 'string',
        description: 'send: sender agent; defaults to (and may not differ from) the calling agent.',
      },
      // delete
      confirm: {
        type: 'boolean',
        enum: [true],
        description: 'delete: must be explicitly true. Deletion is irreversible.',
      },
    },
  },
  // Rarely used admin fields: accepted (handlers validate their own input;
  // nothing checks it against parameters_schema) but not advertised, to save
  // ~3.7k chars per turn.
  // tool(op:schema) returns them as `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    to: {
      type: 'string',
      description: 'dm_send: agent name or id, or "user" (required).',
    },
    all: {
      type: 'boolean',
      description: 'dm_list: include read DMs.',
    },
    system_prompt: {
      type: 'string',
      description:
        'create: optional thread system prompt. To change it later use update with thread.system_prompt.',
    },
    thread: {
      type: 'object',
      additionalProperties: false,
      description:
        'update: thread-level partial update. Omitted fields remain unchanged; pass null only where documented to clear an override.',
      properties: {
        title: { ...nullableString, description: 'Thread title. Null clears it.' },
        project_id: {
          ...nullableString,
          description:
            'Move the thread into this project (the id of a container with category=project), or null to make it flat at the workspace level. A non-project container id is rejected with the nearest project named.',
        },
        dispatch_mode: {
          type: 'string',
          enum: ['all', 'mentioned'],
          description: 'Participant routing mode.',
        },
        system_prompt: {
          ...nullableString,
          description: 'Thread-wide system-prompt addendum. Null clears it.',
        },
        max_waves: {
          ...nullableInteger,
          description:
            'Dispatch-wave cap: -1 is unbounded, a positive integer is a cap, null uses the default. Zero is invalid.',
        },
        max_total_output_tokens: {
          ...nullablePositiveInteger,
          description:
            'Cap on total output tokens across all agents for one message: a runaway guard that stops further dispatch; it never shortens a single reply. Null uses the default.',
        },
        max_agent_dispatches: {
          ...nullablePositiveInteger,
          description: 'Per-agent dispatch threshold override. Null uses the default.',
        },
        tool_access_mode: nullableToolAccessMode,
        tool_access_allow_list: nullableStringArray,
        tool_access_deny_list: nullableStringArray,
        working_directory: {
          ...nullableString,
          description:
            "Folder agents in this thread start in when they wake (their shell and file tools). An absolute path to an existing folder inside the thread's project folder, such as a worktree under .snaglet/worktrees; never inside Snaglet's own directories. Null clears it: agents start in the project's folder, or Snaglet home when the thread has no project folder.",
        },
      },
    },
  },
  param_aliases: { thread_id: ['id'] },
  sort_order: 40,
};

export default definition;
