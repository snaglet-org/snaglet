/**
 * SkillAssignmentModel — agent ↔ skill assignments.
 *
 * A row with `threadId = null` is one of the agent's general defaults; a row
 * with a thread id is a pick for that agent in that thread only. How the two
 * combine is `thread_participants.skill_mode` (inherit / add / override); the
 * pure `resolveEffectiveSkills` turns rows + registry + mode into the
 * effective list. Rows are never filtered by skill status here, so a skill
 * that goes invalid or missing stays visible in settings.
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';

export type SkillMode = 'inherit' | 'add' | 'override';
export const SKILL_MODES: readonly SkillMode[] = ['inherit', 'add', 'override'] as const;

export interface SkillAssignmentRow {
  id: string;
  agentId: string;
  skillId: string;
  threadId: string | null;
  createdAt: string;
}

type CreateSkillAssignmentInput = Pick<SkillAssignmentRow, 'agentId' | 'skillId' | 'threadId'>;

class SkillAssignmentModelClass extends Model<SkillAssignmentRow, CreateSkillAssignmentInput> {
  constructor() {
    super({ table: 'agent_skill_assignments', primaryKey: 'id' });
  }

  /** General defaults (`threadId` null) or one thread's picks for an agent. */
  async listForAgent(agentId: string, threadId: string | null): Promise<SkillAssignmentRow[]> {
    return this.query<SkillAssignmentRow>(
      `SELECT * FROM agent_skill_assignments
        WHERE agent_id = $1 AND thread_id IS NOT DISTINCT FROM $2
        ORDER BY created_at, skill_id`,
      [agentId, threadId]
    );
  }

  /** True when the agent has any skill assigned in any scope (drives per-agent tool advertising). */
  async agentHasAny(agentId: string): Promise<boolean> {
    const row = await this.queryOne<{ any: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM agent_skill_assignments WHERE agent_id = $1) AS any',
      [agentId]
    );
    return row?.any === true;
  }

  /**
   * Replace one scope's set (general or one thread) atomically: rows not in
   * `skillIds` go, missing ones are added, kept ones keep their id.
   */
  async replace(
    agentId: string,
    threadId: string | null,
    skillIds: readonly string[]
  ): Promise<SkillAssignmentRow[]> {
    const ids = [...new Set(skillIds)];
    // Name the partial unique index this scope is covered by, so a concurrent
    // save that inserts the same row is skipped instead of failing the whole
    // replace with a unique violation (*_general_uq / *_thread_uq).
    const conflictTarget =
      threadId === null
        ? '(agent_id, skill_id) WHERE thread_id IS NULL'
        : '(agent_id, thread_id, skill_id) WHERE thread_id IS NOT NULL';
    await transaction(async (tx) => {
      await tx.query(
        `DELETE FROM public.agent_skill_assignments
          WHERE agent_id = $1 AND thread_id IS NOT DISTINCT FROM $2
            AND NOT (skill_id = ANY($3::text[]))`,
        [agentId, threadId, ids]
      );
      for (const skillId of ids) {
        await tx.query(
          `INSERT INTO public.agent_skill_assignments (agent_id, skill_id, thread_id)
           VALUES ($1, $2, $3)
           ON CONFLICT ${conflictTarget} DO NOTHING`,
          [agentId, skillId, threadId]
        );
      }
    });
    return this.listForAgent(agentId, threadId);
  }

  /** The thread-agent's skill mode; `inherit` when the agent is not a participant. */
  async getMode(threadId: string, agentId: string): Promise<SkillMode> {
    const row = await this.queryOne<{ skillMode: SkillMode }>(
      `SELECT tp.skill_mode
         FROM public.thread_participants tp
         JOIN public.members m ON m.id = tp.member_id
        WHERE tp.thread_id = $1 AND m.agent_id = $2
        LIMIT 1`,
      [threadId, agentId]
    );
    return row?.skillMode ?? 'inherit';
  }

  /** Set the thread-agent's skill mode. False when the agent is not a participant. */
  async setMode(threadId: string, agentId: string, mode: SkillMode): Promise<boolean> {
    const rows = await this.query<{ id: string }>(
      `UPDATE public.thread_participants tp SET skill_mode = $3, updated_at = now()
         FROM public.members m
        WHERE m.id = tp.member_id AND tp.thread_id = $1 AND m.agent_id = $2
        RETURNING tp.id`,
      [threadId, agentId, mode]
    );
    return rows.length > 0;
  }
}

export const SkillAssignments = new SkillAssignmentModelClass();
