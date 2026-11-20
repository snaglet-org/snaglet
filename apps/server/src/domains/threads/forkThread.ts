/**
 * Copy a home thread (a user↔agent DM) verbatim into a new workspace thread,
 * so the user can clear the home thread and keep its history. One transaction:
 * the thread row and participants (with the agent's per-thread overrides and
 * skills), runs, activity log and messages, with ids remapped through temp
 * tables, one `INSERT … SELECT` per table. New message ids keep the source
 * `(created_at, id)` order; nodes keep the original timestamps. Summaries,
 * embeddings and memories are not copied. The source is never mutated; the
 * caller holds its purge reservation (activeRunTracker.reserveThreadPurge).
 */
import { transaction } from '@snaglet/db/db';
import { Threads, type ThreadRow } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import type { SkillMode } from '@snaglet/db/tables/skill_assignments';
import { AppError, ConflictError, generateId } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

export interface ForkHomeThreadInput {
  sourceThreadId: string;
  title: string;
  /** Target project container, or null/undefined for a flat workspace thread. */
  projectId?: string | null;
}

export interface ForkHomeThreadResult {
  thread: ThreadRow;
  messageCount: number;
}

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

// Lock-contention codes that mean "retry" (409), not a server bug: the fork's
// list writes contend with a concurrent "New thread" for sibling-row locks.
// A foreign-key violation (23503) is not one of them: every deleter of a
// thread's rows takes the same purge reservation the fork holds, so a 23503
// is a real fault (e.g. a bad projectId) and keeps its own status.
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Fork a home thread / user↔agent DM into a real workspace thread.
 *
 * @throws AppError(404) when the source thread is missing.
 * @throws AppError(400) when the source is not a DM, is an agent↔agent DM
 *   (no human member to carry), or is empty.
 * @throws ConflictError(409) when the fork's list writes hit a transient lock
 *   conflict (a serialization, deadlock or lock timeout racing a New thread).
 *   Nothing was committed; the caller may retry.
 */
export async function forkHomeThread(input: ForkHomeThreadInput): Promise<ForkHomeThreadResult> {
  const { sourceThreadId, title, projectId = null } = input;

  const source = await Threads.findById(sourceThreadId);
  if (!source) {
    throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (source.kind !== 'dm') {
    throw badRequest(
      'Only a home thread or DM can be forked to the workspace; this thread is a regular thread.'
    );
  }

  const participants = await ThreadParticipants.listByThread(sourceThreadId);
  const agentParticipant = participants.find((p) => p.kind === 'agent' && p.agentId);
  const userParticipant = participants.find((p) => p.kind === 'user' && p.userId);
  const agentId = agentParticipant?.agentId ?? undefined;
  const userId = userParticipant?.userId ?? undefined;
  if (!agentId || !userId) {
    throw badRequest(
      'Only a home thread (a user and an agent) can be forked; an agent-to-agent DM has no human member to carry.'
    );
  }

  const newThreadId = generateId('thread');

  try {
    const result: ForkHomeThreadResult = await transaction(async (tx) => {
      // Refuse an empty thread inside the tx — the history is the whole point.
      const { rows: countRows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.messages WHERE thread_id = $1`,
        [sourceThreadId]
      );
      const messageCount = countRows[0]?.n ?? 0;
      if (messageCount === 0) {
        throw badRequest('This thread has no messages to fork.');
      }

      const created = await Threads.create(
        // projectId null = flat at the workspace root. deferListSlot: the
        // sibling-list shift locks every thread row in the target list, so it
        // runs at the very end instead of being held across the whole copy.
        { id: newThreadId, title, projectId, deferListSlot: true },
        tx
      );

      // Id maps (temp tables, dropped on commit). Runs: source run id to a new
      // UUID, so activity and messages remap run_id without entering JS.
      await tx.query(
        `CREATE TEMP TABLE _fork_run_map (old_id text PRIMARY KEY, new_id text NOT NULL)
           ON COMMIT DROP`
      );
      await tx.query(
        `INSERT INTO _fork_run_map (old_id, new_id)
         SELECT id, gen_random_uuid()::text FROM public.runs WHERE thread_id = $1`,
        [sourceThreadId]
      );

      // Messages: new ids in source (created_at, id) order, so ties on
      // created_at keep the source order. The id is `generateId('message')`
      // plus a zero-padded row_number with no separator, keeping the normal
      // `message-<ms>-<body>` shape that node-ref chips, the reply checker and
      // the voice filter recognize (`\d{10,}-[A-Za-z0-9]+`). One base per fork,
      // so the counter decides order and ids stay unique across forks.
      const messageIdBase = generateId('message');
      await tx.query(
        `CREATE TEMP TABLE _fork_msg_map (
            old_id text PRIMARY KEY,
            new_id text NOT NULL,
            new_created_at timestamptz NOT NULL
         ) ON COMMIT DROP`
      );
      await tx.query(
        `INSERT INTO _fork_msg_map (old_id, new_id, new_created_at)
         SELECT m.id,
                $2 || lpad(row_number() OVER (ORDER BY m.created_at ASC, m.id ASC)::text, 12, '0'),
                m.created_at
           FROM public.messages m
          WHERE m.thread_id = $1`,
        [sourceThreadId, messageIdBase]
      );

      // Runs
      await tx.query(
        `INSERT INTO public.runs
           (id, thread_id, agent_id, provider_id, model, status, error,
            started_at, finished_at, created_at,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, provider_calls)
         SELECT map.new_id, $2, r.agent_id, r.provider_id, r.model, r.status, r.error,
                r.started_at, r.finished_at, r.created_at,
                r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens, r.provider_calls
           FROM public.runs r
           JOIN _fork_run_map map ON map.old_id = r.id
          WHERE r.thread_id = $1`,
        [sourceThreadId, newThreadId]
      );

      // agent_activity_log (tool-call and thinking records), run_id remapped.
      // A row with a NULL run_id is not thread-attributable and is skipped.
      await tx.query(
        `INSERT INTO public.agent_activity_log
           (id, agent_id, action_type, trigger_type, reason, token_estimate, created_at,
            tool, tool_input, tool_output, run_id, duration_ms, content)
         SELECT gen_random_uuid()::text, a.agent_id, a.action_type, a.trigger_type, a.reason,
                a.token_estimate, a.created_at, a.tool, a.tool_input, a.tool_output,
                map.new_id, a.duration_ms, a.content
           FROM public.agent_activity_log a
           JOIN _fork_run_map map ON map.old_id = a.run_id`
      );

      // Message node spines. Keep each source message's created/updated time, so search
      // and "recent" views treat the copies as old history, not new activity.
      await tx.query(
        `INSERT INTO public.nodes (id, type, created_at, updated_at)
         SELECT map.new_id, 'message',
                COALESCE(n.created_at, map.new_created_at),
                COALESCE(n.updated_at, map.new_created_at)
           FROM _fork_msg_map map
           LEFT JOIN public.nodes n ON n.id = map.old_id`
      );

      // Messages, verbatim with ids, thread and run remapped. search_text is a
      // generated column, so it is not listed.
      await tx.query(
        `INSERT INTO public.messages
           (id, thread_id, user_id, agent_id, role, content, message_type, resolved,
            metadata, run_id, created_at, external_sender, search_entity_terms, visible_to_agent_id)
         SELECT map.new_id, $2, m.user_id, m.agent_id, m.role, m.content, m.message_type, m.resolved,
                m.metadata, runmap.new_id, m.created_at, m.external_sender, m.search_entity_terms, m.visible_to_agent_id
           FROM public.messages m
           JOIN _fork_msg_map map ON map.old_id = m.id
           LEFT JOIN _fork_run_map runmap ON runmap.old_id = m.run_id
          WHERE m.thread_id = $1`,
        [sourceThreadId, newThreadId]
      );

      // Participants and slots last, so their locks are not held across the
      // copy. Per-thread overrides and thread-scoped skills carry over.
      await ThreadParticipants.addParticipant(
        {
          threadId: newThreadId,
          agentId,
          credentialId: agentParticipant!.credentialId,
          providerId: agentParticipant!.providerId,
          modelId: agentParticipant!.modelId,
          systemPromptAddendum: agentParticipant!.systemPromptAddendum,
          toolAccessMode: agentParticipant!.toolAccessMode,
          toolAccessAllowList: agentParticipant!.toolAccessAllowList,
          toolAccessDenyList: agentParticipant!.toolAccessDenyList,
          toolOverrides: agentParticipant!.toolOverrides,
          maxToolCallsPerTurn: agentParticipant!.maxToolCallsPerTurn,
          maxDurationSeconds: agentParticipant!.maxDurationSeconds,
          autoRespond: agentParticipant!.autoRespond,
        },
        tx
      );
      // addParticipant takes no disable-model-fallback flag, so carry it over
      // explicitly (in the same tx) when the source had it on — it belongs with
      // the other per-thread overrides.
      if (agentParticipant!.disableModelFallback) {
        await tx.query(
          `UPDATE public.thread_participants tp
              SET disable_model_fallback = true
             FROM public.members m
            WHERE m.id = tp.member_id AND tp.thread_id = $1 AND m.agent_id = $2`,
          [newThreadId, agentId]
        );
      }
      await ThreadParticipants.addUserParticipant({ threadId: newThreadId, userId }, tx);

      // The thread's working folder is a thread-row column, not set by create;
      // carry it over so the fork opens in the same directory as the source.
      if (source.workingDirectory) {
        await tx.query('UPDATE public.threads SET working_directory = $2 WHERE id = $1', [
          newThreadId,
          source.workingDirectory,
        ]);
      }

      // Thread-scoped skills: the picks (agent_skill_assignments with this
      // thread id) and the skill_mode on the participant. addParticipant above
      // clears thread skills for a brand-new participant, so copy them after.
      await tx.query(
        `INSERT INTO public.agent_skill_assignments (agent_id, skill_id, thread_id)
         SELECT agent_id, skill_id, $2 FROM public.agent_skill_assignments
          WHERE agent_id = $1 AND thread_id = $3
         ON CONFLICT (agent_id, thread_id, skill_id) WHERE thread_id IS NOT NULL DO NOTHING`,
        [agentId, newThreadId, sourceThreadId]
      );
      // Read skill_mode inside the tx (SkillAssignments.getMode uses the pool,
      // a separate snapshot) so the whole fork works on one transactional view.
      const { rows: skillModeRows } = await tx.query<{ skillMode: SkillMode }>(
        `SELECT tp.skill_mode AS "skillMode"
           FROM public.thread_participants tp
           JOIN public.members m ON m.id = tp.member_id
          WHERE tp.thread_id = $1 AND m.agent_id = $2
          LIMIT 1`,
        [sourceThreadId, agentId]
      );
      const sourceSkillMode = skillModeRows[0]?.skillMode ?? 'inherit';
      if (sourceSkillMode !== 'inherit') {
        await tx.query(
          `UPDATE public.thread_participants tp
              SET skill_mode = $3
             FROM public.members m
            WHERE m.id = tp.member_id AND tp.thread_id = $1 AND m.agent_id = $2`,
          [newThreadId, agentId, sourceSkillMode]
        );
      }

      // Open the list slot last (see deferListSlot above), so the sibling-row
      // lock a concurrent New thread needs is held only briefly. The fork is
      // always a top-level chat thread at slot 0 of its bucket.
      await Threads.openSlot(projectId, 0, tx, newThreadId);

      // Re-read the row: `created` predates working_directory and the list
      // slot. The fallback to `created` is defensive only.
      const finalThread = (await Threads.findById(newThreadId, tx)) ?? created;

      return { thread: finalThread, messageCount };
    });

    return result;
  } catch (err) {
    if (isRetryableLockError(err)) {
      throw new ConflictError('This thread is busy; try forking again in a moment.');
    }
    throw err;
  }
}

/**
 * True for the transient lock conflicts the fork's list writes can hit
 * (serialization, deadlock, lock timeout): safe to retry, nothing committed.
 * Anything else, a foreign-key violation included, keeps its real status.
 */
function isRetryableLockError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED || code === LOCK_NOT_AVAILABLE
  );
}
