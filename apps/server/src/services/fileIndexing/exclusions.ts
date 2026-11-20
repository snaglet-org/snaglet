/**
 * exclusions — the denylist shared by the watcher AND the reconciliation scan,
 * so the two never disagree on the file set. Without it a single save in a repo
 * with node_modules can spray thousands of events / index thousands of junk
 * files.
 *
 * Two layers, both applied by shouldExcludePath:
 *   1. A hardcoded base denylist (dirs, lockfiles, binary/media extensions, the
 *      gate file, dotfiles) — always on, never relaxable.
 *   2. Per-project user rules from snaglet.config.json (`ignorePaths` /
 *      `ignoreFileTypes`), compiled by compileIgnoreRules and passed in. These
 *      are ADDITIVE — they extend the base layer, they can't un-ignore it.
 *
 * The size cap is enforced separately at read time (readEmbeddableFileBody /
 * MAX_EMBED_FILE_BYTES) because it needs a stat. Deferred: .gitignore
 * parsing.
 */

import path from 'node:path';
import { Minimatch } from 'minimatch';
import { AUTO_SKIP_FILE_EXTENSIONS } from '@snaglet/shared/constants';
import { WATCH_CONFIG_FILENAME } from './watchConfig';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
]);

const EXCLUDED_FILENAMES = new Set([
  WATCH_CONFIG_FILENAME, // the gate file is config, not content — never index it
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
]);

/**
 * Non-text content the embedder can't use — always auto-skipped, never
 * relaxable by user config. Sourced from the single shared canonical set
 * (AUTO_SKIP_FILE_EXTENSIONS) so the server denylist and the settings UI can't
 * diverge; stored with the leading dot here to match `path.extname` output.
 * PDF is deliberately not in that set: it is extractable (the read step derives
 * a text layer — see fileSource.readEmbeddableFileContent), so discovery
 * accepts it while a user's `ignoreFileTypes: ["pdf"]` still opts a project out
 * via the layer-2 rules below.
 */
const EXCLUDED_EXTENSIONS = new Set(AUTO_SKIP_FILE_EXTENSIONS.map((ext) => `.${ext}`));

/**
 * The always-on hardcoded denylist, surfaced read-only in the project indexing
 * settings so users can see why `node_modules`, lockfiles, images, etc. never
 * appear — and understand that their own `ignorePaths` / `ignoreFileTypes` are
 * additive on top of this, never a way to relax it. Extensions are returned
 * without the leading dot to match how users write `ignoreFileTypes`.
 */
export interface DefaultExclusions {
  dirs: string[];
  filenames: string[];
  extensions: string[];
}

export function getDefaultExclusions(): DefaultExclusions {
  return {
    dirs: [...EXCLUDED_DIRS].sort(),
    filenames: [...EXCLUDED_FILENAMES].sort(),
    extensions: [...EXCLUDED_EXTENSIONS].map((ext) => ext.replace(/^\./, '')).sort(),
  };
}

/**
 * Compiled per-project ignore rules, derived from snaglet.config.json. Precomputed
 * once (per reconcile / per watcher start) so the hot path only runs compiled
 * matchers and never reparses patterns for each file.
 */
export interface IgnoreRules {
  /** Empty means every path is eligible before exclusions are applied. */
  includePaths: string[];
  includePathMatchers: Minimatch[];
  /** Normalized POSIX path patterns retained for display/debugging. */
  paths: string[];
  /** Precompiled glob matchers, aligned by index with `paths`. Every ancestor
   * of a candidate is tested so a directory match excludes its whole subtree. */
  pathMatchers: Minimatch[];
  /** Normalized extensions: lowercase, no leading dot (e.g. `png`). */
  fileTypes: Set<string>;
}

/** Shared empty ruleset — handy default when a folder has no user rules. */
export const EMPTY_IGNORE_RULES: IgnoreRules = {
  includePaths: [],
  includePathMatchers: [],
  paths: [],
  pathMatchers: [],
  fileTypes: new Set(),
};

/**
 * Compile raw snaglet.config.json arrays into an {@link IgnoreRules}. Tolerant of the
 * forms users actually write:
 *   - `"dist"`, `"docs/generated"`     → a folder (and everything under it)
 *   - `".playwright-mcp/*"`            → folder contents (the `/*` is sugar)
 *   - `"notes/todo.md"`                → one exact file
 *   - a globstar path                    → a name or file at any folder depth
 *   - `"png"` or `".png"` (fileTypes)  → an extension, with or without the dot
 * Blank/whitespace entries are dropped. Backslashes are normalized to `/` so a
 * Windows-style pattern still matches.
 */
export function compileIgnoreRules(input: {
  includePaths?: string[];
  ignorePaths?: string[];
  ignoreFileTypes?: string[];
}): IgnoreRules {
  const includePaths: string[] = [];
  const includePathMatchers: Minimatch[] = [];
  const paths: string[] = [];
  const pathMatchers: Minimatch[] = [];
  const compilePaths = (rawPaths: string[], normalized: string[], matchers: Minimatch[]) => {
    for (const raw of rawPaths) {
      let p = raw.trim().replace(/\\/g, '/');
      if (p.startsWith('./')) p = p.slice(2);
      if (p.endsWith('/**')) {
        p = p.slice(0, -3); // "dir/**" == "dir"
      } else if (p.endsWith('/*')) {
        p = p.slice(0, -2); // "dir/*" == "dir"
      }
      p = p.replace(/\/+$/, ''); // trailing slashes
      if (p) {
        normalized.push(p);
        matchers.push(
          new Minimatch(p, {
            dot: true,
            nocomment: true,
            nonegate: true,
          })
        );
      }
    }
  };
  compilePaths(input.includePaths ?? [], includePaths, includePathMatchers);
  compilePaths(input.ignorePaths ?? [], paths, pathMatchers);
  const fileTypes = new Set<string>();
  for (const raw of input.ignoreFileTypes ?? []) {
    const t = raw.trim().toLowerCase().replace(/^\./, '');
    if (t) fileTypes.add(t);
  }
  return { includePaths, includePathMatchers, paths, pathMatchers, fileTypes };
}

export type IndexedPathKind = 'file' | 'directory';

/**
 * True if a project-relative path should be skipped. Layer 1 (always): denylisted
 * directories anywhere in the path, dotfiles/dotdirs, lockfiles, the gate file,
 * and known binary/media extensions. Layer 2 (when `rules` is given): the
 * project's own `ignoreFileTypes` and `ignorePaths`. Used for both directory
 * pruning (during the walk) and file filtering, so an ignored dir is never
 * descended into.
 */
export function shouldExcludePath(
  relPath: string,
  rules?: IgnoreRules,
  kind: IndexedPathKind = 'file'
): boolean {
  if (!relPath) return true;
  const segments = relPath.split(path.sep);
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (EXCLUDED_DIRS.has(seg)) return true;
    if (seg.startsWith('.')) return true; // dotfiles / dotdirs (.env, .DS_Store, .vscode)
  }
  const base = segments[segments.length - 1] ?? '';
  if (EXCLUDED_FILENAMES.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;

  if (rules) {
    if (rules.fileTypes.size > 0 && ext.length > 1 && rules.fileTypes.has(ext.slice(1))) {
      return true; // ext is ".png" → compare "png"
    }
    if (rules.pathMatchers.length > 0) {
      const posix = segments.join('/');
      // Testing every ancestor makes a matched directory prune the whole
      // subtree while still allowing filename globs such as `**/*.snap`.
      const candidates = posix
        .split('/')
        .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
      for (const matcher of rules.pathMatchers) {
        if (candidates.some((candidate) => matcher.match(candidate))) return true;
      }
    }
    if (rules.includePathMatchers.length > 0) {
      const posix = segments.join('/');
      const candidates = posix
        .split('/')
        .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
      const included = rules.includePathMatchers.some(
        (matcher) =>
          candidates.some((candidate) => matcher.match(candidate)) ||
          (kind === 'directory' && matcher.match(posix, true))
      );
      if (!included) return true;
    }
  }
  return false;
}
