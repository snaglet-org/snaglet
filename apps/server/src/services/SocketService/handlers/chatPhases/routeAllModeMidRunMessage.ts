import { parseMentions } from '@server/services/MentionParser';
import { resolveLimitedMentionBubble } from './mentionRouter';
import { LogsService } from '@server/services/LogsService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { unique } from '@snaglet/shared/utils';

export interface RouteAllModeMidRunMessageInput {
  replyAgentId: string;
  participantAgentIds: readonly string[];
  targetAgentIds?: readonly string[];
  runningAgents: Set<string>;
  agentDispatchCount: Map<string, number>;
  dispatchSet: Set<string>;
  passedAgents: Set<string>;
  wokenByMention: Set<string>;
  hardDispatchCeiling: number;
  effectiveParallelDispatch: boolean;
  content: string;
  startAgent: (agentId: string) => void;
  queuePendingMessage?: (targetAgentId: string) => void;
}

export interface RouteAllModeMidRunMessageResult {
  queuedAgentIds: string[];
  wokenAgentIds: string[];
  limitedAgentIds: string[];
}

export interface ResolveAllModeMidRunTargetsInput {
  content: string;
  replyAgentId: string;
  participantAgentIds: readonly string[];
  agentNameMap: Map<string, string>;
}

export interface ResolveAllModeMidRunTargetsResult {
  targetAgentIds: string[];
  targetsCurrentAgent: boolean;
  /**
   * Explicit @mentions that did not resolve to any participant. Callers
   * surface these via `chat:mention-skipped` (see mentionRouter's
   * resolveAllModeTargets) — dropping them silently was a long-standing
   * all-mode drift from the mentioned-mode paths.
   */
  unresolvedMentionIds: string[];
}

/**
 * Resolve which participants should receive a mid-run user message in `all`
 * mode. An unmentioned message keeps the open-floor behavior. Explicit
 * mentions narrow the target list, matching the initial dispatch path.
 */
export function resolveAllModeMidRunTargets(
  input: ResolveAllModeMidRunTargetsInput
): ResolveAllModeMidRunTargetsResult {
  const mentions = parseMentions(input.content, input.agentNameMap);
  const participantIdsByLowercase = new Map(
    input.participantAgentIds.map((participantId) => [participantId.toLowerCase(), participantId])
  );
  const unresolvedMentionIds: string[] = [];
  const targetAgentIds: string[] = [];
  if (mentions.rawMentions.length === 0) {
    targetAgentIds.push(...input.participantAgentIds);
  } else {
    for (const mentionedId of mentions.mentionedAgentIds) {
      const participantId = participantIdsByLowercase.get(mentionedId.toLowerCase());
      if (participantId) targetAgentIds.push(participantId);
      else unresolvedMentionIds.push(mentionedId);
    }
  }
  const replyAgentIdLowercase = input.replyAgentId.toLowerCase();

  return {
    targetAgentIds: unique(targetAgentIds),
    targetsCurrentAgent: targetAgentIds.some(
      (participantId) => participantId.toLowerCase() === replyAgentIdLowercase
    ),
    unresolvedMentionIds: unique(unresolvedMentionIds),
  };
}

/**
 * Fan a mid-run user message out to every other participant in `all` mode.
 *
 * The active agent gets the message directly in its current loop; this helper
 * handles everyone else by either injecting into an already-running agent's
 * queue, or waking a non-running participant into the current wave.
 */
export function routeAllModeMidRunMessage(
  input: RouteAllModeMidRunMessageInput
): RouteAllModeMidRunMessageResult {
  const queuedAgentIds: string[] = [];
  const wokenAgentIds: string[] = [];
  const limitedAgentIds: string[] = [];

  for (const participantId of input.targetAgentIds ?? input.participantAgentIds) {
    if (participantId === input.replyAgentId) continue;

    if (input.runningAgents.has(participantId)) {
      input.queuePendingMessage?.(participantId);
      queuedAgentIds.push(participantId);
      continue;
    }

    const dispatches = input.agentDispatchCount.get(participantId) ?? 0;
    if (dispatches >= input.hardDispatchCeiling) {
      limitedAgentIds.push(participantId);
      continue;
    }

    input.dispatchSet.add(participantId);
    input.passedAgents.delete(participantId);
    input.wokenByMention.add(participantId);
    wokenAgentIds.push(participantId);

    if (input.effectiveParallelDispatch) {
      input.startAgent(participantId);
    }
  }

  return { queuedAgentIds, wokenAgentIds, limitedAgentIds };
}

/**
 * Context for {@link applyAllModeFanoutEffects}. Carries the static
 * descriptors emitted alongside each fan-out log event plus the broadcast
 * hook for bubble resolution.
 */
export interface AllModeFanoutEffectsContext {
  agentName: string;
  modelName: string;
  threadName: string;
  threadId: string;
  sessionId: string;
  agentNameMap: Map<string, string>;
  agentDispatchCount: Map<string, number>;
  broadcastToChannel: (channel: string, msg: unknown) => void;
}

/**
 * Apply the side effects of an all-mode mid-run fan-out result: log events,
 * a handoff reservation when any agent was woken, and bubble resolution for
 * agents dropped at the dispatch ceiling (via mentionRouter's shared
 * resolveLimitedMentionBubble contract).
 */
export function applyAllModeFanoutEffects(
  fanout: RouteAllModeMidRunMessageResult,
  ctx: AllModeFanoutEffectsContext
): void {
  const { agentName, modelName, threadName, threadId, agentNameMap, agentDispatchCount } = ctx;

  for (const participantId of fanout.queuedAgentIds) {
    LogsService.socket.event('mid-run all-mode message queued (running)', {
      agentName,
      modelName,
      mentionedName: agentNameMap.get(participantId) ?? participantId,
      threadName,
      threadId,
    });
  }

  if (fanout.wokenAgentIds.length > 0) {
    activeRunTracker.reserveHandoff(threadId, 'all-mode-mid-run');
  }
  for (const participantId of fanout.wokenAgentIds) {
    LogsService.socket.event('mid-run all-mode message woke agent', {
      agentName,
      modelName,
      mentionedName: agentNameMap.get(participantId) ?? participantId,
      threadName,
      threadId,
    });
  }

  for (const participantId of fanout.limitedAgentIds) {
    resolveLimitedMentionBubble({
      broadcastToChannel: ctx.broadcastToChannel,
      threadId,
      sessionId: ctx.sessionId,
      agentId: participantId,
    });
    LogsService.socket.event('mid-run all-mode message ignored (limit)', {
      agentName,
      modelName,
      mentionedName: agentNameMap.get(participantId) ?? participantId,
      threadName,
      threadId,
      dispatches: agentDispatchCount.get(participantId) ?? 0,
    });
  }
}
