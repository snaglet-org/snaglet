import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * Note what is not here: there is no `agent_id` parameter.
 *
 * Memory export is bound to the calling agent's id from tool context. Adding
 * an `agent_id` input would create exactly the identity hole the MCP
 * projection refuses for `memory_recall`: memories are keyed by
 * `agents.id`, and a parameter naming an arbitrary agent is a request to read
 * someone else's. The parameter's absence is the enforcement; the handler's
 * check is the backstop.
 */
const definition: BuiltinToolDefinition = {
  id: 'export_node',
  name: 'Export Node',
  type: 'builtin',
  tier: 'standard',
  // `own_memories` needs a calling agent to bind to; the node kinds do not,
  // but the tool as a whole is agent-invoked.
  contextRequirement: 'agent-optional',
  description:
    'Write a workspace node to a folder on this computer as a file. Docs, threads and images ' +
    'export to the chosen folder; `own_memories` writes everything YOU remember to one markdown ' +
    "file. The destination must be an existing folder outside Snaglet's own storage. Existing files " +
    'are never overwritten — a name collision gets a " (2)" suffix.',
  keywords: ['export', 'save', 'file', 'download', 'markdown', 'backup', 'disk'],
  parameters_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['doc', 'thread', 'image', 'own_memories'],
        description:
          'What to export. `own_memories` writes all of YOUR memories; it never reads another ' +
          "agent's.",
      },
      id: {
        type: 'string',
        description:
          'The node id to export (doc/thread/image). Omit for `own_memories` — your own id is used.',
      },
      dest_dir: {
        type: 'string',
        description:
          'Absolute path to an EXISTING folder to write into. Must not be inside Snaglet storage.',
      },
      file_name: {
        type: 'string',
        description:
          'Optional filename. The extension is always set by Snaglet from the content type, so a ' +
          'mismatched one is replaced.',
      },
      message_limit: {
        type: 'integer',
        minimum: 1,
        description:
          'Threads only: export just the newest N messages instead of all of them. The file ' +
          'declares that it was truncated.',
      },
    },
    required: ['kind', 'dest_dir'],
    additionalProperties: false,
  },
  param_aliases: { path: ['dest_dir'], directory: ['dest_dir'], node_id: ['id'] },
};

export default definition;
