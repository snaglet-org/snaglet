/**
 * bulk_import — import a nested workspace tree.
 *
 * Pairs with `bulk_export`. Tree shape:
 *   { kind: 'container', name, children: [...] }
 *   { kind: 'doc',       title, content? }
 *
 * Modes:
 *   - `create` (default): each container/doc must not have a sibling with the
 *     same name/title under its parent. Conflicts throw before any writes.
 *   - `merge`: existing containers (matched by case-insensitive name) are
 *     reused as the target for their children; existing docs (matched by
 *     case-insensitive title under the same container) have their content
 *     overwritten with the imported content.
 *
 * `dry_run: true` performs validation + plan computation but no writes.
 *
 * A magic top-level container name `"<workspace>"` is unwrapped — its children
 * are imported directly under the parent, allowing a full-workspace export to
 * round-trip cleanly.
 *
 * Atomic guarantee (live runs): on the first error, we attempt to roll back
 * containers we created during this run via best-effort cascading deletes.
 * This is best-effort rollback, not a SQL transaction: the underlying
 * Containers/Docs models don't expose a single-transaction API.
 */

import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveContainerReference } from '@server/services/WorkspaceService/pathResolver';
import {
  emitDocBodySaved,
  emitTreeNodeCreated,
  snapshotFromContainer,
  snapshotFromDoc,
} from '@server/realtime/surfaces/tree';
import type { WorkspaceNodeSnapshot } from '@snaglet/shared/types/workspace-events';
import { getErrorMessage } from '@snaglet/shared/utils';

type TreeNode = ContainerNode | DocNode;
interface ContainerNode {
  kind: 'container';
  name: string;
  children?: TreeNode[];
}
interface DocNode {
  kind: 'doc';
  title: string;
  content?: string;
}

interface PlanAction {
  action: 'create_container' | 'reuse_container' | 'create_doc' | 'update_doc';
  kind: 'container' | 'doc';
  name: string;
  parent_path: string; // human-readable trace, like `/Imports/Snaglet/docs`
  existing_id?: string;
}

interface ParsedInput {
  tree: TreeNode;
  parent_id?: string;
  parent_path?: string;
  mode: 'create' | 'merge';
  dry_run: boolean;
}

function isTreeNode(v: unknown): v is TreeNode {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'container') return typeof o.name === 'string';
  if (o.kind === 'doc') return typeof o.title === 'string';
  return false;
}

function parseInput(input: unknown): ParsedInput {
  if (!input || typeof input !== 'object') {
    throw new Error('bulk_import: input must be an object');
  }
  const i = input as Record<string, unknown>;
  if (!isTreeNode(i.tree)) {
    throw new Error('bulk_import: `tree` must be a valid container or doc node');
  }
  if (i.parent_id !== undefined && i.parent_id !== null && typeof i.parent_id !== 'string') {
    throw new Error('bulk_import: `parent_id` must be a string when provided');
  }
  if (i.parent_path !== undefined && i.parent_path !== null && typeof i.parent_path !== 'string') {
    throw new Error('bulk_import: `parent_path` must be a string when provided');
  }
  const mode =
    i.mode === undefined ? 'create' : i.mode === 'create' || i.mode === 'merge' ? i.mode : null;
  if (mode === null) {
    throw new Error('bulk_import: `mode` must be "create" or "merge"');
  }
  const dry_run = i.dry_run === undefined ? false : !!i.dry_run;
  return {
    tree: i.tree as TreeNode,
    parent_id: (i.parent_id as string | undefined) || undefined,
    parent_path: (i.parent_path as string | undefined) || undefined,
    mode,
    dry_run,
  };
}

function eqName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * Recursively validate the entire tree's structural shape before any writes.
 */
function deepValidate(node: TreeNode, path: string): void {
  if (node.kind === 'container') {
    if (!node.name || node.name.trim().length === 0) {
      throw new Error(`bulk_import: container at ${path} has empty name`);
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        throw new Error(`bulk_import: container at ${path} has non-array children`);
      }
      for (let idx = 0; idx < node.children.length; idx++) {
        const child = node.children[idx];
        if (!isTreeNode(child)) {
          throw new Error(`bulk_import: invalid child at ${path}[${idx}]`);
        }
        deepValidate(child, `${path}/${child.kind === 'container' ? child.name : child.title}`);
      }
    }
  } else {
    if (!node.title || node.title.trim().length === 0) {
      throw new Error(`bulk_import: doc at ${path} has empty title`);
    }
    if (node.content !== undefined && typeof node.content !== 'string') {
      throw new Error(`bulk_import: doc at ${path} has non-string content`);
    }
  }
}

interface ImportContext {
  mode: 'create' | 'merge';
  dryRun: boolean;
  plan: PlanAction[];
  createdContainerIds: string[]; // for rollback on failure
  createdDocIds: string[]; // for rollback on failure
  createdNodes: WorkspaceNodeSnapshot[];
  docSaves: Array<{ id: string; body: string; updatedAt: string; lastEditedBy: string | null }>;
}

async function importChildren(
  children: TreeNode[],
  parentId: string | null,
  parentPath: string,
  ctx: ImportContext
): Promise<void> {
  // Snapshot existing siblings ONCE so repeated lookups in merge mode are cheap.
  const existingContainers = await Containers.listByParent(parentId);
  const existingDocs = await Docs.listByContainer(parentId);

  // We mutate these lists as we add new entries so subsequent siblings see them.
  const containerByLowerName = new Map<string, { id: string; name: string }>();
  for (const c of existingContainers) containerByLowerName.set(c.name.toLowerCase(), c);
  const docByLowerTitle = new Map<string, { id: string; title: string }>();
  for (const d of existingDocs) docByLowerTitle.set(d.title.toLowerCase(), d);

  // Pre-validate sibling collisions for create mode (whole batch).
  if (ctx.mode === 'create') {
    for (const child of children) {
      if (child.kind === 'container' && containerByLowerName.has(child.name.toLowerCase())) {
        throw new Error(
          `bulk_import: container "${child.name}" already exists under ${parentPath} (mode=create)`
        );
      }
      if (child.kind === 'doc' && docByLowerTitle.has(child.title.toLowerCase())) {
        throw new Error(
          `bulk_import: doc "${child.title}" already exists under ${parentPath} (mode=create)`
        );
      }
    }
  }

  // Walk children in order, applying actions.
  for (const child of children) {
    if (child.kind === 'container') {
      const existing = containerByLowerName.get(child.name.toLowerCase());
      if (existing && ctx.mode === 'merge') {
        ctx.plan.push({
          action: 'reuse_container',
          kind: 'container',
          name: child.name,
          parent_path: parentPath,
          existing_id: existing.id,
        });
        if (child.children && child.children.length > 0) {
          await importChildren(child.children, existing.id, `${parentPath}/${child.name}`, ctx);
        }
      } else {
        ctx.plan.push({
          action: 'create_container',
          kind: 'container',
          name: child.name,
          parent_path: parentPath,
        });
        let newId: string;
        if (ctx.dryRun) {
          // Use a virtual id so downstream children can be planned coherently.
          newId = `__dry_run_container_${ctx.plan.length}__`;
        } else {
          const created = await Containers.create({
            name: child.name,
            parentId,
          });
          newId = created.id;
          ctx.createdContainerIds.push(newId);
          ctx.createdNodes.push(snapshotFromContainer(created));
        }
        containerByLowerName.set(child.name.toLowerCase(), { id: newId, name: child.name });
        if (child.children && child.children.length > 0) {
          await importChildren(child.children, newId, `${parentPath}/${child.name}`, ctx);
        }
      }
    } else {
      const existing = docByLowerTitle.get(child.title.toLowerCase());
      if (existing && ctx.mode === 'merge') {
        ctx.plan.push({
          action: 'update_doc',
          kind: 'doc',
          name: child.title,
          parent_path: parentPath,
          existing_id: existing.id,
        });
        if (!ctx.dryRun) {
          const updated = await Docs.update(existing.id, { content: child.content ?? '' });
          if (updated) {
            ctx.docSaves.push({
              id: updated.id,
              body: updated.content ?? '',
              updatedAt: updated.updatedAt,
              lastEditedBy: updated.lastEditedBy,
            });
          }
        }
      } else {
        ctx.plan.push({
          action: 'create_doc',
          kind: 'doc',
          name: child.title,
          parent_path: parentPath,
        });
        if (!ctx.dryRun) {
          const created = await Docs.create({
            title: child.title,
            containerId: parentId,
            content: child.content ?? '',
          });
          ctx.createdDocIds.push(created.id);
          ctx.createdNodes.push(snapshotFromDoc(created));
          docByLowerTitle.set(child.title.toLowerCase(), { id: created.id, title: child.title });
        } else {
          docByLowerTitle.set(child.title.toLowerCase(), {
            id: `__dry_run_doc_${ctx.plan.length}__`,
            title: child.title,
          });
        }
      }
    }
  }
}

async function bestEffortRollback(
  ctx: ImportContext
): Promise<{ rolled_back: number; rollback_errors: string[] }> {
  const errors: string[] = [];
  // Delete docs first (containers may cascade, but docs first is safer).
  for (let i = ctx.createdDocIds.length - 1; i >= 0; i--) {
    try {
      await Docs.delete(ctx.createdDocIds[i]);
    } catch (err) {
      errors.push(`doc ${ctx.createdDocIds[i]}: ${getErrorMessage(err)}`);
    }
  }
  // Then containers, deepest first (we created them in pre-order, so reverse).
  // This importer creates only containers and docs; it never creates, moves, or
  // executes threads, so these fresh rollback-only containers cannot own thread
  // execution state and do not need the runtime purge reservation service.
  for (let i = ctx.createdContainerIds.length - 1; i >= 0; i--) {
    try {
      await Containers.delete(ctx.createdContainerIds[i]);
    } catch (err) {
      errors.push(`container ${ctx.createdContainerIds[i]}: ${getErrorMessage(err)}`);
    }
  }
  return {
    rolled_back: ctx.createdDocIds.length + ctx.createdContainerIds.length - errors.length,
    rollback_errors: errors,
  };
}

const handler: ToolHandler = async (input, _settings, _context) => {
  const params = parseInput(input);
  deepValidate(params.tree, '<root>');

  const parentId = await resolveContainerReference(params.parent_id, params.parent_path);
  const parentPath =
    params.parent_path ?? (parentId === null ? '<workspace>' : `<container:${parentId}>`);

  // Unwrap the magic top-level `<workspace>` container.
  let topLevelChildren: TreeNode[];
  if (params.tree.kind === 'container' && params.tree.name === '<workspace>') {
    topLevelChildren = params.tree.children ?? [];
  } else {
    topLevelChildren = [params.tree];
  }

  const ctx: ImportContext = {
    mode: params.mode,
    dryRun: params.dry_run,
    plan: [],
    createdContainerIds: [],
    createdDocIds: [],
    createdNodes: [],
    docSaves: [],
  };

  try {
    await importChildren(topLevelChildren, parentId, parentPath, ctx);
  } catch (err) {
    // If we haven't written anything yet (e.g. pre-write collision in create
    // mode, dry-run, or validation error), rethrow so the caller sees a clean
    // error. Only soft-fail with rollback when we have partial writes to undo.
    const partialWrites = ctx.createdContainerIds.length + ctx.createdDocIds.length;
    if (partialWrites === 0 || params.dry_run) {
      throw err;
    }
    const rb = await bestEffortRollback(ctx);
    const out = {
      success: false,
      error: getErrorMessage(err),
      ...rb,
      plan_before_failure: ctx.plan,
    };
    return { output: JSON.stringify(out, null, 2), rawContent: out };
  }

  for (const node of ctx.createdNodes) {
    emitTreeNodeCreated(node);
  }
  for (const save of ctx.docSaves) {
    emitDocBodySaved(save.id, save.body, save.updatedAt, save.lastEditedBy);
  }

  const counts = ctx.plan.reduce(
    (acc, p) => {
      acc[p.action] = (acc[p.action] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const out = {
    success: true,
    dry_run: params.dry_run,
    mode: params.mode,
    parent_id: parentId,
    total_actions: ctx.plan.length,
    counts,
    plan: ctx.plan,
  };
  return { output: JSON.stringify(out, null, 2), rawContent: out };
};

export default handler;
