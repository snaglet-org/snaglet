import { Messages } from '@snaglet/db/tables/messages';
import { readTrimmedString, clamp } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { isAgentRunEndedRow } from '@server/services/SocketService/agentRunEnded';
import { assertNotDmThread } from '@server/services/ToolService/lib/targetThread';

/** Clamp a count param to [0, 49]. Defaults to `fallback` when absent/invalid. */
function resolveCount(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Math.floor(parsed), 0, 49);
}

const MAX_WINDOW = 50;

const tool: ToolHandler = async (input, _settings, context) => {
  const messageId = readTrimmedString(input.message_id);
  if (!messageId) throw new Error('message_id is required');

  const before = resolveCount(input.before, 10);
  const after = resolveCount(input.after, 10);

  const window = await Messages.getContextWindow(messageId, {
    before,
    after,
    cap: MAX_WINDOW,
  });

  if (!window) {
    throw new Error(`Message not found: ${messageId}`);
  }

  const { anchor } = window;
  // The run-ended footer is UI-only narration: never hand it to an agent. The
  // anchor lookup above is untouched, so a window anchored on a footer row
  // still resolves (the footer itself is just omitted from `messages`).
  const messages = window.messages.filter((message) => !isAgentRunEndedRow(message));
  await assertNotDmThread('thread op:read', anchor.threadId, context, { allowOwnThread: true });

  return JSON.stringify({
    success: true,
    anchor_id: anchor.id,
    thread_id: anchor.threadId,
    requested: { before, after },
    returned_count: messages.length,
    capped_at: MAX_WINDOW,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      agent_id: message.agentId,
      user_id: message.userId,
      message_type: message.messageType,
      created_at: message.createdAt,
      is_anchor: message.id === anchor.id,
    })),
  });
};

export default tool;
