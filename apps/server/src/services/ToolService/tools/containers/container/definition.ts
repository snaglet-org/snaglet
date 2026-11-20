import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * container(op): create and update containers. Renames, moves and archives
 * live on `node`.
 *
 * Schema is flat (like `doc`/`node`): each property says which op reads it.
 * The old ids create_container and update_container are op-pinned aliases in
 * toolAliases.ts, so an access rule naming one covers exactly its op (allow:
 * create_container never grants update). `container_id` / `container_path`
 * are not schema fields (the schema shows only `id` / `path`): they are
 * op-specific alias names (create: the parent; update: the target), mapped in
 * tool.ts.
 */
const definition: BuiltinToolDefinition = {
  id: 'container',
  name: 'Container',
  description:
    'Create a container, or change its description / project facets. ' +
    'op create: `name` (unique among siblings), parent via `parent_id` (a container id, not a display name) or `parent_path` (e.g. "/Snaglet/docs"); omit both to use the calling thread\u2019s container (root for flat threads). An unresolvable parent is an error, never root. `category:"project"` makes a project; a project may also set `folder_path` (absolute local code path) and `github_url`. ' +
    'op update: target by `id` or `path`; set `description` (any container; a search signal, and project context) and/or `folder_path` / `github_url` (projects). `null` or "" clears a field; omitted fields are unchanged. This tool does not change a category: a person promotes a container to a project in its Properties, and a project never loses its project category. Load the `snaglet-projects` skill before creating a project or linking a folder (over 500 files needs a person\u2019s confirmation). ' +
    'Rename, move and archive a container with `node`.',
  type: 'builtin',
  tier: 'core',
  // Neither create_container nor update_container was destructive.
  destructiveOps: [],
  // Old ids stay findable via tool(op:search/schema); each is also an
  // op-pinned alias in toolAliases.ts.
  aliases: ['create_container', 'update_container'],
  keywords: [
    'workspace',
    'container',
    'folder',
    'create',
    'update',
    'library',
    'organize',
    'hierarchy',
    'project',
    'github',
    'description',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['create', 'update'] },
      name: { type: 'string', minLength: 1, description: 'create: display name.' },
      parent_id: { type: 'string', description: 'create: parent container id.' },
      parent_path: {
        type: 'string',
        description: 'create: instead of parent_id, slash path like "/Snaglet/docs".',
      },
      category: {
        type: 'string',
        enum: ['project'],
        description: 'create: "project" makes a project.',
      },
      sort_order: { type: 'integer', description: 'create: slot among siblings.' },
      id: { type: 'string', description: 'update: container id.' },
      path: { type: 'string', description: 'update: instead of id, slash path.' },
      description: {
        type: ['string', 'null'],
        description: 'update: free-text description; null/"" clears.',
      },
      folder_path: {
        type: ['string', 'null'],
        description:
          'create/update (projects): absolute local path to the code; update: null/"" clears.',
      },
      github_url: {
        type: ['string', 'null'],
        description: 'create/update (projects): git repository URL; update: null/"" clears.',
      },
    },
  },
  sort_order: 6,
};

export default definition;
