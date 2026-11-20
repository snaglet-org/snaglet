import { buildProjectLineageString } from '@server/services/ToolService/lib/buildProjectLineageString';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Messages } from '@snaglet/db/tables/messages';
import { LogsService } from '@server/services/LogsService';

/**
 * Hard ceiling on how long the injection lookup may take. This runs on the
 * run's critical path (inside the run lock), so it must not be able to hang
 * the run. A timeout is the only thing that protects against a wedged query
 * (pool exhaustion, lock contention, a slow/deadlocked CTE): a hang is not a
 * throw, so try/catch alone cannot save us — only a timeout can.
 */
const INJECTION_LOOKUP_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Compute the persisted-injection payload for the first message of an empty
 * thread: the project lineage overview (subproject → parent → root), to be
 * stamped onto the message's metadata.persistedInjection.
 *
 * This must be called at the same point the user's first message is created
 * (chatHandlers), before that message is inserted — otherwise the emptiness
 * gate (count === 0) never passes, because the message already exists.
 *
 * Returns null when:
 *  - the thread already has messages (not the first),
 *  - no enclosing project has overview text,
 *  - any lookup fails, OR
 *  - the lookup exceeds INJECTION_LOOKUP_TIMEOUT_MS.
 *
 * Best-effort by design: this must never block or break the user's message.
 * Hidden from UI, excluded from search/embeddings (metadata, not content),
 * and saved so it caches. Write-once — only ever stamped on message 1.
 */
export async function computePersistedInjection(threadId: string): Promise<string | null> {
  try {
    return await withTimeout(
      computePersistedInjectionInner(threadId),
      INJECTION_LOOKUP_TIMEOUT_MS,
      'persisted injection lookup'
    );
  } catch (err: unknown) {
    LogsService.warn('persisted injection (project overview) lookup failed', {
      threadId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

async function computePersistedInjectionInner(threadId: string): Promise<string | null> {
  // Count only real user sends — an agent-initiated thread emits a
  // `[thread started]` thread_event row at turn zero, which countByThreadId
  // would count, making the later first human message skip this one-time
  // injection. countUserMessagesByThreadId filters to message_type='message',
  // so the opener is detected regardless of author-less event narration.
  const existingCount = await Messages.countUserMessagesByThreadId(threadId);
  if (existingCount !== 0) {
    return null;
  }
  // Delegate to the single shared builder so the persisted injection and
  // workspace_orient can never drift. Returns null when no enclosing project
  // carries context (e.g. a flat thread), in which case the project section is
  // omitted on both surfaces.
  return await buildProjectLineageString(threadId);
}
