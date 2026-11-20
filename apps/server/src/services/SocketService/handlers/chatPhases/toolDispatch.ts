import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Messages } from '@snaglet/db/tables/messages';
import { resolveAgentCwd } from '@server/services/ToolService/lib/resolveAgentCwd';
import { confirmationForCall, type ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { SnagletAgent } from '@server/services/AgentService';
import {
  buildImageBlocksForIds,
  extractToolImages,
  postImageCaptureMessage,
} from './extractToolImages';
import type {
  ProviderChatResult,
  ToolResultBlock,
} from '@server/services/ProviderChatService/types';
import type {
  ClarificationRequest,
  ToolAccessConfig,
  UnattendedWake,
  WakeOrigin,
} from '@snaglet/shared/types';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { waitForConfirmation } from '@server/services/SocketService/confirmation';
import { waitForClarification } from '@server/services/SocketService/clarification';
import type { Message } from '@server/services/SocketService/types';
import { toolExecutor } from '@server/services/ToolService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import {
  evaluateToolPermission,
  formatRule,
  parseRule,
} from '@server/services/ToolService/lib/toolPermission';
import { wsService } from '@server/services/WebSocketService';
import { runWithActor } from '@server/realtime/actorContext';
import { currentUnattendedCap, runWithRunContext } from '@server/realtime/runContext';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { settingsService } from '@server/services/settings';
import { toolSettings } from '@server/services/settings/categories/tool';
import { LogsService } from '@server/services/LogsService';
import { logsContent } from '@server/services/logContent';
import {
  getErrorMessage,
  resolveToolId,
  toSnakeCase,
  transformToolAliasParams,
} from '@snaglet/shared/utils';
import { extractActionParams } from '@server/services/ToolService/lib/extractActionParams';
import { drainInjectablePeerMessages } from './peerInjection';
import type { RunAgentTurnDeps } from './types';
import type { RepeatCallGuard } from './repeatCallGuard';
import { classifyToolCall } from './toolCallTargeting';
import { condenseVerbatimText } from '@server/services/ToolService/toolResultFormat';
import type { ContextBudget } from '@server/services/contextWindow/budget';
import {
  INGEST_CHARS_PER_TOKEN,
  resultIngestCeilingChars,
} from '@server/services/contextWindow/adaptiveLimits';
import { estimateSessionTokens } from '@server/services/TokenEstimator';
import { isAllowListExemptTool } from '@server/services/ToolService/lib/alwaysAvailableTools';
import {
  blockedToolMessage,
  threadBlockedToolMessage,
  unknownToolMessage,
} from '@server/services/ToolService/lib/toolMissMessages';
import type { MissingToolLookup } from './missingToolLookup';
import { bareDenyEntryFor } from '@server/services/ToolService/lib/toolVisibility';
import {
  agentFacingToolError,
  agentFacingToolOutput,
  returnsOutsideContent,
} from '@server/services/ToolService/lib/untrustedContent';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { emitUnattendedToolCallEvent } from '@server/services/SocketService/threadEvents';
import {
  decideUnattendedCall,
  unattendedLineBody,
  unattendedSkipMessage,
  unattendedToolLabel,
} from './unattendedGate';

export interface DispatchToolCallsInput {
  readonly result: ProviderChatResult;
  readonly agent: SnagletAgent;
  readonly runtimeAgent: SnagletAgent;
  readonly agentMessages: Message[];
  readonly toolMap: Map<string, ResolvedAgentTool>;
  /** Advertised tools this thread's tool access blocks. A call to
   *  one is denied with a thread-specific reason and never executes. */
  readonly threadBlockedToolMap?: Map<string, ResolvedAgentTool>;
  /** Tool ids this agent is allowed to call, whether advertised or reached
   *  through the `action` gateway. Runtime-only allow-list misses are absent
   *  here and therefore require a human confirmation. */
  readonly visibleToolIds: Set<string>;
  /**
   * Called when a call names a tool `toolMap` lacks (the map is built at run
   * start). It finds a tool that became reachable since (a custom tool the
   * agent just created), which is then added to `toolMap` and run with the
   * usual checks, or one the agent's access blocks, which is refused with
   * that reason. Optional: without it every miss gets the search
   * instruction.
   */
  readonly lookupMissingTool?: MissingToolLookup;
  /** Effective tool-access config — drives the call-time permission guard. */
  readonly toolAccess: ToolAccessConfig;
  readonly session: RunAgentTurnDeps['session'];
  readonly sessionId: string;
  readonly threadName: string;
  readonly runId: string | null;
  readonly triggerMessageId: string | undefined;
  readonly latestThinking: string;
  readonly toToolText: (value: unknown) => string;
  readonly dispatchMode: RunAgentTurnDeps['dispatchMode'];
  /**
   * Per-run guard against byte-identical repeat tool calls. Created once per
   * model attempt in turnLoop and shared across this run's iterations. Optional
   * so non-loop callers/tests can omit it.
   */
  readonly repeatGuard?: RepeatCallGuard;
  /**
   * The run's AbortSignal: threaded into every tool execution so
   * socket:chat:abort cuts in-flight calls short, not just the space between
   * iterations. Optional so non-loop callers/tests can omit it.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Set when an automation started this run. The marker reaches the
   * tool context. Without `unattended`, it alone makes the run unattended
   * with the `skip` policy.
   */
  readonly wakeOrigin?: WakeOrigin;
  /**
   * Set when an automation or a hook started this run: nobody is there to
   * answer a confirmation, so a call that would ask never waits. It is skipped
   * with a tool error, or (policy `auto-approve-allowed`, and only when the
   * agent's access rules allow the call) runs without the prompt. See
   * unattendedGate.ts.
   */
  readonly unattended?: UnattendedWake;
  /**
   * The window this run sends into. With it, the per-result ingest ceiling is the larger of the
   * `max_result_chars` setting and a share of the room still free below the fold, so a big
   * result arrives whole while the context is empty. Omitted: the setting alone applies.
   */
  readonly contextBudget?: Pick<
    ContextBudget,
    'tokenThreshold' | 'systemPromptTokens' | 'provider' | 'modelId'
  >;
}

export interface DispatchToolCallsResult {
  readonly latestThinking: string;
}

/** Hand the permission engine one canonical tool id for deny entries that name
 * the tool by its id or display name in any case, or by any of the
 * definition's `aliases`. Allow entries are left to the engine, which reads a
 * display name the way every access path does (ruleNamesTool: exactly) and
 * resolves old ids itself, with their pins; rewriting an alias such as
 * table_read or get_doc to the canonical id would allow the whole tool. */
function canonicalizeDenyRules(
  access: ToolAccessConfig,
  agentTool: ResolvedAgentTool
): ToolAccessConfig {
  // Every identifier maps to the whole tool, so no deny ever narrows. (An old
  // id in `aliases`, e.g. delete_doc, still denies the whole tool here.)
  const denyIdentifiers = new Set(
    [agentTool.tool.id, agentTool.tool.name, ...(agentTool.tool.aliases ?? [])].map((value) =>
      value.toLowerCase()
    )
  );
  return {
    ...access,
    denyList: access.denyList.map((entry) => {
      const rule = parseRule(entry);
      return denyIdentifiers.has(rule.toolId.toLowerCase())
        ? formatRule({ ...rule, toolId: agentTool.tool.id })
        : entry;
    }),
  };
}

/**
 * The run's unattended marker. A caller that passes only the automation wake
 * marker (`wakeOrigin`) gets the safe default, `skip`.
 */
function unattendedFor(input: DispatchToolCallsInput): UnattendedWake | undefined {
  if (input.unattended) {
    // A capped message handed to this run mid-way (raiseAmbientChain) caps
    // the rest of it.
    return currentUnattendedCap() && input.unattended.policy !== 'skip'
      ? { ...input.unattended, policy: 'skip' }
      : input.unattended;
  }
  if (input.wakeOrigin?.kind !== 'automation') return undefined;
  const id = input.wakeOrigin.automationId;
  return { source: 'automation', id, name: id, policy: 'skip', since: new Date().toISOString() };
}

function throwIfToolDispatchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('run aborted during tool dispatch', 'AbortError');
  }
}

/**
 * End a call whose run was stopped while it waited for (or right after) its
 * confirmation: the call never ran. Records it the way ToolExecutor's abort
 * result is recorded — a failed result frame (so the run's live activity step
 * stops spinning) and an activity-log row (so a reload and the next turn's
 * replay see it ended) — without a tool_result for the model, whose run ends.
 */
function recordCallStoppedAtConfirmation(args: {
  input: DispatchToolCallsInput;
  callId: string;
  logName: string;
  executionName: string;
  executionInput: Record<string, unknown>;
}): void {
  const { input, callId, logName, executionName, executionInput } = args;
  const error = `Tool '${executionName}' was canceled — the run was stopped before it was confirmed.`;
  AgentActivityLog.logActivity({
    agentId: input.agent.id,
    runId: input.runId ?? undefined,
    actionType: 'tool_call',
    triggerType: 'chat_nudge',
    reason: `Tool call: ${logName}`,
    tool: logName,
    toolInput: executionInput,
    toolOutput: { error },
    durationMs: 0,
  }).catch((err) => LogsService.warn('Failed to log tool activity', { error: err }));
  wsService.broadcastToChannel(input.session.threadId, {
    type: 'socket:tool:result',
    payload: {
      sessionId: input.sessionId,
      callId,
      agentId: input.agent.id,
      runId: input.runId,
      success: false,
      output: '',
      error,
      durationMs: 0,
    },
  });
}

/** A replayed gateway call's tool name (see toolDispatch's logName). */
const REPLAYED_GATEWAY_PREFIX = 'action__';

/**
 * A past `action` call replays as a tool_use named `action__<id>` with the
 * target's params as input. A model that copies that name natively means the
 * target tool, so the call goes to `<id>` with its input as params.
 */
function replayedGatewayTarget(name: string): string {
  return name.startsWith(REPLAYED_GATEWAY_PREFIX) && name.length > REPLAYED_GATEWAY_PREFIX.length
    ? name.slice(REPLAYED_GATEWAY_PREFIX.length)
    : name;
}

function lookupToolMap(
  map: ReadonlyMap<string, ResolvedAgentTool> | undefined,
  name: string
): ResolvedAgentTool | undefined {
  return map?.get(name) ?? map?.get(name.toLowerCase()) ?? map?.get(toSnakeCase(name));
}

function rememberTool(map: Map<string, ResolvedAgentTool>, agentTool: ResolvedAgentTool): void {
  for (const key of [agentTool.tool.id, agentTool.tool.name, agentTool.tool.name.toLowerCase()]) {
    if (!map.has(key)) map.set(key, agentTool);
  }
}

type ToolMiss =
  | { kind: 'reachable'; tool: ResolvedAgentTool }
  | { kind: 'refused'; message: string };

/**
 * A call names a tool the run's map lacks. In order: the thread's tool access
 * blocks it; the id was retired (its message names the replacement); the
 * lookup finds it reachable now (remembered for the rest of the run) or
 * blocked by the agent's access; otherwise it is unknown and the model is
 * told to search. Never a bare "unavailable": that read as "you lost access".
 */
async function resolveToolMiss(
  input: DispatchToolCallsInput,
  requestedName: string
): Promise<ToolMiss> {
  const threadBlocked = lookupToolMap(input.threadBlockedToolMap, requestedName);
  if (threadBlocked) {
    return { kind: 'refused', message: threadBlockedToolMessage(threadBlocked.tool.id) };
  }
  const removed = resolveToolId(toSnakeCase(requestedName)).removed;
  if (removed) return { kind: 'refused', message: removed };
  const found = input.lookupMissingTool ? await input.lookupMissingTool(requestedName) : null;
  if (found?.kind === 'reachable') {
    rememberTool(input.toolMap, found.tool);
    return found;
  }
  if (found?.kind === 'blocked') {
    return {
      kind: 'refused',
      message:
        found.by === 'thread'
          ? threadBlockedToolMessage(found.tool.id)
          : blockedToolMessage(found.tool.id, input.agent.name),
    };
  }
  return {
    kind: 'refused',
    message: unknownToolMessage(requestedName, { canCreate: input.toolMap.has('custom_tool') }),
  };
}

export async function dispatchToolCalls(
  input: DispatchToolCallsInput
): Promise<DispatchToolCallsResult> {
  const toolResults: ToolResultBlock[] = [];
  let latestThinking = input.latestThinking;

  // Resolve agent working directory once per dispatch batch
  const agentCwd = await resolveAgentCwd(input.session.threadId);

  // Tokens in the window now, estimated once per batch and grown by each result this batch
  // lets in (they are pushed to agentMessages only after the loop). Sizes the ingest ceiling.
  const ingestFloorChars = await settingsService.read(toolSettings.maxResultChars);
  let usedTokens = input.contextBudget
    ? input.contextBudget.systemPromptTokens +
      estimateSessionTokens(
        input.agentMessages as never,
        undefined,
        input.contextBudget.provider,
        input.contextBudget.modelId
      )
    : 0;

  for (const tc of input.result.toolCalls ?? []) {
    throwIfToolDispatchAborted(input.abortSignal);

    const requestedSubTool =
      tc.name === 'action'
        ? String(
            (tc.input as Record<string, unknown>).tool ??
              (tc.input as Record<string, unknown>).tool_name ??
              ''
          )
        : tc.name;

    // No tool-blocking pull step: mid-run messages reach a running agent via
    // live injection (below) and otherwise in its next-turn history.

    const isActionGateway = tc.name === 'action';
    const requestedName = isActionGateway ? requestedSubTool : replayedGatewayTarget(tc.name);
    const normalizedName = toSnakeCase(requestedName);
    let agentTool = lookupToolMap(input.toolMap, requestedName);

    if (!agentTool) {
      const miss = await resolveToolMiss(input, requestedName);
      if (miss.kind === 'reachable') {
        agentTool = miss.tool;
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: miss.message,
          is_error: true,
        });
        continue;
      }
    }
    if (isActionGateway && agentTool.tool.id === 'action') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: 'action cannot dispatch itself.',
        is_error: true,
      });
      continue;
    }

    const executionName = agentTool.tool.id;
    let executionInput = isActionGateway
      ? extractActionParams(tc.input as Record<string, unknown>)
      : (tc.input as Record<string, unknown>);
    const aliasResolution = resolveToolId(normalizedName);
    if (
      aliasResolution.aliasedFrom &&
      aliasResolution.id === executionName &&
      normalizedName !== executionName
    ) {
      executionInput = transformToolAliasParams(aliasResolution, executionInput);
    }
    const executorCallName =
      aliasResolution.aliasedFrom && aliasResolution.id === executionName
        ? requestedName
        : executionName;

    // In-run repeat guard: on a 3rd+ byte-identical call, short-circuit and
    // return the earlier result verbatim instead of re-executing. (1st runs
    // clean; 2nd runs but gets an advisory appended below.) Still surfaces the
    // call + result to the UI so the suppression is visible, and always pushes
    // a tool_result so the tool_use stays paired.
    //
    // Write-invalidation first: a mutation may have changed a target an earlier
    // read cached, so clear the affected cached reads before evaluating. This
    // makes a legitimate re-read after a write execute fresh (never suppressed
    // with stale data). Mutations themselves are never tracked/suppressed.
    const classification = classifyToolCall(executionName, executionInput);
    if (classification.mutation) input.repeatGuard?.invalidate(classification.mutation);
    const repeatDecision = input.repeatGuard?.evaluate(
      executionName,
      executionInput,
      classification
    );
    if (repeatDecision?.kind === 'suppress') {
      wsService.broadcastToChannel(input.session.threadId, {
        type: 'socket:tool:call',
        payload: {
          sessionId: input.sessionId,
          callId: tc.id,
          agentId: input.agent.id,
          runId: input.runId,
          toolName: executionName,
          toolInput: executionInput,
          requiresConfirmation: false,
        },
      });
      const cached = repeatDecision.cachedResult ?? '';
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: cached });
      wsService.broadcastToChannel(input.session.threadId, {
        type: 'socket:tool:result',
        payload: {
          sessionId: input.sessionId,
          callId: tc.id,
          agentId: input.agent.id,
          runId: input.runId,
          success: true,
          output: cached,
          error: undefined,
          durationMs: 0,
        },
      });
      LogsService.warn('[tool:repeat] suppressed byte-identical repeat call', {
        agentName: input.agent.name,
        toolName: executionName,
      });
      continue;
    }

    // Call-time permission guard for the dangerous "computer" tools. No-op for
    // mode:all agents and non-guarded tools, except a bare deny naming the tool,
    // which holds in every mode (bareDenyEntryFor; the headless gate on
    // /api/tools/execute reads it the same way). `deny` blocks now; `ask` forces
    // the human confirmation flow below (an interactive thread can always prompt).
    const permissionAccess = canonicalizeDenyRules(input.toolAccess, agentTool);
    const bareDeny = bareDenyEntryFor(input.toolAccess.denyList, agentTool.tool) !== undefined;
    const permission = bareDeny
      ? {
          decision: 'deny' as const,
          reason: `Blocked by tool-access policy: tool matches deny rule.`,
        }
      : evaluateToolPermission(permissionAccess, executionName, executionInput, {
          cwd: agentCwd,
          activeToolIds: new Set(toolRegistry.getToolIds()),
          toolAliases: agentTool.tool.aliases,
          toolName: agentTool.tool.name,
        });
    const allowListEscalation =
      input.toolAccess.mode === 'allow_list' &&
      !isAllowListExemptTool(executionName) &&
      (!input.visibleToolIds.has(executionName) || permission.decision === 'ask');
    // A trusted helper inherits its orchestrator's approval bypass, but its
    // explicit `tools` narrowing remains a hard capability boundary. Never
    // turn an out-of-scope helper call into an approval prompt or an execution.
    const trustedHelperOutsideNarrowing =
      input.agent.parentAgentId !== null &&
      input.runtimeAgent.trustedToolCalls === true &&
      allowListEscalation;
    if (permission.decision === 'deny' || trustedHelperOutsideNarrowing) {
      const reason = trustedHelperOutsideNarrowing
        ? 'Blocked by tool-access policy: this tool is outside the subagent tools narrowing.'
        : (permission.reason ?? 'Blocked by tool-access policy.');
      // Mirror the user-denial path: surface the call to the UI, then its failure.
      wsService.broadcastToChannel(input.session.threadId, {
        type: 'socket:tool:call',
        payload: {
          sessionId: input.sessionId,
          callId: tc.id,
          agentId: input.agent.id,
          runId: input.runId,
          toolName: executionName,
          toolInput: executionInput,
          requiresConfirmation: false,
        },
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: reason,
        is_error: true,
      });
      wsService.broadcastToChannel(input.session.threadId, {
        type: 'socket:tool:result',
        payload: {
          sessionId: input.sessionId,
          callId: tc.id,
          agentId: input.agent.id,
          runId: input.runId,
          success: false,
          output: '',
          error: 'Blocked by tool-access policy',
          durationMs: 0,
        },
      });
      LogsService.warn('[tool:policy] denied tool call', {
        agentName: input.agent.name,
        toolName: executionName,
        rule: permission.rule,
      });
      continue;
    }
    const trustedHelper =
      input.runtimeAgent.trustedToolCalls === true && input.agent.parentAgentId !== null;
    // A call asks for one of two reasons: the tool's own "ask first" flag, or
    // the access rules (an `ask` verdict, an allow-list escalation). An
    // unattended run treats them differently (unattendedGate.ts).
    const toolAsksFirst = confirmationForCall(agentTool, executionInput);
    const accessAsks = !trustedHelper && (permission.decision === 'ask' || allowListEscalation);
    let needsConfirmation = toolAsksFirst || accessAsks;

    // Pattern-legal separator: this name persists to agent_activity_log.tool and
    // is replayed into provider tool_use blocks — U+2192 here breaks every
    // OpenAI-compatible request (see toolName.ts). Wire sanitizer covers history.
    const logName = isActionGateway ? `action__${executionName}` : executionName;

    // A run an automation or a hook started has nobody to answer a prompt, so
    // a call that would ask never waits: it is skipped with a tool error the
    // agent can route around, or, under `auto-approve-allowed` and only when
    // the access rules allow it, it runs without the prompt. Either way the
    // run goes on, and the thread gets an `[unattended] …` line.
    const unattended = unattendedFor(input);
    if (needsConfirmation && unattended) {
      // Someone else (a person, or another agent: a peer that @mentioned
      // this one or was injected mid-run) posted here since the run started:
      // their words must not ride on the automation's or hook's approval.
      // Checked only when the call could otherwise be approved; a lookup
      // failure counts as someone.
      const personPresent =
        unattended.policy === 'auto-approve-allowed' && !accessAsks
          ? await Messages.hasMessageFromOthersSince(
              input.session.threadId,
              unattended.since,
              input.agent.id,
              GHOST_AGENT_ID
            ).catch(() => true)
          : false;
      const decision = decideUnattendedCall({ unattended, accessAsks, personPresent });
      const toolLabel = unattendedToolLabel(executionName, executionInput);
      const lineBody = unattendedLineBody({
        decision,
        toolLabel,
        agentName: input.agent.name,
        unattended,
      });
      if (decision.action === 'skip') {
        const accessReason =
          permission.decision === 'ask'
            ? permission.reason
            : allowListEscalation
              ? `'${executionName}' is not on your tool allow list`
              : undefined;
        const message = unattendedSkipMessage(toolLabel, decision.cause, accessReason);
        wsService.broadcastToChannel(input.session.threadId, {
          type: 'socket:tool:call',
          payload: {
            sessionId: input.sessionId,
            callId: tc.id,
            agentId: input.agent.id,
            runId: input.runId,
            toolName: executionName,
            toolInput: executionInput,
            requiresConfirmation: false,
          },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: message,
          is_error: true,
        });
        wsService.broadcastToChannel(input.session.threadId, {
          type: 'socket:tool:result',
          payload: {
            sessionId: input.sessionId,
            callId: tc.id,
            agentId: input.agent.id,
            runId: input.runId,
            success: false,
            output: '',
            error: message,
            durationMs: 0,
          },
        });
        // The run log keeps the skipped call, like a call that ran.
        AgentActivityLog.logActivity({
          agentId: input.agent.id,
          runId: input.runId ?? undefined,
          actionType: 'tool_call',
          triggerType: 'chat_nudge',
          reason: `Tool call: ${logName}`,
          tool: logName,
          toolInput: executionInput,
          toolOutput: { error: message },
          durationMs: 0,
        }).catch((err) => LogsService.warn('Failed to log tool activity', { error: err }));
        LogsService.warn('[unattended] skipped a call that needs a person', {
          agentName: input.agent.name,
          toolName: executionName,
          source: unattended.source,
          sourceId: unattended.id,
          policy: unattended.policy,
          cause: decision.cause,
        });
        await emitUnattendedToolCallEvent(input.session.threadId, lineBody);
        continue;
      }
      LogsService.info('[unattended] auto-approved a call its tool access allows', {
        agentName: input.agent.name,
        toolName: executionName,
        source: unattended.source,
        sourceId: unattended.id,
      });
      await emitUnattendedToolCallEvent(input.session.threadId, lineBody);
      needsConfirmation = false;
    }

    const inputPreview = logsContent() ? JSON.stringify(tc.input).slice(0, 120) : undefined;
    LogsService.tool.start({
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName: input.threadName,
      threadId: input.session.threadId,
      toolName: logName,
      input: inputPreview,
    });
    const callId = tc.id;
    wsService.broadcastToChannel(input.session.threadId, {
      type: 'socket:tool:call',
      payload: {
        sessionId: input.sessionId,
        callId,
        agentId: input.agent.id,
        runId: input.runId,
        toolName: executionName,
        toolInput: executionInput,
        requiresConfirmation: needsConfirmation,
      },
    });

    if (needsConfirmation) {
      const confirmation = await waitForConfirmation({
        threadId: input.session.threadId,
        sessionId: input.sessionId,
        callId,
        agentId: input.agent.id,
        runId: input.runId,
        toolName: executionName,
        // shell(op:write): show the full joined line(s) the write submits
        // (the session's unfinished line + chars), not just the new chars.
        toolInput:
          'submittedLines' in permission && permission.submittedLines
            ? { ...executionInput, submits: permission.submittedLines }
            : executionInput,
        mode: allowListEscalation ? 'allow_list' : 'approval',
        allowListSnapshot: input.toolAccess.allowList,
        denyListSnapshot: input.toolAccess.denyList,
        abortSignal: input.abortSignal,
      });
      // An abort settles the parked confirmation as unapproved so its promise
      // cannot strand the run. It is not a user denial: the call ends as
      // canceled (its result frame and activity row, the way an in-flight
      // tool's abort is recorded), and no later tool call from this provider
      // batch may start after Stop, so the batch ends here.
      if (input.abortSignal?.aborted) {
        recordCallStoppedAtConfirmation({
          input,
          callId,
          logName,
          executionName,
          executionInput,
        });
        throwIfToolDispatchAborted(input.abortSignal);
      }
      if (!confirmation.approved) {
        const reason = confirmation.timedOut
          ? 'Tool confirmation timed out — action was not performed.'
          : 'Tool call was denied by the user';
        const errorLabel = confirmation.timedOut ? 'Confirmation timed out' : 'Denied by user';

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: reason,
          is_error: true,
        });

        wsService.broadcastToChannel(input.session.threadId, {
          type: 'socket:tool:result',
          payload: {
            sessionId: input.sessionId,
            callId,
            agentId: input.agent.id,
            runId: input.runId,
            success: false,
            output: '',
            error: errorLabel,
            durationMs: 0,
          },
        });
        continue;
      }
      if (confirmation.policyUpdated) {
        // The DB write affects future turns. Mirror the grant into this turn's
        // resolved snapshot so a second call in the same tool loop does not
        // immediately ask the identical question again.
        input.visibleToolIds.add(executionName);
        if (!input.toolAccess.allowList.includes(executionName)) {
          input.toolAccess.allowList.push(executionName);
        }
      }
    }

    const apiKey = input.runtimeAgent.credentialId
      ? await providerCredentialService
          .getSecretById(input.runtimeAgent.credentialId)
          .catch(() => null)
      : null;
    // Credential lookup is the final await before execution. Re-check here so
    // ToolExecutor never receives an already-aborted mutation to dispatch.
    throwIfToolDispatchAborted(input.abortSignal);
    const execResult = await runWithActor(
      {
        actorId: input.agent.id,
        actorKind: 'agent',
        actorName: input.agent.name,
      },
      () =>
        // Bind run provenance so anything this tool sets off (dispatch, hook
        // events, subagents) can attribute the work to its originating thread/run.
        runWithRunContext({ threadId: input.session.threadId, runId: input.runId }, () =>
          toolExecutor.execute({ name: executorCallName, input: executionInput }, agentTool, {
            agentId: input.agent.id,
            threadId: input.session.threadId,
            triggerMessageId: input.triggerMessageId,
            cwd: agentCwd,
            signal: input.abortSignal,
            ...(input.wakeOrigin ? { wakeOrigin: input.wakeOrigin } : {}),
            // An unattended run has nobody to answer: `ask` gets no channel
            // and fails at once with a tool error instead of waiting. Otherwise
            // the in-process ask builtin blocks the run on an interactive Q/A
            // in the thread, keyed by this tool call's id; the turn's abort
            // signal (Stop, timeout, halt) cancels the question.
            ...(unattended
              ? { unattended }
              : {
                  requestClarification: (request: ClarificationRequest) =>
                    waitForClarification(
                      input.session.threadId,
                      callId,
                      input.agent.id,
                      input.runId ?? undefined,
                      request,
                      undefined,
                      undefined,
                      input.abortSignal
                    ),
                }),
            runtime: {
              provider: input.runtimeAgent.provider,
              modelId: input.runtimeAgent.modelId ?? 'unknown',
              credentialId: input.runtimeAgent.credentialId ?? null,
              agentName: input.agent.name,
              modelName: input.runtimeAgent.modelId,
              apiKey,
            },
          })
        )
    );
    // Reaper feed: a completed tool call (success or failure) is run
    // progress — the zombie reaper only fires on runs with no tool results
    // and no iterations for the stall window.
    activeRunTracker.noteProgress(input.sessionId);
    // Feeds the tool-call count in this turn's run-ended narration. Counted at
    // the same seam as reaper progress so success and failure both count — the
    // line reports work attempted, which is what a peer needs to judge effort.
    activeRunTracker.noteToolCall(input.runId);
    // The agent-facing seam: every tool result (success or error) enters the
    // model's context here, so this is where it is neutralized (a forged
    // `<system-reminder>` tag in a doc, memory, row, file or page stays inert)
    // and, for tools that reach outside Snaglet, labeled. Done before any
    // truncation below. Handlers return raw output, so hooks and the HTTP
    // execute route get it unchanged. Neutralizing an already-escaped string
    // is a no-op, so handlers that neutralize their own text are not mangled.
    const outsideContent = returnsOutsideContent(agentTool.tool);
    const toolOutputText = agentFacingToolOutput(
      input.toToolText(execResult.output),
      outsideContent
    );
    const toolErrorText = agentFacingToolError(
      input.toToolText(execResult.error ?? 'Unknown error'),
      outsideContent
    );

    // Tier 1 — ingest ceiling. A tool output larger than the cap is head+tail
    // trimmed (with a marker) before it enters history.
    //
    // Note for MCP tools: a raw MCP image result's output is the stringified
    // content (see formatMcpSuccess), so `resultContent` may carry a mangled
    // base64 fragment. That is only an intermediate value: image-bearing
    // results use the scrubbed `captured.cleanedOutput` for the model and the
    // activity log, and the repeat-guard caches `capturedCleanOutput` when set.
    const MAX_TOOL_RESULT_CHARS = input.contextBudget
      ? resultIngestCeilingChars({
          floorChars: ingestFloorChars,
          tokenThreshold: input.contextBudget.tokenThreshold,
          usedTokens,
        })
      : ingestFloorChars;
    let resultContent = execResult.success ? toolOutputText : toolErrorText;
    if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
      resultContent = condenseVerbatimText(resultContent, { budget: MAX_TOOL_RESULT_CHARS });
    }
    // Snapshot before the advisory decoration below — this is what the
    // repeat-guard cache should hold (never the "note: identical call #2…"
    // suffix), used once `capturedCleanOutput` is known post-image-branches.
    const recordableResultContent = resultContent;
    usedTokens += Math.ceil(resultContent.length / INGEST_CHARS_PER_TOKEN);

    // Log bound — independent of the model-context ceiling above. This caps
    // what lands in agent_activity_log.tool_output (storage/run_history), not
    // what the model sees this turn. Deliberately larger than
    // MAX_TOOL_RESULT_CHARS; raw tool outputs can run to several MB.
    const MAX_ACTIVITY_LOG_CHARS = await settingsService.read(
      toolSettings.activityLogMaxOutputChars
    );

    if (repeatDecision?.kind === 'advise' && repeatDecision.advisory) {
      resultContent = `${resultContent}\n\n${repeatDecision.advisory}`;
    }

    // Three image paths attach pixels to the tool_result:
    //   - ephemeralInlineImages: current-turn-only pixels (Vision Mode), never
    //     persisted or posted into chat history.
    //   - inlineImageIds: existing workspace images the tool asked to attach
    //     (e.g. view_image); these also post the shared chat render.
    //   - else branch: capture new images the tool returned (e.g. raw MCP image
    //     blocks), persist them as nodes, post them, and inline them.
    // Adapters that cannot carry images in a tool result re-emit them as the
    // next user message (splitToolResultContent). `capturedCleanOutput` is the
    // base64-stripped output, kept out of the activity log + socket echo.
    let capturedCleanOutput: string | null = null;

    const ephemeralInlineImages = extractEphemeralInlineImages(execResult);
    const inlineImageIds = extractInlineImageIds(execResult);
    if (execResult.success && ephemeralInlineImages.length > 0) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: [
          { type: 'text', text: resultContent },
          ...ephemeralInlineImages.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType,
              data: image.data,
            },
          })),
        ],
        is_error: false,
      });
    } else if (execResult.success && inlineImageIds.length > 0) {
      await postImageCaptureMessage({
        threadId: input.session.threadId,
        agentId: input.agent.id,
        runId: input.runId,
        toolName: executionName,
        imageIds: inlineImageIds,
      });
      const imageBlocks = await buildImageBlocksForIds(inlineImageIds);
      if (imageBlocks.length > 0) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: [{ type: 'text', text: resultContent }, ...imageBlocks],
          is_error: false,
        });
      } else {
        // No bytes could be loaded — fall back to text-only so the call
        // still resolves cleanly.
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: resultContent,
          is_error: false,
        });
      }
    } else {
      // Capture any images the tool returned (e.g. screenshots): persist them
      // as nodes (visible in chat + tree) and get a base64-stripped copy of the
      // output. When present, attach the image once as a real image block
      // inside this tool_result — no truncated base64 text, no second turn.
      const captured = await extractAndPublishToolImages({
        execResult,
        toolName: executionName,
        callId,
        input,
      });
      // The image-scrubbed copy is what the model reads in place of the
      // output, so it goes through the same seam treatment.
      const cleanedOutput = agentFacingToolOutput(captured.cleanedOutput, outsideContent);

      if (execResult.success && captured.imageIds.length > 0) {
        const imageBlocks = await buildImageBlocksForIds(captured.imageIds);
        let cleanedText = cleanedOutput;
        if (cleanedText.length > MAX_TOOL_RESULT_CHARS) {
          cleanedText = condenseVerbatimText(cleanedText, { budget: MAX_TOOL_RESULT_CHARS });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content:
            imageBlocks.length > 0
              ? [{ type: 'text', text: cleanedText }, ...imageBlocks]
              : cleanedText,
          is_error: false,
        });
        capturedCleanOutput = cleanedOutput;
      } else if (execResult.success && captured.hadImageBlocks) {
        // Base64 guarantee: image-shaped content was detected but nothing
        // survived to attach (per-call cap exceeded, or Images.createImage
        // threw) — `resultContent` below is still the raw execResult.output,
        // which may still carry the base64 this branch exists to keep out of
        // the model turn and the activity log. `captured.cleanedOutput` is
        // always scrubbed (see extractToolImages's unconditional replacer),
        // so use it here even with zero attachable images.
        let cleanedText = cleanedOutput;
        if (cleanedText.length > MAX_TOOL_RESULT_CHARS) {
          cleanedText = condenseVerbatimText(cleanedText, { budget: MAX_TOOL_RESULT_CHARS });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: cleanedText,
          is_error: false,
        });
        capturedCleanOutput = cleanedOutput;
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: resultContent,
          is_error: !execResult.success,
        });
      }
    }

    // Repeat-guard bookkeeping: record the result a future identical call can
    // be suppressed with. Deliberately after the image branches above so a
    // base64-bearing MCP result (see the MCP note near
    // `recordableResultContent`) is never cached verbatim — prefer the
    // scrubbed `capturedCleanOutput` when this call produced one, else the
    // plain (pre-advisory) condensed text.
    input.repeatGuard?.recordResult(
      executionName,
      executionInput,
      capturedCleanOutput ?? recordableResultContent
    );

    // Base64 guarantee + log cap, both applied here at the logging seam:
    //   - `capturedCleanOutput` (when set) is already base64-scrubbed — see
    //     the image branches above — so this can never write raw image bytes
    //     into agent_activity_log.tool_output.
    //   - Independently, cap whatever text lands in the log row at
    //     MAX_ACTIVITY_LOG_CHARS (a storage/run_history bound, not the
    //     model-context MAX_TOOL_RESULT_CHARS ceiling above).
    // The log holds the agent-facing text (neutralized, labeled when outside):
    // replay and run_history hand it back to agents later.
    const loggedOutputText = execResult.success
      ? (capturedCleanOutput ?? toolOutputText)
      : toolErrorText;
    const cappedLoggedOutput =
      loggedOutputText.length > MAX_ACTIVITY_LOG_CHARS
        ? condenseVerbatimText(loggedOutputText, { budget: MAX_ACTIVITY_LOG_CHARS })
        : loggedOutputText;

    AgentActivityLog.logActivity({
      agentId: input.agent.id,
      runId: input.runId ?? undefined,
      actionType: 'tool_call',
      triggerType: 'chat_nudge',
      reason: `Tool call: ${logName}`,
      tool: logName,
      toolInput: executionInput,
      toolOutput: execResult.success
        ? { output: cappedLoggedOutput }
        : { error: cappedLoggedOutput },
      durationMs: execResult.durationMs,
    }).catch((err) => LogsService.warn('Failed to log tool activity', { error: err }));

    wsService.broadcastToChannel(input.session.threadId, {
      type: 'socket:tool:result',
      payload: {
        sessionId: input.sessionId,
        callId,
        agentId: input.agent.id,
        runId: input.runId,
        success: execResult.success,
        output: capturedCleanOutput ?? toolOutputText,
        error: execResult.success ? undefined : toolErrorText,
        durationMs: execResult.durationMs,
      },
    });

    LogsService.tool.end({
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName: input.threadName,
      threadId: input.session.threadId,
      toolName: logName,
      success: execResult.success,
      durationMs: execResult.durationMs,
      output: (toolOutputText || toolErrorText).slice(0, 120),
      error: execResult.success ? undefined : toolErrorText,
    });
  }

  // Mid-run peer injection: deliver any queued teammate/user messages into this
  // agent's live context, bundled as text after the tool_results in the same
  // user turn (docs-compliant for client-tool turns). Mode/sender-gated (a user
  // message always injects; peers follow the mode). Empty array -> the message
  // stays a pure tool_result turn.
  const injectedPeerMessages = drainInjectablePeerMessages({
    threadId: input.session.threadId,
    agentId: input.agent.id,
    mode: input.dispatchMode,
  });
  // If the repeat guard tripped its suppression cap this iteration, append a
  // one-time loop-breaking nudge. Append-only, inside the same tool-result user
  // turn, so it never rewrites earlier messages and stays cache-safe.
  const loopNudge = input.repeatGuard?.takePendingNudge() ?? null;
  const appendedText = [...injectedPeerMessages, ...(loopNudge ? [loopNudge] : [])];
  const userContent =
    appendedText.length > 0
      ? [...toolResults, ...appendedText.map((text) => ({ type: 'text' as const, text }))]
      : toolResults;
  input.agentMessages.push({ role: 'user', content: userContent } as Message);
  if (injectedPeerMessages.length > 0) {
    LogsService.socket.event('mid-run peer messages injected', {
      agentName: input.agent.name,
      threadId: input.session.threadId,
      count: injectedPeerMessages.length,
    });
  }
  return { latestThinking };
}

interface EphemeralInlineImage {
  id: string;
  mediaType: 'image/jpeg' | 'image/png';
  data: string;
}

/**
 * Private current-turn image protocol. Unlike inlineImageIds and MCP image
 * blocks, these bytes bypass image-node creation and chat message persistence.
 * VisionThreadService owns their temp-file lifetime and turn teardown.
 */
function extractEphemeralInlineImages(execResult: {
  rawContent?: unknown;
}): EphemeralInlineImage[] {
  const raw = execResult.rawContent;
  if (!raw || typeof raw !== 'object') return [];
  const candidates = (raw as { ephemeralInlineImages?: unknown }).ephemeralInlineImages;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((candidate): candidate is EphemeralInlineImage => {
      if (!candidate || typeof candidate !== 'object') return false;
      const image = candidate as Partial<EphemeralInlineImage>;
      return (
        typeof image.id === 'string' &&
        image.id.length > 0 &&
        (image.mediaType === 'image/jpeg' || image.mediaType === 'image/png') &&
        typeof image.data === 'string' &&
        image.data.length > 0
      );
    })
    .slice(0, 1);
}

/**
 * Pull `inlineImageIds: string[]` off the tool's rich-result `rawContent`,
 * if present. This is the opt-in protocol a tool uses to say "attach
 * these existing workspace images to my tool_result so the model sees
 * them inline" — see view_image's `id` branch for the canonical example.
 *
 * Returns an empty array for any non-conforming shape so the call site
 * can branch cleanly with `.length > 0`.
 */
function extractInlineImageIds(execResult: { rawContent?: unknown }): string[] {
  const raw = execResult.rawContent;
  if (!raw || typeof raw !== 'object') return [];
  const ids = (raw as { inlineImageIds?: unknown }).inlineImageIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function extractAndPublishToolImages({
  execResult,
  toolName,
  callId,
  input,
}: {
  execResult: Awaited<ReturnType<typeof toolExecutor.execute>>;
  toolName: string;
  callId: string;
  input: DispatchToolCallsInput;
}): Promise<{
  imageIds: string[];
  cleanedOutput: string;
  hasImages: boolean;
  /** See ExtractToolImagesResult.hadImageBlocks — the base64 guarantee signal. */
  hadImageBlocks: boolean;
}> {
  try {
    const extractInput = (execResult as { rawContent?: unknown }).rawContent ?? execResult;
    const extracted = await extractToolImages(extractInput, {
      threadId: input.session.threadId,
      agentId: input.agent.id,
      runId: callId,
      toolName,
    });
    if (extracted.images.length === 0) {
      return {
        imageIds: [],
        cleanedOutput: extracted.cleanedOutput,
        hasImages: false,
        hadImageBlocks: extracted.hadImageBlocks,
      };
    }

    const imageIds = extracted.images.map((i) => i.id);
    await postImageCaptureMessage({
      threadId: input.session.threadId,
      agentId: input.agent.id,
      runId: input.runId,
      toolName,
      imageIds,
    });
    LogsService.info('image-extract: captured images from tool', {
      agentName: input.agent.name,
      toolName,
      imageCount: extracted.images.length,
    });
    return {
      imageIds,
      cleanedOutput: extracted.cleanedOutput,
      hasImages: true,
      hadImageBlocks: true,
    };
  } catch (imgErr) {
    LogsService.warn('image-extract: failed', {
      toolName,
      error: getErrorMessage(imgErr),
    });
    return { imageIds: [], cleanedOutput: '', hasImages: false, hadImageBlocks: false };
  }
}
