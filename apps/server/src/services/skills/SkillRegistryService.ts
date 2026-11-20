/**
 * SkillRegistryService — keeps `skill_registry` in step with SKILL.md folders.
 *
 * Two roots:
 *   personal  `<snaglet-home>/skills/<slug>/SKILL.md` (`~/.snaglet/skills`, created at
 *             boot): the user's own skills, usable once assigned.
 *   builtin   the folder that ships with Snaglet (resolveBuiltinSkillsDir): usable
 *             by every agent with no assignment. A personal skill with the
 *             same slug wins (resolveEffectiveSkills).
 * Skills are not per-project: every skill works in every project, and project
 * `.snaglet/skills` folders are not scanned.
 *
 * Disk is the source of truth; the table is a discovery index. Each root gets
 * its own FolderScanner (boot scan + debounced watch). A skill exists only
 * while its folder does: a vanished folder deletes its row, and the FK cascade
 * on `skill_assignments` deletes its assignments. Renaming a folder therefore makes a new skill
 * that must be assigned again. Skill content is read and hashed, never executed.
 */
import { existsSync } from 'fs';
import path from 'path';
import { SkillRegistry } from '@snaglet/db';
import type { SkillScope } from '@snaglet/db';
import { generateId, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { FolderScanner, type ScannedFolder } from '@server/services/FolderScanner';
import { SNAGLET_SKILLS_DIR } from '@server/services/snagletHome';
import { resolveBuiltinSkillsDir } from './builtinSkillsDir';
import { readSkillFolder } from './skillFile';

const LOG_PREFIX = '\x1b[36m[skills]\x1b[0m';

export interface SkillRoot {
  scope: SkillScope;
  projectId: string | null;
  dir: string;
}

/** Register (or refresh) one folder under a root. Never throws. */
export async function registerSkillFolder(root: SkillRoot, slug: string): Promise<void> {
  try {
    const read = await readSkillFolder(root.dir, slug);
    // skill_registry still has `scope` / `project_id` columns, but skills are
    // not per-project: every row written here has project NULL.
    await SkillRegistry.upsertDiscovered({
      id: generateId('skill'),
      scope: root.scope,
      projectId: root.projectId,
      slug: read.slug,
      name: read.name,
      description: read.description,
      sourcePath: read.sourcePath,
      contentHash: read.contentHash,
      status: read.status,
      error: read.error,
    });
    if (read.status === 'invalid') {
      logger.warn(`${LOG_PREFIX} ${root.scope} skill "${slug}" is invalid: ${read.error}`);
    }
  } catch (err) {
    logger.warn(`${LOG_PREFIX} could not register "${slug}": ${getErrorMessage(err)}`);
  }
}

/**
 * A folder vanished: delete its row (its assignments cascade with it).
 * Never throws.
 */
export async function deleteSkillFolderRow(root: SkillRoot, slug: string): Promise<void> {
  try {
    const gone = await SkillRegistry.deleteBySlug(root.scope, root.projectId, slug);
    if (gone)
      logger.info(`${LOG_PREFIX} ${root.scope} skill "${slug}" folder removed; row deleted`);
  } catch (err) {
    logger.warn(`${LOG_PREFIX} could not delete "${slug}": ${getErrorMessage(err)}`);
  }
}

/**
 * Rows whose folder is gone while the server was down: FolderScanner only
 * reports removals it saw during this process, so reconcile against disk once
 * per root at start.
 */
export async function markVanishedSkills(root: SkillRoot): Promise<void> {
  const rows = await SkillRegistry.listForRoot(root.scope, root.projectId);
  for (const row of rows) {
    if (!existsSync(path.join(root.dir, row.slug, 'SKILL.md'))) {
      await deleteSkillFolderRow(root, row.slug);
    }
  }
}

export async function listSkillRoots(
  personalDir: string = SNAGLET_SKILLS_DIR,
  builtinDir: string | null = resolveBuiltinSkillsDir()
): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [{ scope: 'personal', projectId: null, dir: personalDir }];
  if (builtinDir) roots.push({ scope: 'builtin', projectId: null, dir: builtinDir });
  return roots;
}

/**
 * Startup sweep: delete rows older databases may still hold — every `project`
 * row (project `.snaglet/skills` folders are not scanned) and any `missing` row
 * (skills are deleted when their folder vanishes). Their assignments cascade.
 * Never throws.
 */
async function deleteRetiredSkillRows(): Promise<void> {
  try {
    const n = await SkillRegistry.deleteRetiredRows();
    if (n > 0) logger.info(`${LOG_PREFIX} deleted ${n} retired skill row(s)`);
  } catch (err) {
    logger.warn(`${LOG_PREFIX} could not delete retired skill rows: ${getErrorMessage(err)}`);
  }
}

/**
 * How long a watched skill's SKILL.md may be absent before its row is deleted.
 * An editor's remove-then-write save, a git checkout, or a briefly moved file
 * can make one debounced scan see the folder gone; deleting at once would
 * silently drop every assignment of the skill (FK cascade). The boot-time
 * reconcile (markVanishedSkills) needs no grace and stays immediate.
 */
const SKILL_VANISH_GRACE_MS = 3000;

function rootKey(root: SkillRoot): string {
  return `${root.scope}:${root.projectId ?? ''}:${root.dir}`;
}

export class SkillRegistryService {
  private readonly scanners = new Map<string, FolderScanner>();

  /** Pending grace-period deletes, keyed by root + slug. */
  private readonly pendingDeletes = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly personalDir: string = SNAGLET_SKILLS_DIR,
    private readonly vanishGraceMs: number = SKILL_VANISH_GRACE_MS,
    private readonly builtinDir: string | null = resolveBuiltinSkillsDir()
  ) {}

  /**
   * Watch-path removal: wait out the grace period, then re-check SKILL.md on
   * disk. Still absent → delete the row. Back → do nothing: the scanner
   * re-registers it, and the upsert keeps the same id, so assignments survive.
   * One pending check per skill; a repeat removal restarts the wait.
   */
  private scheduleVanishCheck(root: SkillRoot, slug: string): Promise<void> {
    const key = `${rootKey(root)}:${slug}`;
    const prior = this.pendingDeletes.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.pendingDeletes.delete(key);
      if (existsSync(path.join(root.dir, slug, 'SKILL.md'))) {
        logger.info(`${LOG_PREFIX} skill "${slug}" came back within the grace period; kept`);
        return;
      }
      const run = deleteSkillFolderRow(root, slug).finally(() => this.inFlight.delete(run));
      this.inFlight.add(run);
    }, this.vanishGraceMs);
    timer.unref?.();
    this.pendingDeletes.set(key, timer);
    return Promise.resolve();
  }

  /** Start scanners for every current root; stop ones that no longer apply. Idempotent. */
  async syncRoots(): Promise<void> {
    await deleteRetiredSkillRows();
    const roots = await listSkillRoots(this.personalDir, this.builtinDir);
    if (!this.builtinDir)
      logger.warn(`${LOG_PREFIX} no built-in skills folder found; none indexed`);
    const wanted = new Set(roots.map(rootKey));
    for (const [key, scanner] of this.scanners) {
      if (!wanted.has(key)) {
        scanner.stop();
        this.scanners.delete(key);
      }
    }
    for (const root of roots) {
      const key = rootKey(root);
      if (this.scanners.has(key)) continue;
      const scanner = new FolderScanner({
        dir: root.dir,
        kind: 'skills',
        requiredFiles: ['SKILL.md'],
        onUpsert: (folder: ScannedFolder) => registerSkillFolder(root, folder.name),
        onRemove: (slug: string) => this.scheduleVanishCheck(root, slug),
      });
      this.scanners.set(key, scanner);
      await markVanishedSkills(root);
      await scanner.start();
    }
  }

  /** Re-scan every active root now (tests). */
  async scanAll(): Promise<void> {
    for (const scanner of this.scanners.values()) await scanner.scan();
  }

  /** Resolves once no grace-period check is pending or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pendingDeletes.size > 0 || this.inFlight.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stop(): void {
    for (const scanner of this.scanners.values()) scanner.stop();
    this.scanners.clear();
    for (const timer of this.pendingDeletes.values()) clearTimeout(timer);
    this.pendingDeletes.clear();
  }
}

let service: SkillRegistryService | undefined;

/** Boot entry point. Never throws; a bad root is logged and skipped. */
export async function startSkillScanner(): Promise<void> {
  try {
    service ??= new SkillRegistryService();
    await service.syncRoots();
  } catch (err) {
    logger.warn(`${LOG_PREFIX} scanner start failed: ${getErrorMessage(err)}`);
  }
}

export function stopSkillScanner(): void {
  service?.stop();
  service = undefined;
}
