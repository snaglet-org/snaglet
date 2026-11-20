import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * subagent(op) — named helpers in hidden threads.
 * Core, so starting a helper is always at hand.
 * Every op acts on the calling agent's own helpers in the thread it is in;
 * helpers themselves are denied this tool (no nesting).
 */
const definition: BuiltinToolDefinition = {
  id: 'subagent',
  name: 'Subagent',
  type: 'builtin',
  tier: 'core',
  contextRequirement: 'agent-required',
  // Needs a calling agent in a live thread; the panel and /api/tools/execute refuse it.
  dispatchOnly: true,
  destructiveOps: [],
  description:
    'Hand a self-contained task to a named helper that works in its own hidden thread while you keep going. ' +
    'op start (name, model, brief; optional tools, instructions) returns at once; start several in one turn to work in parallel. ' +
    'wait (optional names, timeout_seconds up to 240) blocks until they finish and returns their reports: use it when you need the reports in this turn. ' +
    'If you end your turn instead, each report arrives later as a separate Snaglet message that wakes you. ' +
    'Helpers cannot ask the user, write memory or start helpers, so the brief must hold everything they need. ' +
    'Never write or guess a report yourself: wait for it, or end your turn. ' +
    'send (name, message): more work, the answer to its question, or a redirect; it also resumes a paused helper. A helper you do not send to during the turn that reads its report is removed when that turn ends, unless it failed or is paused. ' +
    'stop (name) pauses it: its run stops and it is kept with its work, doing nothing, until you send it something. ' +
    'pause (name, plus for like "15m" or "2h", or until as an ISO time) pauses it and resumes it on its own then. ' +
    'update (name, instructions) replaces its standing instructions from its next turn. ' +
    "remove (name): stop it and delete it with its thread. list: this thread's helpers. models: the models your helpers can run on (ids to pass as model). " +
    'pause\'s for and until are not listed: tool({op:"schema", name:"subagent"}) returns them as unlisted_parameters.',
  keywords: [
    'subagent',
    'helper',
    'delegate',
    'parallel',
    'parallelize',
    'fan out',
    'background task',
    'spawn',
    'worker',
    'research in parallel',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: ['start', 'send', 'wait', 'stop', 'pause', 'update', 'remove', 'list', 'models'],
      },
      name: {
        type: 'string',
        description:
          'start: a short name for the helper, unique among this thread\'s live helpers (e.g. "Scout"). send/stop/pause/update/remove: which helper.',
      },
      model: {
        type: 'string',
        description:
          'start: a model id on your own provider. An unknown one is refused with the list to pick from.',
      },
      brief: {
        type: 'string',
        description:
          'start: the whole assignment: goal, context, constraints, and what the report must contain.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'start: optional; limit the helper to these tool ids (never more than you have).',
      },
      instructions: {
        type: 'string',
        description:
          'start: optional standing rules for all its work, added to its system prompt (≤8000 characters); the brief is its first task. update: the new instructions; "" clears them.',
      },
      message: { type: 'string', description: 'send: the follow-up task or the answer.' },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'wait: helpers to wait for (default: all of yours that are running).',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: 1,
        maximum: 240,
        description: 'wait: longest to wait (default and maximum 240).',
      },
    },
  },
  // pause's for/until: accepted (the handler reads input directly; nothing
  // checks it against parameters_schema) but not advertised, to save tokens
  // on every turn. tool(op:schema) returns them as `unlisted_parameters`;
  // TOOL.md lists them.
  unlisted_params: {
    for: {
      type: 'string',
      description:
        'pause: how long before it resumes on its own, e.g. "15m", "2h", "1h30m" (1 minute to 7 days).',
    },
    until: {
      type: 'string',
      description:
        'pause: when it resumes on its own, an ISO date-time such as "2026-10-13T15:00:00Z" (up to 7 days ahead).',
    },
  },
};

export default definition;
