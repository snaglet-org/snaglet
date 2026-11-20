/**
 * ContainerTreeService
 *
 * Owns the tree-building logic for the workspace container tree. Exposes
 * `buildContainerTree`, which assembles the nested node tree the GET /tree
 * route serves.
 */

import { Containers, Docs, Images, Projects, Threads } from '@snaglet/db';
import type {
  ContainerTreeNode,
  DocTreeNode,
  ImageTreeNode,
  ThreadTreeNode,
  TreeChild,
} from '@snaglet/shared/types';

// The node shapes are the shared wire schema — see
// packages/shared/types/container-tree.ts. Re-exported so existing consumers
// of this module keep their import site.
export type { TreeChild };

/**
 * Build the workspace container tree, optionally scoped to a project subtree.
 *
 * Returns a flat array of top-level `TreeChild` nodes — containers (with their
 * children nested), plus loose docs/images and flat threads at the
 * root level. Projects are containers (category='project') and render as
 * ordinary containers carrying their project facet (folderPath/githubUrl) as
 * flat fields directly on the node.
 *
 * Threads are not in the folder tree: a thread is scoped to a project
 * (`projectId`) or is flat. The tree nests each project's threads as children
 * of the project container, in their manual order (`sortOrder`), so path
 * headers, reveal and palette paths keep working; flat threads sit at the
 * root in theirs. With a
 * `projectId` scope, the project's own threads and every nested project's
 * threads (under their own project) are included; flat threads are not.
 *
 * When `projectId` (a project-container id) is provided and it is not a project
 * container, returns `null` so the caller can short-circuit with an empty 200.
 */
export async function buildContainerTree(projectId: string | null): Promise<TreeChild[] | null> {
  const [containerRows, docRows, threadRows, imageRows] = await Promise.all([
    Containers.listAllOrdered(),
    Docs.listAllOrdered(),
    Threads.listAllOrdered(),
    Images.listAllOrdered(),
  ]);

  // When projectId is provided, restrict the tree to the subtree rooted at the
  // project container via BFS.
  let allowedContainerIds: Set<string> | null = null;
  let allowedDocIds: Set<string> | null = null;
  if (projectId) {
    const project = await Projects.findById(projectId);
    if (!project || !project.containerId) {
      // Not a project container → caller renders empty result.
      return null;
    }
    const rootId = project.containerId;
    allowedContainerIds = new Set<string>();
    allowedDocIds = new Set<string>();

    const childrenByParent = new Map<string, string[]>();
    for (const c of containerRows) {
      if (c.parentId === null) continue;
      const list = childrenByParent.get(c.parentId);
      if (list) list.push(c.id);
      else childrenByParent.set(c.parentId, [c.id]);
    }

    const queue: string[] = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (allowedContainerIds.has(id)) continue;
      allowedContainerIds.add(id);
      const kids = childrenByParent.get(id);
      if (kids) queue.push(...kids);
    }

    for (const d of docRows) {
      if (d.containerId && allowedContainerIds.has(d.containerId)) {
        allowedDocIds.add(d.id);
      }
    }
  }

  const byId = new Map<string, ContainerTreeNode>();
  for (const row of containerRows) {
    if (allowedContainerIds && !allowedContainerIds.has(row.id)) continue;
    const node: ContainerTreeNode = {
      kind: 'container',
      ...row,
      children: [],
    };
    byId.set(row.id, node);
  }

  const roots: ContainerTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const looseDocs: DocTreeNode[] = [];
  for (const doc of docRows) {
    if (allowedDocIds && !allowedDocIds.has(doc.id)) continue;
    const leaf: DocTreeNode = {
      kind: 'doc',
      id: doc.id,
      containerId: doc.containerId,
      title: doc.title,
      content: doc.content,
      sortOrder: doc.sortOrder,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    const parent = doc.containerId ? byId.get(doc.containerId) : undefined;
    if (parent) {
      parent.children.push(leaf);
    } else {
      looseDocs.push(leaf);
    }
  }

  // `Threads.listAllOrdered` returns each project's threads (and the flat
  // ones) in manual order, which is the order they are nested in here.
  const flatThreads: ThreadTreeNode[] = [];
  for (const thread of threadRows) {
    if (
      allowedContainerIds &&
      (thread.projectId === null || !allowedContainerIds.has(thread.projectId))
    ) {
      continue;
    }
    const leaf: ThreadTreeNode = {
      kind: 'thread',
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      sortOrder: thread.sortOrder,
      lastMessageAt: thread.lastMessageAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
    const project = thread.projectId ? byId.get(thread.projectId) : undefined;
    if (project) {
      project.children.push(leaf);
    } else {
      flatThreads.push(leaf);
    }
  }

  const looseImages: ImageTreeNode[] = [];
  for (const image of imageRows) {
    if (allowedContainerIds && image.containerId && !allowedContainerIds.has(image.containerId))
      continue;
    if (allowedContainerIds && !image.containerId) continue;
    const leaf: ImageTreeNode = {
      kind: 'image',
      id: image.id,
      containerId: image.containerId,
      name: image.name,
      description: image.description,
      tags: image.tags,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      sortOrder: image.sortOrder,
      url: `/api/images/${image.id}/content`,
      createdAt: image.createdAt,
      updatedAt: image.updatedAt,
    };
    const parent = image.containerId ? byId.get(image.containerId) : undefined;
    if (parent) {
      parent.children.push(leaf);
    } else {
      looseImages.push(leaf);
    }
  }

  // Tasks are table rows, not nodes, so nothing task-specific is placed here;
  // a doc a task row links to is an ordinary doc and already surfaces above.
  return [...roots, ...looseDocs, ...flatThreads, ...looseImages];
}
