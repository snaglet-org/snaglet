import type { ToolHandler } from '@server/services/ToolService/types';
import createContainer from '@server/services/ToolService/handlers/containers/createContainer';
import updateContainer from '@server/services/ToolService/handlers/containers/updateContainer';

type Input = Record<string, unknown>;

/**
 * The fields each op reads. A field that belongs only to the other op is
 * refused before any handler runs, so a call can never half-mean another op
 * (e.g. `description` on a create, `parent_id` on an update). Unknown fields
 * pass through to the handler.
 *
 * `container_id` / `container_path` are alias names on both ops with
 * different meanings: on create they are the parent (aliases for
 * parent_id/parent_path); on update they are the target.
 */
const OP_FIELDS: Record<string, readonly string[]> = {
  create: [
    'name',
    'parent_id',
    'parent_path',
    'container_id',
    'container_path',
    'container',
    'parent',
    'container_name',
    'parent_name',
    'category',
    'folder_path',
    'github_url',
    'sort_order',
  ],
  update: [
    'id',
    'path',
    'container_id',
    'container_path',
    'description',
    'folder_path',
    'github_url',
  ],
};

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set(OP_FIELDS[op]);
  for (const [otherOp, fields] of Object.entries(OP_FIELDS)) {
    if (otherOp === op) continue;
    for (const field of fields) {
      if (!own.has(field) && input[field] !== undefined) {
        throw new Error(
          `container ${op}: \`${field}\` belongs to op ${otherOp}, not ${op}. Nothing was changed.`
        );
      }
    }
  }
}

// create's input passes through unchanged: its alias
// container_id/container_path (the parent) and loose parent keys reach
// the handler's own resolution and conflict checks.
const create: ToolHandler = (input, settings, context) => {
  const { op: _op, ...rest } = input;
  return createContainer(rest, settings, context);
};

// The update handler reads container_id/container_path (the target) and keys
// off which facet fields are present (null = clear), so only present fields
// are forwarded. An explicit container_id wins over `id`.
const update: ToolHandler = (input, settings, context) => {
  const out: Input = {};
  const target = input.container_id !== undefined ? input.container_id : input.id;
  const targetPath = input.container_path !== undefined ? input.container_path : input.path;
  if (target !== undefined) out.container_id = target;
  if (targetPath !== undefined) out.container_path = targetPath;
  for (const field of ['folder_path', 'github_url', 'description']) {
    if (input[field] !== undefined) out[field] = input[field];
  }
  return updateContainer(out, settings, context);
};

const OPS: Record<string, ToolHandler> = { create, update };

/**
 * container(op): one core noun tool over the container handlers, create and
 * update. Each op builds exactly the input its handler validates.
 */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!op || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(', ')}.`);
  }
  refuseForeignFields(op, input);
  return handler(input, settings, context);
};

export default tool;
