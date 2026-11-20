import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expandHome, type LocalModelManifest } from './localModelManifest';

const verifiedFiles = new Map<string, string>();

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function matchesChecksum(file: string, sha256: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    // Recheck replaced/edited assets without hashing large weights on every
    // inference. Only successful verifications are cached.
    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, sha256].join(
      ':'
    );
    if (verifiedFiles.get(file) === fingerprint) return true;
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) return false;
    verifiedFiles.set(file, fingerprint);
    return true;
  } catch {
    return false;
  }
}

/** Select one complete model bundle for reading. Never mix tokenizers and
 * weights between homes, and never redirect writes to the shared fallback. */
export function modelReadDir(manifest: LocalModelManifest): string {
  const local = expandHome(manifest.dir);
  if (manifest.files.every((file) => isFile(path.join(local, file.localPath)))) return local;

  // Only built-in model manifests participate. Arbitrary absolute/custom paths
  // must retain their original meaning, including explicit missing-file errors.
  if (!manifest.dir.startsWith('~/.snaglet/models/')) return local;
  const fallback = path.join(homedir(), manifest.dir.slice('~/'.length));
  if (fallback === local) return local;
  const valid = manifest.files.every((file) =>
    matchesChecksum(path.join(fallback, file.localPath), file.sha256)
  );
  return valid ? fallback : local;
}

export function modelReadFilePath(manifest: LocalModelManifest, localPath: string): string {
  return path.join(modelReadDir(manifest), localPath);
}
