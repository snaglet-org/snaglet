/**
 * Read-only skill browsing for the Skills sidebar.
 *
 * Lists the user's own skills, a skill folder's files, and one file's text.
 * Built-in skills are left out everywhere here (see isUserSkill). Nothing
 * here writes to disk or the DB. Every path is resolved with realpath and must
 * stay inside the skill's own folder, the same guard `skill {op: "read"}`
 * uses, so a symlink cannot expose files outside `~/.snaglet/skills/<slug>/`.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { SkillRegistry, type SkillRegistryRow } from '@snaglet/db/tables/skill_registry';
import type { SkillStatus } from '@snaglet/db/tables/skill_registry';
import { isContained } from './skillFile';

/**
 * The read-only viewer shows files up to this size; bigger ones get a clear
 * refusal. A viewer limit only: skills themselves have no size limit.
 */
const SKILL_VIEW_MAX_BYTES = 256 * 1024;
/** Folder walk bounds, so a huge or deep folder can't stall the sidebar. */
const SKILL_FILES_MAX_ENTRIES = 200;
const SKILL_FILES_MAX_DEPTH = 4;

export interface SkillListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: SkillStatus;
  error: string | null;
  /** Absolute path to SKILL.md. */
  sourcePath: string;
  /** Absolute path to the skill folder (for Copy path / Reveal in Finder). */
  folderPath: string;
  /** First 8 hex chars of the SKILL.md content hash, or null. */
  version: string | null;
  indexedAt: string;
}

export interface SkillFileEntry {
  /** Path relative to the skill folder, `/`-separated. */
  path: string;
  size: number;
}

export interface SkillFileContent {
  path: string;
  /** Absolute path on disk (for Copy path). */
  absolutePath: string;
  content: string;
}

/** A browse failure the route maps to an HTTP status. */
export class SkillBrowseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 415
  ) {
    super(message);
    this.name = 'SkillBrowseError';
  }
}

function toItem(row: SkillRegistryRow): SkillListItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    error: row.error,
    sourcePath: row.sourcePath,
    folderPath: path.dirname(row.sourcePath),
    version: row.contentHash ? row.contentHash.slice(0, 8) : null,
    indexedAt: row.indexedAt,
  };
}

/**
 * Built-in skills ship with Snaglet and every agent always has them, so the UI
 * never shows them: not in the list, the pickers, or the file browser. A
 * personal skill with a built-in's slug is the user's own and stays visible.
 */
function isUserSkill(row: SkillRegistryRow): boolean {
  return row.scope !== 'builtin';
}

/** The user's own skills, sorted by slug. A vanished folder has no row. */
export async function listSkillsForUi(): Promise<SkillListItem[]> {
  const rows = (await SkillRegistry.listAll()).filter(isUserSkill);
  return rows.map(toItem).sort((a, b) => a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id));
}

/** One of the user's own skills; a built-in id is not found, like an unknown one. */
export async function getSkillForUi(id: string): Promise<SkillRegistryRow> {
  const row = await SkillRegistry.findById(id);
  if (!row || !isUserSkill(row)) throw new SkillBrowseError(`Skill '${id}' not found.`, 404);
  return row;
}

/**
 * The skill's folder, resolved with realpath and required to sit strictly
 * inside the realpath of its skills root (`<root>/<slug>/SKILL.md`, the same
 * derivation as skillTool's folderOf). A skill folder that is itself a symlink
 * out of the root (`<root>/x -> ~/.ssh`) is refused here, so browse and reveal
 * never follow it — even though the registry still holds the unresolved path.
 */
export async function realFolderOf(row: SkillRegistryRow): Promise<string> {
  // A folder that is gone (row not yet swept by the scanner) is a 404 from realpath.
  const folder = path.dirname(row.sourcePath);
  let realFolder: string;
  let realRoot: string;
  try {
    realFolder = await fs.realpath(folder);
    realRoot = await fs.realpath(path.dirname(folder));
  } catch {
    throw new SkillBrowseError(`Skill folder for '${row.slug}' not found.`, 404);
  }
  if (!isContained(realRoot, realFolder) || realFolder === realRoot) {
    throw new SkillBrowseError(
      `Skill folder for '${row.slug}' resolves outside the skills folder.`,
      400
    );
  }
  return realFolder;
}

/**
 * Files in a skill folder, depth-first, sorted (SKILL.md first). Symlinks are
 * followed only when they resolve inside the folder; directories are walked
 * at most SKILL_FILES_MAX_DEPTH deep and SKILL_FILES_MAX_ENTRIES files total.
 */
export async function listSkillFiles(
  id: string
): Promise<{ files: SkillFileEntry[]; truncated: boolean }> {
  const row = await getSkillForUi(id);
  const root = await realFolderOf(row);
  const files: SkillFileEntry[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= SKILL_FILES_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      let real: string;
      try {
        real = await fs.realpath(path.join(dir, name));
      } catch {
        continue; // dangling symlink
      }
      if (!isContained(root, real) || real === root) continue;
      const stat = await fs.stat(real).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth < SKILL_FILES_MAX_DEPTH) await walk(real, depth + 1);
        else truncated = true;
      } else if (stat.isFile()) {
        files.push({
          path: path.relative(root, real).split(path.sep).join('/'),
          size: stat.size,
        });
      }
    }
  }

  await walk(root, 1);
  files.sort((a, b) => {
    if (a.path === 'SKILL.md') return -1;
    if (b.path === 'SKILL.md') return 1;
    return a.path.localeCompare(b.path);
  });
  return { files, truncated };
}

/** One text file from a skill folder. Same containment and binary guards as `skill {op: "read"}`. */
export async function readSkillFileForUi(id: string, rel: string): Promise<SkillFileContent> {
  if (!rel || !rel.trim()) throw new SkillBrowseError('path is required.', 400);
  if (path.isAbsolute(rel)) {
    throw new SkillBrowseError('path must be relative to the skill folder.', 400);
  }
  const row = await getSkillForUi(id);
  const root = await realFolderOf(row);
  let real: string;
  try {
    real = await fs.realpath(path.resolve(root, rel));
  } catch {
    throw new SkillBrowseError(`File '${rel}' not found in skill '${row.slug}'.`, 404);
  }
  if (!isContained(root, real) || real === root) {
    throw new SkillBrowseError(`path '${rel}' is outside skill '${row.slug}'.`, 400);
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new SkillBrowseError(`'${rel}' is not a file.`, 400);
  if (stat.size > SKILL_VIEW_MAX_BYTES) {
    throw new SkillBrowseError(
      `'${rel}' is ${stat.size} bytes; the viewer shows files up to ${SKILL_VIEW_MAX_BYTES}.`,
      413
    );
  }
  const content = await fs.readFile(real, 'utf8');
  if (content.includes('\u0000')) throw new SkillBrowseError(`'${rel}' is not a text file.`, 415);
  return { path: path.relative(root, real).split(path.sep).join('/'), absolutePath: real, content };
}
