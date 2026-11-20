/**
 * Type definitions for workspace content — projects, images, codebase.
 */

export interface StoredImage {
  id: string;
  containerId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  githubUrl: string | null;
  folderPath: string | null;
  /**
   * The container this project is attached to. NULL = detached (reachable
   * via Projects.detach). Lives on `nodes.container_id` and enforced 1:1
   * per container by `idx_nodes_one_project_per_container`.
   */
  containerId: string | null;
  description: string | null;
  /** Whether the linked folder's files are indexed (the DB half of the indexing gate). */
  fileIndexingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
