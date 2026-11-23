/**
 * The tag a commit gets from the branch it landed on.
 *
 * - `main` holds releases: the tag is the source version, `v1.0.1`.
 * - `staging` collects work for the next release: each landing gets the next
 *   pre-release tag of the source version, `v1.0.1-beta.1`, `v1.0.1-beta.2`, …
 *
 * A tag is only a name for a commit. Building, signing and publishing a
 * release stays a separate step (scripts/ship-desktop.mjs).
 *
 * CLI: node scripts/release/tags.mjs <branch>   prints the tag, or nothing when
 * there is none to make; exits 1 with a reason when the version must be bumped.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * @param {{ branch: string, version: string, tags: string[], headTags?: string[] }} input
 *   `tags` is every tag in the repository; `headTags` the tags already on this commit.
 * @returns {{ tag: string | null, reason: string, bump?: boolean }}
 */
export function nextTag({ branch, version, tags, headTags = [] }) {
  if (!VERSION.test(version))
    return { tag: null, reason: `"${version}" is not a plain x.y.z version`, bump: true };
  const release = `v${version}`;
  if (branch === 'main') {
    if (headTags.includes(release))
      return { tag: null, reason: `${release} is already on this commit` };
    if (tags.includes(release)) {
      return {
        tag: null,
        reason: `${release} already names an earlier commit: raise the version before releasing`,
        bump: true,
      };
    }
    return { tag: release, reason: 'release' };
  }
  if (branch === 'staging') {
    if (tags.includes(release)) {
      return {
        tag: null,
        reason: `${release} is already released: raise the version on staging for the next release`,
        bump: true,
      };
    }
    const prefix = `${release}-beta.`;
    if (headTags.some((t) => t.startsWith(prefix)))
      return { tag: null, reason: 'this commit already has a beta tag' };
    const last = Math.max(
      0,
      ...tags
        .filter((t) => t.startsWith(prefix))
        .map((t) => Number(t.slice(prefix.length)))
        .filter(Number.isInteger)
    );
    return { tag: `${prefix}${last + 1}`, reason: 'pre-release' };
  }
  return { tag: null, reason: `no tags are made on ${branch}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const branch = process.argv[2];
  if (!branch) {
    console.error('usage: node scripts/release/tags.mjs <branch>');
    process.exit(2);
  }
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const result = nextTag({
    branch,
    version,
    tags: git('tag', '--list'),
    headTags: git('tag', '--points-at', 'HEAD'),
  });
  if (result.tag) console.log(result.tag);
  else console.error(result.reason);
  process.exit(result.bump ? 1 : 0);
}
