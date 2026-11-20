import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'action',
  name: 'Action',
  description:
    'Execution gateway — run any available tool by passing its id, name, or alias plus params: action({tool, params}). Optional: tools can also be called directly as native tool calls; the gateway is a single-tool indirection for models that prefer it. Either path executes identically. Never imitate tool calls in chat text — submit a real tool call.',
  type: 'builtin',
  tier: 'core',
  // Pure dispatch gateway: ToolExecutor owns the real unwrap. The socket loop
  // pre-resolves it only to preserve live-turn confirmation/thread overrides;
  // HTTP/SDK/hook callers reach the same executor chokepoint.
  dispatchOnly: true,
  keywords: ['execute', 'action', 'run', 'invoke', 'tool', 'call', 'dispatch', 'gateway'],
  parameters_schema: {
    type: 'object',
    required: ['tool'],
    properties: {
      tool: {
        type: 'string',
        description: 'The tool to execute by ID or display name (e.g. file or "File")',
      },
      params: {
        type: 'object',
        description: 'Parameters for the tool',
      },
    },
  },
};

export default definition;
