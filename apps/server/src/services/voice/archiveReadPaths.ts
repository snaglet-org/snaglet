import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { EspeakArchiveSpec } from './voiceModelManifest';

const verifiedTrees = new Map<string, string>();

/** Archive assets have a pinned tree digest as well as a download checksum.
 * Include relative names in the digest so missing/renamed dictionaries fail. */
export function archiveTreeMatches(dir: string, expected: string): boolean {
  try {
    const files: string[] = [];
    const walk = (relative: string): void => {
      for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile()) files.push(name);
        else throw new Error('Archive tree contains a non-regular file');
      }
    };
    walk('');
    files.sort();
    const fingerprint = JSON.stringify(
      files.map((name) => {
        const stat = statSync(path.join(dir, name));
        return [name, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
      })
    );
    const key = `${dir}:${expected}`;
    if (verifiedTrees.get(key) === fingerprint) return true;
    const hash = createHash('sha256');
    for (const name of files) {
      const digest = createHash('sha256')
        .update(readFileSync(path.join(dir, name)))
        .digest('hex');
      hash.update(`${name}\0${digest}\n`);
    }
    if (hash.digest('hex') !== expected) return false;
    verifiedTrees.set(key, fingerprint);
    return true;
  } catch {
    return false;
  }
}

/** Never redirect archive writes, and never trust a fallback's sentinel alone. */
export function archiveReadDir(spec: EspeakArchiveSpec): string {
  if (existsSync(path.join(spec.destDir, spec.sentinelRelPath))) return spec.destDir;
  if (!spec.sharedPath?.startsWith('~/.snaglet/models/') || !spec.treeSha256) return spec.destDir;
  const shared = path.join(homedir(), spec.sharedPath.slice(2));
  return shared !== spec.destDir && archiveTreeMatches(shared, spec.treeSha256)
    ? shared
    : spec.destDir;
}
