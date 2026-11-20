/**
 * DmService — direct messages between two members: agent to agent, and agent
 * to the user.
 *
 * A DM is an ordinary message in a DM thread (`threads.kind = 'dm'`):
 * one flat, hidden thread per pair of members, found by its sorted
 * `threads.dm_pair_key`. Each side's unread cursor is its
 * `thread_participants.last_read_at`; unread = messages newer than the cursor
 * that the participant did not write (a NULL cursor means all of them).
 *
 * No-wake guarantee: `send` persists, broadcasts and emits `message:create`
 * exactly like `postAgentMessageToThread`, but never dispatches. This module
 * must not import `dispatchToThread`, or anything that calls it (such as
 * ThreadDeliveryPolicyService). A DM from the user does not come through
 * here: it takes the normal chat path, which wakes the agent in the DM thread
 * (that thread has one agent participant, so dispatch treats it as solo).
 *
 * Text returned by `listUnread` is the raw message body: data from another
 * actor, never instructions. Callers that show it to a model frame it.
 */

import { getDb } from '@snaglet/db';
import { transaction } from '@snaglet/db/db';
import { Agents, type AgentRow } from '@snaglet/db/tables/agents';
import { Members } from '@snaglet/db/tables/members';
import { Messages } from '@snaglet/db/tables/messages';
import type { NodeRunner } from '@snaglet/db/tables/nodes';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Threads, type ThreadRow } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { ErrorCode } from '@snaglet/shared/types';
import {
  AppError,
  ConflictError,
  generateId,
  getErrorMessage,
  isoNow,
  snippet,
} from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { hooks } from '@server/services/HookService';
import { notificationService } from '@server/services/NotificationService';
import { wsService } from '@server/services/WebSocketService';
import { dmPairKey } from './dmPairKey';

/** One side of a DM. */
export type DmParty = { kind: 'agent'; agentId: string } | { kind: 'user'; userId: string };

/** One unread DM, oldest first in a list. `content` is the raw body (data, not instructions). */
interface UnreadDm {
  threadId: string;
  fromName: string;
  /** Whether the sender is an agent or the user. */
  fromKind: 'agent' | 'user';
  messageId: string;
  content: string;
  createdAt: string;
}

/** Unread DMs from one sender. */
interface UnreadDmSender {
  fromName: string;
  fromKind: 'agent' | 'user';
  count: number;
}

/** Longest DM body, in characters, after trimming. */
const DM_MAX_CHARS = 4000;
const DEFAULT_UNREAD_LIMIT = 50;
const MAX_UNREAD_LIMIT = 200;
const NOTIFICATION_PREVIEW_CHARS = 200;

interface ResolvedParty {
  party: DmParty;
  /** Display name: the agent's name, or the user's name from the users table. */
  name: string;
}

function invalid(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, 400);
}

function notFound(message: string): AppError {
  return new AppError(message, ErrorCode.NOT_FOUND, 404);
}

function sameParty(a: DmParty, b: DmParty): boolean {
  if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId;
  if (a.kind === 'user' && b.kind === 'user') return a.userId === b.userId;
  return false;
}

function assertTwoParties(a: DmParty, b: DmParty): void {
  if (sameParty(a, b)) throw invalid('You cannot DM yourself');
}

/** The trimmed body, or a 400 when it is empty or too long. */
function validContent(raw: string): string {
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) throw invalid('A DM needs some text');
  if (content.length > DM_MAX_CHARS) {
    throw invalid(
      `A DM is at most ${DM_MAX_CHARS.toLocaleString('en-US')} characters; this one has ${content.length.toLocaleString('en-US')}`
    );
  }
  return content;
}

/** An agent that can take part in DMs right now, or the reason it cannot. */
async function dmAgent(agentId: string): Promise<AgentRow> {
  const agent = await Agents.findById(agentId);
  // The ghost is the attribution actor of deleted agents, never a correspondent.
  if (!agent || agent.id === GHOST_AGENT_ID) throw notFound(`Agent not found: ${agentId}`);
  if (agent.parentAgentId) {
    throw invalid(`${agent.name} is a subagent helper; helpers do not take part in DMs`);
  }
  if (agent.archived) throw new ConflictError(`${agent.name} is archived`);
  if (!agent.dmEnabled) throw new ConflictError(`DMs are turned off for ${agent.name}`);
  return agent;
}

/** Look a party up without writing anything; throws when it cannot DM. */
async function resolveParty(party: DmParty): Promise<ResolvedParty> {
  if (party.kind === 'agent') {
    const agent = await dmAgent(party.agentId);
    return { party, name: agent.name };
  }
  const user = await Users.findById(party.userId);
  if (!user) throw notFound(`User not found: ${party.userId}`);
  return { party, name: user.name.trim() || user.id };
}

/** The party's members.id; created only on first use, so a repeat send writes no member row. */
async function memberIdFor(party: DmParty): Promise<string> {
  const member =
    party.kind === 'agent'
      ? ((await Members.findByAgent(party.agentId)) ??
        (await Members.ensureForAgent(party.agentId)))
      : ((await Members.findByUser(party.userId)) ?? (await Members.ensureForUser(party.userId)));
  return member.id;
}

async function addParticipant(threadId: string, party: DmParty, tx: NodeRunner): Promise<void> {
  if (party.kind === 'agent') {
    await ThreadParticipants.addParticipant({ threadId, agentId: party.agentId }, tx);
  } else {
    await ThreadParticipants.addUserParticipant({ threadId, userId: party.userId }, tx);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

async function findOrCreateResolved(a: ResolvedParty, b: ResolvedParty): Promise<ThreadRow> {
  const [memberA, memberB] = await Promise.all([memberIdFor(a.party), memberIdFor(b.party)]);
  const key = dmPairKey(memberA, memberB);
  const existing = await Threads.findByDmPairKey(key);
  if (existing) return existing;

  try {
    return await transaction(async (tx) => {
      const thread = await Threads.create(
        {
          id: generateId('thread'),
          title: `${a.name} ↔ ${b.name}`,
          kind: 'dm',
          dmPairKey: key,
          dispatchMode: 'mentioned',
        },
        tx
      );
      // Member id order, so two creates that touch the same member rows
      // always take their locks in the same order.
      const parties = memberA < memberB ? [a, b] : [b, a];
      for (const side of parties) await addParticipant(thread.id, side.party, tx);
      return thread;
    });
  } catch (err) {
    // A concurrent create won the unique pair key. This transaction rolled
    // back whole, its nodes row included, so the winner's thread is the one.
    if (isUniqueViolation(err)) {
      const winner = await Threads.findByDmPairKey(key);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * The DM thread of two parties, created (flat, `dispatchMode: 'mentioned'`,
 * both participant rows) on first use. Refuses the same party twice, an
 * unknown party, and an agent that cannot DM (`dm_enabled` false, archived,
 * a subagent helper). Concurrent calls for one pair return one thread.
 */
async function findOrCreate(a: DmParty, b: DmParty): Promise<ThreadRow> {
  assertTwoParties(a, b);
  const [resolvedA, resolvedB] = await Promise.all([resolveParty(a), resolveParty(b)]);
  return findOrCreateResolved(resolvedA, resolvedB);
}

/** Tell the user about an agent's DM. Best-effort: the DM is already sent. */
async function notifyUser(
  threadId: string,
  fromName: string,
  fromAgentId: string,
  content: string
): Promise<void> {
  try {
    await notificationService.create({
      type: 'thread_activity',
      title: `${fromName} sent you a DM`,
      body: snippet(content, NOTIFICATION_PREVIEW_CHARS) || null,
      threadId,
      agentId: fromAgentId,
    });
  } catch (err) {
    logger.warn(`[dm] notification failed for ${threadId}: ${getErrorMessage(err)}`);
  }
}

/**
 * An agent's DM to another agent or to the user. Every check runs before
 * anything is written: the body (trimmed, 1 to {@link DM_MAX_CHARS}
 * characters), self-DMs, and both parties (see {@link findOrCreate}). The
 * message is persisted, broadcast to the thread's channel and emitted as
 * `message:create`; nobody is woken. A DM to the user also raises a
 * `thread_activity` notification.
 */
async function send(input: {
  from: DmParty;
  to: DmParty;
  content: string;
}): Promise<{ messageId: string; threadId: string }> {
  const sender = input.from;
  if (sender.kind !== 'agent') {
    throw invalid('A DM from the user is sent in the chat, so the agent wakes to answer it');
  }
  const content = validContent(input.content);
  assertTwoParties(sender, input.to);
  const [from, to] = await Promise.all([resolveParty(sender), resolveParty(input.to)]);
  const thread = await findOrCreateResolved(from, to);

  const messageId = generateId('message');
  const createdAt = isoNow();
  await Messages.create({
    id: messageId,
    threadId: thread.id,
    role: 'assistant',
    content,
    agentId: sender.agentId,
    messageType: 'message',
  });

  hooks.emit('message:create', {
    id: messageId,
    threadId: thread.id,
    role: 'agent',
    agentId: sender.agentId,
    text: content,
    chars: content.length,
  });

  wsService.broadcastToChannel(thread.id, {
    type: 'socket:chat:message_created',
    payload: {
      id: messageId,
      threadId: thread.id,
      role: 'assistant',
      content,
      agent_id: sender.agentId,
      created_at: createdAt,
      message_type: 'message',
    },
  });

  if (input.to.kind === 'user') await notifyUser(thread.id, from.name, sender.agentId, content);

  return { messageId, threadId: thread.id };
}

/**
 * THE definition of "mail" and "unread", shared by every query that counts or
 * lists DMs so the numbers never disagree. Aliases: messages `m`, the reader's
 * participant row `tp` and member `me`. Narration (`thread_event`, author-less)
 * is not mail; the reader's own messages are never unread.
 */
const DM_IS_MAIL = `m.message_type IN ('message', 'question')
   AND (m.agent_id IS NOT NULL OR m.user_id IS NOT NULL)
   AND (me.agent_id IS NULL OR m.agent_id IS DISTINCT FROM me.agent_id)
   AND (me.user_id IS NULL OR m.user_id IS DISTINCT FROM me.user_id::text)`;
const DM_IS_UNREAD = `m.created_at > COALESCE(tp.last_read_at, '-infinity'::timestamptz)`;

/** Display name of a message's sender or a party: agent `a`, else user `u`. */
const nameOf = (agentAlias: string, userAlias: string): string =>
  `COALESCE(${agentAlias}.name, ${userAlias}.name, 'unknown')`;

/**
 * The DMs of one member (`$1`), as rows of messages `m` with the sender's
 * agent `a` or user `u`; unread only when `unreadOnly`.
 */
function dmMailFrom(opts: { unreadOnly: boolean; threadFilter?: boolean }): string {
  return `
  FROM public.thread_participants tp
  JOIN public.members me ON me.id = tp.member_id
  JOIN public.threads t ON t.id = tp.thread_id
  JOIN public.messages m ON m.thread_id = tp.thread_id
  LEFT JOIN public.agents a ON a.id = m.agent_id
  LEFT JOIN public.users u ON u.id = m.user_id
 WHERE tp.member_id = $1
   AND t.kind = 'dm'
   AND ${DM_IS_MAIL}
   ${opts.unreadOnly ? `AND ${DM_IS_UNREAD}` : ''}
   ${opts.threadFilter ? 'AND tp.thread_id = $2' : ''}`;
}

const UNREAD_DM_FROM = dmMailFrom({ unreadOnly: true });

const FROM_NAME = nameOf('a', 'u');
const FROM_KIND = `CASE WHEN m.agent_id IS NOT NULL THEN 'agent' ELSE 'user' END`;

/**
 * An agent's unread DMs across all its DM threads: the newest `limit`
 * (default 50, at most 200), oldest first. Refused (409) when the agent has
 * DMs turned off.
 */
async function listUnread(agentId: string, limit = DEFAULT_UNREAD_LIMIT): Promise<UnreadDm[]> {
  const agent = await Agents.findById(agentId);
  if (!agent) throw notFound(`Agent not found: ${agentId}`);
  if (!agent.dmEnabled) throw new ConflictError(`DMs are turned off for ${agent.name}`);
  const member = await Members.findByAgent(agentId);
  if (!member) return [];
  const n = Math.min(Math.max(Math.trunc(limit) || DEFAULT_UNREAD_LIMIT, 1), MAX_UNREAD_LIMIT);
  const { rows } = await getDb().query<UnreadDm>(
    `SELECT * FROM (
       SELECT m.thread_id AS "threadId",
              ${FROM_NAME} AS "fromName",
              ${FROM_KIND} AS "fromKind",
              m.id AS "messageId",
              m.content,
              m.created_at AS "createdAt"
         ${UNREAD_DM_FROM}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2
     ) newest
     ORDER BY "createdAt" ASC, "messageId" ASC`,
    [member.id, n]
  );
  return rows;
}

/**
 * Unread DM counts per sender for one member (agent or user), most recent
 * sender first. One query; an empty array when nothing is unread.
 */
async function unreadSummary(memberId: string): Promise<UnreadDmSender[]> {
  const { rows } = await getDb().query<UnreadDmSender>(
    `SELECT ${FROM_NAME} AS "fromName",
            ${FROM_KIND} AS "fromKind",
            count(*)::int AS "count"
       ${UNREAD_DM_FROM}
      GROUP BY m.agent_id, m.user_id, a.name, u.name
      ORDER BY max(m.created_at) DESC, "fromName" ASC`,
    [memberId]
  );
  return rows;
}

/** One DM from {@link DmService.listMail}: the message plus whether the reader has not seen it. */
export interface DmMailMessage extends UnreadDm {
  unread: boolean;
}

/**
 * An agent's DMs across its DM threads, or in one thread (`threadId`). By
 * default only unread ones, OLDEST first and capped at `limit`, so a reader
 * that marks the thread read through the last message it was given never
 * skips an unread one. `all` returns the newest `limit` messages, read or
 * not (oldest first). `remainingUnread` counts unread messages not returned.
 * Refused (409) when the agent has DMs turned off.
 */
async function listMail(
  agentId: string,
  opts: { limit?: number; all?: boolean; threadId?: string } = {}
): Promise<{ messages: DmMailMessage[]; remainingUnread: number }> {
  const agent = await Agents.findById(agentId);
  if (!agent) throw notFound(`Agent not found: ${agentId}`);
  if (!agent.dmEnabled) throw new ConflictError(`DMs are turned off for ${agent.name}`);
  const member = await Members.findByAgent(agentId);
  if (!member) return { messages: [], remainingUnread: 0 };
  const n = Math.min(
    Math.max(Math.trunc(opts.limit ?? DEFAULT_UNREAD_LIMIT) || DEFAULT_UNREAD_LIMIT, 1),
    MAX_UNREAD_LIMIT
  );
  const threadFilter = Boolean(opts.threadId);
  const params: unknown[] = opts.threadId ? [member.id, opts.threadId] : [member.id];
  const from = dmMailFrom({ unreadOnly: !opts.all, threadFilter });
  const { rows } = await getDb().query<DmMailMessage>(
    `SELECT * FROM (
       SELECT m.thread_id AS "threadId",
              ${FROM_NAME} AS "fromName",
              ${FROM_KIND} AS "fromKind",
              m.id AS "messageId",
              m.content,
              m.created_at AS "createdAt",
              m.created_at > COALESCE(tp.last_read_at, '-infinity'::timestamptz) AS "unread"
         ${from}
        ORDER BY m.created_at ${opts.all ? 'DESC' : 'ASC'}, m.id ${opts.all ? 'DESC' : 'ASC'}
        LIMIT ${n}
     ) picked
     ORDER BY "createdAt" ASC, "messageId" ASC`,
    params
  );
  const { rows: total } = await getDb().query<{ n: number }>(
    `SELECT count(*)::int AS n ${dmMailFrom({ unreadOnly: true, threadFilter })}`,
    params
  );
  const returnedUnread = rows.filter((r) => r.unread).length;
  return {
    messages: rows,
    remainingUnread: Math.max(Number(total[0]?.n ?? 0) - returnedUnread, 0),
  };
}

/**
 * Read one DM thread as an agent: its unread messages (oldest first, up to
 * `limit`), then move the agent's cursor to the newest message returned (not
 * to now), so unread messages beyond `limit` stay unread. Refused when the
 * thread is not a DM the agent is in.
 */
async function readThread(
  agentId: string,
  threadId: string,
  limit?: number
): Promise<{ messages: DmMailMessage[]; remainingUnread: number }> {
  const member = await Members.findByAgent(agentId);
  const { rows } = await getDb().query<{ ok: boolean }>(
    `SELECT true AS ok FROM public.thread_participants tp
       JOIN public.threads t ON t.id = tp.thread_id
      WHERE tp.thread_id = $1 AND tp.member_id = $2 AND t.kind = 'dm'`,
    [threadId, member?.id ?? null]
  );
  if (!rows[0]) throw notFound(`Not a DM thread you are in: ${threadId}`);
  const result = await listMail(agentId, { limit, threadId });
  const newest = result.messages[result.messages.length - 1];
  if (member && newest) await markReadThrough(threadId, member.id, newest.messageId);
  return result;
}

/** Move a member's cursor to a message's own created_at (exact precision); never backwards. */
async function markReadThrough(
  threadId: string,
  memberId: string,
  messageId: string
): Promise<void> {
  await getDb().query(
    `UPDATE public.thread_participants tp
        SET last_read_at = GREATEST(
              COALESCE(tp.last_read_at, '-infinity'::timestamptz),
              (SELECT created_at FROM public.messages WHERE id = $3 AND thread_id = $1))
      WHERE tp.thread_id = $1 AND tp.member_id = $2
        AND EXISTS (SELECT 1 FROM public.messages WHERE id = $3 AND thread_id = $1)`,
    [threadId, memberId, messageId]
  );
}

/** Mark everything in a DM thread read for one member, up to now. Never moves the cursor back. */
async function markRead(threadId: string, memberId: string): Promise<void> {
  await ThreadParticipants.markRead(threadId, memberId);
}

/**
 * Mark a thread read for a member only when it is a DM thread; any other
 * thread is left alone. One conditional UPDATE, so a run can call it without
 * first loading the thread. Never moves the cursor back.
 */
async function markReadIfDm(threadId: string, memberId: string): Promise<void> {
  await getDb().query(
    `UPDATE public.thread_participants tp
        SET last_read_at = GREATEST(COALESCE(tp.last_read_at, '-infinity'::timestamptz), now())
      WHERE tp.thread_id = $1 AND tp.member_id = $2
        AND EXISTS (SELECT 1 FROM public.threads t WHERE t.id = tp.thread_id AND t.kind = 'dm')`,
    [threadId, memberId]
  );
}

/** One DM thread in a viewer's list, with the other party and the viewer's unread count. */
interface DmThreadSummary {
  id: string;
  title: string;
  withName: string;
  withKind: 'agent' | 'user';
  withAgentId?: string;
  unread: number;
  lastMessageAt: string | null;
}

/**
 * A member's DM threads (agent to agent, and with the user), newest activity
 * first. Selects `kind = 'dm'` threads directly: the shared thread filters
 * hide them by design. `unread` counts what the other party wrote after the
 * member's read cursor.
 */
async function listThreadsForMember(memberId: string): Promise<DmThreadSummary[]> {
  const { rows } = await getDb().query<
    Omit<DmThreadSummary, 'withAgentId'> & { withAgentId: string | null }
  >(
    `SELECT t.id,
            t.title,
            t.last_message_at AS "lastMessageAt",
            ${nameOf('oa', 'ou')} AS "withName",
            CASE WHEN om.agent_id IS NOT NULL THEN 'agent' ELSE 'user' END AS "withKind",
            om.agent_id AS "withAgentId",
            (SELECT count(*)::int FROM public.messages m
              WHERE m.thread_id = t.id
                AND ${DM_IS_MAIL}
                AND ${DM_IS_UNREAD}
            ) AS "unread"
       FROM public.thread_participants tp
       JOIN public.members me ON me.id = tp.member_id
       JOIN public.threads t ON t.id = tp.thread_id AND t.kind = 'dm'
       JOIN public.thread_participants otp ON otp.thread_id = t.id AND otp.member_id <> tp.member_id
       JOIN public.members om ON om.id = otp.member_id
       LEFT JOIN public.agents oa ON oa.id = om.agent_id
       LEFT JOIN public.users ou ON ou.id = om.user_id
      WHERE tp.member_id = $1
      ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC`,
    [memberId]
  );
  return rows.map(({ withAgentId, ...rest }) => ({
    ...rest,
    ...(withAgentId ? { withAgentId } : {}),
  }));
}

export const DmService = {
  listThreadsForMember,
  findOrCreate,
  send,
  listUnread,
  unreadSummary,
  markRead,
  markReadIfDm,
  listMail,
  readThread,
  markReadThrough,
} as const;
