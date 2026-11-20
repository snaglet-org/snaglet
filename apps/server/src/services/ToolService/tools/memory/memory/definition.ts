import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'memory',
  name: 'Memory',
  description:
    'Your long-term memory. op: search (recall by relevance — check before asking the user), create (save a durable fact; reusing a key updates it), update (change one memory by memory_id or key), delete (by memory_id or a substring query).',
  type: 'builtin',
  tier: 'core',
  // Owner-scoped store; every op resolves agent XOR member.
  contextRequirement: 'agent-required',
  keywords: [
    'memory',
    'remember',
    'recall',
    'save',
    'search',
    'edit',
    'update',
    'forget',
    'delete',
    'note',
    'preference',
    'prior decision',
  ],
  parameters_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['search', 'create', 'update', 'delete'] },
      query: {
        type: 'string',
        description: 'search: what to recall. delete: substring matched against key/content.',
      },
      limit: { type: 'integer', minimum: 1, default: 5, description: 'search: max results.' },
      content: {
        type: 'string',
        description: 'create: the fact. update: new or appended text (mode overwrite|append).',
      },
      key: {
        type: 'string',
        description: 'create: optional stable key (reuse updates). update: target by key.',
      },
      memory_id: { type: 'string', description: 'update/delete: target by id.' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append', 'replace'],
        description: 'update: how to change the content.',
      },
      find: { type: 'string', description: 'update replace: literal text to find.' },
      replace_with: {
        type: 'string',
        description: 'update replace: replacement ("" deletes the found text).',
      },
      all: { type: 'boolean', description: 'update replace: every occurrence.' },
      separator: { type: 'string', description: 'update append: joiner (default newline).' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  sort_order: 30,
};

export default definition;
