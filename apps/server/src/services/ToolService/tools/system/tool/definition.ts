import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'tool',
  name: 'Tools',
  description:
    "Use this whenever the tool you need is not in your list: your list holds only the tools loaded now, not everything you can do. Never tell the user you can't do something, or that a tool is missing, until you have searched. op search finds tools by capability (name the thing or the verb); op schema returns one tool's parameters by id, name or alias. Call a found tool with action({tool, params}). If nothing fits, create one with custom_tool.",
  type: 'builtin',
  tier: 'core',
  keywords: ['tool', 'search', 'schema', 'find', 'discover', 'lookup', 'parameters', 'catalog'],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: ['search', 'schema'],
        description: 'search: find tools by capability. schema: fetch one tool’s parameters.',
      },
      query: {
        type: 'string',
        description: 'search: describe the capability you need rather than guessing a tool name.',
      },
      mode: {
        type: 'string',
        enum: ['hybrid', 'semantic', 'keyword', 'list'],
        description:
          "search: retrieval mode. 'hybrid' (default) fuses semantic and keyword; 'keyword' skips embeddings; 'list' returns compact assigned/unassigned catalog summaries and needs no query.",
      },
      explain: {
        type: 'boolean',
        description: 'search: include per-result ranking reasons and scores; default false.',
      },
      name: {
        type: 'string',
        description: 'schema: tool id (e.g. doc), display name or alias. Required.',
      },
    },
    examples: [
      { op: 'search', query: 'workspace doc' },
      { op: 'schema', name: 'doc' },
    ],
  },
  unlisted_params: {
    tool: {
      type: 'string',
      description: 'schema: the retired get_tool_schema spelling of `name`; still accepted.',
    },
  },
  sort_order: 6,
};

export default definition;
