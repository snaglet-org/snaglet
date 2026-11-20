/**
 * bulk_export — dump a workspace subtree as a nested JSON tree.
 *
 * Tree shape:
 *   { kind: 'container', name, children: [ ...nested nodes... ] }
 *   { kind: 'doc',       title, content? }
 *
 * The exported tree is structural — it intentionally omits ids, timestamps,
 * and sort_order so it can be re-imported (or imported into a different
 * workspace) without conflict. `bulk_import` consumes the same
 * shape.
 *
 * Strategy: a single SQL pull of all containers + (optionally) all docs in
 * one go, then in-memory subtree assembly. Avoids N+1 by indexing by parent.
 */

import { Containers } from '@snaglet/db/tables/containers';
import { getDb } from '@snaglet/db';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveContainerByPath } from '@server/services/WorkspaceService/pathResolver';

function parseInput(input: unknown): {
  root_id?: string;
  root_path?: string;
  include_content: boolean;
  max_nodes: number;
} {
  if (input !== undefined && input !== null && typeof input !== 'object') {
    throw new Error('bulk_export: input must be an object');
  }
  const i = (input ?? {}) as Record<string, unknown>;
  if (i.root_id !== undefined && i.root_id !== null && typeof i.root_id !== 'string') {
    throw new Error('bulk_export: `root_id` must be a string when provided');
  }
  if (i.root_path !== undefined && i.root_path !== null && typeof i.root_path !== 'string') {
    throw new Error('bulk_export: `root_path` must be a string when provided');
  }
  if (i.root_id && i.root_path) {
    throw new Error('bulk_export: provide either `root_id` or `root_path`, not both');
  }
  const include_content = i.include_content === undefined ? true : !!i.include_content;
  const max_nodes = i.max_nodes === undefined ? 2000 : Number(i.max_nodes);
  if (
    !Number.isFinite(max_nodes) ||
    max_nodes < 1 ||
    max_nodes > 10000 ||
    !Number.isInteger(max_nodes)
  ) {
    throw new Error('bulk_export: `max_nodes` must be an integer in 1..10000');
  }
  return {
    root_id: (i.root_id as string | undefined) || undefined,
    root_path: (i.root_path as string | undefined) || undefined,
    include_content,
    max_nodes,
  };
}

interface ContainerRowMin {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

interface DocRowMin {
  id: string;
  title: string;
  container_id: string | null;
  content: string;
  sort_order: number;
}

interface ExportedDoc {
  kind: 'doc';
  title: string;
  content?: string;
}

interface ExportedContainer {
  kind: 'container';
  name: string;
  children: Array<ExportedContainer | ExportedDoc>;
}

async function loadAll(): Promise<{ containers: ContainerRowMin[]; docs: DocRowMin[] }> {
  // Placement (parent_id, container_id, sort_order) is read from nodes, its
  // single source of truth. ContainerRowMin's parent_id is aliased from n.container_id.
  const pool = getDb();
  const [c, d] = await Promise.all([
    pool.query<ContainerRowMin>(
      `SELECT c.id, c.name,
              n.container_id AS parent_id,
              n.sort_order   AS sort_order
         FROM containers c
         JOIN nodes n ON n.id = c.id
        ORDER BY n.container_id NULLS FIRST, n.sort_order ASC, c.name ASC`
    ),
    pool.query<DocRowMin>(
      `SELECT d.id, d.title,
              n.container_id AS container_id,
              d.content,
              n.sort_order   AS sort_order
         FROM docs d
         JOIN nodes n ON n.id = d.id
        ORDER BY n.container_id NULLS FIRST, n.sort_order ASC, d.title ASC`
    ),
  ]);
  return { containers: c.rows, docs: d.rows };
}

const handler: ToolHandler = async (input, _settings, _context) => {
  const params = parseInput(input);

  // Resolve the root.
  let rootId: string | null = null;
  if (params.root_id) {
    const exists = await Containers.findById(params.root_id);
    if (!exists) {
      throw new Error(`bulk_export: root_id "${params.root_id}" not found`);
    }
    rootId = exists.id;
  } else if (params.root_path) {
    rootId = await resolveContainerByPath(params.root_path);
    if (!rootId) {
      throw new Error(`bulk_export: root_path "${params.root_path}" did not resolve`);
    }
  }

  const { containers, docs } = await loadAll();

  // Index for fast subtree assembly.
  const childrenByParent = new Map<string | null, ContainerRowMin[]>();
  for (const c of containers) {
    const arr = childrenByParent.get(c.parent_id) ?? [];
    arr.push(c);
    childrenByParent.set(c.parent_id, arr);
  }
  const docsByContainer = new Map<string | null, DocRowMin[]>();
  for (const d of docs) {
    const arr = docsByContainer.get(d.container_id) ?? [];
    arr.push(d);
    docsByContainer.set(d.container_id, arr);
  }

  let exportedCount = 0;
  let truncated = false;
  function exportContainer(c: ContainerRowMin): ExportedContainer | null {
    if (truncated) return null;
    if (exportedCount >= params.max_nodes) {
      truncated = true;
      return null;
    }
    exportedCount++;
    const node: ExportedContainer = { kind: 'container', name: c.name, children: [] };
    // Child containers first, then docs at this level.
    const childContainers = childrenByParent.get(c.id) ?? [];
    for (const child of childContainers) {
      if (truncated) break;
      const sub = exportContainer(child);
      if (sub) node.children.push(sub);
    }
    const childDocs = docsByContainer.get(c.id) ?? [];
    for (const d of childDocs) {
      if (truncated) break;
      if (exportedCount >= params.max_nodes) {
        truncated = true;
        break;
      }
      exportedCount++;
      const doc: ExportedDoc = { kind: 'doc', title: d.title };
      if (params.include_content) doc.content = d.content ?? '';
      node.children.push(doc);
    }
    return node;
  }

  // Build the result. If rootId is null we export a virtual "workspace" root
  // that holds all top-level containers + top-level docs.
  let tree: ExportedContainer;
  if (rootId === null) {
    tree = { kind: 'container', name: '<workspace>', children: [] };
    const topContainers = childrenByParent.get(null) ?? [];
    for (const c of topContainers) {
      if (truncated) break;
      const sub = exportContainer(c);
      if (sub) tree.children.push(sub);
    }
    const topDocs = docsByContainer.get(null) ?? [];
    for (const d of topDocs) {
      if (truncated) break;
      if (exportedCount >= params.max_nodes) {
        truncated = true;
        break;
      }
      exportedCount++;
      const doc: ExportedDoc = { kind: 'doc', title: d.title };
      if (params.include_content) doc.content = d.content ?? '';
      tree.children.push(doc);
    }
  } else {
    const rootContainer = containers.find((c) => c.id === rootId);
    if (!rootContainer) {
      // shouldn't happen — we already validated, but defensive.
      throw new Error(`bulk_export: root container "${rootId}" disappeared`);
    }
    const built = exportContainer(rootContainer);
    if (!built) {
      // max_nodes <= 0 edge case can't happen (parseInput floors at 1), so
      // this means we never got off the ground; treat as empty.
      tree = { kind: 'container', name: rootContainer.name, children: [] };
    } else {
      tree = built;
    }
  }

  const out = {
    success: true,
    root_id: rootId,
    include_content: params.include_content,
    node_count: exportedCount,
    truncated,
    tree,
  };
  return { output: JSON.stringify(out, null, 2), rawContent: out };
};

export default handler;
