/**
 * thread(op:"dm_send" | "dm_list" | "dm_read"): direct messages between the
 * calling agent and another agent or the local user. All three ops are gated
 * by the caller's `dm_enabled`. DmService owns the rules (body length,
 * self-DM, recipient dm_enabled, no wake); this file resolves the caller and
 * recipient, enforces the per-run send cap, and wraps returned text in a
 * sender-attributed envelope.
 */
import { Agents } from '@snaglet/db/tables/agents';
import { Members } from '@snaglet/db/tables/members';
import { Users } from '@snaglet/db/tables/users';
import { readTrimmedString } from '@snaglet/shared/utils';
import { DmService, type DmMailMessage, type DmParty } from '@server/services/dm/DmService';
import {
  neutralizeDelimitedContent,
  neutralizeUntrustedName,
} from '@server/services/ToolService/lib/untrustedContent';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

/** Most dm_send calls one run may make. */
const DM_SENDS_PER_RUN = 5;
const MAX_NAME_HINTS = 5;
const COUNTER_TTL_MS = 60 * 60 * 1000;

/**
 * Sends so far in each run. A run is keyed by its AbortSignal when it has one
 * (a WeakMap, so it is released with the run). Headless runs without a signal
 * fall back to agent + trigger message (or agent + thread), kept in a map that
 * drops entries an hour after their last send.
 */
const sendsBySignal = new WeakMap<AbortSignal, number>();
const sendsByKey = new Map<string, { count: number; touched: number }>();

function pruneCounters(now: number): void {
  for (const [key, entry] of sendsByKey) {
    if (now - entry.touched > COUNTER_TTL_MS) sendsByKey.delete(key);
  }
}

function runKey(agentId: string, context?: ToolHandlerContext): string {
  return `${agentId}:${context?.triggerMessageId ?? context?.threadId ?? 'none'}`;
}

function sendsSoFar(agentId: string, context?: ToolHandlerContext): number {
  if (context?.signal) return sendsBySignal.get(context.signal) ?? 0;
  pruneCounters(Date.now());
  return sendsByKey.get(runKey(agentId, context))?.count ?? 0;
}

function recordSend(agentId: string, context?: ToolHandlerContext): void {
  if (context?.signal) {
    sendsBySignal.set(context.signal, (sendsBySignal.get(context.signal) ?? 0) + 1);
    return;
  }
  const key = runKey(agentId, context);
  const now = Date.now();
  sendsByKey.set(key, { count: (sendsByKey.get(key)?.count ?? 0) + 1, touched: now });
}

/** Test hook: forget all headless-run counters. */
export function resetDmSendCounters(): void {
  sendsByKey.clear();
}

/** The envelope's opening marker; reserved so a body cannot forge another envelope. */
const DM_OPEN = '[DM from';

/**
 * One DM's text framed as sender-attributed data. The only way DM bodies reach
 * a model. The body is neutralized first: system-reminder tags and any literal
 * `[DM from` are escaped, so it cannot pose as platform framing or as a second DM.
 * The sender name is actor-controlled too (an agent can rename itself), so it
 * goes through {@link neutralizeUntrustedName}: one line, brackets escaped.
 */
export function wrapDmText(
  message: Pick<DmMailMessage, 'fromName' | 'fromKind' | 'createdAt' | 'content'>
): string {
  const name = neutralizeUntrustedName(message.fromName);
  const who = message.fromKind === 'user' ? `${name} (the user)` : name;
  const at = new Date(message.createdAt).toISOString();
  // The helper only encodes complete `[...]` markers, and the envelope's opener
  // `[DM from` is open-ended, so the opener is escaped here the same way
  // (`[` -> `&#91;`) after the helper strips system-framing tags.
  const body = neutralizeDelimitedContent(message.content, []).replace(
    /\[DM from/gi,
    (m) => `&#91;${m.slice(1)}`
  );
  return `${DM_OPEN} ${who} at ${at}]: ${body}`;
}

function describeMessages(messages: DmMailMessage[], remainingUnread: number) {
  return {
    messages: messages.map((m) => ({
      thread_id: m.threadId,
      message_id: m.messageId,
      from: m.fromName,
      from_kind: m.fromKind,
      created_at: new Date(m.createdAt).toISOString(),
      unread: m.unread,
      text: wrapDmText(m),
    })),
    remaining_unread: remainingUnread,
  };
}

/** The calling agent, or an error naming why it cannot use DMs. */
async function callerAgent(context?: ToolHandlerContext) {
  const agentId = context?.agentId;
  if (!agentId) throw new Error('DM ops need a calling agent');
  const agent = await Agents.findById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (!agent.dmEnabled)
    throw new Error(`DMs are turned off for ${agent.name}, so you cannot use dm ops`);
  return agent;
}

async function resolveRecipient(to: string): Promise<DmParty> {
  if (to.toLowerCase() === 'user') {
    const user = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());
    return { kind: 'user', userId: user.id };
  }
  const agent = (await Agents.findById(to)) ?? (await Agents.findByName(to));
  if (agent) return { kind: 'agent', agentId: agent.id };
  const names = (await Agents.list({ limit: MAX_NAME_HINTS })).map((a) => a.name);
  const hint = names.length ? ` Some valid agents: ${names.join(', ')}.` : '';
  throw new Error(
    `No agent named or with id "${to}". Use an agent name, an agent id, or "user".${hint}`
  );
}

function readLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export const threadDmSend: ToolHandler = async (input, _settings, context) => {
  const agent = await callerAgent(context);
  const to = readTrimmedString(input.to);
  if (!to) throw new Error('to is required: an agent name or id, or "user"');
  if (sendsSoFar(agent.id, context) >= DM_SENDS_PER_RUN) {
    throw new Error(`DM limit reached: at most ${DM_SENDS_PER_RUN} dm_send per run`);
  }
  const recipient = await resolveRecipient(to);
  const from: DmParty = { kind: 'agent', agentId: agent.id };
  // DmService validates the body, self-DM and the recipient's dm_enabled.
  const { messageId, threadId } = await DmService.send({
    from,
    to: recipient,
    content: typeof input.content === 'string' ? input.content : '',
  });
  recordSend(agent.id, context);

  // Replying clears the sender's own unread for this DM.
  const member = await Members.findByAgent(agent.id);
  if (member) await DmService.markReadThrough(threadId, member.id, messageId);

  return JSON.stringify({ success: true, message_id: messageId, thread_id: threadId, woke: false });
};

export const threadDmList: ToolHandler = async (input, _settings, context) => {
  const agent = await callerAgent(context);
  const { messages, remainingUnread } = await DmService.listMail(agent.id, {
    limit: readLimit(input.limit),
    all: input.all === true,
  });
  return JSON.stringify(describeMessages(messages, remainingUnread));
};

export const threadDmRead: ToolHandler = async (input, _settings, context) => {
  const agent = await callerAgent(context);
  const threadId = readTrimmedString(input.id) || readTrimmedString(input.thread_id);
  if (!threadId) throw new Error('id is required: the DM thread id from dm_list');
  const { messages, remainingUnread } = await DmService.readThread(
    agent.id,
    threadId,
    readLimit(input.limit)
  );
  return JSON.stringify(describeMessages(messages, remainingUnread));
};
