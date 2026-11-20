import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'ask',
  name: 'Ask',
  // Blocks on context.requestClarification, which only the live socket
  // dispatch loop injects — headless/panel runs always throw. Panel hides
  // Run and /api/tools/execute rejects it.
  dispatchOnly: true,
  description:
    'Ask: ask the user structured questions and PAUSE until they answer; the answers are the result. ' +
    'Use it only for a real decision the request, context or a sensible default cannot settle and that changes your next step, ' +
    'never for what you can decide or look up. Batch related questions into ONE call; prefer select types with good options, allow_other if they may be incomplete.',
  type: 'builtin',
  tier: 'core',
  keywords: [
    'triage',
    'ask',
    'clarify',
    'clarification',
    'question',
    'confirm',
    'choose',
    'decision',
    'options',
    'input',
    'prompt user',
  ],
  parameters_schema: {
    type: 'object',
    required: ['questions'],
    properties: {
      preamble: {
        type: 'string',
        description: 'Optional one line above the questions.',
      },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          required: ['id', 'prompt', 'type'],
          properties: {
            id: {
              type: 'string',
              description: 'snake_case answer key, unique in this call.',
            },
            prompt: { type: 'string' },
            type: {
              type: 'string',
              enum: ['text', 'single_select', 'multi_select'],
              description: 'text: free answer; single_select: one; multi_select: one or more.',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'required for the select types',
            },
            allow_other: {
              type: 'boolean',
              description: 'selects: add a free-text "Other…" field',
            },
            min_select: {
              type: 'integer',
              description: 'multi_select; default 1',
            },
            max_select: {
              type: 'integer',
              description: 'multi_select; omit for no limit',
            },
            required: {
              type: 'boolean',
              description: 'default true',
            },
          },
        },
      },
    },
  },
};

export default definition;
