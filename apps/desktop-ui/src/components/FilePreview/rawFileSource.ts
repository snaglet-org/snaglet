import { getApiUrl } from '@desktop/utils/api';

/** How a visual previewer locates a file's raw bytes: an indexed file node id,
 * or an absolute path (file: chips / filesystem search hits, which have no node
 * id). The by-path route serves only paths inside a live project's folder. */
export type RawFileSource = { kind: 'id'; fileId: string } | { kind: 'path'; path: string };

/** The authenticated raw-bytes route for `source`. */
export function rawFileUrl(source: RawFileSource): string {
  if (source.kind === 'id') {
    return getApiUrl(`/files/${encodeURIComponent(source.fileId)}/raw`);
  }
  const search = new URLSearchParams({ path: source.path });
  return getApiUrl(`/files/raw?${search.toString()}`);
}
