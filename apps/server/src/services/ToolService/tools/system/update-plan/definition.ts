import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'update_plan',
  name: 'Update Plan',
  description:
    'Codex-compatible planning tool. Updates the current task plan with statuses so the agent can track multi-step work.',
  type: 'builtin',
  tier: 'core',
  keywords: ['codex', 'plan', 'planning', 'todo', 'steps', 'status', 'progress'],
  aliases: ['task_plan', 'set_plan', 'plan_update'],
  parameters_schema: {
    type: 'object',
    required: ['plan'],
    properties: {
      explanation: {
        type: 'string',
        description: 'Optional short explanation for this plan update.',
      },
      plan: {
        type: 'array',
        description: 'Plan items. At most one item should be in_progress.',
        items: {
          type: 'object',
          required: ['step', 'status'],
          properties: {
            step: {
              type: 'string',
              description: 'Task step text.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current step status.',
            },
          },
        },
      },
    },
  },
  sort_order: 4,
};

export default definition;
