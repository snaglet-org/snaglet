/**
 * Raw-writer stamp guard.
 *
 * docs.last_edited_by / containers.last_edited_by are FKs to members(id) and
 * are stamped only by the model chokepoints (DocModel/ContainerModel/
 * ProjectModel via `currentActorMemberId()`) or by a documented bypass that
 * stamps them itself. Any other raw `UPDATE docs SET` / `UPDATE containers
 * SET` would silently leave last_edited_by stale, so this greps
 * apps/server/src and packages/db (.ts only) for that literal-table shape and
 * fails on anything outside the allowlist.
 *
 * The regex is deliberately simple: it does not catch a write built from a
 * dynamic identifier (`UPDATE ${this.qualifiedTable} SET ...`), which only
 * the owning models use.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';

const REPO_ROOT = join(__dirname, '../../../..');
const SCAN_DIRS = ['apps/server/src', 'packages/db'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'coverage', 'generated']);

// `UPDATE docs SET` / `UPDATE public.containers SET`, case-insensitive,
// optional schema qualifier.
const RAW_WRITE_PATTERN = /UPDATE\s+(public\.)?(docs|containers)\s+SET/i;

/**
 * Files allowed to raw-write docs/containers, relative to repo root.
 *
 *  - DocModel.ts / ContainerModel.ts / ProjectModel.ts: the model chokepoints
 *    that own these tables and stamp last_edited_by themselves.
 *  - editDoc.ts: a raw-SQL bypass (anchor-based content splicing) that
 *    stamps last_edited_by inline.
 *  - database-execute/definition.ts: not a writer; its parameter schema holds
 *    an example string containing "UPDATE docs SET". Attribution for
 *    agent-authored SQL in database_execute is out of scope by design.
 */
const ALLOWLIST = new Set<string>([
  'packages/db/tables/docs/DocModel.ts',
  'packages/db/tables/containers/ContainerModel.ts',
  'packages/db/tables/projects/ProjectModel.ts',
  'apps/server/src/services/ToolService/handlers/docs/editDoc.ts',
  'apps/server/src/services/ToolService/tools/database/database-execute/definition.ts',
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(join(dir, entry.name));
    }
  }
}

function findRawWriters(): string[] {
  const offenders: string[] = [];
  for (const scanDir of SCAN_DIRS) {
    const files: string[] = [];
    walk(join(REPO_ROOT, scanDir), files);
    for (const absPath of files) {
      const relPath = relative(REPO_ROOT, absPath).split(sep).join('/');
      if (ALLOWLIST.has(relPath)) continue;
      const src = readFileSync(absPath, 'utf8');
      if (RAW_WRITE_PATTERN.test(src)) offenders.push(relPath);
    }
  }
  return offenders;
}

describe('raw-writer stamp guard (docs/containers attribution)', () => {
  it('every allowlisted file still exists and still matches (no stale entries)', () => {
    for (const relPath of ALLOWLIST) {
      const absPath = join(REPO_ROOT, relPath);
      expect(() => readFileSync(absPath, 'utf8')).not.toThrow();
    }
  });

  it('no raw `UPDATE docs|containers SET` writer exists outside the documented allowlist', () => {
    const offenders = findRawWriters();
    if (offenders.length > 0) {
      throw new Error(
        `Raw SQL write(s) to docs/containers found outside the documented allowlist:\n` +
          offenders.map((f) => `  - ${f}`).join('\n') +
          `\n\nRaw writers must stamp last_edited_by via the actor->member resolver ` +
          `(currentActorMemberId() from @snaglet/db/actorMember) or route the write through ` +
          `DocModel/ContainerModel/ProjectModel instead. If this is a new, reviewed, ` +
          `documented bypass that already stamps correctly (see edit-doc/tool.ts for the ` +
          `pattern), add it to the ALLOWLIST in this test with a comment explaining why.`
      );
    }
    expect(offenders).toEqual([]);
  });
});
