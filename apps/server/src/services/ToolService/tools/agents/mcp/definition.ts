import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * mcp(op) — MCP server management with the same rules as Settings → MCP
 * (/api/mcp/servers). create/update can make Snaglet launch a command or call a
 * URL, delete removes the server from every agent, and set_credential writes
 * a secret, so all four are confirm-gated (destructiveOps). restore is not:
 * it can only put back, exactly, a server the same agent deleted minutes ago.
 */
const definition: BuiltinToolDefinition = {
  id: 'mcp',
  name: 'MCP',
  type: 'builtin',
  tier: 'standard',
  destructiveOps: ['create', 'update', 'delete', 'set_credential'],
  description:
    'Manage MCP servers. op list / get (id) show config, live status and whether a credential is ' +
    'saved (literal env/header values masked); create (id, name, plus command for stdio or url ' +
    'for http/sse; command_args for its arguments); update (id; only fields you pass change); delete (id; also removes it from ' +
    'agents); restore (id; undoes your own delete within 10 minutes); test (id; one-shot ' +
    'connection check); set_credential (id + secret and/or bundle — ' +
    'reference it in env/headers as ${credential} or ${cred.<field>}). ' +
    'scope, enabled, autoload, requires_confirmation, provider_id and bundle are not listed: tool({op:"schema", name:"mcp"}) returns them as unlisted_parameters.',
  keywords: [
    'mcp',
    'mcp server',
    'add mcp server',
    'model context protocol',
    'connector',
    'server',
    'credential',
    'test connection',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'get', 'create', 'update', 'delete', 'restore', 'test', 'set_credential'],
      },
      id: {
        type: 'string',
        description:
          'Every op except list: server id (lowercase letters, digits, - or _). Its tools appear as mcp__<id>__<tool>.',
      },
      name: { type: 'string', description: 'create (required)/update: display name.' },
      transport: {
        type: 'string',
        enum: ['stdio', 'http', 'sse'],
        description: 'create/update: default stdio.',
      },
      command: { type: 'string', description: 'create/update, stdio: executable (e.g. "npx").' },
      // Not `args`: that name is reserved by the double-wrap unwrapper
      // (definitionWrapperKeys guard). Maps to the server's `args`.
      command_args: {
        type: 'array',
        items: { type: 'string' },
        description: 'create/update, stdio: command arguments.',
      },
      url: { type: 'string', description: 'create/update, http/sse: server URL.' },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'create/update, stdio: environment variables. Put secrets in via ${credential} / ${cred.<field>}, never literally.',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'create/update, http/sse: request headers. Use ${credential} / ${cred.<field>} for secrets.',
      },
      secret: {
        type: 'string',
        description: 'set_credential: one opaque secret, read by ${credential}.',
      },
    },
  },
  // The advanced create/update switches and set_credential's bundle:
  // accepted (the handlers read input directly; nothing checks it against
  // parameters_schema) but not advertised, to save tokens on every turn.
  // tool(op:schema) returns them as `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    scope: {
      type: 'string',
      enum: ['shared', 'per-agent'],
      description: 'create/update: one connection for all agents (default) or one each.',
    },
    enabled: {
      type: 'boolean',
      description: 'create (default true)/update (kept unless sent).',
    },
    autoload: {
      type: 'boolean',
      description: 'create/update: load its tools without a search.',
    },
    requires_confirmation: {
      type: 'boolean',
      description: "create/update: ask before each of the server's tool calls (default true).",
    },
    provider_id: {
      type: ['string', 'null'],
      description:
        'create/update, advanced: provider whose credential this server uses. Default: its own id.',
    },
    bundle: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'set_credential: named fields, each read by ${cred.<field>}.',
    },
  },
};

export default definition;
