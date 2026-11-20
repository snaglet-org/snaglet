import type { ToolHandler } from '@server/services/ToolService/types';
import getNode from '@server/services/ToolService/handlers/workspace/getNode';
import verifyIds from '@server/services/ToolService/handlers/workspace/verifyIds';
import workspaceTree from '@server/services/ToolService/handlers/workspace/workspaceTreeOp';
import archiveNode from '@server/services/ToolService/handlers/workspace/archiveNode';
import restoreNode from '@server/services/ToolService/handlers/workspace/restoreNode';
import moveNode from '@server/services/ToolService/handlers/workspace/moveNode';
import renameNode from '@server/services/ToolService/handlers/workspace/renameNode';

type Input = Record<string, unknown>;

const json = (value: unknown): string => JSON.stringify(value);
const defined = (entries: Record<string, unknown>): Input =>
  Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));

/** Kind hint for move/rename: `node` (archive's default) means "no hint". */
function hintKind(kind: unknown): string | undefined {
  return typeof kind === 'string' && kind !== 'node' ? kind : undefined;
}

const get: ToolHandler = async (input) => {
  if (input.ids !== undefined) {
    if (input.id !== undefined) throw new Error('node get: pass either `id` or `ids`, not both.');
    return json(await verifyIds({ ids: input.ids as string[] }));
  }
  return json(
    await getNode({
      node_id: input.id as string,
      ...defined({
        include_children: input.include_children,
        include_archived: input.include_archived,
      }),
    } as Parameters<typeof getNode>[0])
  );
};

const tree: ToolHandler = (input, settings, context) =>
  workspaceTree(
    defined({
      container_id: input.id,
      path: input.path,
      name: input.name,
      kinds: input.kinds,
      scope: input.scope,
    }),
    settings,
    context
  );

const archive: ToolHandler = async (input, _settings, context) =>
  json(
    await archiveNode(
      defined({
        id: input.id,
        path: input.path,
        kind: input.kind === 'container' ? 'container' : 'node',
      }) as Parameters<typeof archiveNode>[0],
      undefined,
      context
    )
  );

const restore: ToolHandler = async (input, _settings, context) =>
  json(
    await restoreNode(
      {
        node_id: input.id as string,
        ...(input.parent_id !== undefined
          ? { container_id: input.parent_id as string | null }
          : {}),
      },
      undefined,
      context
    )
  );

/**
 * move and rename are separate ops so every old id pins one op and access
 * rules stay op-level: `allow: move` never grants a rename. Each op runs its
 * own handler, which checks everything before writing.
 */
const move: ToolHandler = (input, settings, context) => {
  if (input.title !== undefined || input.new_title !== undefined) {
    throw new Error(
      'node move: `title` is not a move field. Rename with node(op:"rename", title). Nothing was changed.'
    );
  }
  // move never had a preview mode; refuse rather than silently write.
  if (input.validate_only !== undefined) {
    throw new Error('node move: `validate_only` applies to rename only. Nothing was changed.');
  }
  return moveNode(
    defined({
      id: input.id,
      path: input.path,
      kind: hintKind(input.kind),
      new_parent_id: input.parent_id,
      new_parent_path: input.parent_path,
      sort_order: input.sort_order,
      allow_archived: input.allow_archived,
    }),
    settings,
    context
  );
};

const rename: ToolHandler = (input, settings, context) => {
  const kind = hintKind(input.kind);
  if (kind === 'thread') {
    throw new Error(
      'node rename: applies to docs, containers and images, not a thread.' +
        ' Rename a thread with thread(op:"update", title). Nothing was changed.'
    );
  }
  for (const field of ['parent_id', 'parent_path', 'sort_order'] as const) {
    if (input[field] !== undefined) {
      throw new Error(
        `node rename: \`${field}\` is not a rename field. Move with node(op:"move"). Nothing was changed.`
      );
    }
  }
  return renameNode(
    defined({
      id: input.id,
      path: input.path,
      kind,
      new_title: input.title,
      update_inline_labels: input.update_inline_labels,
      validate_only: input.validate_only,
      allow_archived: input.allow_archived,
    }),
    settings,
    context
  );
};

const OPS: Record<string, ToolHandler> = { get, tree, move, rename, archive, restore };

/**
 * node(op): one noun tool over the workspace-node handlers: get (with
 * verify_ids), tree, move, rename, archive and restore. Each op builds exactly
 * the input its handler validates.
 */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  return handler(input, settings, context);
};

export default tool;
