/**
 * Skill catalog — the short "which skills can I load here" list rendered into
 * the system prompt, and the one loader both the turn path
 * and the context-usage estimator call so they cannot drift.
 *
 * The rendered bytes are a pure function of the effective skill set: entries
 * sorted by slug, no hashes, ids or timestamps. It varies per thread
 * (Inherit/Add/Override), so it sits in the thread segment of the system
 * prompt, after the agent-level cached prefix (see composeSystemPrompt.ts).
 */
import { getErrorMessage } from '@snaglet/shared/utils';
import { SkillAssignments, SkillRegistry, Threads } from '@snaglet/db';
import type { SkillRegistryRow } from '@snaglet/db';
import { logger } from '@server/config/logger';
import { resolveEffectiveSkills } from './resolveEffectiveSkills';

/**
 * Safety cap on listed entries. High on purpose: normal skill sets are listed in
 * full, so the model sees every slug. It only bounds a runaway set: a description
 * is up to 1,024 characters (the Agent Skills spec limit), so 60 entries is about
 * 62 KB at the very worst. Real descriptions run 100-500 characters and agents
 * carry a handful of skills, so the usual list is a few KB.
 */
export const SKILL_CATALOG_MAX_ENTRIES = 60;

export interface SkillCatalogEntry {
  slug: string;
  description: string;
}

export const SKILL_CATALOG_HEADER = [
  '## Skills',
  'When a task matches a skill below, load it (`skill` op `load`) before you start, not after. Loading a skill grants no permissions.',
].join('\n');

function compareEntries(a: SkillCatalogEntry, b: SkillCatalogEntry): number {
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return 0;
}

function entryLine(e: SkillCatalogEntry): string {
  const desc = e.description.replace(/\s+/g, ' ').trim();
  return `- \`${e.slug}\`${desc ? ` — ${desc}` : ''}`;
}

/**
 * Render the catalog text, or null when there is nothing to list. Deterministic
 * for a given set regardless of input order. Every skill is listed with its
 * description up to SKILL_CATALOG_MAX_ENTRIES; anything past that is counted in
 * a final "+N more" line so the model knows the list is incomplete.
 */
export function renderSkillCatalog(entries: readonly SkillCatalogEntry[]): string | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(compareEntries);
  const lines = sorted.slice(0, SKILL_CATALOG_MAX_ENTRIES).map(entryLine);
  const hidden = sorted.length - lines.length;
  if (hidden > 0) {
    lines.push(`- +${hidden} more not listed — load any assigned skill by slug.`);
  }
  return [SKILL_CATALOG_HEADER, ...lines].join('\n');
}

export function toCatalogEntries(skills: readonly SkillRegistryRow[]): SkillCatalogEntry[] {
  return skills.map((s) => ({ slug: s.slug, description: s.description }));
}

/**
 * The agent's effective, valid skills for one thread: its assigned skills plus
 * every built-in. With no assignments anywhere (the common case) it skips the
 * assignment queries and returns just the built-ins.
 */
export async function loadEffectiveSkills(
  agentId: string,
  threadId: string
): Promise<SkillRegistryRow[]> {
  const [hasAssigned, builtin] = await Promise.all([
    SkillAssignments.agentHasAny(agentId),
    SkillRegistry.listBuiltinValid(),
  ]);
  if (!hasAssigned) {
    if (builtin.length === 0 || !(await Threads.findById(threadId))) return [];
    return resolveEffectiveSkills({
      mode: 'inherit',
      general: [],
      thread: [],
      registry: new Map(),
      builtin,
    }).effective.map((e) => e.skill);
  }
  const [thread, mode, general, picks, registryRows] = await Promise.all([
    Threads.findById(threadId),
    SkillAssignments.getMode(threadId, agentId),
    SkillAssignments.listForAgent(agentId, null),
    SkillAssignments.listForAgent(agentId, threadId),
    SkillRegistry.listAll(),
  ]);
  if (!thread) return [];
  const resolved = resolveEffectiveSkills({
    mode,
    general,
    thread: picks,
    registry: new Map(registryRows.map((r) => [r.id, r])),
    builtin,
  });
  return resolved.effective.map((e) => e.skill);
}

/**
 * Catalog entries for the system prompt. Best-effort: a lookup failure logs and
 * renders no catalog rather than failing the turn.
 */
export async function loadSkillCatalogEntries(
  agentId: string,
  threadId: string | null | undefined
): Promise<SkillCatalogEntry[]> {
  if (!threadId) return [];
  try {
    return toCatalogEntries(await loadEffectiveSkills(agentId, threadId));
  } catch (err) {
    logger.warn('[skills] catalog lookup failed; rendering none', {
      agentId,
      threadId,
      error: getErrorMessage(err),
    });
    return [];
  }
}
