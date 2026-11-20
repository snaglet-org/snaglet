import { statSync } from 'node:fs';

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve ripgrep for code search. Packaged Snaglet sets SNAGLET_RIPGREP_PATH to its
 * bundled, checksum-pinned binary. When that is unset (development) or the
 * file is missing, fall back to `rg` on PATH; callers treat an ENOENT from
 * that as "no ripgrep" and use their plain-text Node fallback.
 */
export function ripgrepExecutable(): string {
  const bundled = process.env.SNAGLET_RIPGREP_PATH?.trim();
  if (bundled && isFile(bundled)) return bundled;
  return 'rg';
}
