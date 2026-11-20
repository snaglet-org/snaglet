/**
 * mentionRouter — the single owner of mid-conversation mention policy.
 *
 * One parser (MentionParser) feeds many moments that can carry an @mention:
 * an agent's per-iteration utterance, its final reply, a user message injected
 * mid-run. Mentions that appear only in private reasoning do not dispatch —
 * an agent must say a summon out loud. Every routed source flows through here so
 * the rules cannot drift:
 *
 *   - non-participant   → `chat:mention-skipped` broadcast (UI shows why)
 *   - self-mention      → ignored (reported via `targetedSelf`)
 *   - target mid-run    → queued into pendingAgentMessages (delivered
 *                         between tool iterations)
 *   - idle + under cap  → woken into the current wave (dispatchSet +
 *                         wokenByMention + immediate startAgent when the
 *                         wave runs parallel); crossing the soft dispatch
 *                         threshold marks the agent for discernment
 *                         guidance, same as the wave-loop filter
 *   - idle + at cap     → dropped, and the client's optimistic "Thinking…"
 *                         bubble is resolved with socket:done{passed:true}
 *
 * This policy is deliberately centralized — copy-pasted variants drift
 * (missed pending-bubble resolves on ceiling drops, silently dropped unknown
 * mentions, skipped soft-threshold guidance). Change policy here, not at
 * call sites.
 */

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { LogsService } from '@server/services/LogsService';
import { parseMentions } from '@server/services/MentionParser';
import {
  pendingAgentMessages,
  type PendingAgentMessageReason,
} from '@server/services/PendingAgentMessageService';
import {
  resolveAllModeMidRunTargets,
  type ResolveAllModeMidRunTargetsResult,
} from './routeAllModeMidRunMessage';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';

/** Who authored the content whose mentions are being routed. */
export interface MentionSender {
  /** Agent id when an agent authored the content; omit for user-authored. */
  agentId?: string | null;
  userId?: string | null;
  name: string;
  /** Model label, for log events only. */
  modelId?: string | null;
}

export interface RouteMentionsInput {
  deps: RunAgentTurnDeps;
  shared: RunAgentTurnSharedState;
  /** The message text whose @mentions should be routed. */
  content: string;
  /** The agent whose run produced/received this content — never re-woken by itself. */
  replyAgentId: string;
  sender: MentionSender;
  /** pendingAgentMessages reason used when the target is mid-run. */
  queueReason: PendingAgentMessageReason;
  /** Optional explicit queue-entry id (e.g. the persisted message id). */
  queueMessageId?: string;
  /** Optional persisted message id the content came from. */
  sourceMessageId?: string;
  /** Log-event prefix so operators can tell which path routed the mention. */
  logContext: string;
}

export interface MentionRoutingOutcome {
  woke: string[];
  queued: string[];
  skipped: string[];
  limited: string[];
  /** True when the content @mentions the agent whose run produced it. */
  targetedSelf: boolean;
}

/**
 * Parse `content` and apply the wake/queue/limit/skip policy to every
 * @mention. No-op (all-empty outcome) when the content carries no mentions.
 */
export function routeMentions(input: RouteMentionsInput): MentionRoutingOutcome {
  const { deps, shared, content, replyAgentId, sender, logContext } = input;
  const {
    session,
    threadName,
    agentNameMap,
    resolveParticipantId,
    isParticipantMention,
    startAgent,
    HARD_DISPATCH_CEILING,
    softDispatchThreshold,
    dispatchSet,
    wokenByMention,
    effectiveParallelDispatch,
  } = deps;
  const { runningAgents, agentDispatchCount, passedAgents, agentSoftThresholdNotified } = shared;

  const outcome: MentionRoutingOutcome = {
    woke: [],
    queued: [],
    skipped: [],
    limited: [],
    targetedSelf: false,
  };

  const mentions = parseMentions(content, agentNameMap);
  if (!mentions.hasMentions) return outcome;

  const logMeta = {
    agentName: sender.name,
    modelName: sender.modelId ?? undefined,
    threadName,
    threadId: session.threadId,
  };

  for (const rawMentionedId of mentions.mentionedAgentIds) {
    const mentionedId = resolveParticipantId(rawMentionedId) ?? rawMentionedId;

    if (!isParticipantMention(rawMentionedId)) {
      emitMentionSkipped({ deps, sender, mentionedId });
      outcome.skipped.push(mentionedId);
      continue;
    }

    if (mentionedId === replyAgentId) {
      outcome.targetedSelf = true;
      continue;
    }
    const mentionedName = agentNameMap.get(mentionedId) ?? mentionedId;

    if (runningAgents.has(mentionedId)) {
      pendingAgentMessages.enqueue({
        ...(input.queueMessageId ? { id: input.queueMessageId } : {}),
        threadId: session.threadId,
        targetAgentId: mentionedId,
        senderAgentId: sender.agentId ?? null,
        senderUserId: sender.userId ?? null,
        senderName: sender.name,
        content,
        reason: input.queueReason,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      });
      outcome.queued.push(mentionedId);
      LogsService.socket.event(`${logContext} mention queued (agent running)`, {
        ...logMeta,
        mentionedName,
      });
      continue;
    }

    const dispatches = agentDispatchCount.get(mentionedId) ?? 0;
    if (dispatches >= HARD_DISPATCH_CEILING) {
      resolveLimitedMentionBubble({
        broadcastToChannel: (channel, msg) => deps.wsService.broadcastToChannel(channel, msg),
        threadId: session.threadId,
        sessionId: deps.sessionId,
        agentId: mentionedId,
      });
      outcome.limited.push(mentionedId);
      LogsService.socket.event(`${logContext} mention ignored (dispatch limit)`, {
        ...logMeta,
        mentionedName,
        dispatches,
      });
      continue;
    }

    // Wake: same state transitions as the wave-loop candidate filter,
    // including the soft-threshold discernment marking it applies.
    dispatchSet.add(mentionedId);
    passedAgents.delete(mentionedId);
    wokenByMention.add(mentionedId);
    if (dispatches >= softDispatchThreshold) {
      agentSoftThresholdNotified.add(mentionedId);
    }
    outcome.woke.push(mentionedId);
    LogsService.socket.event(`${logContext} mention woke agent`, {
      ...logMeta,
      mentionedName,
    });
    activeRunTracker.reserveHandoff(session.threadId, 'mention-handoff');
    if (effectiveParallelDispatch) {
      startAgent(mentionedId);
    }
  }

  return outcome;
}

/**
 * All-mode target resolution with the skip policy applied: explicit mentions
 * that don't resolve to a participant broadcast `chat:mention-skipped`
 * instead of vanishing silently.
 */
export function resolveAllModeTargets(input: {
  deps: RunAgentTurnDeps;
  content: string;
  replyAgentId: string;
  sender: MentionSender;
}): ResolveAllModeMidRunTargetsResult {
  const route = resolveAllModeMidRunTargets({
    content: input.content,
    replyAgentId: input.replyAgentId,
    participantAgentIds: input.deps.participantAgentIds,
    agentNameMap: input.deps.agentNameMap,
  });
  for (const mentionedId of route.unresolvedMentionIds) {
    emitMentionSkipped({ deps: input.deps, sender: input.sender, mentionedId });
    LogsService.socket.event('all-mode mention skipped (not a participant)', {
      agentName: input.sender.name,
      threadName: input.deps.threadName,
      threadId: input.deps.session.threadId,
      mentionedName: input.deps.agentNameMap.get(mentionedId) ?? mentionedId,
    });
  }
  return route;
}

/** Broadcast `chat:mention-skipped` so the UI can explain a dropped mention. */
function emitMentionSkipped(input: {
  deps: RunAgentTurnDeps;
  sender: MentionSender;
  mentionedId: string;
}): void {
  const { deps, sender, mentionedId } = input;
  const mentionedName = deps.agentNameMap.get(mentionedId) ?? mentionedId;
  LogsService.socket.event('mention skipped (not a participant)', {
    threadName: deps.threadName,
    threadId: deps.session.threadId,
    mentionerName: sender.name,
    mentionedName,
  });
  deps.wsService.broadcastToChannel(deps.session.threadId, {
    type: 'chat:mention-skipped',
    payload: {
      threadId: deps.session.threadId,
      mentionerAgentId: sender.agentId ?? null,
      mentionerName: sender.name,
      mentionedAgentId: mentionedId,
      mentionedName,
      reason: 'not-participant',
    },
  });
}

/**
 * Resolve the client's optimistic "Thinking…" bubble for an agent whose
 * mention was dropped at the dispatch ceiling. The client creates a pending
 * bubble the moment it sees an @mention; without this, the bubble spins
 * forever. Low-level signature so the all-mode fan-out (which carries a
 * broadcast fn, not the full deps bag) shares the exact payload contract.
 */
export function resolveLimitedMentionBubble(input: {
  broadcastToChannel: (channel: string, msg: unknown) => void;
  threadId: string;
  sessionId: string;
  agentId: string;
}): void {
  input.broadcastToChannel(input.threadId, {
    type: 'socket:done',
    payload: {
      sessionId: input.sessionId,
      reply: '',
      durationMs: 0,
      agentId: input.agentId,
      passed: true,
    },
  });
}
