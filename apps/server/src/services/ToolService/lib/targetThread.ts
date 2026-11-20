/**
 * targetThread: which thread a thread tool acts on.
 *
 * Thread tools default to the thread the agent is calling from, so "post /
 * read / update my own thread" never needs an id the agent has to guess. An
 * explicit id always wins. External (MCP) callers have no calling thread and
 * must pass an id. Errors name the caller's own thread so a wrong guess is
 * corrected on the next call instead of failing silently.
 *
 * Destructive ops (thread op:"delete") do not use the default: they keep a
 * required explicit id.
 */

import { Threads } from '@snaglet/db/tables/threads';
import { readTrimmedString } from '@snaglet/shared/utils';
import { getCurrentActor } from '@server/realtime/actorContext';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

type ThreadContext = Pick<ToolHandlerContext, 'threadId'> | undefined;

/** "`<title>` (`<id>`)" for the caller's thread, or null when it has none. */
async function callerThreadLabel(context: ThreadContext): Promise<string | null> {
  const threadId = context?.threadId;
  if (!threadId) return null;
  const thread = await Threads.findById(threadId).catch(() => null);
  const title = thread?.title?.trim() || 'Untitled Thread';
  return `\`${title}\` (\`${threadId}\`)`;
}

/** Suffix for an error: where the caller actually is, or how to fix the call. */
async function whereYouAre(context: ThreadContext): Promise<string> {
  const label = await callerThreadLabel(context);
  return label
    ? ` You are in thread ${label}; omit the id to target it.`
    : ' No calling thread is available, so pass the thread id explicitly.';
}

/**
 * The thread a tool targets: the explicit `thread_id` (canonical after alias
 * normalization maps a schema `id` onto it), else the calling thread. Throws when
 * neither exists, or when an external MCP caller omits the id.
 */
export async function resolveTargetThreadId(
  input: Record<string, unknown>,
  context: ThreadContext,
  toolName: string
): Promise<string> {
  const explicit = readTrimmedString(input.thread_id);
  if (explicit) return explicit;
  if (getCurrentActor()?.actorKind === 'external') {
    throw new Error(`${toolName}: thread id is required for external callers.`);
  }
  if (context?.threadId) return context.threadId;
  throw new Error(`${toolName}: no thread to target.${await whereYouAre(context)}`);
}

/** Not-found error that names the caller's own thread. */
export async function threadNotFoundError(
  toolName: string,
  threadId: string,
  context: ThreadContext
): Promise<Error> {
  return new Error(`${toolName}: thread not found: ${threadId}.${await whereYouAre(context)}`);
}

/**
 * DM threads (threads.kind = 'dm') are reached only through the dm ops, which
 * carry the send cap, body limit, dm_enabled and no-wake rules. Every other
 * thread op that targets one is refused, with a pointer to the right op.
 *
 * `allowOwnThread` (read and send only): the agent's own current thread is
 * allowed, since an agent woken inside its user-to-agent DM must read and
 * reply there normally. update and delete never allow it.
 */
export async function assertNotDmThread(
  toolName: string,
  threadId: string,
  context: ThreadContext,
  opts: { allowOwnThread: boolean }
): Promise<void> {
  if (opts.allowOwnThread && context?.threadId === threadId) return;
  const thread = await Threads.findById(threadId);
  if (thread?.kind !== 'dm') return;
  throw new Error(
    `${toolName}: ${threadId} is a direct-message thread. Use thread op:"dm_read" to read it ` +
      `and op:"dm_send" to message the other party; it cannot be read, posted to, updated or deleted here.`
  );
}
