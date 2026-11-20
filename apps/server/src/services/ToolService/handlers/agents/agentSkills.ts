/**
 * agentSkills — the skills part of update_agent: add, remove or replace an
 * agent's general (default) skill set.
 *
 * Writes go through SkillAssignmentService.replaceGeneral, the same path as
 * PUT /api/agents/:id/skills, so the registry id check is shared. A reference
 * may be a skill id or a slug; a slug that names more than one skill (say a
 * personal and a project skill) must be given by id, except that a personal
 * skill overriding a built-in's slug is simply the personal one. Built-in
 * skills cannot be assigned (every agent has them): the service drops them and
 * the reply names them. Assigning a skill grants no permissions — it only puts
 * the playbook in the agent's ## Skills list.
 */
import { SkillRegistry } from '@snaglet/db';
import type { SkillRegistryRow } from '@snaglet/db';
import { SkillAssignmentService } from '@server/services/skills/SkillAssignmentService';

export interface SkillChangeInput {
  add_skills?: unknown;
  remove_skills?: unknown;
  set_skills?: unknown;
}

export interface SkillChangeResult {
  before: string[];
  after: string[];
  /** Slugs (or ids for unknown rows) of the final set, for the reply. */
  afterLabels: string[];
  /** Slugs of requested built-in skills, which were not assigned (always on). */
  builtinIgnored: string[];
}

/** True when the input asks for any skill change. */
export function hasSkillChange(input: SkillChangeInput): boolean {
  return (
    input.add_skills !== undefined ||
    input.remove_skills !== undefined ||
    input.set_skills !== undefined
  );
}

function toList(v: unknown, name: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) {
    return `\`${name}\` must be an array of skill ids or slugs.`;
  }
  return (v as string[]).map((s) => s.trim());
}

function label(row: SkillRegistryRow): string {
  if (row.scope === 'project') return `${row.slug} (project)`;
  if (row.scope === 'builtin') return `${row.slug} (built-in, every agent has it)`;
  return row.slug;
}

/** Resolve id-or-slug references; returns ids or an error message. */
function resolveRefs(refs: string[], registry: SkillRegistryRow[]): string[] | string {
  const byId = new Map(registry.map((r) => [r.id, r]));
  const ids: string[] = [];
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const ref of refs) {
    if (byId.has(ref)) {
      ids.push(ref);
      continue;
    }
    const all = registry.filter((r) => r.slug === ref);
    // A personal skill with a built-in's slug overrides it: the slug is the user's.
    const own = all.filter((r) => r.scope !== 'builtin');
    const matches = own.length > 0 ? own : all;
    if (matches.length === 1) ids.push(matches[0].id);
    else if (matches.length === 0) unknown.push(ref);
    else ambiguous.push(`${ref} (${matches.map((m) => m.id).join(', ')})`);
  }
  if (unknown.length) {
    const known = registry
      .filter((r) => r.status === 'valid')
      .map(label)
      .slice(0, 40);
    return `Unknown skill(s): ${unknown.join(', ')}. Known skills: ${known.join(', ') || 'none'}.`;
  }
  if (ambiguous.length) {
    return `Slug names more than one skill; pass the id instead: ${ambiguous.join('; ')}.`;
  }
  return ids;
}

interface SkillPlan {
  addIds: string[];
  removeIds: string[];
  setIds: string[] | undefined;
  registry: SkillRegistryRow[];
}

/**
 * Validate and resolve a requested change without writing anything, so a
 * caller (agent create) can refuse bad input before it creates the agent.
 */
export async function planSkillChange(input: SkillChangeInput): Promise<SkillPlan | string> {
  const add = toList(input.add_skills, 'add_skills');
  const remove = toList(input.remove_skills, 'remove_skills');
  const set = input.set_skills === undefined ? undefined : toList(input.set_skills, 'set_skills');
  for (const v of [add, remove, set]) if (typeof v === 'string') return v;
  if (set !== undefined && (input.add_skills !== undefined || input.remove_skills !== undefined)) {
    return '`set_skills` replaces the whole set; do not combine it with add_skills/remove_skills.';
  }

  const registry = await SkillRegistry.listAll();
  const resolve = (refs: string[]) => resolveRefs(refs, registry);
  const addIds = resolve(add as string[]);
  if (typeof addIds === 'string') return addIds;
  const removeIds = resolve(remove as string[]);
  if (typeof removeIds === 'string') return removeIds;
  const setIds = set === undefined ? undefined : resolve(set as string[]);
  if (typeof setIds === 'string') return setIds;
  return { addIds, removeIds, setIds, registry };
}

/**
 * Apply the requested change. `set_skills` sets the whole set and can't be
 * mixed with add/remove. Returns an error string on bad input.
 */
export async function applySkillChange(
  agentId: string,
  input: SkillChangeInput
): Promise<SkillChangeResult | string> {
  const plan = await planSkillChange(input);
  if (typeof plan === 'string') return plan;
  const { addIds, removeIds, setIds, registry } = plan;

  const before = await SkillAssignmentService.listGeneral(agentId);
  let next: string[];
  if (setIds !== undefined) {
    next = [...new Set(setIds)];
  } else {
    const drop = new Set(removeIds);
    next = [...new Set([...before, ...addIds])].filter((id) => !drop.has(id));
  }
  const after = await SkillAssignmentService.replaceGeneral(agentId, next);
  const byId = new Map(registry.map((r) => [r.id, r]));
  return {
    before,
    after,
    afterLabels: after.map((id) => {
      const row = byId.get(id);
      return row ? label(row) : id;
    }),
    builtinIgnored: builtinSlugs([...(setIds ?? []), ...addIds], registry),
  };
}

/** Slugs of the built-in skills among requested ids (never assigned; always on). */
export function builtinSlugs(
  ids: readonly string[],
  registry: readonly SkillRegistryRow[]
): string[] {
  const byId = new Map(registry.map((r) => [r.id, r]));
  return [...new Set(ids)]
    .map((id) => byId.get(id))
    .filter((row): row is SkillRegistryRow => row?.scope === 'builtin')
    .map((row) => row.slug);
}

/** The reply field naming requested built-ins that were not assigned, or nothing. */
export function builtinSkillsNote(slugs: readonly string[]): { skills_note?: string } {
  if (slugs.length === 0) return {};
  return {
    skills_note: `Not assigned: ${slugs.join(', ')} (built-in; every agent always has it).`,
  };
}
