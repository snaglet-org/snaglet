/**
 * utteranceMessages: persistence + mention routing for an agent's spoken text.
 * Each tool-loop iteration can produce visible ("spoken") text; it is persisted
 * as a normal assistant message row and routes its @-mentions like a posted
 * message. Interim utterances and the terminal reply share both paths:
 *   - persistUtterance: write the row, sync its embedding, broadcast
 *     socket:chat:message_created. Not injectedDuringRun (that flag means
 *     received-while-running, not spoken-while-running).
 *   - routeSpokenMentions: fire the row's @-mentions once, per dispatch mode.
 */

import { Messages } from '@snaglet/db/tables/messages';
import { stripFabricatedSubagentReports } from '@server/services/subagents/subagentText';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import type { SnagletAgent } from '@server/services/AgentService';
import { syncMessageEmbedding } from '@server/services/EmbeddingService';
import { hooks } from '@server/services/HookService';
import { wsService } from '@server/services/WebSocketService';
import { generateId, getErrorMessage, isoNow } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { resolveAllModeTargets, routeMentions } from './mentionRouter';
import { emitUtterancePersisted } from '@server/services/SocketService/voiceSession/utteranceEvents';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';

/** Fan-out callback used by all-mode routing (defined per model attempt in the turn loop). */
type FanOutAllModeMidRunMessage = (
  midRunContent: string,
  targetAgentIds?: readonly string[],
  meta?: {
    senderAgentId?: string | null;
    senderUserId?: string | null;
    senderName?: string;
    sourceMessageId?: string;
  }
) => unknown;

/** Cumulative token usage for the producing run — carried on the terminal reply. */
interface UtteranceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextWindowTokens: number;
  /** Times the run compacted its own context (absent when it never did). */
  readonly runCompactions?: number;
}

export interface PersistUtteranceInput {
  readonly threadId: string;
  readonly threadName: string;
  readonly agentId: string;
  readonly runId: string;
  /** Visible (thinking-stripped) text. Callers guarantee it is non-empty. */
  readonly content: string;
  readonly previewMessage: (value: string, max?: number) => string;
  /** LogsService.socket.event label so operators can tell interim from abort-partial. */
  readonly logLabel: string;
  /**
   * Message type for the row + broadcast. Interim/partial utterances are always
   * plain 'message'; the terminal reply passes its detected type ('message' or
   * 'question'). Defaults to 'message'.
   */
  readonly messageType?: 'message' | 'question';
  /**
   * Run-level token usage. Only the terminal reply carries it; when present it
   * is written to the DB row and included in the broadcast payload so the two
   * cannot drift. Omitted (undefined) for interim/partial utterances.
   */
  readonly usage?: UtteranceUsage;
}

/**
 * Persist one spoken utterance as an assistant message row (agentId + runId,
 * not injectedDuringRun) and broadcast it. The terminal reply also passes its
 * detected type and run usage. Returns the new message id, or null when the
 * agent is not a thread participant (or the text was only an invented report).
 *
 * Removal mute: removing a participant mid-run does not stop its in-flight
 * turn, so this membership check (every utterance funnels through here) keeps
 * a removed agent from posting; callers skip mention routing on null.
 */
export async function persistUtterance(input: PersistUtteranceInput): Promise<string | null> {
  const stillParticipant = await ThreadParticipants.isAgentParticipant(
    input.threadId,
    input.agentId
  );
  if (!stillParticipant) {
    LogsService.socket.event('utterance dropped — agent not a participant', {
      threadName: input.threadName,
      threadId: input.threadId,
      agentId: input.agentId,
      runId: input.runId,
      text: input.previewMessage(input.content, 300),
    });
    return null;
  }
  // An imitated subagent result is the agent inventing a report it has not
  // received; Snaglet posts real ones itself (subagents/subagentText).
  const fabricated = stripFabricatedSubagentReports(input.content);
  if (fabricated.stripped) {
    LogsService.socket.event('invented subagent report removed from utterance', {
      threadId: input.threadId,
      agentId: input.agentId,
      runId: input.runId,
    });
    if (fabricated.text.length === 0) return null;
  }
  const content = fabricated.text;
  const messageId = generateId('message');
  const createdAt = isoNow();
  const messageType = input.messageType ?? 'message';
  await Messages.create({
    id: messageId,
    threadId: input.threadId,
    role: 'assistant',
    content,
    agentId: input.agentId,
    messageType,
    runId: input.runId,
    ...(input.usage ? { usage: input.usage } : {}),
  });
  // Lifecycle hook — every spoken agent utterance (interim + terminal) funnels
  // through here, so this is the single chokepoint for `message:create` on the
  // agent side. `role: 'agent'` + agentId let hooks pre-filter and run tools
  // under the speaking agent's permissions. Fire-and-forget, never blocks.
  hooks.emit('message:create', {
    id: messageId,
    threadId: input.threadId,
    role: 'agent',
    agentId: input.agentId,
    text: content,
    chars: content.length,
  });
  void syncMessageEmbedding(messageId, content).catch((err) => {
    LogsService.warn('message embedding sync failed', {
      threadName: input.threadName,
      threadId: input.threadId,
      messageId,
      error: getErrorMessage(err),
    });
  });
  wsService.broadcastToChannel(input.threadId, {
    type: 'socket:chat:message_created',
    payload: {
      id: messageId,
      threadId: input.threadId,
      role: 'assistant',
      content,
      agent_id: input.agentId,
      created_at: createdAt,
      message_type: messageType,
      injected_during_run: false,
      run_id: input.runId,
      ...(input.usage ? { usage: input.usage } : {}),
    },
  });
  LogsService.socket.event(input.logLabel, {
    threadName: input.threadName,
    threadId: input.threadId,
    text: input.previewMessage(content, 300),
  });
  // Voice tap: notify the in-process utterance stream so the TTS pipeline /
  // run-phase tracker can react. Inert (no listeners) on text-only threads; kind
  // is derived downstream from usage + logLabel, so nothing extra threads here.
  emitUtterancePersisted({
    threadId: input.threadId,
    agentId: input.agentId,
    runId: input.runId,
    messageId,
    content,
    hasUsage: input.usage !== undefined,
    logLabel: input.logLabel,
  });
  return messageId;
}

export interface RouteSpokenMentionsInput {
  readonly deps: RunAgentTurnDeps;
  readonly shared: RunAgentTurnSharedState;
  readonly agent: SnagletAgent;
  readonly runtimeAgent: SnagletAgent;
  /** The agent whose run produced this content — never re-woken by itself. */
  readonly replyAgentId: string;
  readonly content: string;
  readonly fanOutAllModeMidRunMessage: FanOutAllModeMidRunMessage;
  /** Log-event prefix so operators can tell which spoken source routed the mention. */
  readonly logContext: string;
}

/**
 * Route the @-mentions in spoken agent text (interim utterance, terminal reply,
 * or output_to_chat post) to teammates, with one policy for every source:
 *   - 1:1 (not a group)  → no-op.
 *   - all mode           → fan out via fanOutAllModeMidRunMessage.
 *   - mentioned          → routeMentions: wake idle peers into the wave, queue
 *                          into a peer already running. A peer woken by an
 *                          earlier utterance is in `runningAgents` by the next,
 *                          so a repeat mention queues instead of re-waking.
 */
export function routeSpokenMentions(input: RouteSpokenMentionsInput): void {
  const { deps, shared, agent, runtimeAgent, replyAgentId, content, logContext } = input;
  if (!deps.isGroup) return;

  const sender = { agentId: agent.id, name: agent.name, modelId: runtimeAgent.modelId };

  if (deps.dispatchMode === 'all') {
    const route = resolveAllModeTargets({ deps, content, replyAgentId, sender });
    input.fanOutAllModeMidRunMessage(content, route.targetAgentIds, {
      senderAgentId: agent.id,
      senderName: agent.name,
    });
    return;
  }

  const outcome = routeMentions({
    deps,
    shared,
    content,
    replyAgentId,
    sender,
    queueReason: 'mentioned',
    logContext,
  });

  // Teammates who are mid-run and were not tagged still hear the group talk,
  // held until a message reaches them (see drainInjectablePeerMessages).
  for (const runningId of shared.runningAgents) {
    if (runningId === replyAgentId || outcome.queued.includes(runningId)) continue;
    pendingAgentMessages.enqueue({
      threadId: deps.session.threadId,
      targetAgentId: runningId,
      senderAgentId: agent.id,
      senderName: agent.name,
      content,
      reason: 'thread-message',
    });
  }
}
