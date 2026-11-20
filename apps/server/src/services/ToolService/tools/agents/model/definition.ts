import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * model(op) — list_models (op list) and add_model (op add) as one tool for the
 * model entity. list keeps list_models' `operation` (providers | models);
 * both old ids are op-pinned aliases in toolAliases.ts.
 */
const definition: BuiltinToolDefinition = {
  id: 'model',
  name: 'Model',
  type: 'builtin',
  tier: 'standard',
  destructiveOps: [],
  description:
    'LLM providers and models. op list: operation:"providers" (default) lists configured ' +
    'providers; operation:"models" with provider_id lists that provider\'s live chat-model catalog. ' +
    'op add: add a custom chat model (and its metadata) to an LLM provider, or update one already there — ' +
    'needs provider_id + model_id; blank fields keep their values; a removed model is restored.',
  keywords: [
    'model',
    'models',
    'provider',
    'providers',
    'llm',
    'catalog',
    'custom model',
    'add model',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: { type: 'string', enum: ['list', 'add'] },
      operation: {
        type: 'string',
        enum: ['providers', 'models'],
        default: 'providers',
        description: "list: providers, or one provider's models.",
      },
      provider_id: {
        type: 'string',
        description:
          'list (models view)/add (required): provider id (e.g. "anthropic", "openai", "ollama").',
      },
      model_id: {
        type: 'string',
        description: 'add (required): the model id the provider API expects (e.g. "gpt-4.1-mini").',
      },
      display_name: {
        type: 'string',
        description: 'add: label shown in Snaglet. Defaults to model_id.',
      },
      context_window_tokens: { type: 'integer', minimum: 1 },
      max_output_tokens: { type: 'integer', minimum: 1 },
      metadata: {
        type: 'object',
        description: 'add: optional per-model tuning. Unlisted keys are rejected.',
        properties: {
          safetyMarginPct: {
            type: 'number',
            minimum: 0,
            maximum: 90,
            description: 'Percent shaved off the context window before budgeting.',
          },
          cacheTtl: { type: 'string', enum: ['5m', '1h'], description: 'Prompt-cache TTL.' },
          contextCompression: {
            type: 'object',
            properties: {
              tokenBudgetRatio: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
              tailMessages: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
          summary: {
            type: 'object',
            properties: {
              maxWords: { type: 'integer', minimum: 1 },
              tokenThreshold: { type: 'integer', minimum: 1 },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
};

export default definition;
