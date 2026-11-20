/**
 * skill(op) handlers.
 *
 *   load {slug, part?, version?}       → the skill's SKILL.md, re-read from disk now
 *   read {slug, path, part?, version?} → one supporting text file inside the skill folder
 *
 * Every call re-resolves the CALLING agent's effective set for the CALLING
 * thread; a skill outside it is refused with
 * "Skill 'x' is not available in this thread." (Advertising `skill` is
 * per-agent; availability is per-thread and checked here.) Skill content is
 * returned as text and never executed; loading grants no permissions.
 *
 * Files have no length limit. One that does not fit in a single tool result
 * (the `max_result_chars` setting, the same floor toolDispatch trims at) comes
 * back in numbered parts, `part` picking one (skillParts.ts), so the middle of
 * a long skill is never cut out at ingest. Each call reads the file once and
 * uses that one text for the version and the content; a `version` from an
 * earlier part's footer that no longer matches is refused.
 *
 * Files over SKILL_FILE_MAX_BYTES are refused from their size before any read
 * (a memory guard, not an authoring limit), and a supporting file is sniffed
 * for NUL bytes before it is read whole.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { SkillRegistryRow } from '@snaglet/db';
import { settingsService } from '@server/services/settings';
import { toolSettings } from '@server/services/settings/categories/tool';
import {
  formatMegabytes,
  hashSkillContent,
  isContained,
  readSkillFolderText,
  SKILL_FILE_MAX_BYTES,
} from './skillFile';
import { loadEffectiveSkills } from './skillCatalog';
import { pageSkillText } from './skillParts';

/** Bytes sniffed for a NUL before a supporting file is read whole. */
const BINARY_SNIFF_BYTES = 8 * 1024;

function notAvailable(slug: string): Error {
  return new Error(`Skill '${slug}' is not available in this thread.`);
}

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} is required.`);
  return v.trim();
}

/**
 * Pick the effective skill for a slug. Skills live in one place (`~/.snaglet/skills`)
 * so a slug names at most one skill. Pure — exported for tests.
 */
export function pickSkill(effective: readonly SkillRegistryRow[], slug: string): SkillRegistryRow {
  const match = effective.find((s) => s.slug === slug);
  if (!match) throw notAvailable(slug);
  return match;
}

async function resolveForCall(
  input: Record<string, unknown>,
  context: { agentId?: string; threadId?: string } | undefined
): Promise<SkillRegistryRow> {
  const slug = requireString(input, 'slug');
  if (!context?.agentId || !context.threadId) {
    throw new Error('skill can only be used by an agent inside a thread.');
  }
  const effective = await loadEffectiveSkills(context.agentId, context.threadId);
  return pickSkill(effective, slug);
}

/** The skill folder and its root, derived from the registry's SKILL.md path. */
function folderOf(skill: SkillRegistryRow): { folder: string; root: string } {
  const folder = path.dirname(skill.sourcePath);
  return { folder, root: path.dirname(folder) };
}

/** The ingest floor toolDispatch trims every tool result at, read the same way. */
function maxResultChars(): Promise<number> {
  return settingsService.read(toolSettings.maxResultChars);
}

/** Version of the whole file, so every part of one file carries the same one. */
function versionOf(text: string): string {
  return hashSkillContent(text).slice(0, 12);
}

export async function loadSkill(
  input: Record<string, unknown>,
  context: { agentId?: string; threadId?: string } | undefined
): Promise<string> {
  const skill = await resolveForCall(input, context);
  const { root } = folderOf(skill);
  // Re-validate from disk (the registry may lag an edit by a scan tick), and
  // use that one read for the version and the content.
  const { result: check, text } = await readSkillFolderText(root, skill.slug);
  if (check.status !== 'valid' || text === null) {
    throw new Error(
      `Skill '${skill.slug}' is invalid right now: ${check.error ?? 'unknown error'}`
    );
  }
  const version = versionOf(text);
  return pageSkillText({
    text,
    version,
    header: (at) =>
      `[Skill ${skill.slug} · version ${version}${at ? ` · part ${at.n} of ${at.total}` : ''} · read supporting files with skill {op: "read", slug, path}]`,
    call: { op: 'load', slug: skill.slug },
    label: `Skill '${skill.slug}'`,
    maxResultChars: await maxResultChars(),
    part: input.part,
    expectedVersion: input.version,
  });
}

/**
 * A supporting file's text: refused unread when over SKILL_FILE_MAX_BYTES,
 * and when its first bytes hold a NUL (binary), before it is read whole.
 */
async function readSupportingText(realFile: string, rel: string, size: number): Promise<string> {
  if (size > SKILL_FILE_MAX_BYTES) {
    throw new Error(
      `'${rel}' is ${formatMegabytes(size)}; skill files over ${formatMegabytes(SKILL_FILE_MAX_BYTES)} are not read.`
    );
  }
  const notText = new Error(`'${rel}' is not a text file.`);
  const handle = await fs.open(realFile, 'r');
  try {
    const head = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (head.subarray(0, bytesRead).includes(0)) throw notText;
  } finally {
    await handle.close();
  }
  const text = await fs.readFile(realFile, 'utf8');
  if (text.includes('\u0000')) throw notText;
  return text;
}

export async function readSkillFile(
  input: Record<string, unknown>,
  context: { agentId?: string; threadId?: string } | undefined
): Promise<string> {
  const rel = requireString(input, 'path');
  if (path.isAbsolute(rel)) throw new Error('path must be relative to the skill folder.');
  const skill = await resolveForCall(input, context);
  const { folder } = folderOf(skill);
  let realFolder: string;
  let realFile: string;
  try {
    realFolder = await fs.realpath(folder);
    realFile = await fs.realpath(path.resolve(folder, rel));
  } catch {
    throw new Error(`File '${rel}' not found in skill '${skill.slug}'.`);
  }
  if (!isContained(realFolder, realFile) || realFile === realFolder) {
    throw new Error(`path '${rel}' is outside skill '${skill.slug}'.`);
  }
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error(`'${rel}' is not a file.`);
  const text = await readSupportingText(realFile, rel, stat.size);
  const version = versionOf(text);
  return pageSkillText({
    text,
    version,
    header: (at) =>
      at
        ? `[Skill ${skill.slug} · ${rel} · version ${version} · part ${at.n} of ${at.total}]`
        : `[Skill ${skill.slug} · ${rel}]`,
    call: { op: 'read', slug: skill.slug, path: rel },
    label: `'${rel}' in skill '${skill.slug}'`,
    maxResultChars: await maxResultChars(),
    part: input.part,
    expectedVersion: input.version,
  });
}
