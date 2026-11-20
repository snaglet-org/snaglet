import { Threads } from '@snaglet/db/tables/threads';
import { Models } from '@snaglet/db/tables/models';
import type { ToolRow } from '@snaglet/db/tables/tools';
import {
  resolveAdvertisedAgentToolSets,
  selectAdvertisedAgentTools,
  SKILL_TOOL_ID,
  type ResolvedAgentTool,
} from '@server/services/AgentToolResolver';
import type { SnagletAgent } from '@server/services/AgentService';
import {
  findCurrentRunBoundary,
  resolveContextBudget,
  type ContextBudget,
} from '@server/services/ContextWindowService';
import type { Message } from '@server/services/SocketService/types';
import type { HistoryFoldState } from '@server/services/contextWindow/historyFold';
import { composeSystemPrompt } from '@server/services/SystemPromptComposer';
import { toolDiscoveryReminder } from '@server/services/SystemPromptComposer/blocks/toolDiscoveryBlock';
import { loadSkillCatalogEntries } from '@server/services/skills/skillCatalog';
import { expandPromptIncludes } from '@server/services/SystemPromptComposer/expandPromptIncludes';
import { resolveRunParams } from '@server/services/SystemPromptComposer/resolveRunParams';
import {
  composeTurnContextData,
  buildTurnContextMessage,
} from '@server/services/SystemPromptComposer/composeTurnContextTail';
import { buildAutomationWakeNote } from './buildAutomationWakeNote';
import { buildUnreadDmNote } from './buildUnreadDmNote';
import { buildPriorRunHint } from './buildPriorRunHint';
import { createMissingToolLookup, type MissingToolLookup } from './missingToolLookup';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';
import { agentService } from '@server/services/AgentService';
import { adoptConnectedModel } from '@server/services/agentDefaultModel';
import { settingsService } from '@server/services/settings';
import { budgetSettings } from '@server/services/settings/categories/budget';
import { logger } from '@server/config/logger';
import { toolSettings } from '@server/services/settings/categories/tool';
import { buildReplayPayload, type ReplayWatermark } from './replayLoader';
import { buildMemoryRecallSegment } from '@server/services/summary/memoryRecallSegment';
import { saveCompaction } from '@server/services/summary/compactionRecord';
import { flattenTextBlocks, toolAliasIdsFor } from '@snaglet/shared/utils';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { buildModelCandidates, type ModelCandidate } from '../modelCandidates';
import { makeCredentialResolver } from './makeCredentialResolver';
import { isThreadVoiceActive } from '@server/services/SocketService/voiceSession/voiceSessionRegistry';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';
import { noteContextAssemblyStarted } from '@server/services/subagents/resultVisibility';
import { resolveHelperToolPolicy } from '@server/services/subagents/helperInheritance';
import { orphanedHelperAccess } from '@server/services/ToolService/lib/agentToolPolicy';
import {
  visionThreadService,
  type VisionAccessSnapshot,
} from '@server/services/vision/VisionThreadService';
import { composeVisionAccessSegment } from '@server/services/vision/visionAccessContext';
import { measureAnthropicToolCatalog } from '@server/services/ToolService/ToolFormatService';

export type AgentTurnContextResult =
  | { status: 'agent_not_found'; agentId: string }
  | { status: 'agent_archived'; agent: SnagletAgent }
  | { status: 'no_model'; agent: SnagletAgent }
  | {
      status: 'ready';
      agent: SnagletAgent;
      agentTools: ResolvedAgentTool[];
      /** Runtime-routable tools. In allow-list mode this also contains hidden
       *  misses so an explicit action-gateway invocation can escalate to ask. */
      executionTools: ResolvedAgentTool[];
      /** Base-access catalog: the tools array + system prompt, identical across threads. */
      advertisedTools: ResolvedAgentTool[];
      /** Advertised tools this thread's tool access makes unreachable. */
      threadBlockedTools: ResolvedAgentTool[];
      /** Effective tool-access config (thread override ?? agent base) — drives call-time permission checks. */
      toolAccess: ToolAccessConfig;
      /** Resolves a call to a tool the run's map lacks (missingToolLookup); absent for a tool-less run. */
      lookupMissingTool?: MissingToolLookup;
      modelCandidates: ModelCandidate[];
      runtimeAgentTemplate: SnagletAgent;
      systemBlocks: Awaited<ReturnType<typeof composeSystemPrompt>>;
      /**
       * Leading portion of the per-turn ephemeral turn-context tail
       * (coordinates, project scope, soft-threshold note, plus the once-per-
       * turn auto-recalled memories block when anything cleared the relevance
       * floor). The remaining async segment (prior-run hint) is spliced in and
       * the message assembled in prepareModelAttemptContext. Not part of the
       * persisted record.
       */
      turnContextData: string;
      startedAt: number;
    };

export interface ModelAttemptContext {
  readonly toolRows: ToolRow[];
  readonly toolMap: Map<string, ResolvedAgentTool>;
  /** Advertised tools this thread's tool access blocks, by id/name/alias. */
  readonly threadBlockedToolMap: Map<string, ResolvedAgentTool>;
  readonly visibleToolIds: Set<string>;
  readonly budget: ContextBudget;
  readonly agentMessages: Message[];
  /**
   * The vision access snapshot built into this attempt's payload, or null when
   * no vision segment was included. Confirm it via
   * `visionThreadService.confirmAccessDelivered` once this attempt gets a
   * successful provider result — assembling it is not the model reading it, so
   * an attempt that never succeeds must leave the transition pending.
   */
  readonly visionAccessCandidate: VisionAccessSnapshot | null;
  /**
   * The replayed history's unit spans and the compaction replay applied. The history compactor
   * cuts only at these, so a fold never splits a run's tool exchange.
   */
  readonly historyFold: HistoryFoldState;
  readonly maxToolIterations: number;
  readonly shouldStreamThinking: boolean;
  /**
   * Roster + dispatch-mode snapshot carried into any compaction summary this
   * turn — so roster/mode narration (`thread_event` rows) that gets
   * folded away by compression doesn't lose its state. Empty when there are no
   * participants to name.
   */
  readonly compactionCarryForward: string;
  /**
   * Newest `(created_at, id)` keyset among the message rows this context was
   * assembled from — the voice catch-up watermark. Seeding the catch-up cursor
   * from this (instead of a second `getLastByThread` read after assembly) makes
   * the perceived context and the catch-up window provably contiguous. Null only
   * when the thread had zero messages, in which case the caller falls back to a
   * head read. Inert on text threads (catch-up never runs there).
   */
  readonly contextWatermark: ReplayWatermark | null;
  /**
   * Index into `agentMessages` where the current run's working state begins:
   * the triggering inbound message and everything after it (the ephemeral
   * turn-context tail, then every in-run message the turn loop appends —
   * tool exchanges, lint corrections, mid-run injections, voice catch-up).
   * Captured once here, right after payload assembly; the array is
   * append-only for the rest of the attempt, so the index stays valid across
   * tool iterations. compressMessages treats everything at/after it as
   * uncompressible — a run must never lose sight of its own exchanges.
   */
  readonly currentRunBoundary: number;
}

export async function assembleAgentTurnContext({
  deps,
  shared,
  replyAgentId,
}: {
  deps: RunAgentTurnDeps;
  shared: RunAgentTurnSharedState;
  replyAgentId: string;
}): Promise<AgentTurnContextResult> {
  let agent = await agentService.get(replyAgentId);
  if (!agent) return { status: 'agent_not_found', agentId: replyAgentId };
  if (agent.archived) return { status: 'agent_archived', agent };

  const startedAt = Date.now();
  // Before replay loads: subagent results written before this point are in
  // this turn's context (see subagents/resultVisibility).
  noteContextAssemblyStarted(deps.session.threadId, agent.id, startedAt);
  const effectiveModel = await Threads.getEffectiveModel(deps.session.threadId, agent.id);

  // There is no agent model chain (no agent_models table): model resolution
  // falls through to the agent's own provider/model fields.
  const agentModelChain: Array<{
    provider_id: string;
    model_id: string;
    credential_id: string | null;
    priority: number;
  }> = [];

  const threadAgentOverride = deps.threadRuntimeConfig?.agentOverrides.get(agent.id);
  const candidatesFor = (model: Pick<SnagletAgent, 'provider' | 'modelId' | 'credentialId'>) =>
    buildModelCandidates({
      threadOverrideModel: threadAgentOverride?.model,
      effectiveModel,
      agentModelChain,
      agentModel: {
        provider: model.provider,
        modelId: model.modelId,
        credentialId: model.credentialId,
      },
      resolveCredentialIdForModel: makeCredentialResolver({
        threadId: deps.session.threadId,
        agentId: replyAgentId,
      }),
    });
  let modelCandidates = await candidatesFor(agent);

  // An agent saved without any model (a starter agent) runs on what the user
  // connected: it adopts a provider and model once, then keeps them.
  if (modelCandidates.length === 0 && !agent.provider && !agent.modelId) {
    const adopted = await adoptConnectedModel(agent.id);
    if (adopted) {
      agent = { ...agent, ...adopted };
      modelCandidates = await candidatesFor(agent);
    }
  }

  if (modelCandidates.length === 0) return { status: 'no_model', agent };

  const runtimeAgent: SnagletAgent = {
    ...agent,
    provider: modelCandidates[0].provider_id,
    modelId: modelCandidates[0].model_id,
    credentialId: modelCandidates[0].credential_id,
  };

  // A subagent helper can do exactly what its orchestrator can do in the
  // parent thread, read live (narrowed by the helper's own `tools`), never
  // its own row or this hidden thread's overrides. One whose orchestrator
  // policy is gone has nothing to inherit (agentToolPolicy).
  const isHelper = Boolean(agent.parentAgentId);
  const helperPolicy = isHelper ? await resolveHelperToolPolicy(agent.id) : null;
  const baseToolAccess: ToolAccessConfig =
    helperPolicy?.access ??
    (isHelper
      ? orphanedHelperAccess()
      : {
          mode: (agent.toolAccessMode as ToolAccessConfig['mode']) ?? 'all',
          allowList: Array.isArray(agent.toolAccessAllowList) ? agent.toolAccessAllowList : [],
          denyList: Array.isArray(agent.toolAccessDenyList) ? agent.toolAccessDenyList : [],
        });
  const effectiveToolAccess = isHelper
    ? baseToolAccess
    : (threadAgentOverride?.toolAccess ?? baseToolAccess);
  const threadToolOverrides = isHelper
    ? helperPolicy?.threadToolOverrides
    : threadAgentOverride?.toolOverrides;
  // A helper's MCP servers come from its policy (the orchestrator's, in the
  // parent thread); the resolver ignores a delta for it.
  const mcpServerOverride = isHelper ? undefined : threadAgentOverride?.mcpServers;

  // Chat-only models: if the resolved model can't do native tool calling, run
  // the agent tool-less — drop tools from both the API request and the system
  // prompt, so the model is never handed (or told about) tools it can't call.
  // The user can still chat with it; it just can't act on the workspace or the
  // computer. Unknown models (not in the catalog) default to tool-capable, so
  // only models explicitly flagged unsupported (e.g. tinyllama) are gated.
  let modelSupportsTools = true;
  if (runtimeAgent.provider && runtimeAgent.modelId) {
    const modelRow = await Models.findByProviderAndModelId(
      runtimeAgent.provider,
      runtimeAgent.modelId
    );
    modelSupportsTools = modelRow?.supportsTools !== false;
  }
  // One advertised catalog per agent across every thread: the tools
  // array and every tool-gated system block come from the agent's base access,
  // so the cached prefix is shared between threads. A thread's tool-access
  // override narrows or widens only what is reachable at call time (the
  // effective sets below); an advertised tool the thread blocks is denied at
  // dispatch with a thread-specific error and named once in the uncached tail.
  // The turn is about to use these tools, so it (alone) warms MCP servers
  // whose tools aren't cached yet; listings never start one.
  const baseSets = await resolveAdvertisedAgentToolSets(agent.id, {
    access: baseToolAccess,
    threadOverrides: threadToolOverrides,
    mcpServerOverride,
    modelSupportsTools,
    warmMcpServers: true,
  });
  const effectiveSets =
    effectiveToolAccess === baseToolAccess
      ? baseSets
      : await resolveAdvertisedAgentToolSets(agent.id, {
          access: effectiveToolAccess,
          threadOverrides: threadToolOverrides,
          mcpServerOverride,
          modelSupportsTools,
          warmMcpServers: true,
        });
  const { allowedTools: agentTools, executionTools } = effectiveSets;
  const advertisedTools = baseSets.advertisedTools;
  const threadBlockedTools = threadBlockedAdvertisedTools(advertisedTools, executionTools);
  if (!modelSupportsTools) {
    logger.info('[chat-only] model does not support tools — running agent tool-less', {
      agentName: agent.name,
      provider: runtimeAgent.provider,
      model: runtimeAgent.modelId,
    });
  }

  const promptContext: SystemPromptContext = {
    agent,
    runtimeAgent,
    threadAgentOverride,
    threadId: deps.session.threadId,
    threadRuntimeConfig: deps.threadRuntimeConfig ?? null,
    isGroup: deps.isGroup,
    dispatchMode: deps.dispatchMode,
    isDm: deps.isDm === true,
    isHelperThread: deps.isHelperThread === true,
    agentTools: advertisedTools,
    participantAgentIds: deps.participantAgentIds,
    replyAgentId,
    mentionContext: deps.isGroup ? deps.buildMentionContext(replyAgentId) : undefined,
    agentSoftThresholdNotified: shared.agentSoftThresholdNotified,
    agentDispatchCount: shared.agentDispatchCount,
    runKind: 'realtime_thread',
    runParams: await resolveRunParams({ threadId: deps.session.threadId }),
    // Voice profile tail rides only while a voice session is active.
    voiceModeActive: isThreadVoiceActive(deps.session.threadId),
    // Thread segment of the system prompt (after the agent-level core).
    // Rendered only when `skill` is callable in this thread (execution set,
    // after the thread's tool access) — not merely advertised: a thread that
    // blocks `skill` must not list skills the model can't load. Thread segment
    // only, so the cached core/tools prefix is unaffected.
    skillCatalog: executionTools.some((at) => at.tool.id === SKILL_TOOL_ID)
      ? await loadSkillCatalogEntries(agent.id, deps.session.threadId)
      : [],
  };

  // composeSystemPrompt stamps ctx.embeddingsEnabled — call it before the tail
  // data (which reads that flag for the indexed-files hint).
  const systemBlocks = await composeSystemPrompt(promptContext);

  // Auto-recalled memories for this wake, built once per turn and folded into
  // turnContextData so it rides the
  // ephemeral tail — behind the durable cache breakpoint, never persisted,
  // never replayed. Gated on the agent actually having memory tools (the same
  // `memory_` prefix perceptionBlock gates its memory guidance on). Queried
  // with the turn's inbound context (latest thread message + title).
  // Best-effort: a recall failure logs inside the builder and injects nothing.
  const threadTitle = promptContext.runParams?.thread_title;
  const memoryRecallSegment = await buildMemoryRecallSegment({
    agentId: agent.id,
    agentName: agent.name ?? null,
    threadId: deps.session.threadId,
    threadTitle: typeof threadTitle === 'string' ? threadTitle : null,
    hasMemoryTools: agentTools.some(
      (at) => at.tool.id === 'memory' || at.tool.id.startsWith('memory_')
    ),
  });
  const turnContextData = [
    composeTurnContextData(promptContext),
    await buildAutomationWakeNote(deps.wakeOrigin, agent.id),
    await buildUnreadDmNote(agent.id, {
      dmEnabled: agent.dmEnabled !== false,
      currentThreadId: deps.session.threadId,
    }),
    composeThreadBlockedToolsLine(threadBlockedTools.map((at) => at.tool.id)),
    // The search-before-you-say-no rule again, after the whole history, where
    // an agent deep in a conversation still reads it (toolDiscoveryBlock).
    toolDiscoveryReminder(advertisedTools),
    memoryRecallSegment,
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');

  return {
    status: 'ready',
    agent,
    agentTools,
    executionTools,
    advertisedTools,
    threadBlockedTools,
    toolAccess: effectiveToolAccess,
    lookupMissingTool: modelSupportsTools
      ? createMissingToolLookup(agent.id, {
          access: effectiveToolAccess,
          accessFrom: effectiveToolAccess === baseToolAccess ? 'agent' : 'thread',
          threadOverrides: threadToolOverrides,
          mcpServerOverride,
        })
      : undefined,
    modelCandidates,
    runtimeAgentTemplate: {
      ...runtimeAgent,
      // Tool confirmation is evaluated against the runtime agent at dispatch.
      // A helper inherits the orchestrator's live trust, not its stale row.
      trustedToolCalls: isHelper
        ? helperPolicy?.orchestrator.trustedToolCalls === true
        : runtimeAgent.trustedToolCalls,
      systemPrompt: flattenTextBlocks(systemBlocks),
    },
    systemBlocks,
    turnContextData,
    startedAt,
  };
}

export async function prepareModelAttemptContext({
  deps,
  agent,
  runtimeAgent,
  agentTools,
  executionTools,
  advertisedTools,
  threadBlockedTools = [],
  toolAccess,
  turnContextData,
  currentRunId = null,
}: {
  deps: RunAgentTurnDeps;
  agent: SnagletAgent;
  runtimeAgent: SnagletAgent;
  agentTools: ResolvedAgentTool[];
  executionTools: ResolvedAgentTool[];
  /** The agent's base-access catalog (identical in every thread). Absent →
   *  selected from the effective sets, as before. */
  advertisedTools?: ResolvedAgentTool[];
  /** Advertised tools this thread's tool access makes unreachable. */
  threadBlockedTools?: ResolvedAgentTool[];
  toolAccess: ToolAccessConfig;
  /**
   * Leading portion of the ephemeral turn-context tail (coordinates/project
   * data + the once-per-turn recalled-memories block), from
   * assembleAgentTurnContext.
   */
  turnContextData: string;
  /**
   * The run this attempt belongs to. The turn loop creates its row before
   * calling here, so the prior-run hint must skip it to find the run before.
   */
  currentRunId?: string | null;
}): Promise<ModelAttemptContext> {
  // Advertise only core tools to the provider's `tools` field — the model calls
  // those directly. Everything else (standard, including integrations) is
  // reached on demand via `tool(op:search)` + `tool(op:schema)` + the `action`
  // gateway, keeping the request (and prompt-cache prefix) lean. `toolMap`
  // indexes runtime-routable tools; allow-list misses stay absent from the
  // advertised catalog but may be explicitly invoked and escalated to ask.
  const toolRows: ToolRow[] = (
    advertisedTools ??
    selectAdvertisedAgentTools({
      allowedTools: agentTools,
      executionTools,
      access: toolAccess,
      // Same strict-advertisement trim resolveAdvertisedAgentToolSets applies —
      // the wire catalog and the estimator must select identically.
      advertiseAllowedOnly: agent.toolAccessAdvertiseAllowedOnly === true,
    })
  ).map((at) => at.tool);
  if (process.env.SNAGLET_DEBUG_TOOL_CATALOG_METRICS === '1') {
    const metrics = measureAnthropicToolCatalog(toolRows);
    logger.info(
      `[tool-catalog-metrics] tools=${metrics.toolCount} ` +
        `serialized_bytes=${metrics.serializedBytes} ` +
        `estimated_tokens=${metrics.estimatedTokens}`
    );
  }
  const visibleToolIds = new Set(agentTools.map((at) => at.tool.id));
  const toolMap = new Map<string, ResolvedAgentTool>();
  // Exact catalog identities always win. Definition aliases and permanent
  // compatibility aliases are added only after every direct id/name exists.
  for (const at of executionTools) {
    toolMap.set(at.tool.id, at);
    toolMap.set(at.tool.name, at);
    toolMap.set(at.tool.name.toLowerCase(), at);
  }
  for (const at of executionTools) {
    for (const alias of at.tool.aliases ?? []) {
      if (!toolMap.has(alias)) toolMap.set(alias, at);
    }
    for (const alias of toolAliasIdsFor(at.tool.id)) {
      if (!toolMap.has(alias)) toolMap.set(alias, at);
    }
  }

  // Advertised-but-thread-blocked tools resolve here so dispatch can name the
  // thread as the reason. Kept out of toolMap: toolMap stays the reachable set
  // (vision availability and every other reachability read are unchanged).
  const threadBlockedToolMap = indexResolvedTools(threadBlockedTools);

  // The budget is fully model-derived, with no per-thread history override
  // (the tail sizes itself at compression time).
  // The overhead handed in is what this attempt will actually send:
  // `runtimeAgent.systemPrompt` is the flattened composed prompt (set on the
  // runtime template by assembleAgentTurnContext), and `toolRows` is the
  // advertised catalog selected a few lines above. Both come out of the window
  // before the message budget is computed.
  const resolvedBudget = await resolveContextBudget(runtimeAgent, deps.session.threadId, {
    systemPromptText: runtimeAgent.systemPrompt,
    toolRows,
  });
  // Cache TTL: model-metadata override → runtime default. Chat turns get the
  // extended 1h TTL (humans take breaks between messages).
  const budget: typeof resolvedBudget = {
    ...resolvedBudget,
    cacheTtl: resolvedBudget.cacheTtl ?? '1h',
  };

  // Turn replay (the committed perception model — no feature flag): rebuild each
  // agent's own turns with tool calls + reasoning (cache + memory), peers as text
  // only, in append-only order so message slots never shift and the cache prefix
  // stays byte-identical across turns.
  const replay = await buildReplayPayload(deps.session.threadId, agent.id, budget, (record) =>
    saveCompaction({ threadId: deps.session.threadId, agentId: agent.id, record }).then(
      () => undefined
    )
  );
  const perceivedMessages = replay.messages as Message[];
  const contextWatermark = replay.watermark;
  const agentMessages = await Promise.all(
    perceivedMessages.map(async (msg) =>
      msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('![')
        ? ({ ...msg, content: await expandPromptIncludes(msg.content) } as Message)
        : msg
    )
  );

  // Vision Mode grants access only — never capture, score, select, or inject
  // pixels during context assembly. The model decides semantically whether
  // this turn needs the one allowed on-demand frame.
  //
  // The delta is a read: it is idempotent, so the model-fallback path that
  // re-runs this function cannot duplicate or contradict a transition. Nothing
  // is acknowledged here — assembling a payload is not the model receiving it.
  // The candidate rides out on the attempt context and is confirmed only if
  // this attempt gets a successful provider result.
  //
  // Availability is resolved per agent from the routable tool map rather than
  // from tier or catalog defaults, so an agent that cannot reach a capture
  // tool is told capture is unavailable instead of being told to call it.
  const visionAccessDelta = visionThreadService.accessDeltaFor(deps.session.threadId, agent.id);
  const visionAccessSegment = composeVisionAccessSegment(visionAccessDelta, {
    screen: toolMap.has('capture_user_screen') ? 'capture_user_screen' : null,
    camera: toolMap.has('capture_user_camera') ? 'capture_user_camera' : null,
  });

  // Per-turn ephemeral turn-context tail. One user message,
  // appended fresh after all history, carrying the
  // volatile context that would otherwise bust the system-prompt cache:
  //   - coordinates + project scope + soft-threshold note (turnContextData)
  //   - the prior-run hint
  // Pane layout is not pushed here — agents pull it on demand via the
  // get_user_pane_layout tool (live client read), so the wake tail stays lean.
  // Never persisted, never replayed — it sits behind the message-tail cache
  // breakpoint, so its per-turn variance costs only the tail, not the prefix.
  const priorRunHint = await buildPriorRunHint({
    threadId: deps.session.threadId,
    replyAgentId: agent.id,
    currentRunId,
  });
  const who = `${agent.name ?? agent.id} @ thread ${deps.session.threadId}`;
  const turnContextMessage = buildTurnContextMessage([
    turnContextData,
    priorRunHint?.text ?? null,
    visionAccessSegment,
  ]);
  // Non-null only when a vision segment genuinely landed in this attempt's
  // payload. Carried out so the caller can confirm it against this attempt's
  // provider result rather than against whatever ran last.
  const visionAccessCandidate =
    turnContextMessage && visionAccessDelta && visionAccessSegment
      ? visionThreadService.accessCandidateFrom(visionAccessDelta)
      : null;
  if (turnContextMessage) {
    agentMessages.push(turnContextMessage as Message);
    logger.debug(
      `[turn-context] injected -> ${who}\n` +
        turnContextMessage.content
          .split('\n')
          .map((l) => `  | ${l}`)
          .join('\n')
    );
  }

  // Current-run boundary: where this run's working state starts in the
  // assembled payload — the trailing run of plain user turns (triggering
  // inbound message, narration, the ephemeral tail just pushed). Everything
  // the turn loop appends from here on lands after it, so one capture serves
  // every iteration of this attempt. compressMessages never folds anything
  // at/after this index, so a run never loses its own tool exchanges to the
  // summary mid-run on small budgets.
  const currentRunBoundary = findCurrentRunBoundary(agentMessages);

  const globalMaxToolIterations = await settingsService.read(toolSettings.maxIterations);
  const maxToolIterations = getAgentMaxToolIterations(agent) ?? globalMaxToolIterations;
  const groupBudgetForThinking = deps.isGroup
    ? await settingsService.read(budgetSettings.group)
    : null;

  // Roster + mode snapshot for compaction carry-forward. Built
  // synchronously from the dispatch's resolved participants — the source of
  // truth for who is in the turn — so no extra DB read on the hot path.
  const roster = deps.participantAgentIds.map((id) => deps.agentNameMap.get(id) ?? id).join(', ');
  const compactionCarryForward =
    deps.participantAgentIds.length > 0
      ? deps.isDm
        ? `[current roster: ${roster}]`
        : `[current roster: ${roster} · dispatch mode: ${deps.dispatchMode}]`
      : '';

  return {
    toolRows,
    toolMap,
    threadBlockedToolMap,
    visibleToolIds,
    budget,
    agentMessages,
    visionAccessCandidate,
    historyFold: { units: replay.units, compaction: replay.compaction },
    maxToolIterations,
    shouldStreamThinking: !deps.isGroup || (groupBudgetForThinking?.streamThinking ?? true),
    compactionCarryForward,
    contextWatermark,
    currentRunBoundary,
  };
}

function getAgentMaxToolIterations(agent: SnagletAgent): number | null {
  return typeof agent.maxToolCallsPerTurn === 'number' ? agent.maxToolCallsPerTurn : null;
}

/** Advertised tools the effective (thread) access makes unreachable. */
function threadBlockedAdvertisedTools(
  advertisedTools: ResolvedAgentTool[],
  executionTools: ResolvedAgentTool[]
): ResolvedAgentTool[] {
  const reachable = new Set(executionTools.map((at) => at.tool.id));
  return advertisedTools.filter((at) => !reachable.has(at.tool.id));
}

const THREAD_BLOCKED_LIST_CAP = 10;

/** One tail line naming advertised tools this thread blocks; null when none. */
export function composeThreadBlockedToolsLine(toolIds: string[]): string | null {
  if (toolIds.length === 0) return null;
  const shown = toolIds.slice(0, THREAD_BLOCKED_LIST_CAP).map((id) => `\`${id}\``);
  const more = toolIds.length - shown.length;
  return `Not allowed in this thread (thread tool access): ${shown.join(', ')}${
    more > 0 ? ` +${more} more` : ''
  }.`;
}

function indexResolvedTools(tools: ResolvedAgentTool[]): Map<string, ResolvedAgentTool> {
  const map = new Map<string, ResolvedAgentTool>();
  for (const at of tools) {
    map.set(at.tool.id, at);
    map.set(at.tool.name, at);
    map.set(at.tool.name.toLowerCase(), at);
  }
  for (const at of tools) {
    for (const alias of at.tool.aliases ?? []) if (!map.has(alias)) map.set(alias, at);
    for (const alias of toolAliasIdsFor(at.tool.id)) if (!map.has(alias)) map.set(alias, at);
  }
  return map;
}
