import { getErrorMessage, readTrimmedString } from '@snaglet/shared/utils';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { Agents } from '@snaglet/db/tables/agents';
import type { ToolHandler } from '@server/services/ToolService/types';
import {
  postAgentMessageToThread,
  postExternalMessageToThread,
} from '@server/services/ThreadDeliveryPolicyService';
import { getCurrentActor } from '@server/realtime/actorContext';
import {
  assertNotDmThread,
  resolveTargetThreadId,
  threadNotFoundError,
} from '@server/services/ToolService/lib/targetThread';
import { withCrossThreadFooter } from './crossThreadFooter';

/** Delivery's not-found error, rethrown naming the caller's own thread. */
async function deliver<T>(
  threadId: string,
  context: Parameters<typeof threadNotFoundError>[2],
  post: () => Promise<T>
): Promise<T> {
  try {
    return await post();
  } catch (error) {
    if (getErrorMessage(error) === `Thread not found: ${threadId}`) {
      throw await threadNotFoundError('thread op:send', threadId, context);
    }
    throw error;
  }
}

/**
 * The line a hook's message ends with when the hook runs as an agent (run
 * as): `[hook <name> as <Agent>]`. Without it the hook's words read as the
 * agent's own. Other hook posts are unchanged. The agent lookup is
 * decoration: a failure falls back to the id, never fails the send.
 */
export async function hookSenderLine(hookName: string, agentId: string): Promise<string> {
  const agent = await Promise.resolve()
    .then(() => Agents.findById(agentId))
    .catch(() => null);
  return `[hook ${hookName} as ${readTrimmedString(agent?.name) || agentId}]`;
}

/** thread(op:"send"): post a message into a thread. */
const threadSend: ToolHandler = async (input, _settings, context) => {
  let content = readTrimmedString(input.content);
  const requestedAgentId = readTrimmedString(input.sender_agent_id);
  const actor = getCurrentActor();

  if (!content) throw new Error('content is required and must be non-empty');
  // Defaults to the calling thread; external callers must pass an id.
  const threadId = await resolveTargetThreadId(input, context, 'thread op:send');
  await assertNotDmThread('thread op:send', threadId, context, { allowOwnThread: true });

  if (actor?.actorKind === 'external') {
    if (requestedAgentId) {
      throw new Error('sender_agent_id is not allowed for external MCP callers');
    }
    const { messageId } = await deliver(threadId, context, () =>
      postExternalMessageToThread({
        threadId,
        memberId: actor.actorId,
        memberName: actor.actorName ?? 'External MCP client',
        content,
      })
    );

    return JSON.stringify({
      success: true,
      message_id: messageId,
      thread_id: threadId,
      sender_member_id: actor.actorId,
      posted: true,
      dispatch: { initiated: true },
    });
  }

  const agentId = requestedAgentId || context?.agentId;
  if (!agentId) {
    throw new Error(
      'No sender agent available: pass sender_agent_id or call from a context with agentId set'
    );
  }
  if (context?.agentId && agentId !== context.agentId) {
    throw new Error('sender_agent_id cannot override the calling agent identity');
  }

  // Reply-address footer: dispatch is fire-and-forget, so the receiving agent
  // gets no ambient link back to the conversation this was sent from. Appending
  // the origin thread as a footer gives it a concrete target to reply to with
  // thread op:send. Skipped for same-thread posts (the address would be redundant)
  // and when the caller has no thread context (e.g. headless runs).
  //
  // The footer also names the sender and says outright that the message did not
  // originate here. Without that, a cross-thread send from an agent that is
  // *also* a participant of the target thread is indistinguishable from that
  // agent simply speaking in the current conversation — the receiver reads it
  // as live local dialogue and answers in the wrong place. The lookups are
  // decoration (see crossThreadFooter.ts): failing degrades the wording, never
  // the send.
  content = await withCrossThreadFooter({
    kind: 'sent',
    content,
    agentId,
    originThreadId: context?.threadId,
    targetThreadId: threadId,
  });
  if (context?.hookOrigin && context.hookRunAs && agentId !== GHOST_AGENT_ID) {
    content = `${content}\n\n${await hookSenderLine(context.hookOrigin.hookName, agentId)}`;
  }

  const { messageId } = await deliver(threadId, context, () =>
    postAgentMessageToThread({ threadId, agentId, content })
  );

  return JSON.stringify({
    success: true,
    message_id: messageId,
    thread_id: threadId,
    sender_agent_id: agentId,
    posted: true,
    // The wake runs asynchronously — the target thread's wave can span many
    // agent turns, and awaiting it would freeze the sender's own run for the
    // duration. Delivery of the message itself is already guaranteed above.
    dispatch: { initiated: true },
  });
};

export default threadSend;
