/**
 * resolveEffectiveSkills — the one place an agent's skill set for a thread is
 * decided. Pure: callers load rows, this decides.
 *
 *   inherit  → general defaults
 *   add      → general defaults ∪ thread picks (a skill in both keeps origin 'general')
 *   override → thread picks only (empty override = no assigned skills)
 *
 * Built-in skills are added on top in every mode (see `builtin`). They cannot
 * be assigned: an assignment row left over from before that rule (scope
 * 'builtin' in `registry`) is skipped here, neither effective nor dropped, so
 * it never shows in settings and never outranks a personal override.
 *
 * A candidate is dropped (with a reason, for settings) when its registry row
 * is gone or not `valid`. Skills are not per-project: a valid skill is
 * available in every thread, in any project. Order: general picks first, then
 * thread picks, each in assignment order; ids are deduped.
 */

import type { SkillAssignmentRow, SkillMode, SkillRegistryRow } from '@snaglet/db';

type SkillOrigin = 'general' | 'thread' | 'builtin';
/**
 * 'unknown': no registry row (a vanished folder deletes its row, and its
 * assignments cascade, so this is the defensive case). 'invalid': row exists
 * but is not `valid`.
 */
type SkillDropReason = 'unknown' | 'invalid';

interface EffectiveSkill {
  skill: SkillRegistryRow;
  origin: SkillOrigin;
}

interface DroppedSkill {
  skillId: string;
  origin: SkillOrigin;
  reason: SkillDropReason;
}

export interface ResolveEffectiveSkillsInput {
  mode: SkillMode;
  general: readonly Pick<SkillAssignmentRow, 'skillId'>[];
  thread: readonly Pick<SkillAssignmentRow, 'skillId'>[];
  /** Registry rows by id (at least every assigned id that still exists). */
  registry: ReadonlyMap<string, SkillRegistryRow>;
  /**
   * Built-in skills (scope 'builtin'): every agent gets them in every mode,
   * with no assignment. Appended after the assigned ones; one whose slug an
   * assigned skill already uses is skipped, so a user's own skill of the same
   * name overrides the built-in.
   */
  builtin?: readonly SkillRegistryRow[];
}

export interface ResolvedSkills {
  effective: EffectiveSkill[];
  dropped: DroppedSkill[];
}

export function resolveEffectiveSkills(input: ResolveEffectiveSkillsInput): ResolvedSkills {
  const candidates: { skillId: string; origin: SkillOrigin }[] = [];
  if (input.mode !== 'override') {
    for (const a of input.general) candidates.push({ skillId: a.skillId, origin: 'general' });
  }
  if (input.mode !== 'inherit') {
    for (const a of input.thread) candidates.push({ skillId: a.skillId, origin: 'thread' });
  }

  const seen = new Set<string>();
  const effective: EffectiveSkill[] = [];
  const dropped: DroppedSkill[] = [];
  for (const c of candidates) {
    if (seen.has(c.skillId)) continue;
    // Not marked seen: the built-in still joins below through `builtin`.
    if (input.registry.get(c.skillId)?.scope === 'builtin') continue;
    seen.add(c.skillId);
    const reason = dropReason(input.registry.get(c.skillId));
    if (reason) dropped.push({ ...c, reason });
    else effective.push({ skill: input.registry.get(c.skillId)!, origin: c.origin });
  }
  const slugs = new Set(effective.map((e) => e.skill.slug));
  for (const skill of input.builtin ?? []) {
    if (seen.has(skill.id) || slugs.has(skill.slug) || dropReason(skill)) continue;
    seen.add(skill.id);
    slugs.add(skill.slug);
    effective.push({ skill, origin: 'builtin' });
  }
  return { effective, dropped };
}

function dropReason(skill: SkillRegistryRow | undefined): SkillDropReason | null {
  if (!skill) return 'unknown';
  if (skill.status !== 'valid') return 'invalid';
  return null;
}
