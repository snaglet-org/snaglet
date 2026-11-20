// filePath — encode/decode for `file:` and `folder:` chip hrefs. These chips
// reference a path (not a node id), so an agent reading the saved markdown
// sees a meaningful path. Lives in utils/ so the chip-markdown encoder and
// the renderer's parser (features/rich-markdown/renderer/nodeRef) share it.

const FILE_PATH_HREF_PREFIX = 'file:';
const FOLDER_PATH_HREF_PREFIX = 'folder:';

/** Encode a path behind a scheme prefix, URL-encoding each segment so spaces /
 *  `#` / `%` survive a markdown link href. */
function pathToChipHref(prefix: string, path: string): string {
  return `${prefix}${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Decode a scheme-prefixed path href back to the raw path, or null when the
 *  href doesn't use the given scheme. A `//` start (a URL authority such as
 *  `file://host/…`) is refused both as written and once decoded, so
 *  `file:%2F%2Fhost/…` cannot slip past the check. */
function parsePathChipHref(prefix: string, href: string): string | null {
  if (!href.startsWith(prefix)) return null;
  const encoded = href.slice(prefix.length);
  if (!encoded || encoded.startsWith('//')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return decoded.startsWith('//') ? null : decoded;
}

/** `apps/server/index.ts` → `file:apps/server/index.ts`. */
export function filePathToChipHref(path: string): string {
  return pathToChipHref(FILE_PATH_HREF_PREFIX, path);
}

/** Inverse of {@link filePathToChipHref}; null when `href` isn't a file chip. */
export function parseFilePathChipHref(href: string): string | null {
  return parsePathChipHref(FILE_PATH_HREF_PREFIX, href);
}

/** `apps/server` → `folder:apps/server`. */
export function folderPathToChipHref(path: string): string {
  return pathToChipHref(FOLDER_PATH_HREF_PREFIX, path);
}

/** Inverse of {@link folderPathToChipHref}; null when `href` isn't a folder chip. */
export function parseFolderPathChipHref(href: string): string | null {
  return parsePathChipHref(FOLDER_PATH_HREF_PREFIX, href);
}
