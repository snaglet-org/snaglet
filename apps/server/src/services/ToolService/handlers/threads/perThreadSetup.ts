import type { ThreadParticipantRow } from '@snaglet/db/tables/thread_participants';
import { SkillAssignments } from '@snaglet/db/tables/skill_assignments';

const hasItems = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === 'object' && value !== null && Object.keys(value).length > 0;

/**
 * What a person set up for this agent in this thread, by name; empty when
 * nothing. Taking an agent out of a thread deletes its participant row and its
 * skill picks there, so an agent with any of this is a person's to remove, in
 * the app: the thread tool refuses both `remove_agents` and `leave` for it.
 * One list for both, so they cannot drift.
 */
export async function perThreadSetup(
  threadId: string,
  agentId: string,
  row: ThreadParticipantRow
): Promise<string[]> {
  const setup: string[] = [];
  if (row.modelId || row.providerId || row.credentialId || row.disableModelFallback) {
    setup.push('model');
  }
  if (
    row.toolAccessMode ||
    hasItems(row.toolAccessAllowList) ||
    hasItems(row.toolAccessDenyList) ||
    hasItems(row.toolOverrides)
  ) {
    setup.push('tool access');
  }
  if (row.systemPromptAddendum?.trim()) setup.push('instructions');
  // skill_mode is on the row (tp.*) but not in its declared type.
  const skillMode = (row as { skillMode?: string | null }).skillMode;
  if (
    (skillMode && skillMode !== 'inherit') ||
    (await SkillAssignments.listForAgent(agentId, threadId)).length > 0
  ) {
    setup.push('skills');
  }
  if (row.maxToolCallsPerTurn != null || row.maxDurationSeconds != null) setup.push('limits');
  if (row.autoRespond === false) setup.push('auto-respond off');
  return setup;
}
