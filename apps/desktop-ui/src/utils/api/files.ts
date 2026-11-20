import { fetchData, getApiUrl } from './core';

/** One indexed file under a project, as returned by GET /api/files. The body
 * lives on disk (not the DB) and is fetched separately via getContent. */
export interface FileRecord {
  id: string;
  /** Path relative to the project's folder root; carries the on-disk hierarchy. */
  relativePath: string;
  /** Absolute on-disk path — used as a dragged file chip's reference so it
   * parses out as `/abs/path`. */
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
}

type FilePreviewReason = 'binary' | 'too_large' | 'missing';

/** File content payload for the read-only pane. `content` is null when the file
 * can't be previewed (`previewable: false`), with `reason` saying why. */
export interface FileContent {
  id: string;
  relativePath: string;
  sizeBytes: number;
  content: string | null;
  previewable: boolean;
  reason?: FilePreviewReason;
  projectRoot?: string;
}

export const filesApi = {
  /** Flat file list for a project's folder tree (ownership-resolved server-side). */
  listByProject: (projectId: string) => {
    const search = new URLSearchParams({ projectId });
    return fetchData<FileRecord[]>(getApiUrl(`/files?${search.toString()}`));
  },
  /** Read one file's text off disk for the pane (by file node id). */
  getContent: (fileId: string) =>
    fetchData<FileContent>(getApiUrl(`/files/${encodeURIComponent(fileId)}/content`)),
  /** Read a file by absolute path (for the chip preview modal). The server
   * refuses paths outside an indexed project folder. */
  getContentByPath: (absolutePath: string) => {
    const search = new URLSearchParams({ path: absolutePath });
    return fetchData<FileContent>(getApiUrl(`/files/preview?${search.toString()}`));
  },
  /**
   * Rename a file in a linked project folder, in place. Leaving the extension
   * off keeps the old one; the server refuses a name another file has.
   */
  rename: (absolutePath: string, name: string) =>
    fetchData<RenamedFile>(getApiUrl('/files/rename'), {
      method: 'POST',
      body: JSON.stringify({ path: absolutePath, name }),
    }),
};

/** Result of {@link filesApi.rename}. */
export interface RenamedFile {
  /** Absolute path under the new name. */
  path: string;
  name: string;
}

/** Relative resources are resolved server-side within the source project. */
export function relativeFileUrl(source: string, href: string, root?: string, raw = false): string {
  const search = new URLSearchParams({ source, href });
  if (root) search.set('root', root);
  if (raw) search.set('raw', '1');
  return getApiUrl(`/files/relative?${search}`);
}
export function getRelativeFile(source: string, href: string, root?: string): Promise<FileContent> {
  return fetchData<FileContent>(relativeFileUrl(source, href, root));
}
