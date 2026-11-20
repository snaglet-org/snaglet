import { Threads, type ThreadRow } from '@snaglet/db/tables/threads';
import { Messages } from '@snaglet/db/tables/messages';
import { Users } from '@snaglet/db/tables/users';
import { generateId, getErrorMessage, isoNow } from '@snaglet/shared/utils';
import { wsService } from './WebSocketService';
import { dispatchToThread } from './SocketService/dispatch/dispatchToThread';
import type { DispatchResult } from './SocketService/dispatch/dispatchTypes';
import { LogsService } from './LogsService';
import { hooks } from './HookService';
import { chainStampMetadata } from './customHooks/chainStamp';

/** A settle callback's failure is logged; it never turns into an unhandled rejection. */
function notifyDispatchSettled(
  input: { threadId: string; onDispatchSettled?: (outcome: PostedMessageDispatch) => void },
  outcome: PostedMessageDispatch
): void {
  if (!input.onDispatchSettled) return;
  try {
    input.onDispatchSettled(outcome);
  } catch (err) {
    LogsService.warn('thread_send dispatch callback failed', {
      threadId: input.threadId,
      error: getErrorMessage(err),
    });
  }
}

async function requireThread(threadId: string): Promise<ThreadRow> {
  const thread = await Threads.findById(threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }
  return thread;
}

/** How the fire-and-forget dispatch of a posted message ended. */
export type PostedMessageDispatch = { result: DispatchResult } | { error: unknown };

/**
 * Persist an agent-authored message into a thread, broadcast it, and wake
 * the thread's participants through the shared dispatch core. This is the
 * `thread` op:send implementation.
 *
 * `onDispatchSettled` hears how the dispatch ended (it is not awaited here):
 * subagent helpers use it to report a task that never got a turn.
 */
export async function postAgentMessageToThread(input: {
  threadId: string;
  agentId: string;
  content: string;
  onDispatchSettled?: (outcome: PostedMessageDispatch) => void;
}): Promise<{ messageId: string }> {
  await requireThread(input.threadId);
  const messageId = generateId('message');
  const createdAt = isoNow();

  await Messages.create({
    id: messageId,
    threadId: input.threadId,
    role: 'assistant',
    content: input.content,
    agentId: input.agentId,
    messageType: 'message',
    // A hook-caused send keeps its chain context if the thread is busy and the
    // wake is delivered later, from another run. Server-only key.
    metadata: chainStampMetadata(),
  });

  // Lifecycle hook — the agent-to-agent `thread_send` chokepoint (high
  // volume in a multi-agent workspace; the other two wired emit sites are
  // chatHandlers.ts for live user sends and utteranceMessages.ts for spoken
  // agent replies). `chars` is generic lifecycle metadata available to
  // user-authored hooks. Fire-and-forget, never blocks.
  hooks.emit('message:create', {
    id: messageId,
    threadId: input.threadId,
    role: 'agent',
    agentId: input.agentId,
    text: input.content,
    chars: input.content.length,
  });

  wsService.broadcastToChannel(input.threadId, {
    type: 'socket:chat:message_created',
    payload: {
      id: messageId,
      threadId: input.threadId,
      role: 'assistant',
      content: input.content,
      agent_id: input.agentId,
      created_at: createdAt,
      message_type: 'message',
    },
  });

  // Fire-and-forget: the target thread's wave loop runs until every woken agent
  // (and every agent THEY wake) finishes — minutes to hours. Awaiting it here
  // held the SENDING agent's run hostage for that whole span, wedging its own
  // thread: while wedged, inbound messages queue in memory and the abort signal
  // can't reach inside the await (an observed cause of orchestrator
  // freezes). The seed
  // message is already persisted above, and the dispatch core's busy-skip /
  // queued_for_post_run machinery guarantees the wake is never lost, so the
  // sender needs nothing from the wave's outcome.
  void dispatchToThread({
    threadId: input.threadId,
    senderId: input.agentId,
    messageId,
    message: input.content,
    source: 'tool',
    // Busy target thread → also delivered into its running agents' next tool
    // turn (mode-gated: a peer reaches them only via @mention or all mode).
    sender: { kind: 'agent' },
  }).then(
    (dispatch) => {
      LogsService.socket.event('thread_send dispatch settled', {
        threadId: input.threadId,
        senderId: input.agentId,
        messageId,
        ok: dispatch.ok,
        reason: dispatch.reason,
        wakeCount: dispatch.wakeCount,
      });
      notifyDispatchSettled(input, { result: dispatch });
    },
    (err: unknown) => {
      LogsService.error('thread_send dispatch failed', {
        threadId: input.threadId,
        senderId: input.agentId,
        messageId,
        error: getErrorMessage(err),
      });
      notifyDispatchSettled(input, { error: err });
    }
  );

  return { messageId };
}

/**
 * Persist a message from an authenticated external MCP member and wake the
 * thread through the same dispatch core as native sends. The messages table's
 * role/author invariant requires a users-row author, so the local user remains
 * the structural author while the real external identity is retained in the
 * established `metadata.externalSender` provenance field.
 */
export async function postExternalMessageToThread(input: {
  threadId: string;
  memberId: string;
  memberName: string;
  content: string;
}): Promise<{ messageId: string }> {
  await requireThread(input.threadId);
  const messageId = generateId('message');
  const createdAt = isoNow();
  const localUser = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());
  const externalSender = { memberId: input.memberId, name: input.memberName };

  await Messages.create({
    id: messageId,
    threadId: input.threadId,
    role: 'user',
    content: input.content,
    userId: localUser.id,
    messageType: 'message',
    metadata: { externalSender },
  });

  hooks.emit('message:create', {
    id: messageId,
    threadId: input.threadId,
    role: 'user',
    text: input.content,
    chars: input.content.length,
  });

  wsService.broadcastToChannel(input.threadId, {
    type: 'socket:chat:message_created',
    payload: {
      id: messageId,
      threadId: input.threadId,
      role: 'user',
      content: input.content,
      user_id: localUser.id,
      agent_id: null,
      external_sender: externalSender,
      external_sender_label: null,
      created_at: createdAt,
      message_type: 'message',
    },
  });

  void dispatchToThread({
    threadId: input.threadId,
    senderId: input.memberId,
    messageId,
    message: input.content,
    source: 'tool',
    // Busy thread → also delivered into the running target agents' next tool
    // turn, exactly like a socket send from the app (user voice: always injected).
    sender: { kind: 'user', name: input.memberName, userId: localUser.id },
  }).then(
    (dispatch) => {
      LogsService.socket.event('external thread_send dispatch settled', {
        threadId: input.threadId,
        senderId: input.memberId,
        messageId,
        ok: dispatch.ok,
        reason: dispatch.reason,
        wakeCount: dispatch.wakeCount,
      });
    },
    (err: unknown) => {
      LogsService.error('external thread_send dispatch failed', {
        threadId: input.threadId,
        senderId: input.memberId,
        messageId,
        error: getErrorMessage(err),
      });
    }
  );

  return { messageId };
}
