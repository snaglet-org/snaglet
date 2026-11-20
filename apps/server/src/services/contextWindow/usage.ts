/**
 * Thread context-usage estimation — mirrors the runtime budget + compression
 * pass so the desktop UI's per-thread usage indicator matches what will
 * actually be sent to the model on the next turn.
 *
 * "Mirrors" is literal: this does the same assembly runAgentTurn does — compose
 * the system prompt, resolve the advertised tool catalog, replay the thread the
 * way the agent perceives it (tool calls and results included) — because
 * anything cheaper is a different number than the one that gets sent. That
 * makes this endpoint materially more expensive than a message-row scan; it is
 * on-demand (panel open, post-compaction refresh), so correctness wins.
 */

import { agentService } from '@server/services/AgentService';
import { resolveAdvertisedAgentToolSets, SKILL_TOOL_ID } from '@server/services/AgentToolResolver';
import { loadSkillCatalogEntries } from '@server/services/skills/skillCatalog';
import { resolveThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import { summaryService } from '@server/services/SummaryService';
import { labelThreadSummary } from '@server/services/summary/threadSummaryLabel';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import { buildReplayPayload } from '@server/services/SocketService/handlers/chatPhases/replayLoader';
import { composeSystemPrompt } from '@server/services/SystemPromptComposer';
import { resolveRunParams } from '@server/services/SystemPromptComposer/resolveRunParams';
import { estimateSessionTokens } from '@server/services/TokenEstimator';
import { Models } from '@snaglet/db/tables/models';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { flattenTextBlocks, getErrorMessage } from '@snaglet/shared/utils';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { resolveContextBudget } from './budget';
import { compressMessages } from './compression';

/**
 * Snapshot of how much of an agent's context window is currently consumed by
 * a thread, including pre/post-compression token counts and budget breakdown.
 * Powers the per-thread "context usage" indicator in the desktop UI.
 */
interface ThreadContextUsage {
  threadId: string;
  agentId: string;
  provider: string;
  model: string | null;
  tokens: {
    /**
     * Post-compression size of the whole request: system prompt + tool catalog
     * + messages. Equals systemPromptTokens + toolCatalogTokens + messageTokens.
     */
    estimated: number;
    /** Same total, pre-compression (full replayed thread). */
    raw: number;
    compressed: boolean;
    keptMessages: number;
    messagesCounted: number;
    /** Message payload only, post-compression — tool calls and results included. */
    messageTokens: number;
    /** Chars in the composed system prompt actually sent. */
    systemPromptChars: number;
    /** Tokens for that same composed prompt — not the agent's raw persona field. */
    systemPromptTokens: number;
    /** Tokens for the advertised `tools` payload. */
    toolCatalogTokens: number;
    /** How many tool schemas that catalog carries. */
    toolCount: number;
    threadSummaryUsed: boolean;
  };
  budget: {
    contextWindowTokens: number;
    maxOutputTokens: number;
    usableBudget: number;
    tokenThreshold: number;
    /** True when overhead alone exhausted the window and the budget was floored. */
    overheadFloored: boolean;
  };
  percent: number;
  percentOfUsable: number;
  /** Estimation method, surfaced so the UI can show "~" if it's character-based. */
  source: 'character-estimate';
  /**
   * Most recent per-agent compaction for this thread. Null when the agent has
   * never been compacted on this thread. Powers the "Last compacted vN · Xm ago"
   * line and confirms a no-op compact button click landed (version stays the
   * same when there's nothing new to summarize).
   */
  latestSummary: {
    version: number;
    /**
     * When this summary VERSION was created — the actual compaction moment.
     * Summary versions are immutable rows, so this is the honest "last
     * compacted" anchor; `updatedAt` (the node row's timestamp) can drift
     * later from unrelated node touches (embedding sync, repair passes).
     */
    createdAt: string;
    updatedAt: string;
    messagesCovered: number;
  } | null;
}

/**
 * Discriminated result for `estimateThreadUsage`. Lets callers map missing-id
 * cases to their own error layer (HTTP, websocket, etc.) without ContextWindow
 * needing to know about HTTP. `usage` is only present when `ok` is true.
 */
export type ThreadUsageResult =
  | { ok: true; usage: ThreadContextUsage }
  | { ok: false; reason: 'thread_not_found' | 'agent_not_found' };

/**
 * Compute the current context-window usage for an agent in a thread.
 *
 * Mirrors the runtime path runAgentTurn takes (same budget resolution + same
 * compression pass) so the value the UI shows here matches what will actually
 * be sent to the model on the next turn — not the raw thread size.
 */
export async function estimateThreadUsage(
  threadId: string,
  agentId: string,
  options?: {
    /**
     * Apply the latest thread summary even when the raw thread is still
     * under the auto-compression threshold. Used by the UI's post-compact
     * refresh so the user sees the bar drop after clicking Compact —
     * otherwise `compressMessages` would early-return with the raw
     * uncompressed token count and the bar wouldn't move.
     */
    applySummaryUnconditionally?: boolean;
  }
): Promise<ThreadUsageResult> {
  const thread = await Threads.findById(threadId);
  if (!thread) return { ok: false, reason: 'thread_not_found' };

  const agent = await agentService.get(agentId);
  if (!agent) return { ok: false, reason: 'agent_not_found' };

  const effective = await Threads.getEffectiveModel(threadId, agentId);
  const runtimeAgent = {
    ...agent,
    provider: effective?.providerId ?? agent.provider,
    modelId: effective?.modelId ?? agent.modelId,
  };

  const threadRuntimeConfig = await resolveThreadRuntimeConfig(threadId).catch((err) => {
    logger.warn('[context-usage] thread runtime config resolution failed', {
      threadId,
      err: getErrorMessage(err),
    });
    return null;
  });
  const threadAgentOverride = threadRuntimeConfig?.agentOverrides.get(agentId);

  const participants = await ThreadParticipants.listByThread(threadId);
  const participantAgentIds = participants
    .map((p) => p.agentId)
    .filter((id): id is string => Boolean(id));

  // Same advertised catalog the turn path builds — including the chat-only
  // gate, so a tool-less model doesn't get billed for schemas it never sees.
  const baseToolAccess: ToolAccessConfig = {
    mode: (agent.toolAccessMode as ToolAccessConfig['mode']) ?? 'all',
    allowList: Array.isArray(agent.toolAccessAllowList) ? agent.toolAccessAllowList : [],
    denyList: Array.isArray(agent.toolAccessDenyList) ? agent.toolAccessDenyList : [],
  };
  const modelRow =
    runtimeAgent.provider && runtimeAgent.modelId
      ? await Models.findByProviderAndModelId(runtimeAgent.provider, runtimeAgent.modelId)
      : null;
  const modelSupportsTools = modelRow?.supportsTools !== false;
  const baseSets = await resolveAdvertisedAgentToolSets(agentId, {
    // Base access, as the turn path advertises: a thread's tool
    // access gates calls, never the catalog.
    access: baseToolAccess,
    threadOverrides: threadAgentOverride?.toolOverrides,
    modelSupportsTools,
  });
  const { advertisedTools } = baseSets;
  // The thread's EXECUTION set, as contextAssembly computes it — it gates the
  // skill catalog (thread segment), so the estimate matches the real prompt.
  const effectiveToolAccess = threadAgentOverride?.toolAccess ?? baseToolAccess;
  const { executionTools } =
    effectiveToolAccess === baseToolAccess
      ? baseSets
      : await resolveAdvertisedAgentToolSets(agentId, {
          access: effectiveToolAccess,
          threadOverrides: threadAgentOverride?.toolOverrides,
          modelSupportsTools,
        });
  const toolRows = advertisedTools.map((at) => at.tool);

  // The system prompt that is actually sent — every block, flattened — not the
  // agent's persona field. `agentSoftThresholdNotified` / `agentDispatchCount`
  // are per-wave dispatch telemetry read only by the ephemeral turn-context
  // tail, which is not part of the system prompt; empty is the correct value
  // outside a live wave.
  const systemBlocks = await composeSystemPrompt({
    agent,
    runtimeAgent,
    threadAgentOverride,
    threadId,
    threadRuntimeConfig,
    isGroup: participantAgentIds.length > 1,
    dispatchMode: thread.dispatchMode ?? 'mentioned',
    // A DM / home thread gets its own prompt variant, as on the turn path.
    isDm: thread.kind === 'dm',
    isHelperThread: Boolean(thread.parentThreadId),
    agentTools: advertisedTools,
    participantAgentIds,
    replyAgentId: agentId,
    agentSoftThresholdNotified: new Set<string>(),
    agentDispatchCount: new Map<string, number>(),
    runKind: 'realtime_thread',
    runParams: await resolveRunParams({ threadId }),
    // Same skill catalog the turn path renders (contextAssembly), so the
    // estimate and the real prompt cannot drift.
    skillCatalog: executionTools.some((at) => at.tool.id === SKILL_TOOL_ID)
      ? await loadSkillCatalogEntries(agentId, threadId)
      : [],
  });
  const systemPrompt = flattenTextBlocks(systemBlocks);

  const budget = await resolveContextBudget(runtimeAgent, threadId, {
    systemPromptText: systemPrompt,
    toolRows,
  });

  // Replay, not a message-row scan: tool calls and tool results are never
  // stored as messages, and on an agent-heavy thread they are the bulk of the
  // payload. This is the same builder the turn path feeds the provider.
  const replay = await buildReplayPayload(threadId, agentId, budget);
  const providerMessages = replay.messages as ProviderMessage[];

  const rawMessageTokens = estimateSessionTokens(
    providerMessages,
    undefined,
    budget.provider,
    budget.modelId
  );

  // Apply the same compression runAgentTurn applies. Without this, the UI
  // shows raw thread size and reads ~100% on long threads even when the
  // compressed prompt is much smaller.
  // The turn path never puts the thread digest in context (a fold uses the persisted compaction
  // replay already applied, or a synthesized digest), so the estimate does not either. Only the
  // post-Compact estimate, which shows the drop a manual compact brings, reads it.
  let threadSummaryText: string | null = null;
  if (options?.applySummaryUnconditionally) {
    try {
      const summaryRow = await summaryService.getThreadSummary(threadId, agentId);
      // A fold is already the first message of the replay this estimate is built from.
      threadSummaryText = summaryRow?.compaction ? null : labelThreadSummary(summaryRow);
    } catch {
      threadSummaryText = null;
    }
  }
  const compressionResult = compressMessages(
    providerMessages,
    budget,
    systemPrompt,
    threadSummaryText,
    options?.applySummaryUnconditionally,
    undefined,
    true // quiet: read-only estimation mirror — don't log as a live compaction
  );
  const messageTokens = estimateSessionTokens(
    compressionResult.messages,
    undefined,
    budget.provider,
    budget.modelId
  );

  // The reported total is the sum of the reported parts, by construction.
  const overheadTokens = budget.systemPromptTokens + budget.toolCatalogTokens;
  const effectiveTokens = overheadTokens + messageTokens;
  const rawTokens = overheadTokens + rawMessageTokens;

  const maxContext = budget.contextWindowTokens;
  const percent = maxContext > 0 ? Math.min(100, (effectiveTokens / maxContext) * 100) : 0;
  // Against the MESSAGE budget — usableBudget already has the overhead removed,
  // so measuring the full total here would count system + tools twice.
  const percentOfUsable =
    budget.usableBudget > 0 ? Math.min(100, (messageTokens / budget.usableBudget) * 100) : 0;

  // Pull the current per-agent summary so the UI can show "Last compacted vN ·
  // Xm ago" and confirm a no-op compact landed (version stays put when there's
  // nothing new since the last summary).
  let latestSummary: ThreadContextUsage['latestSummary'] = null;
  try {
    const row = await ThreadSummaries.getByThreadAndAgent(threadId, agentId);
    if (row) {
      latestSummary = {
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messagesCovered: row.messagesCovered,
      };
    }
  } catch {
    /* leave latestSummary null on lookup failure — non-essential */
  }

  return {
    ok: true,
    usage: {
      threadId,
      agentId,
      provider: budget.provider,
      model: effective?.modelId ?? null,
      tokens: {
        estimated: effectiveTokens,
        raw: rawTokens,
        compressed: compressionResult.compressed,
        keptMessages: compressionResult.keptCount,
        messagesCounted: providerMessages.length,
        messageTokens,
        systemPromptChars: systemPrompt.length,
        systemPromptTokens: budget.systemPromptTokens,
        toolCatalogTokens: budget.toolCatalogTokens,
        toolCount: toolRows.length,
        threadSummaryUsed: threadSummaryText !== null,
      },
      budget: {
        contextWindowTokens: budget.contextWindowTokens,
        maxOutputTokens: budget.maxOutputTokens,
        usableBudget: budget.usableBudget,
        tokenThreshold: budget.tokenThreshold,
        overheadFloored: budget.overheadFloored,
      },
      percent,
      percentOfUsable,
      source: 'character-estimate',
      latestSummary,
    },
  };
}
