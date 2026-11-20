import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'custom_tool',
  name: 'Custom Tool',
  description:
    'Author custom TypeScript tools in the Snaglet tools home with op create/update. create scaffolds a definition.json + tool.ts folder and waits for the live scanner to build and register it; an existing name is rejected. update changes an existing custom tool’s description, parameters_schema and/or tool.ts (what you omit is kept) and returns the build error if it fails. create and update both ask the user first (the code runs as the user). To find or inspect tools use tool.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['tool', 'create', 'update', 'scaffold', 'typescript', 'custom', 'workspace'],
  // Both ops put agent-authored Node code into the tools home where the live
  // scanner builds and registers it to run as the user, so a guarded agent
  // asks first. create registers a new tool; update swaps an existing one.
  destructiveOps: ['create', 'update'],
  parameters_schema: {
    type: 'object',
    required: ['op', 'name'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: ['create', 'update'],
        description: 'create a new custom tool, or update an existing one.',
      },
      name: {
        type: 'string',
        description:
          'Folder and declared tool name: lowercase letters, numbers, hyphens (e.g. export-report).',
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        maxLength: 64,
      },
      description: {
        type: 'string',
        description:
          'Agent-facing description of what the tool does. Required by create; optional for update.',
      },
      parameters_schema: {
        type: 'object',
        description:
          'JSON Schema for the tool input. create defaults to an object with no properties; update keeps the current one when omitted.',
      },
      handler_source: {
        type: 'string',
        description:
          'Complete TypeScript source for tool.ts; it must default-export an async handler. create generates a no-op when omitted; update keeps the current source when omitted.',
      },
    },
  },
  unlisted_params: {
    overwrite: {
      type: 'boolean',
      description:
        'create only, legacy create_tool flag: replace an existing same-name folder. Prefer op "update".',
    },
  },
  sort_order: 12,
};

export default definition;
