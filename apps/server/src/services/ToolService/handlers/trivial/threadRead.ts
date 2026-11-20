import { Messages } from '@snaglet/db/tables/messages';
import { Threads } from '@snaglet/db/tables/threads';
import { readTrimmedString, clamp } from '@snaglet/shared/utils';
import { isAgentRunEndedRow } from '@server/services/SocketService/agentRunEnded';
import type { ToolHandler } from '@server/services/ToolService/types';
import {
  assertNotDmThread,
  resolveTargetThreadId,
  threadNotFoundError,
} from '@server/services/ToolService/lib/targetThread';

function resolveLimit(value: unknown): number {
  const parsed = Number(value ?? 50);
  return Number.isFinite(parsed) ? clamp(Math.floor(parsed), 1, 100) : 50;
}

const tool: ToolHandler = async (input, _settings, context) => {
  // Defaults to the calling thread. Same limit/cursor either way.
  const threadId = await resolveTargetThreadId(input, context, 'thread_read');
  const before = readTrimmedString(input.before) || undefined;

  const thread = await Threads.findById(threadId);
  if (!thread) throw await threadNotFoundError('thread_read', threadId, context);
  await assertNotDmThread('thread op:read', threadId, context, { allowOwnThread: true });

  const messages = await Messages.listForThreadRead(threadId, {
    limit: resolveLimit(input.limit),
    before,
  });

  return JSON.stringify({
    success: true,
    thread: {
      id: thread.id,
      title: thread.title,
    },
    messages: messages
      .filter((message) => !isAgentRunEndedRow(message))
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        agent_id: message.agentId,
        user_id: message.userId,
        message_type: message.messageType,
        created_at: message.createdAt,
      })),
  });
};

export default tool;
