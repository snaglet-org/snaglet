import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * automation(op) — scheduled wakes. An agent
 * schedules wakes for itself in its own thread; at each wake the prompt
 * arrives as a message. Every write goes through AutomationService.
 */
const definition: BuiltinToolDefinition = {
  id: 'automation',
  name: 'Automation',
  type: 'builtin',
  tier: 'standard',
  contextRequirement: 'agent-optional',
  destructiveOps: [],
  description:
    'Wake yourself later in your thread (people can also wake another agent or thread). ' +
    'Each wake posts the prompt as a message, so idle work is picked up again; nothing runs between wakes. ' +
    'op run: one test wake now; runs: past wakes. ' +
    'when: e.g. {in:"2h"}, {repeat:"FREQ=DAILY", at:"09:00"}, {every:"30m"} (+ window_start/window_end), {first_open:true}; plus tz. ' +
    'calendar_id and the list/runs filters are not listed: tool({op:"schema", name:"automation"}) returns them as unlisted_parameters.',
  keywords: [
    'automation',
    'schedule',
    'scheduled',
    'remind',
    'reminder',
    'remind me',
    'wake',
    'wake me',
    'later',
    'every',
    'every day',
    'every morning',
    'first open',
    'when snaglet opens',
    'recurring',
    'cron',
    'timer',
    'check back',
    'follow up',
    'run now',
    'test run',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: ['create', 'list', 'get', 'update', 'disable', 'enable', 'cancel', 'run', 'runs'],
      },
      id: { type: 'string', description: 'Every op but create/list: the automation id.' },
      name: { type: 'string', description: 'create/update: a short name (1–80 characters).' },
      prompt: {
        type: 'string',
        description: 'create/update: what you are told at each wake (1–4000 characters).',
      },
      when: {
        type: 'object',
        description:
          'create/update: exactly one of in, at, repeat (+ at HH:mm), every (+ at, or window_start + window_end), first_open (+ after).',
        additionalProperties: false,
        properties: {
          in: { type: 'string', description: '"30m", "2h" or "1d" from now.' },
          at: {
            type: 'string',
            description:
              'Local "2026-10-14T09:00"; with repeat, "09:00"; with every, the first run.',
          },
          repeat: { type: 'string', description: 'RRULE body, DAILY to YEARLY.' },
          starts: {
            type: 'string',
            description: 'repeat: first day, "2026-10-14" (default today).',
          },
          every: {
            type: 'string',
            description: '"15m", "2h", "1d". Agents: ≥15m, or ≥5m with a window ≤2h.',
          },
          window_start: {
            type: 'string',
            description:
              'every: daily window start, local "05:05" (with window_end, not at); runs at it, then every interval.',
          },
          window_end: {
            type: 'string',
            description:
              'every: last run time each day, "06:00" (inclusive); earlier than window_start crosses midnight.',
          },
          first_open: {
            type: 'boolean',
            description:
              'Once a day, when Snaglet is first open and awake at or after `after`; a day Snaglet is not open is skipped.',
          },
          after: {
            type: 'string',
            description: 'first_open: earliest local time, "05:00" (default).',
          },
          tz: { type: 'string', description: 'IANA zone (default: the user’s).' },
        },
      },
    },
  },
  // Not advertised, to save tokens on every turn (nothing checks input
  // against parameters_schema): create's thread_id/agent_id (people only),
  // calendar_id, and list/runs' filters and paging. tool(op:schema) returns
  // them as `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    calendar_id: {
      type: ['string', 'null'],
      description: 'create/update: the calendar (default: Default; null: none).',
    },
    status: {
      type: 'string',
      enum: ['active', 'paused', 'finished', 'cancelled', 'all'],
      description: 'list: which (default active).',
    },
    mine: {
      type: 'boolean',
      description: 'list: only the ones that wake you (default true).',
    },
    limit: { type: 'integer', description: 'runs: how many, newest first (default 10, max 50).' },
    before: { type: 'string', description: 'runs: the previous page’s next_cursor.' },
    thread_id: {
      type: 'string',
      description: 'create: the thread to wake in (people only; agents: their own thread).',
    },
    agent_id: {
      type: 'string',
      description: 'create: the agent to wake (people only; agents: themselves).',
    },
  },
  sort_order: 60,
};

export default definition;
