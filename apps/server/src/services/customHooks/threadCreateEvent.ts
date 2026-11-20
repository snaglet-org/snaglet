/**
 * threadCreateEvent — the single builder for the `thread:create` hook
 * payload, shared by every emit site (REST create, socket session create,
 * the thread-create tool) and the test console's resolver so all four
 * deliver the same shape:
 *
 *   - `createdBy` — the ambient actor (HTTP middleware binds the user,
 *     the agent run wrapper binds the calling agent), overridable when the
 *     site knows better.
 *   - `participants` — the full roster at creation time, with each agent's
 *     effective model (thread override, else the agent's own config) and
 *     per-thread system-prompt addendum.
 *   - `systemPrompt` — the thread-level prompt (`threads.thread_system_prompt`,
 *     the column the composer reads).
 *
 * Emit sites must call this after participants/prompt are persisted — the
 * builder reads the DB, so an early emit reports an empty roster.
 */
import { getDb } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { getCurrentActor } from '@server/realtime/actorContext';
import { hooks, type HookEventMap } from '@server/services/HookService';

type ThreadCreateEvent = HookEventMap['thread:create'];
type ThreadCreatedBy = ThreadCreateEvent['createdBy'];

export async function buildThreadCreateEvent(
  threadId: string,
  createdByOverride?: ThreadCreatedBy
): Promise<ThreadCreateEvent | null> {
  const { rows: threadRows } = await getDb().query<{
    id: string;
    title: string | null;
    dispatch_mode: string;
    system_prompt: string | null;
  }>(
    `SELECT id, title, dispatch_mode, thread_system_prompt AS system_prompt
       FROM threads WHERE id=$1`,
    [threadId]
  );
  const thread = threadRows[0];
  if (!thread) return null;

  const { rows: parts } = await getDb().query<{
    kind: 'agent' | 'user' | 'external';
    agent_id: string | null;
    user_id: string | null;
    provider_id: string | null;
    model_id: string | null;
    system_prompt_addendum: string | null;
  }>(
    // Effective model = the participant's thread-level override when set,
    // else the agent's own configured provider/model.
    `SELECT m.kind, m.agent_id, m.user_id,
            COALESCE(tp.provider_id, a.provider_id) AS provider_id,
            COALESCE(tp.model_id, a.model_id) AS model_id,
            tp.system_prompt_addendum
       FROM thread_participants tp
       JOIN members m ON m.id=tp.member_id
       LEFT JOIN agents a ON a.id=m.agent_id
      WHERE tp.thread_id=$1
      ORDER BY tp.created_at, tp.id`,
    [threadId]
  );

  const participants: ThreadCreateEvent['participants'] = parts.map((row) => ({
    kind: row.kind,
    ...(row.agent_id ? { id: row.agent_id } : row.user_id ? { id: row.user_id } : {}),
    ...(row.kind === 'agent'
      ? {
          providerId: row.provider_id,
          modelId: row.model_id,
          systemPromptAddendum: row.system_prompt_addendum,
        }
      : {}),
  }));
  const firstAgentId = parts.find((row) => row.agent_id)?.agent_id ?? undefined;

  const actor = getCurrentActor();
  const createdBy: ThreadCreatedBy =
    createdByOverride ??
    (actor
      ? { kind: actor.actorKind, ...(actor.actorKind === 'system' ? {} : { id: actor.actorId }) }
      : { kind: 'system' });

  return {
    id: thread.id,
    title: thread.title,
    createdBy,
    ...(firstAgentId ? { agentId: firstAgentId } : {}),
    participants,
    systemPrompt: thread.system_prompt,
    dispatchMode: thread.dispatch_mode,
  };
}

/**
 * Fire-and-forget emit for the creation sites. Never throws and never
 * blocks the response path; a build failure is logged and swallowed —
 * hooks are observers, not part of the write.
 */
export function emitThreadCreate(threadId: string, createdByOverride?: ThreadCreatedBy): void {
  void buildThreadCreateEvent(threadId, createdByOverride)
    .then((event) => {
      if (event) hooks.emit('thread:create', event);
    })
    .catch((err: unknown) => {
      logger.warn('thread:create hook emit failed', { threadId, error: getErrorMessage(err) });
    });
}
