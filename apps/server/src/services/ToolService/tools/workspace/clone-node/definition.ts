import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'clone_node',
  name: 'clone_node',
  description:
    'Clone a workspace node — copy/paste with fresh ids. A **doc** copies its content verbatim (links and transclusions pointing OUTSIDE the copy keep pointing at the originals). A **container** copies its WHOLE subtree (child docs and containers, plus the threads scoped to any project inside it), capped at 200 nodes; references between docs inside the copied subtree are re-pointed to their clones. A **thread** is cloned CONFIG-ONLY: a fresh, empty thread in the same project with the same title, dispatch config, system prompts, and participant set — no messages, memories, or summaries. Threads attach to a project, not a non-project container, so `target_container_id` applies to docs and containers only. Colliding titles get a ` (n)` suffix. To clone a single doc with a custom title, use `doc` (op `duplicate`).',
  tier: 'standard',
  type: 'builtin',
  keywords: [
    'workspace',
    'clone',
    'copy',
    'paste',
    'duplicate',
    'subtree',
    'doc',
    'container',
    'thread',
  ],
  parameters_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'ID of the node to clone (doc, container, or thread).',
      },
      target_container_id: {
        type: ['string', 'null'],
        description:
          "Where to paste the clone. OMIT to paste beside the original (into the source's own parent). Pass `null` (or an empty string) to paste at the workspace root. Pass a container id to paste into that container.",
      },
      sort_order: {
        type: 'number',
        description:
          "Explicit position under the target container. If omitted, the clone is appended (max sibling sort_order + 1) — except a thread copy, which starts at the top of its project's thread list (0).",
      },
      allow_archived: {
        type: 'boolean',
        description:
          'Allow cloning an archived source node (default: false — archived nodes are rejected by default).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

export default definition;
