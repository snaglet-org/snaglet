/**
 * buildDispatchDeps — derive the full `InternalDispatchDeps` bag for
 * non-socket callers (tool wakeups) from a minimal input.
 *
 * The socket path (`handleChatSend`) builds the dep bag inline because it
 * already has session/meta/clientId from the WS payload. Non-socket callers
 * do not have those, but they DO have `{threadId, senderId, messageId, message}`
 * — enough to derive everything else by reading from the DB and constructing
 * a synthetic ephemeral session (DB-unbacked; in-memory only, used purely to
 * pass session.threadId into the dispatch core).
 *
 * Semantics:
 *   - `clientId: ''` — `wsService.sendToClient` is null-safe (returns false on miss),
 *     so every streaming WS frame inside the dispatch core silently no-ops. Tool
 *     callers don't need or want streaming.
 *   - Fresh `AbortController` — each tool dispatch gets its own, decoupled from
 *     any socket abort tree.
 *   - `parallelDispatch: false` by default — dispatch routing comes from the
 *     thread's `dispatch_mode` column; explicit override available via input.
 */

import { randomUUID } from 'crypto';
import { Threads } from '@snaglet/db/tables/threads';
import {
  ThreadParticipants,
  type ThreadParticipantRow,
} from '@snaglet/db/tables/thread_participants';
import { agentService } from '@server/services/AgentService';
import { partitionArchivedParticipants } from './partitionArchivedParticipants';
import { threadRosterVersion } from './rosterVersion';
import {
  resolveThreadRuntimeConfig,
  type ThreadRuntimeConfig,
} from '@server/services/ConfigResolverService';
import { parseMentions, type MentionResult } from '@server/services/MentionParser';
import { buildDispatchSet } from '../handlers/chatHandlers/buildDispatchSet';
import { validateMentionFanOut } from '@server/services/groupChat/safety';
import { LogsService } from '@server/services/LogsService';
import type { InternalDispatchDeps } from './dispatchToThread';
import type { SocketSession } from '../types';
import { getErrorMessage } from '@snaglet/shared/utils';

export interface BuildDispatchDepsInput {
  threadId: string;
  senderId: string;
  /**
   * Caller persisted the message; pass the resulting messageId.
   * `triggerMessageId` is `string | undefined` downstream, so no null-safety
   * changes are needed when a caller omits it.
   */
  messageId?: string;
  /** The message text — needed for mention parse + wave seed. */
  message: string;
  /** Optional override for routing cadence. Defaults to thread.dispatch_mode. */
  parallelDispatch?: boolean;
  /** Scheduler-only targeted wake. Must resolve to a current participant. */
  targetAgentId?: string;
  /**
   * Extra already-persisted message texts whose @mentions also select who
   * wakes (self-healing redispatch only). A run can end with several
   * undelivered messages; the redispatch seeds on the newest, but each
   * earlier one may @mention a different agent and must wake them too.
   */
  routingMessages?: readonly string[];
  /** Continuation-budget seed (self-healing redispatch path only). */
  budgetSeed?: import('@server/services/ConversationBudget').ConversationBudgetSeed;
}

export type BuildDispatchDepsResult =
  | { ok: true; deps: InternalDispatchDeps }
  | {
      ok: false;
      reason: 'thread_not_found' | 'no_participants' | 'fanout_exceeded';
      message: string;
    };

/**
 * Build the full dep bag for a non-socket dispatch.
 *
 * Returns `{ok: false}` for the pre-dispatch validation failures that the
 * socket handler reports as WS error frames — tool callers receive them
 * as structured errors instead.
 */
export async function buildDispatchDeps(
  input: BuildDispatchDepsInput
): Promise<BuildDispatchDepsResult> {
  const { threadId, senderId, messageId, message } = input;

  const thread = await Threads.findById(threadId).catch((err: unknown) => {
    LogsService.warn('buildDispatchDeps: thread fetch failed', {
      threadId,
      error: getErrorMessage(err),
    });
    return null;
  });
  if (!thread) {
    return { ok: false, reason: 'thread_not_found', message: `Thread ${threadId} not found` };
  }

  const threadName = thread.title?.trim() || 'Untitled Thread';
  // Taken before the read: a run notices a change that lands in between.
  const rosterVersion = threadRosterVersion(threadId);
  const latestParticipants = await ThreadParticipants.listByThread(threadId).catch(
    (err: unknown) => {
      LogsService.warn('buildDispatchDeps: participant fetch failed', {
        threadId,
        error: getErrorMessage(err),
      });
      return [] as ThreadParticipantRow[];
    }
  );
  const rawParticipantIds = Array.from(
    new Set(
      latestParticipants
        .map((p) => p.agentId)
        .filter((id): id is string => Boolean(id) && id !== senderId)
    )
  );
  // Tombstone filter — keep archived agents in `thread_participants` for
  // historical "who was in this thread" queries, but drop them from the wake
  // list so dispatch never runs an archived agent. Shared with the socket chat
  // path so both roster builders agree on the exclusion rule.
  const { liveIds: participantAgentIds, archivedIds } =
    await partitionArchivedParticipants(rawParticipantIds);
  if (archivedIds.length > 0) {
    LogsService.warn('buildDispatchDeps: skipping archived participants', {
      threadId,
      archivedIds,
    });
  }
  if (participantAgentIds.length === 0) {
    return {
      ok: false,
      reason: 'no_participants',
      message:
        archivedIds.length > 0
          ? 'Thread has no live agent participants (all archived)'
          : 'Thread has no agent participants to dispatch to',
    };
  }

  const isGroup = participantAgentIds.length > 1;

  const agentNameMap = new Map<string, string>();
  const agentRoleMap = new Map<string, string>();
  if (isGroup) {
    for (const pid of participantAgentIds) {
      const peer = await agentService.get(pid);
      if (peer) {
        agentNameMap.set(peer.id, peer.name);
        if (peer.role) agentRoleMap.set(peer.id, peer.role);
      }
    }
  }

  const threadRuntimeConfig: ThreadRuntimeConfig | null = await resolveThreadRuntimeConfig(
    threadId
  ).catch((err) => {
    LogsService.warn('buildDispatchDeps: thread runtime config resolution failed', {
      threadId,
      error: getErrorMessage(err),
    });
    return null;
  });

  const parsedMentions = isGroup
    ? mergeMentions(
        [message, ...(input.routingMessages ?? [])].map((text) => parseMentions(text, agentNameMap))
      )
    : { mentionedAgentIds: [], hasMentions: false, rawMentions: [] as string[] };

  const fanOutError = validateMentionFanOut(parsedMentions.mentionedAgentIds);
  if (fanOutError) {
    return { ok: false, reason: 'fanout_exceeded', message: fanOutError };
  }

  const dispatchRouting = thread.dispatchMode ?? 'mentioned';
  const mentions: MentionResult = parsedMentions;
  const effectiveParallelDispatch = isGroup ? true : Boolean(input.parallelDispatch);

  const resolveParticipantId = (mentionedId: string): string | undefined => {
    const lc = mentionedId.toLowerCase();
    return participantAgentIds.find((pid) => pid.toLowerCase() === lc);
  };
  const isParticipantMention = (mentionedId: string): boolean =>
    resolveParticipantId(mentionedId) !== undefined;
  const mentionedIdSetLC = new Set(mentions.mentionedAgentIds.map((id) => id.toLowerCase()));
  const targetParticipant = input.targetAgentId
    ? resolveParticipantId(input.targetAgentId)
    : undefined;
  if (input.targetAgentId && !targetParticipant) {
    return {
      ok: false,
      reason: 'no_participants',
      message: `Agent ${input.targetAgentId} is not an active participant in thread ${threadId}`,
    };
  }
  const dispatchSet = targetParticipant
    ? new Set([targetParticipant])
    : buildDispatchSet({
        mentions,
        dispatchRouting,
        participantAgentIds,
        mentionedIdSetLC,
      });

  // Used only to pass `session.threadId` through the dispatch core.
  // Not persisted to the socket_sessions table.
  const sessionId = `tool-dispatch-${randomUUID()}`;
  // Synthetic SocketSession — dispatchToThreadInternal only reads `session.threadId`.
  const session: SocketSession = {
    id: sessionId,
    agentId: senderId,
    threadId,
    participantAgentIds,
    createdAt: Date.now(),
  };

  // Empty clientId — wsService.sendToClient is null-safe and silently no-ops.
  const meta = { clientId: '' } as InternalDispatchDeps['meta'];

  const deps: InternalDispatchDeps = {
    session,
    sessionId,
    threadName,
    isGroup,
    meta,
    message,
    triggerMessageId: messageId,
    participantAgentIds,
    agentNameMap,
    agentRoleMap,
    resolveParticipantId,
    isParticipantMention,
    // The sender stays out of the roster when a run re-reads it (liveRoster).
    rosterExcludeAgentId: senderId,
    rosterVersion,
    mentions,
    dispatchSet,
    dispatchRouting,
    effectiveParallelDispatch: targetParticipant ? false : effectiveParallelDispatch,
    thread,
    threadRuntimeConfig,
    ...(input.budgetSeed ? { budgetSeed: input.budgetSeed } : {}),
  };

  return { ok: true, deps };
}

/** Union of several mention parses, first-seen order, duplicates dropped. */
export function mergeMentions(results: readonly MentionResult[]): MentionResult {
  if (results.length === 1) return results[0]!;
  const ids = new Set<string>();
  const raw = new Set<string>();
  for (const r of results) {
    r.mentionedAgentIds.forEach((id) => ids.add(id));
    r.rawMentions.forEach((m) => raw.add(m));
  }
  return { mentionedAgentIds: [...ids], hasMentions: ids.size > 0, rawMentions: [...raw] };
}
