import { Messages } from '@snaglet/db/tables/messages';
import { Users } from '@snaglet/db/tables/users';
import { syncMessageEmbedding } from '@server/services/EmbeddingService';
import { wsService } from '@server/services/WebSocketService';
import { getErrorMessage, isoNow } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';

/**
 * Persist-first: write an inbound chat message that arrived while a run holds
 * the thread lock straight to the `messages` table, before it is parked in the
 * mid-run injection queue.
 *
 * A run wedged in a never-returning tool call never drains its in-memory queue
 * and never ends, so a memory-only message would be lost. Persisting on receipt
 * makes the DB the source of truth: the queue holds a reference, and a frozen
 * run can only delay delivery, never lose it. The row is stamped
 * `injectedDuringRun: true` with the same clean-content + `persistedInjection`
 * metadata shape the drain path writes.
 *
 * Returns true on a durable write. On failure it returns false and the caller
 * falls back to the in-memory-only enqueue, so a transient DB error still
 * delivers the message rather than dropping it.
 */
export async function persistInboundMidRunMessage(params: {
  id: string;
  threadId: string;
  content: string;
  injection?: string;
  threadName: string;
}): Promise<boolean> {
  const { id, threadId, content, injection, threadName } = params;
  let userId: string;
  try {
    const user = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());
    userId = user.id;
    await Messages.create({
      id,
      threadId,
      role: 'user',
      content,
      agentId: null,
      userId: user.id,
      injectedDuringRun: true,
      metadata: injection ? { persistedInjection: injection } : null,
    });
  } catch (err) {
    LogsService.warn('persist-first: failed to persist inbound mid-run message', {
      threadName,
      threadId,
      messageId: id,
      error: getErrorMessage(err),
    });
    return false;
  }

  void syncMessageEmbedding(id, content).catch((err) => {
    LogsService.warn('message embedding sync failed', {
      threadName,
      threadId,
      messageId: id,
      error: getErrorMessage(err),
    });
  });
  // This broadcast IS the persisted ack the UI waits on (pending → sent):
  // it must only ever fire after the Messages.create above succeeded.
  wsService.broadcastToChannel(threadId, {
    type: 'socket:chat:message_created',
    payload: {
      id,
      threadId,
      role: 'user',
      content,
      user_id: userId,
      created_at: isoNow(),
      message_type: 'message',
      injected_during_run: true,
    },
  });
  return true;
}
