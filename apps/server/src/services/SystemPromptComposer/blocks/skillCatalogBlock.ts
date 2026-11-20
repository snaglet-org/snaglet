/**
 * skillCatalogBlock — the ## Skills list.
 *
 * THREAD SEGMENT, not core: the effective skill set varies per thread
 * (Inherit/Add/Override), so this block sits after every CORE builder and
 * before threadSystemPromptBlock (the user's thread prompt stays last). It
 * shares the single system cache breakpoint; no breakpoint of its own.
 *
 * Bytes are a pure function of the set (sorted, no hashes/timestamps), and the
 * block renders nothing when the agent has no effective skills here.
 */
import { renderSkillCatalog } from '../../skills/skillCatalog';
import { isHelperRun } from '../helperRun';
import type { BlockBuilder } from '../types';

/**
 * The built-ins about working with other agents: the snaglet-agent-collab hub and
 * its three leaves. A subagent helper works alone in its hidden thread and
 * takes no part in DMs, so none is listed for it (fixed per agent row, so
 * still cache-stable).
 */
const NOT_FOR_HELPERS = new Set([
  'snaglet-agent-collab',
  'snaglet-group-threads',
  'snaglet-other-threads',
  'snaglet-dms',
]);

/**
 * snaglet-group-threads is for a thread with other agents in it (routing, who
 * answers, bringing someone in), which a DM / home thread never is: it holds
 * the user and this one agent, and agents cannot be added. Fixed for the
 * thread's life, so still cache-stable.
 */
const NOT_FOR_HOME_THREADS = new Set(['snaglet-group-threads']);

export const skillCatalogBlock: BlockBuilder = async (ctx) => {
  const entries = ctx.skillCatalog ?? [];
  const hidden = isHelperRun(ctx) ? NOT_FOR_HELPERS : ctx.isDm ? NOT_FOR_HOME_THREADS : null;
  const listed = hidden ? entries.filter((e) => !hidden.has(e.slug)) : entries;
  const text = renderSkillCatalog(listed);
  return text === null ? null : { type: 'text', text };
};
