import { Messages } from '@snaglet/db/tables/messages';
import { stripFabricatedSubagentReports } from '@server/services/subagents/subagentText';
import { Runs } from '@snaglet/db/tables/runs';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import type { SnagletAgent } from '@server/services/AgentService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { hooks } from '@server/services/HookService';
import type { ContextBudget } from '@server/services/ContextWindowService';
import { syncMessageEmbedding } from '@server/services/EmbeddingService';
import type { ProviderChatResult } from '@server/services/ProviderChatService/types';
import {
  lintWorkspaceReferencesInMessage,
  type WorkspaceReferenceIssue,
} from '@server/services/SocketService/outboundMessageLinter';
import type { Message } from '@server/services/SocketService/types';
import { wsService } from '@server/services/WebSocketService';
import { elapsedMs, getErrorMessage } from '@snaglet/shared/utils';
import {
  emitAgentStatus,
  emitAgentTyping,
  resolveMessageType,
  stripThinkingTags,
} from '../chatHelpers';
import { LogsService } from '@server/services/LogsService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { detectPassSignal } from './detectPassSignal';
import { STAGNATION_POLICY, checkReplyStagnation } from './detectStagnation';
import { settingsService } from '@server/services/settings';
import { dispatchSettings } from '@server/services/settings/categories/dispatch';
import { resolveAllModeTargets, routeMentions } from './mentionRouter';
import type { RunTokenTotals } from './runTokenMeter';
import { persistUtterance } from './utteranceMessages';
import { routeReplyMentions } from './routeReplyMentions';
import { handOverToRemainingAgent, replacementForLeaver } from './handOverToRemainingAgent';
import { persistRunErrorMessage } from '@server/services/SocketService/persistRunErrorMessage';
import { outputLimitNotice } from './outputLimit';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';

export interface HandleFinalReplyInput {
  readonly deps: RunAgentTurnDeps;
  readonly shared: RunAgentTurnSharedState;
  readonly replyAgentId: string;
  readonly agent: SnagletAgent;
  readonly runtimeAgent: SnagletAgent;
  readonly agentMessages: Message[];
  readonly result: ProviderChatResult;
  readonly runId: string | null;
  readonly budget: ContextBudget;
  readonly startedAt: number;
  /** Last provider call's prompt size — the per-message context-window proxy. */
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** Run totals summed across every provider call — the billed figure. */
  readonly runTokens: RunTokenTotals;
  readonly iterations: number;
  /**
   * Set when the reply ended at the model's output limit, with the limit the
   * request carried (null when it named none and the provider's own applied).
   * Whatever text arrived posts as usual, then a notice says the reply was cut
   * off, and the run is recorded as failed with that reason.
   */
  readonly cutOff?: { readonly maxOutputTokens: number | null };
  /**
   * Times this run compacted its own context. Rides the reply's usage so the
   * chat draws its compaction divider: the last prompt's size alone may not
   * drop below the previous reply's when the compaction happened mid-run.
   */
  readonly runCompactions?: number;
  readonly fanOutAllModeMidRunMessage: (
    midRunContent: string,
    targetAgentIds?: readonly string[],
    meta?: {
      senderAgentId?: string | null;
      senderUserId?: string | null;
      senderName?: string;
      sourceMessageId?: string;
    }
  ) => unknown;
}

/**
 * Drop an imitated subagent result (see stripFabricatedSubagentReports) from
 * an agent's reply before it is posted. A reply that was nothing but an
 * invented report says it is waiting instead.
 */
function withoutFabricatedSubagentReports(
  reply: string,
  where: { agentName: string; threadId: string; runId: string }
): string {
  const { text, stripped } = stripFabricatedSubagentReports(reply);
  if (!stripped) return reply;
  LogsService.socket.event('invented subagent report removed from reply', where);
  return text.length > 0 ? text : 'Waiting for the subagent report.';
}

export async function handleFinalReply(input: HandleFinalReplyInput): Promise<void> {
  const { session, sessionId, threadName, meta, convBudget } = input.deps;
  const { recentRepliesByAgent, passedAgents } = input.shared;
  const runId = input.runId;
  if (!runId) {
    throw new Error('Cannot finalize agent reply without a run id');
  }

  // Terminal-iteration parity: a user message can arrive during the final
  // zero-tool LLM call — after the last drain seam in the tool loop. Deliver it
  // per mode so the agent responds to it instead of ending idle with the
  // message unanswered. (Only the human's mid-run sends land in the session
  // queue; agent→agent messages route through pendingAgentMessages instead.)
  const rewoken = await drainTerminalMidRunMessages({ input });

  const finalReply = withoutFabricatedSubagentReports(stripThinkingTags(input.result.reply).reply, {
    agentName: input.agent.name,
    threadId: session.threadId,
    runId,
  });
  const isContinuationRound = input.shared.conversationRound > 0;
  const passSignal = detectPassSignal(finalReply, isContinuationRound);
  const { trimmedReply, isExplicitPass, strippedReply } = passSignal;
  // A pure pass is token-only; a trailing token after real content is a
  // "parting message" — the content posts below, then the agent passes.
  const isPurePass = isExplicitPass && strippedReply.length === 0;

  // Repetition (stagnation) detection with a strike policy: a reply too
  // similar to one of the agent's own recent replies records a strike (the
  // reply still posts); STAGNATION_POLICY.strikesToPass consecutive strikes
  // auto-pass the agent; a genuinely different reply resets the count.
  // Semantic-first (embedding cosine), lexical Jaccard fallback — see
  // detectStagnation.ts.
  let isAutoPass = false;
  if (isContinuationRound && !isExplicitPass && trimmedReply.length > 0) {
    const priorReplies = recentRepliesByAgent.get(input.replyAgentId) ?? [];
    if (priorReplies.length > 0) {
      const embeddingThreshold = await settingsService
        .read(dispatchSettings.stagnationSimilarity)
        .catch(() => STAGNATION_POLICY.embeddingThreshold);
      const check = await checkReplyStagnation(trimmedReply, priorReplies, {
        embeddingThreshold,
      });
      if (check.similar) {
        const strikes = (input.shared.stagnationStrikes.get(input.replyAgentId) ?? 0) + 1;
        input.shared.stagnationStrikes.set(input.replyAgentId, strikes);
        isAutoPass = strikes >= STAGNATION_POLICY.strikesToPass;
        LogsService.socket.event(
          isAutoPass ? 'auto-passed (reply too similar)' : 'stagnation strike (reply similar)',
          {
            agentName: input.agent.name,
            modelName: input.runtimeAgent.modelId,
            threadName,
            threadId: session.threadId,
            round: input.shared.conversationRound,
            method: check.method,
            similarity: `${(check.similarity * 100).toFixed(0)}%`,
            strikes,
          }
        );
      } else if (input.shared.stagnationStrikes.has(input.replyAgentId)) {
        input.shared.stagnationStrikes.delete(input.replyAgentId);
        LogsService.socket.event('stagnation strikes reset (reply diverged)', {
          agentName: input.agent.name,
          threadName,
          threadId: session.threadId,
          round: input.shared.conversationRound,
        });
      }
    }
  }

  if (isPurePass || isAutoPass) {
    passedAgents.add(input.replyAgentId);
    input.shared.passKinds.set(input.replyAgentId, isPurePass ? 'explicit' : 'stagnation');
    convBudget.recordAgentTurn(input.totalOutputTokens);
    input.shared.currentWaveResults.push({
      agentId: input.replyAgentId,
      passed: true,
      replyLength: 0,
    });
    await finishRun(input, runId, 0);
    emitAgentTyping(meta.clientId, sessionId, input.agent.id, false, {
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadId: session.threadId,
    });
    emitAgentStatus(meta.clientId, sessionId, input.agent.id, 'idle', {
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadId: session.threadId,
    });
    wsService.broadcastToChannel(session.threadId, {
      type: 'socket:done',
      payload: {
        sessionId,
        runId,
        reply: '',
        durationMs: elapsedMs(input.startedAt),
        agentId: input.agent.id,
        passed: true,
      },
    });
    LogsService.socket.event('passed', {
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName,
      threadId: session.threadId,
      wave: input.shared.conversationRound,
    });
    return;
  }

  // Outbound content: for a parting-message pass, the trailing token is
  // stripped — the note posts, the token does not.
  const rawOutboundReply = isExplicitPass ? strippedReply : trimmedReply;
  const referenceLint = await lintWorkspaceReferencesInMessage(rawOutboundReply);
  // Cache safety: the agent's original text is what gets persisted and replayed.
  //
  // `referenceLint.content` is the rewritten form (unverified ids wrapped in
  // `[unverified: … — not found]`). Persisting that mutates history: on the next
  // run the rewritten bytes replay inside the durable cache prefix, the
  // provider's exact-leading-byte match fails there, and the whole message
  // region is re-billed.
  //
  // Unverified references are observability-only: `referenceLint.issues` is
  // logged as a warning in persistFinalReply. Agents may write incorrect ids on
  // purpose (examples, hypotheticals), so no correction message is injected, the
  // agent is not re-woken, and nothing is stamped onto the row.
  const outboundReply = rawOutboundReply;
  if (referenceLint.infrastructureError) {
    LogsService.warn('outbound workspace-reference lint failed open', {
      agentName: input.agent.name,
      threadName,
      threadId: session.threadId,
    });
  }

  // Posted reply: append to the agent's recent-replies window (newest last,
  // bounded by the stagnation comparison window).
  const windowReplies = recentRepliesByAgent.get(input.replyAgentId) ?? [];
  windowReplies.push(outboundReply);
  while (windowReplies.length > STAGNATION_POLICY.window) windowReplies.shift();
  recentRepliesByAgent.set(input.replyAgentId, windowReplies);
  convBudget.recordAgentTurn(input.totalOutputTokens);
  input.shared.currentWaveResults.push({
    agentId: input.replyAgentId,
    // A parting-message pass counts as passed for wave accounting: the agent
    // spoke, but has yielded — the post-wave auto-pass loop must not treat it
    // as a live responder, and the next wave must not re-dispatch it unless a
    // peer explicitly re-summons it (mention wake clears passedAgents).
    passed: isExplicitPass,
    replyLength: outboundReply.length,
    usedTools: input.iterations > 1,
  });
  if (isExplicitPass) {
    passedAgents.add(input.replyAgentId);
    input.shared.passKinds.set(input.replyAgentId, 'explicit');
    LogsService.socket.event('passed (with parting message)', {
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName,
      threadId: session.threadId,
      wave: input.shared.conversationRound + 1,
      replyLength: outboundReply.length,
    });
  }

  // The terminal reply is just another utterance: it routes its @-mentions
  // through the same seam as every interim utterance, so a run fires each
  // spoken row exactly once and the rules cannot drift. routeReplyMentions
  // re-reads the roster if an agent joined or left, and skips a speaker that
  // left the thread during its run (its reply is dropped).
  await routeReplyMentions({
    deps: input.deps,
    shared: input.shared,
    agent: input.agent,
    runtimeAgent: input.runtimeAgent,
    replyAgentId: input.replyAgentId,
    content: outboundReply,
    fanOutAllModeMidRunMessage: input.fanOutAllModeMidRunMessage,
    logContext: 'final reply',
  });

  const detectedMessageType = resolveMessageType(outboundReply);
  await persistFinalReply({
    input,
    finalReply: outboundReply,
    detectedMessageType,
    referenceIssues: referenceLint.issues,
  });

  await finishRun(input, runId, outboundReply.length);
  emitAgentTyping(meta.clientId, sessionId, input.agent.id, false, {
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadId: session.threadId,
  });
  emitAgentStatus(meta.clientId, sessionId, input.agent.id, 'idle', {
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadId: session.threadId,
  });

  const durationMs = elapsedMs(input.startedAt);
  // No per-wake workspace delta is surfaced to the client. Field kept (always
  // null) for socket/UI back-compat.
  const wakeDelta = null;
  wsService.broadcastToChannel(session.threadId, {
    type: 'socket:done',
    payload: {
      sessionId,
      runId,
      // Parting-message pass: the client sees the stripped note, never the token.
      reply: outboundReply,
      durationMs,
      usage: {
        inputTokens: input.totalInputTokens,
        outputTokens: input.totalOutputTokens,
        contextWindowTokens: input.budget.contextWindowTokens,
        // Authoritative run totals. The live counter reconciles to these, and
        // they are the same values just written to `runs` (cache_read_tokens /
        // cache_creation_tokens / provider_calls persist there so this claim
        // holds — without them, these reached the socket frame and nowhere
        // else, and a cache regression was unanswerable after the fact).
        billedInputTokens: input.runTokens.billedInputTokens,
        cacheReadTokens: input.runTokens.cacheReadTokens,
        cacheCreationTokens: input.runTokens.cacheCreationTokens,
        providerCalls: input.runTokens.providerCalls,
        ...(input.runCompactions ? { runCompactions: input.runCompactions } : {}),
      },
      agentId: input.agent.id,
      messageType: detectedMessageType,
      responseOptions: null,
      wakeDelta,
    },
  });
  LogsService.socket.event('done', {
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadName,
    threadId: session.threadId,
    round: input.shared.conversationRound,
    durationMs,
    iterations: input.iterations,
    tokensIn: input.totalInputTokens,
    tokensOut: input.totalOutputTokens,
  });

  // The terminal drain re-woke this agent for a message sent during this run:
  // the dispatch runs it again in the next wave. Announced after this run's
  // idle and done, which clear the agent's bubble, so it reads "queued" until
  // that turn starts (or, if the dispatch ends first, until the lock release
  // clears it). A passing agent is not run again.
  if (rewoken && !passedAgents.has(input.replyAgentId)) {
    emitAgentStatus(meta.clientId, sessionId, input.agent.id, 'queued', {
      agentName: input.agent.name,
      threadId: session.threadId,
    });
  }

  // No thread digest here: the fold (historyCompactor) is the thread's only summary, saved to
  // thread_summaries each time history is folded.
}

/**
 * Deliver messages parked in the session queue when the run reached its
 * terminal (zero-tool) iteration, branching by dispatch mode:
 *
 *   - all (group)       → fan out to targets + re-wake (drainAllModeMidRunMessages)
 *   - solo (1:1)        → re-wake the one agent so it answers the user
 *   - mentioned (group) → re-wake the current agent (the user's voice always
 *                         reaches it) and route any @mentions to peers
 *
 * Only the human user's mid-run sends land in the session queue, so every
 * message here is user-authored — hence the current agent is always re-woken
 * (the user's own voice injects in every mode; see decideMidRunInjection).
 * Resolves true when the current agent was re-woken for the next wave.
 */
async function drainTerminalMidRunMessages({
  input,
}: {
  input: HandleFinalReplyInput;
}): Promise<boolean> {
  // Route against the thread as it is now (an agent may have joined or left).
  await input.deps.refreshRoster?.();
  const { isGroup, dispatchMode } = input.deps;
  if (isGroup && dispatchMode === 'all') return drainAllModeMidRunMessages({ input });
  if (!isGroup) return drainSoloTerminalMidRunMessages({ input });
  if (dispatchMode === 'mentioned') return drainMentionedTerminalMidRunMessages({ input });
  // Any other (unknown) group mode: defer — messages stay in the session queue
  // and are drained on the next turn.
  return false;
}

/**
 * Persist + broadcast one drained mid-run user message. Shared by the solo and
 * mentioned terminal drains; mirrors the all-mode persist so replay ordering
 * (injectedDuringRun) is identical across modes.
 */
async function persistTerminalMidRunMessage({
  input,
  midRunMsgId,
  midRunContent,
  userId,
}: {
  input: HandleFinalReplyInput;
  midRunMsgId: string;
  midRunContent: string;
  userId: string;
}): Promise<void> {
  const { session, threadName, previewMessage } = input.deps;
  LogsService.user.message({
    threadName,
    threadId: session.threadId,
    text: previewMessage(midRunContent, 300),
  });
  await Messages.create({
    id: midRunMsgId,
    threadId: session.threadId,
    role: 'user',
    content: midRunContent,
    agentId: null,
    userId,
    injectedDuringRun: true,
  });
  void syncMessageEmbedding(midRunMsgId, midRunContent).catch((err) => {
    LogsService.warn('message embedding sync failed', {
      threadName,
      threadId: session.threadId,
      messageId: midRunMsgId,
      error: getErrorMessage(err),
    });
  });
  wsService.broadcastToChannel(session.threadId, {
    type: 'socket:chat:message_created',
    payload: {
      id: midRunMsgId,
      threadId: session.threadId,
      role: 'user',
      content: midRunContent,
      injected_during_run: true,
    },
  });
}

/**
 * Solo (1:1) terminal drain: persist the user's mid-run message(s) and re-wake
 * the one agent. On the re-wake the messages are already in the agent's history
 * (via turn replay), so it answers them instead of ending idle. The wave loop's
 * solo-break honors wokenByMention to run that one extra wave.
 */
async function drainSoloTerminalMidRunMessages({
  input,
}: {
  input: HandleFinalReplyInput;
}): Promise<boolean> {
  const { session, sessionId, threadName, wokenByMention } = input.deps;
  const pending = activeRunTracker.drainMessages(sessionId);
  if (pending.length === 0) return false;

  const user = await Users.getOrCreateLocalUser();
  for (const { id, content, persisted } of pending) {
    // chatHandlers already persisted this row on receipt when
    // persisted=true; skip re-creating (would PK-collide) and only broadcast.
    if (!persisted) {
      await persistTerminalMidRunMessage({
        input,
        midRunMsgId: id,
        midRunContent: content,
        userId: user.id,
      });
    }
  }

  // The agent that just answered may have left the thread during its run; then
  // the message goes to the agent still there instead of re-waking the leaver.
  const replacement = replacementForLeaver(input.deps, input.replyAgentId);
  if (replacement !== null) {
    if (replacement) {
      handOverToRemainingAgent({
        deps: input.deps,
        shared: input.shared,
        agentId: replacement,
        leaverId: input.replyAgentId,
        messages: pending.map(({ id, content }) => ({
          id,
          content,
          senderUserId: user.id,
          senderName: 'User',
        })),
      });
    }
    return false;
  }
  wokenByMention.add(input.replyAgentId);
  LogsService.socket.event('solo terminal mid-run drain → re-wake', {
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadName,
    threadId: session.threadId,
    count: pending.length,
  });
  return true;
}

/**
 * Mentioned-mode (group) terminal drain: persist the user's mid-run message(s),
 * route any @mentions to peers (waking idle ones, queuing running ones), and
 * re-wake the current agent — the user's own voice always reaches the agent it
 * is talking to, regardless of whether it was @mentioned. The re-wake rides the
 * normal multi-wave loop via wokenByMention.
 */
async function drainMentionedTerminalMidRunMessages({
  input,
}: {
  input: HandleFinalReplyInput;
}): Promise<boolean> {
  const { session, sessionId, threadName, wokenByMention } = input.deps;
  const pending = activeRunTracker.drainMessages(sessionId);
  if (pending.length === 0) return false;

  const user = await Users.getOrCreateLocalUser();
  for (const { id, content, persisted } of pending) {
    // chatHandlers already persisted this row on receipt when
    // persisted=true; skip re-creating (would PK-collide) and only route mentions.
    if (!persisted) {
      await persistTerminalMidRunMessage({
        input,
        midRunMsgId: id,
        midRunContent: content,
        userId: user.id,
      });
    }
    // Route the message's @mentions to teammates (self-mention is a no-op here;
    // the current agent is re-woken below regardless).
    routeMentions({
      deps: input.deps,
      shared: input.shared,
      content,
      replyAgentId: input.replyAgentId,
      sender: { userId: user.id, name: 'User' },
      queueReason: 'mentioned',
      sourceMessageId: id,
      logContext: 'mentioned terminal mid-run',
    });
  }

  wokenByMention.add(input.replyAgentId);
  LogsService.socket.event('mentioned terminal mid-run drain → re-wake', {
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadName,
    threadId: session.threadId,
    count: pending.length,
  });
  return true;
}

async function drainAllModeMidRunMessages({
  input,
}: {
  input: HandleFinalReplyInput;
}): Promise<boolean> {
  const { session, sessionId, threadName, previewMessage } = input.deps;
  const pendingMidRunMessages = activeRunTracker.drainMessages(sessionId);
  if (pendingMidRunMessages.length === 0) {
    return false;
  }

  const midRunUser = await Users.getOrCreateLocalUser();
  const routedMidRunMessages = pendingMidRunMessages.map((message) => ({
    ...message,
    route: resolveAllModeTargets({
      deps: input.deps,
      content: message.content,
      replyAgentId: input.replyAgentId,
      sender: { userId: midRunUser.id, name: 'User' },
    }),
  }));

  for (const {
    id: midRunMsgId,
    content: midRunContent,
    persisted: midRunPersisted,
    route,
  } of routedMidRunMessages) {
    LogsService.user.message({
      threadName,
      threadId: session.threadId,
      text: previewMessage(midRunContent, 300),
    });
    // A row chatHandlers persisted on receipt was embedded and broadcast then
    // too; only a message whose persist failed is saved and announced here.
    if (!midRunPersisted) {
      await Messages.create({
        id: midRunMsgId,
        threadId: session.threadId,
        role: 'user',
        content: midRunContent,
        agentId: null,
        userId: midRunUser.id,
        injectedDuringRun: true,
      });
      void syncMessageEmbedding(midRunMsgId, midRunContent).catch((err) => {
        LogsService.warn('message embedding sync failed', {
          threadName,
          threadId: session.threadId,
          messageId: midRunMsgId,
          error: getErrorMessage(err),
        });
      });
      wsService.broadcastToChannel(session.threadId, {
        type: 'socket:chat:message_created',
        payload: {
          id: midRunMsgId,
          threadId: session.threadId,
          role: 'user',
          content: midRunContent,
          injected_during_run: true,
        },
      });
    }

    input.fanOutAllModeMidRunMessage(midRunContent, route.targetAgentIds, {
      senderUserId: midRunUser.id,
      senderName: 'User',
      sourceMessageId: midRunMsgId,
    });
    if (route.targetsCurrentAgent) {
      pendingAgentMessages.enqueue({
        id: midRunMsgId,
        threadId: session.threadId,
        targetAgentId: input.replyAgentId,
        senderUserId: midRunUser.id,
        senderName: 'User',
        content: midRunContent,
        reason: 'all-mode-thread-message',
        sourceMessageId: midRunMsgId,
      });
    }
  }

  if (!routedMidRunMessages.some(({ route }) => route.targetsCurrentAgent)) return false;
  input.deps.wokenByMention.add(input.replyAgentId);
  LogsService.socket.event('mid-run all-mode drain deferred to next wave', {
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadName,
    threadId: session.threadId,
    count: pendingMidRunMessages.length,
  });
  return true;
}

/**
 * Record the run's end. `runs` is the usage-history table, so it records what
 * the run was billed: input summed across every provider call, not the last
 * call's prompt size (the per-message `usage.inputTokens` keeps the last-call
 * meaning, because the UI reads it as a context-window gauge; see
 * runTokenMeter). A reply cut off at the output limit never ends as a quiet
 * completion, a pass included: the thread gets a notice after whatever text
 * arrived and the run is recorded as failed with that reason.
 */
async function finishRun(
  input: HandleFinalReplyInput,
  runId: string,
  replyLength: number
): Promise<void> {
  const { session, threadName } = input.deps;
  const runUsage = {
    inputTokens: input.runTokens.billedInputTokens,
    outputTokens: input.runTokens.outputTokens,
    cacheReadTokens: input.runTokens.cacheReadTokens,
    cacheCreationTokens: input.runTokens.cacheCreationTokens,
    providerCalls: input.runTokens.providerCalls,
  };
  const cutOffNotice = input.cutOff ? outputLimitNotice(input.cutOff.maxOutputTokens) : null;
  if (cutOffNotice) {
    LogsService.warn('reply ended at the output limit', {
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName,
      threadId: session.threadId,
      runId,
      maxOutputTokens: input.cutOff?.maxOutputTokens ?? null,
      replyLength,
    });
    await persistRunErrorMessage({
      threadId: session.threadId,
      agentId: input.agent.id,
      agentName: input.agent.name,
      runId,
      kind: 'output_limit',
      rawError: cutOffNotice,
      provider: input.runtimeAgent.provider,
      modelId: input.runtimeAgent.modelId,
    });
    await Runs.markFailed(runId, cutOffNotice, runUsage);
  } else {
    await Runs.markCompleted(runId, runUsage);
  }
  activeRunTracker.finish(runId);
  hooks.emit('run:end', {
    runId,
    agentId: input.agent.id,
    threadId: session.threadId,
    status: cutOffNotice ? 'failed' : 'completed',
  });
}

async function persistFinalReply({
  input,
  finalReply,
  detectedMessageType,
  referenceIssues,
}: {
  input: HandleFinalReplyInput;
  finalReply: string;
  detectedMessageType: 'message' | 'question';
  referenceIssues: readonly WorkspaceReferenceIssue[];
}) {
  const { session, threadName, previewMessage } = input.deps;
  if (finalReply.trim().length === 0) return;
  // Guarded by handleFinalReply (throws on a null runId before we get here), so
  // input.runId is non-null; narrow it for persistUtterance's `string` contract.
  if (!input.runId) return;

  // The terminal reply is semantically the last utterance: persist + broadcast
  // it through the same path as every interim utterance so the row and its
  // socket:chat:message_created event cannot drift. It differs only in carrying
  // the detected message type and the run's cumulative usage (written to the row
  // and the broadcast). socket:done still fires separately for run completion.
  const messageId = await persistUtterance({
    threadId: session.threadId,
    threadName,
    agentId: input.agent.id,
    runId: input.runId,
    content: finalReply,
    previewMessage,
    logLabel: 'assistant message',
    messageType: detectedMessageType,
    usage: {
      inputTokens: input.totalInputTokens,
      outputTokens: input.totalOutputTokens,
      contextWindowTokens: input.budget.contextWindowTokens,
      ...(input.runCompactions ? { runCompactions: input.runCompactions } : {}),
    },
  });

  // Null = the agent was removed from the thread mid-run and the terminal reply
  // was dropped (not persisted, not broadcast). Nothing posted, so there is no
  // outbound message to lint — skip the integrity check.
  if (messageId === null) return;

  // Unverified workspace ids are logged only. Nothing is injected into the
  // thread and the agent is not woken: an incorrect id may be deliberate.
  if (referenceIssues.length > 0) {
    LogsService.warn('outbound message failed integrity lint', {
      agentName: input.agent.name,
      threadName,
      threadId: session.threadId,
      messageId,
      lintKind: 'unverified_workspace_ids',
      unverifiedIds: [...new Set(referenceIssues.map((issue) => issue.id))],
    });
  }
}
