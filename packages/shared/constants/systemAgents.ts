/**
 * System-agent identity constants (the "ghost" permanent actor).
 *
 * `ghost` is a single, permanent system agent that inherits attribution when a
 * real agent is permanently deleted. Deleting an agent DESTROYS its private
 * trash (memories and thread summaries) but repoints every kept
 * reference (messages, runs, activity log, workspace attribution, …) to ghost —
 * so history and provenance never go authorless. Ghost is:
 *   - undeletable  (guarded at the routes, the service, AND a DB trigger),
 *   - unarchivable / unsweepable,
 *   - un-namable   (no agent may be created or renamed to "ghost",
 *                   case-insensitive — the seeded row owns the unique
 *                   lower(name) index),
 *   - invisible    in rosters / pickers / palette / dispatch / ArchivedDrawer,
 *   - but resolvable by id wherever attribution needs a name.
 *
 * Seeded by packages/db/migrations/seeds/ghost-agent.sql (idempotent).
 */

/** Stable primary key of the ghost agent (public.agents.id). */
export const GHOST_AGENT_ID = 'ghost';

/** Reserved display name of the ghost agent (occupies the unique lower(name) index). */
export const GHOST_AGENT_NAME = 'ghost';

/** Stable id of ghost's principal row (public.members.id, kind='agent'). Attribution
 *  FKs (containers/docs created_by, placement_events.moved_by, …) point at members,
 *  so ghost needs its own member entry to inherit them. Kept identical to the agent
 *  id ('ghost') for simplicity — members.id and agents.id are separate PKs. */
export const GHOST_MEMBER_ID = 'ghost';

/**
 * True when `name` collides with a reserved system name (case-insensitive,
 * trimmed): "ghost" (the system actor) or its hook label "system" (what agents
 * see in `[message from system]`). Reserved across both principal kinds: no
 * agent AND no human user may be created or renamed to either, so nobody can
 * pose as Snaglet's own notices. Used to reject a reserved name with a clear message
 * instead of leaking a raw unique-constraint violation (agents) or creating an
 * ambiguous author (users).
 */
export function isReservedActorName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  return n === GHOST_AGENT_NAME || n === GHOST_HOOK_LABEL;
}

/**
 * Display label for messages the ghost system actor posts on behalf of Snaglet itself
 * (hook notices: branch sync, PR relays, review/board wakes). Shown to people in
 * the UI and to agents in the `[message from <label>]` header, in place of the
 * reserved name "ghost". One constant so the wording is a one-line change.
 */
export const GHOST_HOOK_LABEL = 'system';

/** Metadata key AgentModel.purge() stamps on a deleted agent's messages it repoints to ghost. */
export const ORIGINAL_AGENT_NAME_KEY = 'originalAgentName';

/**
 * The name to show for a message's author.
 *
 * Ghost ALSO inherits the messages of permanently deleted agents; purge stamps
 * those with `metadata.originalAgentName`. So ghost without that stamp is a
 * system post (a hook notice) and reads {@link GHOST_HOOK_LABEL}; every other
 * case (a real agent, or a deleted agent's message held by ghost) keeps
 * `fallbackName`, exactly as before. Pure: no I/O.
 *
 * `originalAgentName` is the stamp already read off the metadata (string or
 * nullish); a blank/non-string stamp counts as absent.
 */
export function resolveAuthorLabel<T extends string | null | undefined>(args: {
  agentId: string | null | undefined;
  fallbackName: T;
  originalAgentName?: string | null;
}): T | typeof GHOST_HOOK_LABEL {
  if (args.agentId !== GHOST_AGENT_ID) return args.fallbackName;
  const stamp = args.originalAgentName;
  if (typeof stamp === 'string' && stamp.trim() !== '') return args.fallbackName;
  return GHOST_HOOK_LABEL;
}

/** Read the purge stamp off a raw message-metadata blob; null when absent. */
export function readOriginalAgentName(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const v = (metadata as Record<string, unknown>)[ORIGINAL_AGENT_NAME_KEY];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
