/**
 * SkillAssignmentService — reads and writes an agent's skill assignments and
 * resolves its effective set for a thread. Writes validate
 * every skill id against the registry; assigning grants no permissions.
 *
 * Built-in skills cannot be assigned: every agent always has them. A built-in
 * id sent in a write is ignored (not an error, so a list saved before this
 * rule still saves), and no list returned here ever holds one. Saving a set
 * drops any built-in assignment row left over from before; one that is never
 * re-saved stays in the table with no effect.
 *
 * A change to an agent's general set announces `agent.updated` naming
 * `skills`, whichever path wrote it (the agent pane, the update_agent tool,
 * create_agent), so an open agent pane shows it without a reload.
 */
import { SkillAssignments, SkillRegistry, Threads } from '@snaglet/db';
import { emitAgentUpdated } from '@server/realtime/surfaces/agents';
import type { SkillAssignmentRow, SkillMode, SkillRegistryRow } from '@snaglet/db';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { resolveEffectiveSkills, type ResolvedSkills } from './resolveEffectiveSkills';

type Registry = ReadonlyMap<string, SkillRegistryRow>;

async function registryById(): Promise<Map<string, SkillRegistryRow>> {
  const rows = await SkillRegistry.listAll();
  return new Map(rows.map((r) => [r.id, r]));
}

/** Assignment rows minus built-ins (a row with no registry entry is kept). */
function assignedOnly(rows: readonly SkillAssignmentRow[], registry: Registry): string[] {
  return rows.map((a) => a.skillId).filter((id) => registry.get(id)?.scope !== 'builtin');
}

/**
 * The ids to write: unknown ids are refused (nothing is written), built-in
 * ids are dropped.
 */
function assignableSkillIds(skillIds: readonly string[], registry: Registry): string[] {
  const ids = [...new Set(skillIds)];
  const unknown = ids.filter((id) => !registry.has(id));
  if (unknown.length > 0) {
    throw new AppError(
      `Unknown skill id(s): ${unknown.join(', ')}. List skills from the skill registry.`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return ids.filter((id) => registry.get(id)?.scope !== 'builtin');
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

export interface ThreadSkillState {
  mode: SkillMode;
  threadSkillIds: string[];
  generalSkillIds: string[];
  resolved: ResolvedSkills;
}

export const SkillAssignmentService = {
  async listGeneral(agentId: string): Promise<string[]> {
    const [rows, registry] = await Promise.all([
      SkillAssignments.listForAgent(agentId, null),
      registryById(),
    ]);
    return assignedOnly(rows, registry);
  },

  async replaceGeneral(agentId: string, skillIds: readonly string[]): Promise<string[]> {
    const registry = await registryById();
    const ids = assignableSkillIds(skillIds, registry);
    const before = assignedOnly(await SkillAssignments.listForAgent(agentId, null), registry);
    const after = assignedOnly(await SkillAssignments.replace(agentId, null, ids), registry);
    if (!sameSet(before, after)) emitAgentUpdated(agentId, ['skills']);
    return after;
  },

  /**
   * The thread-agent's mode, picks and resolved assigned set. Built-ins are
   * left out of all three: they are not assignments.
   */
  async getThreadState(threadId: string, agentId: string): Promise<ThreadSkillState> {
    const thread = await Threads.findById(threadId);
    if (!thread) {
      throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const [mode, general, picks, registry] = await Promise.all([
      SkillAssignments.getMode(threadId, agentId),
      SkillAssignments.listForAgent(agentId, null),
      SkillAssignments.listForAgent(agentId, threadId),
      registryById(),
    ]);
    return {
      mode,
      generalSkillIds: assignedOnly(general, registry),
      threadSkillIds: assignedOnly(picks, registry),
      resolved: resolveEffectiveSkills({
        mode,
        general,
        thread: picks,
        registry,
      }),
    };
  },

  /** Set mode and/or thread picks. The agent must be a participant of the thread. */
  async updateThread(
    threadId: string,
    agentId: string,
    patch: { mode?: SkillMode; skillIds?: readonly string[] }
  ): Promise<ThreadSkillState> {
    const thread = await Threads.findById(threadId);
    if (!thread) {
      throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    // Validate before any write, so a bad id leaves the mode untouched too.
    const skillIds =
      patch.skillIds === undefined
        ? undefined
        : assignableSkillIds(patch.skillIds, await registryById());
    // setMode doubles as the participant check: a non-participant writes nothing.
    const isParticipant = await SkillAssignments.setMode(
      threadId,
      agentId,
      patch.mode ?? (await SkillAssignments.getMode(threadId, agentId))
    );
    if (!isParticipant) {
      throw new AppError(
        'Thread participant not found',
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    if (skillIds !== undefined) {
      await SkillAssignments.replace(agentId, threadId, skillIds);
    }
    return this.getThreadState(threadId, agentId);
  },
};
