import { fetchData, getApiUrl } from './core';
import type { ContainerCategory } from '@snaglet/shared';
import type {
  ContainerTreeNode,
  DocTreeNode,
  ImageTreeNode,
  ThreadTreeNode,
  TreeChild,
} from '@snaglet/shared/types';

export type { ContainerTreeNode, DocTreeNode, ImageTreeNode, ThreadTreeNode };

export interface ContainerRecord {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  x: number | null;
  y: number | null;
  /**
   * Optional light grouping semantic. `'project'` marks a project home —
   * the container IS the project. Absent/null = plain organization.
   */
  category?: ContainerCategory | null;
  /** Project facet — absolute local folder path (meaningful when
   * `category === 'project'`). */
  folderPath?: string | null;
  /** Read-only — members.id of the actor who created the container. */
  createdBy?: string | null;
  /** Read-only — members.id of the actor who last edited the container. */
  lastEditedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ContainerInput {
  name: string;
  parentId?: string | null;
  /** Set `'project'` to create the container as a project home. */
  category?: ContainerCategory | null;
  x?: number | null;
  y?: number | null;
}

export interface ContainerUpdate {
  name?: string;
  parentId?: string | null;
  /**
   * Set `'project'` to promote a plain folder to a project (the only
   * category). The server refuses the reverse — a project's threads and
   * tables are scoped to it — so `null` is only ever re-sent unchanged.
   */
  category?: ContainerCategory | null;
  x?: number | null;
  y?: number | null;
  /**
   * Positional move within the target parent. When set, the server
   * atomically bumps any sibling already at this slot (or beyond) by +1
   * so the drop has room — see ContainerModel.moveTo.
   */
  sortOrder?: number;
}

// Tree node shapes (ContainerTreeNode / DocTreeNode / ThreadTreeNode /
// ImageTreeNode) are the shared wire schema — see
// packages/shared/types/container-tree.ts. Re-exported above so UI code
// imports them from this module.

/**
 * File node — a text file on a project's local disk, mirrored as a `file` node.
 * The body is NOT in the DB; `relativePath` (relative to the project's folder
 * root) carries the on-disk hierarchy, which the sidebar groups into a folder
 * tree client-side. Clicking one opens FileView, which fetches the content.
 */
export interface FileTreeNode {
  kind: 'file';
  id: string;
  containerId: string | null;
  projectId: string;
  relativePath: string;
  /** Basename, for the row label and the pane title. */
  name: string;
  sizeBytes: number;
  updatedAt: string;
  /** Absolute on-disk path. When set, FileView fetches content by path instead
   * of by node id (used for filesystem palette hits that have no DB record). */
  absolutePath?: string;
}

/** UI-side alias for the shared tree-child union (`TreeChild`). */
export type LibraryTreeChild = TreeChild;

export const containersApi = {
  listRoots: () => fetchData<ContainerRecord[]>(getApiUrl('/containers/roots')),
  listTree: (projectId?: string | null, init?: RequestInit) =>
    fetchData<LibraryTreeChild[]>(
      getApiUrl(
        projectId
          ? `/containers/tree?projectId=${encodeURIComponent(projectId)}`
          : '/containers/tree'
      ),
      init
    ),
  listByParent: (parentId: string | null) =>
    fetchData<ContainerRecord[]>(
      getApiUrl(
        parentId === null ? '/containers' : `/containers?parentId=${encodeURIComponent(parentId)}`
      )
    ),
  get: (id: string) => fetchData<ContainerRecord>(getApiUrl(`/containers/${id}`)),
  create: (data: ContainerInput) =>
    fetchData<ContainerRecord>(getApiUrl('/containers'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: ContainerUpdate) =>
    fetchData<ContainerRecord>(getApiUrl(`/containers/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => fetchData<null>(getApiUrl(`/containers/${id}`), { method: 'DELETE' }),
};
