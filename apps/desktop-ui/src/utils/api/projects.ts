import { fetchData, getApiUrl } from './core';
import type { ProjectRecord } from './types';
import type {
  ProjectApplyHeldRemovalsResult,
  ProjectBackfillStartResult,
  ProjectEmbeddingsClearPreview,
  ProjectEmbeddingsClearResult,
  ProjectIndexingStatus,
} from '@snaglet/shared/types';

export type {
  ProjectApplyHeldRemovalsResult,
  ProjectBackfillStartResult,
  ProjectEmbeddingsClearPreview,
  ProjectEmbeddingsClearResult,
  ProjectIndexingStatus,
} from '@snaglet/shared/types';

/**
 * Editable project facet. A project is a container with
 * `category === 'project'`, so `id` here is a container id and these routes
 * are container-facet operations server-side. Projects are created with
 * `containersApi.create({ category: 'project' })`; this client only reads and
 * edits the facet of an existing project container.
 */
interface ProjectInput {
  name: string;
  githubUrl?: string | null;
  folderPath?: string | null;
  description?: string | null;
  fileIndexingEnabled?: boolean;
}

/** The always-on hardcoded exclusions, surfaced read-only in the settings UI. */
interface IndexExclusionDefaults {
  dirs: string[];
  filenames: string[];
  extensions: string[];
}

/** A project's file-indexing settings, read from `<folder>/snaglet.config.json`. */
export interface IndexConfig {
  /** False when the project has no linked folder (nothing to index / no file). */
  hasFolder: boolean;
  folderPath: string | null;
  /** Whether snaglet.config.json exists on disk yet (false → created on first save). */
  configExists: boolean;
  /** File present but not valid JSON — editing is blocked until fixed by hand. */
  parseError: boolean;
  enabled: boolean;
  /** Empty means all project paths are eligible before exclusions. */
  includePaths: string[];
  ignorePaths: string[];
  ignoreFileTypes: string[];
  defaults: IndexExclusionDefaults;
}

/** Editable subset written back to snaglet.config.json. Omitted fields are left as-is. */
interface IndexConfigEdits {
  enabled?: boolean;
  includePaths?: string[];
  ignorePaths?: string[];
  ignoreFileTypes?: string[];
}

interface FileEmbeddingCoverage {
  embeddedFiles: number;
  totalFiles: number;
}

export interface FileIndexingImpact {
  eligibleFiles: number;
  scannedEntries: number;
  capped: boolean;
}

export interface ProjectFolderImpact extends FileIndexingImpact {
  folderPath: string;
  warnings: string[];
  childRepositories: string[];
  replacingFolder: boolean;
  requiresConfirmation: boolean;
}

export const projectsApi = {
  /** `id` is the project container's id. */
  get: (id: string) => fetchData<ProjectRecord>(getApiUrl(`/projects/${id}`)),
  update: (id: string, data: Partial<ProjectInput>) =>
    fetchData<ProjectRecord>(getApiUrl(`/projects/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /**
   * Save (or clear) a project's working folder. Validates the path exists and
   * is a directory server-side and creates the `~/.snaglet/projects/<id>` symlink;
   * rejects (throwing the server message) when the path is missing/invalid.
   * `overlapWarning` (set path only) is a non-blocking notice that the folder
   * overlaps another project's folder — files will be shared, not re-indexed.
   */
  previewFolderPath: (id: string, folderPath: string) =>
    fetchData<ProjectFolderImpact>(getApiUrl(`/projects/${id}/folder-path/preview`), {
      method: 'POST',
      body: JSON.stringify({ folderPath }),
    }),
  saveFolderPath: (
    id: string,
    folderPath: string | null,
    options?: { confirmFolderLink?: boolean; clearPreviousIndex?: boolean }
  ) =>
    fetchData<ProjectRecord & { overlapWarning?: string | null }>(
      getApiUrl(`/projects/${id}/folder-path`),
      {
        method: 'PUT',
        body: JSON.stringify({ folderPath, ...options }),
      }
    ),
  /** Read the project's file-indexing settings from `<folder>/snaglet.config.json`. */
  getIndexConfig: (id: string) => fetchData<IndexConfig>(getApiUrl(`/projects/${id}/index-config`)),
  getFileEmbeddingCoverage: (id: string) =>
    fetchData<FileEmbeddingCoverage>(getApiUrl(`/projects/${id}/file-embedding-coverage`)),
  getFileIndexingImpact: (id: string) =>
    fetchData<FileIndexingImpact>(getApiUrl(`/projects/${id}/file-indexing-impact`)),
  /**
   * Edit the managed indexing settings in `<folder>/snaglet.config.json` (atomic,
   * preserving unknown keys; creates the file if absent). Returns the fresh
   * on-disk state. `enabled` is mirrored to the per-project indexing toggle.
   */
  updateIndexConfig: (id: string, edits: IndexConfigEdits) =>
    fetchData<IndexConfig>(getApiUrl(`/projects/${id}/index-config`), {
      method: 'PUT',
      body: JSON.stringify(edits),
    }),
  /** Combined worker/config/coverage/runtime status for the embeddings UI. */
  getIndexingStatus: (id: string) =>
    fetchData<ProjectIndexingStatus>(getApiUrl(`/projects/${id}/indexing-status`)),
  /**
   * Start a project-scoped backfill of missing/stale embeddings. Works while
   * background indexing is paused. Rejects with 409 while a backfill or clear
   * is already running; progress arrives via workspace events + status polls.
   */
  cancelEmbeddingsBackfill: (id: string) =>
    fetchData<{ cancelling: boolean }>(getApiUrl(`/projects/${id}/embeddings/backfill/cancel`), {
      method: 'POST',
    }),

  startEmbeddingsBackfill: (id: string) =>
    fetchData<ProjectBackfillStartResult>(getApiUrl(`/projects/${id}/embeddings/backfill`), {
      method: 'POST',
    }),
  /** Honest deletion numbers (shared vs genuinely reclaimable) for the modal. */
  getEmbeddingsClearPreview: (id: string) =>
    fetchData<ProjectEmbeddingsClearPreview>(getApiUrl(`/projects/${id}/embeddings/clear-preview`)),
  /**
   * The confirmed destructive clear: deletes this project's indexed file rows
   * and GC's orphaned embeddings. Never touches source files or the worker
   * preference — pausing is a separate, reversible action (updateIndexConfig).
   */
  clearEmbeddings: (id: string) =>
    fetchData<ProjectEmbeddingsClearResult>(getApiUrl(`/projects/${id}/embeddings/clear`), {
      method: 'POST',
    }),
  /**
   * A person confirms removing the files the mass-removal backstop is holding.
   * `expected` is the exact count they were shown; the server refuses (409,
   * nothing removed) if the folder changed since.
   */
  applyHeldRemovals: (id: string, expected: number) =>
    fetchData<ProjectApplyHeldRemovalsResult>(
      getApiUrl(`/projects/${id}/indexing/apply-held-removals`),
      { method: 'POST', body: JSON.stringify({ expected }) }
    ),
  // No `delete`/uninitialize: a project's category is immutable, so a project
  // only goes away with its container (archive / delete).
};
