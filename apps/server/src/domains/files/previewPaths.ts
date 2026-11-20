import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { isAncestorOrSame } from '@server/services/fileIndexing/ownership';

/** Both lexical and real containment are required: symlinks may not escape. */
export async function realFileWithin(root: string, target: string): Promise<string | null> {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) return null;
  if (!isAncestorOrSame(path.resolve(root), path.resolve(target))) return null;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    return isAncestorOrSame(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

export function relativeFileTarget(source: string, href: string): string | null {
  try {
    // URL query/fragment do not name filesystem bytes. Decode exactly once.
    const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    if (!pathname || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(pathname) || /[\0\\]/.test(pathname))
      return null;
    return path.resolve(path.dirname(source), pathname);
  } catch {
    return null;
  }
}
