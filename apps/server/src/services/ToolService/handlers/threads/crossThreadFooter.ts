import { readTrimmedString } from '@snaglet/shared/utils';
import { Agents } from '@snaglet/db/tables/agents';
import { Threads } from '@snaglet/db/tables/threads';

/** How the message reached the thread it is being read in. */
export type CrossThreadFooterKind = 'sent' | 'created';

/**
 * The reply call, spelled out exactly. Both footer variants end with it so the
 * receiver always gets the same concrete route back to the origin thread.
 */
export function replyCall(originThreadId: string): string {
  return `call thread with op:"send" and id:"${originThreadId}".`;
}

/**
 * Footer text for a message that originated in another thread. It names the
 * agent and the origin thread (title + id chip) and says outright that the
 * message did not originate in the thread it is read in: without that, a
 * cross-thread message from an agent that also participates in the target
 * reads as live local conversation and gets answered in the wrong place.
 */
export function crossThreadFooter(
  kind: CrossThreadFooterKind,
  agentLabel: string,
  originName: string,
  originThreadId: string
): string {
  const origin = `[${originName}](${originThreadId})`;
  if (kind === 'created') {
    return (
      `— ${agentLabel} created this thread from ${origin} and posted this message from there. ` +
      `To reply in that thread, ${replyCall(originThreadId)}`
    );
  }
  return `— sent by ${agentLabel} from ${origin}, not from this conversation. To reply, ${replyCall(originThreadId)}`;
}

/**
 * Append the origin footer to `content` when the caller runs in a thread other
 * than `targetThreadId`; otherwise return `content` unchanged (no thread
 * context, e.g. a headless run, or a same-thread post where the address would
 * be redundant).
 *
 * The footer is decoration: the origin-thread and agent lookups degrade the
 * wording (`Untitled Thread`, `an agent`) and never throw, so they cannot fail
 * the send or the thread creation that carries it.
 */
export async function withCrossThreadFooter(params: {
  kind: CrossThreadFooterKind;
  content: string;
  agentId: string;
  originThreadId: string | null | undefined;
  targetThreadId: string;
}): Promise<string> {
  const { kind, content, agentId, originThreadId, targetThreadId } = params;
  if (!originThreadId || originThreadId === targetThreadId) return content;

  const [origin, agent] = await Promise.all([
    Promise.resolve()
      .then(() => Threads.findById(originThreadId))
      .catch(() => null),
    Promise.resolve()
      .then(() => Agents.findById(agentId))
      .catch(() => null),
  ]);
  const originName = readTrimmedString(origin?.title) || 'Untitled Thread';
  // readTrimmedString is total — an absent, blank, or non-string name yields ''.
  const agentName = readTrimmedString(agent?.name);
  const agentLabel = agentName ? `@${agentName}` : 'an agent';
  return `${content}\n\n${crossThreadFooter(kind, agentLabel, originName, originThreadId)}`;
}
