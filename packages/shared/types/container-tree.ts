/**
 * Workspace container tree — wire schema.
 *
 * Canonical node shapes for the nested tree served by GET /api/containers/tree.
 * The server builds these in ContainerTreeService.buildContainerTree; the
 * desktop UI consumes them via containersApi.listTree (re-exported there as
 * `LibraryTreeChild`). Field semantics follow what the emit site actually
 * puts on the wire — see apps/server/src/domains/containers/ContainerTreeService.ts.
 */

import type { ContainerCategory } from '../constants/taxonomy';

export interface ContainerTreeNode {
  kind: 'container';
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  children: TreeChild[];
  /**
   * Optional grouping category (`project` only). NULL = plain organization.
   * `category === 'project'` marks a project container — the project node
   * kind collapsed into containers, so the container id is the project id.
   * Always emitted (null when unset).
   */
  category: ContainerCategory | null;
  /** Project facet — absolute local folder path. Meaningful when category='project'. */
  folderPath: string | null;
  /** Project facet — git repository URL. Meaningful when category='project'. */
  githubUrl: string | null;
  /** Read-only — members.id of the actor who created the container. */
  createdBy?: string | null;
  /** Read-only — members.id of the actor who last edited the container. */
  lastEditedBy?: string | null;
}

export interface DocTreeNode {
  kind: 'doc';
  id: string;
  containerId: string | null;
  title: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Threads are not placed in the folder tree. A thread is scoped to a project
 * container (`projectId`) or is flat at the workspace level (`null`); it
 * never has a `nodes.container_id`.
 */
export interface ThreadTreeNode {
  kind: 'thread';
  id: string;
  /** Project container id (`containers.category = 'project'`), or null when flat. */
  projectId: string | null;
  title: string | null;
  /**
   * Manual position within the project's thread list (or the flat list),
   * ascending; the tree payload already lists threads in this order.
   */
  sortOrder: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Image node — uploaded image attached to a container. `url` is a relative API
 * path that resolves to the binary payload (e.g. `/api/images/<id>/content`).
 */
export interface ImageTreeNode {
  kind: 'image';
  id: string;
  containerId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sortOrder: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export type TreeChild = ContainerTreeNode | DocTreeNode | ThreadTreeNode | ImageTreeNode;
