import { readOriginalAgentName } from '@snaglet/shared/constants/systemAgents';
import { fetchData, getApiUrl, fetchJson } from './core';
import { getPanelJsonHeaders } from '@desktop/utils/panelToken';
import type { ApiResponse } from './core';
import {
  SUBAGENT_RESULT_EVENT_KIND,
  type SubagentStatus,
  type SubagentSummary,
  type ThreadNotificationSettingsResponse,
  type UpdateThreadNotificationSettingsRequest,
} from '@snaglet/shared/types';
import type {
  DmThreadSummary,
  ThreadSummary,
  ThreadSummaryRecord,
  ThreadWorkingDirectory,
  ThreadMessage,
  ThreadMessageSubagentResult,
  ThreadActivityLogRecord,
  ThreadEffectiveModel,
  ThreadParticipant,
} from './types';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

type SupportedDispatchMode = NonNullable<ThreadSummary['dispatchMode']>;

export type ParsedThreadDispatchMode =
  | { status: 'missing' }
  | { status: 'supported'; mode: SupportedDispatchMode }
  | { status: 'unsupported' };

/**
 * Parse routing separately from the general thread normalizer so strict
 * consumers (voice) can distinguish a missing value from an explicit
 * unknown/corrupt one. General thread UI treats both as the default by
 * omitting `dispatchMode` from its normalized summary.
 */
export function parseThreadDispatchMode(raw: unknown): ParsedThreadDispatchMode {
  const thread = asRecord(raw);
  const rawDispatch = thread.dispatchMode ?? thread.dispatch_mode;
  if (rawDispatch == null) return { status: 'missing' };
  if (rawDispatch === 'all' || rawDispatch === 'mentioned') {
    return { status: 'supported', mode: rawDispatch };
  }
  return { status: 'unsupported' };
}

/** Outcome of `threadsApi.createInProjectWithAgents`. */
export interface ThreadCreateResult {
  thread: ThreadSummary;
  /** Agents that could not be added after the thread was created; empty on full success. */
  failedAgentIds: string[];
}

function normalizeThreadSummary(raw: unknown): ThreadSummary {
  const thread = asRecord(raw);
  // The server emits camelCase (model columnMap converts DB snake→camel).
  // snake_case is accepted too, for callers/tests passing DB-shaped rows
  // directly, but the canonical path is the camelCase one.
  const parsedDispatch = parseThreadDispatchMode(thread);
  const dispatchMode: ThreadSummary['dispatchMode'] =
    parsedDispatch.status === 'supported' ? parsedDispatch.mode : undefined;
  const kind = thread.kind === 'dm' || thread.kind === 'chat' ? thread.kind : undefined;
  return {
    ...(kind ? { kind } : {}),
    id: String(thread.id ?? ''),
    agentId: String(thread.agentId ?? thread.agent_id ?? ''),
    title: (thread.title as string | null | undefined) ?? null,
    projectId:
      thread.projectId == null && thread.project_id == null
        ? null
        : String(thread.projectId ?? thread.project_id),
    maxAgentDispatches:
      typeof thread.maxAgentDispatches === 'number'
        ? thread.maxAgentDispatches
        : typeof thread.max_agent_dispatches === 'number'
          ? thread.max_agent_dispatches
          : null,
    dispatchMode,
    parentThreadId:
      thread.parentThreadId == null && thread.parent_thread_id == null
        ? null
        : String(thread.parentThreadId ?? thread.parent_thread_id),
    maxWaves:
      typeof thread.maxWaves === 'number'
        ? thread.maxWaves
        : typeof thread.max_waves === 'number'
          ? thread.max_waves
          : null,
    maxTotalOutputTokens:
      typeof thread.maxTotalOutputTokens === 'number'
        ? thread.maxTotalOutputTokens
        : typeof thread.max_total_output_tokens === 'number'
          ? thread.max_total_output_tokens
          : null,
    threadSystemPrompt:
      (thread.threadSystemPrompt as string | null | undefined) ??
      (thread.thread_system_prompt as string | null | undefined) ??
      null,
    createdAt: String(thread.createdAt ?? thread.created_at ?? ''),
    updatedAt: String(thread.updatedAt ?? thread.updated_at ?? ''),
  };
}

function normalizeThreadMessage(raw: unknown): ThreadMessage {
  const message = asRecord(raw);
  return {
    id: String(message.id ?? ''),
    threadId: String(message.threadId ?? message.thread_id ?? ''),
    role: String(message.role ?? ''),
    agentId:
      message.agentId == null && message.agent_id == null
        ? null
        : String(message.agentId ?? message.agent_id ?? ''),
    originalAgentName: readOriginalAgentName(message.metadata),
    // externalSender (connection-level MCP-caller attribution) must be mapped
    // on this REST hydration path as well as on the live socket broadcast
    // (chatStreamTranscriptHandlers.ts), or a page reload silently loses the
    // badge. Same for externalSenderLabel (per-message `from` provenance).
    externalSender:
      (message.externalSender as ThreadMessage['externalSender']) ??
      (message.external_sender as ThreadMessage['externalSender']) ??
      null,
    externalSenderLabel:
      (message.externalSenderLabel as string | null | undefined) ??
      (message.external_sender_label as string | null | undefined) ??
      null,
    content: String(message.content ?? ''),
    createdAt: String(message.createdAt ?? message.created_at ?? ''),
    messageType:
      (message.messageType as ThreadMessage['messageType'] | undefined) ??
      (message.message_type as ThreadMessage['messageType'] | undefined) ??
      'message',
    responseOptions:
      (message.responseOptions as ThreadMessage['responseOptions']) ??
      (message.response_options as ThreadMessage['responseOptions']) ??
      null,
    resolved: Boolean(message.resolved ?? false),
    thinkingContent:
      (message.thinkingContent as string | null | undefined) ??
      (message.thinking_content as string | null | undefined) ??
      null,
    toolActivity:
      (message.toolActivity as ThreadMessage['toolActivity']) ??
      (message.tool_activity as ThreadMessage['toolActivity']) ??
      null,
    injectedDuringRun:
      typeof message.injectedDuringRun === 'boolean'
        ? message.injectedDuringRun
        : typeof message.injected_during_run === 'boolean'
          ? message.injected_during_run
          : false,
    linterTargetAgentId:
      message.linterTargetAgentId == null && message.linter_target_agent_id == null
        ? null
        : String(message.linterTargetAgentId ?? message.linter_target_agent_id ?? ''),
    fabricatedIds: Array.isArray(message.fabricatedIds)
      ? (message.fabricatedIds as string[])
      : Array.isArray(message.fabricated_ids)
        ? (message.fabricated_ids as string[])
        : null,
    runId:
      message.runId == null && message.run_id == null
        ? null
        : String(message.runId ?? message.run_id ?? ''),
    usage: (message.usage as ThreadMessage['usage']) ?? null,
    runError: normalizeRunError(message.runError ?? message.run_error),
    contextPacks: normalizeContextPacks(message.contextPacks ?? message.context_packs),
    subagentResult: subagentResultFromMetadata(message.metadata),
  };
}

const ENDED_SUBAGENT_STATUSES: ReadonlySet<string> = new Set<SubagentStatus>([
  'finished',
  'failed',
  'stopped',
]);

function endedStatus(raw: unknown): ThreadMessageSubagentResult['status'] | null {
  return typeof raw === 'string' && ENDED_SUBAGENT_STATUSES.has(raw)
    ? (raw as ThreadMessageSubagentResult['status'])
    : null;
}

/** The pause / remove notice fields, present only on a notice row. */
function noticeFields(
  notice: unknown,
  by: unknown,
  resumeAt: unknown
): Pick<ThreadMessageSubagentResult, 'notice' | 'noticeBy' | 'resumeAt'> {
  if (notice !== 'paused' && notice !== 'removed') return {};
  return {
    notice,
    noticeBy: typeof by === 'string' ? by : null,
    resumeAt: typeof resumeAt === 'string' ? resumeAt : null,
  };
}

/**
 * A subagent result row's helper, from the persisted `messages.metadata`
 * (`event_kind` + the snake_case SubagentResultMetadata keys) — the history
 * read path. Null for every other row.
 */
export function subagentResultFromMetadata(raw: unknown): ThreadMessageSubagentResult | null {
  const meta = asRecord(raw);
  if (meta.event_kind !== SUBAGENT_RESULT_EVENT_KIND) return null;
  const status = endedStatus(meta.subagent_status);
  if (typeof meta.subagent_id !== 'string' || typeof meta.subagent_name !== 'string' || !status) {
    return null;
  }
  return {
    subagentId: meta.subagent_id,
    name: meta.subagent_name,
    threadId: typeof meta.subagent_thread_id === 'string' ? meta.subagent_thread_id : null,
    orchestratorAgentId: String(meta.orchestrator_agent_id ?? ''),
    orchestratorName: String(meta.orchestrator_name ?? meta.orchestrator_agent_id ?? ''),
    status,
    ...noticeFields(meta.subagent_notice, meta.subagent_notice_by, meta.subagent_resume_at),
  };
}

/**
 * The same, from the live `socket:chat:message_created` broadcast, which
 * carries `event_kind` beside a camelCase `subagent` object instead of the
 * metadata blob.
 */
export function subagentResultFromBroadcast(
  eventKind: unknown,
  raw: unknown
): ThreadMessageSubagentResult | null {
  if (eventKind !== SUBAGENT_RESULT_EVENT_KIND) return null;
  const sub = asRecord(raw);
  const status = endedStatus(sub.status);
  if (typeof sub.id !== 'string' || typeof sub.name !== 'string' || !status) return null;
  return {
    subagentId: sub.id,
    name: sub.name,
    threadId: typeof sub.threadId === 'string' ? sub.threadId : null,
    orchestratorAgentId: String(sub.orchestratorAgentId ?? ''),
    orchestratorName: String(sub.orchestratorName ?? sub.orchestratorAgentId ?? ''),
    status,
    ...noticeFields(sub.notice, sub.noticeBy, sub.resumeAt),
  };
}

/**
 * Normalize the per-agent `contextPacks` map (agentId → pack text) surfaced by
 * the server. Keeps only string values so a malformed payload can't put
 * non-string shapes on the message. Returns null when absent or empty — this is
 * what powers the persisted "injected context" disclosure on reload.
 */
export function normalizeContextPacks(raw: unknown): ThreadMessage['contextPacks'] {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [agentId, pack] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof pack === 'string' && pack.length > 0) out[agentId] = pack;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normalize a run_error payload from the API/socket into the camelCase
 * `ThreadMessageRunError` shape. Accepts both the wire snake_case
 * (`model_id`, `agent_name`) and any already-camelCased input.
 */
export function normalizeRunError(raw: unknown): ThreadMessage['runError'] {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const summary = r.summary;
  if (typeof kind !== 'string' || typeof summary !== 'string') return null;
  return {
    kind: kind as NonNullable<ThreadMessage['runError']>['kind'],
    summary,
    provider: (r.provider as string | null | undefined) ?? null,
    modelId:
      (r.modelId as string | null | undefined) ?? (r.model_id as string | null | undefined) ?? null,
    agentName:
      (r.agentName as string | null | undefined) ??
      (r.agent_name as string | null | undefined) ??
      null,
  };
}

function normalizeThreadParticipant(raw: unknown): ThreadParticipant {
  const participant = asRecord(raw);
  const agentId = String(participant.agentId ?? participant.agent_id ?? '');
  const rawKind = String(participant.kind ?? '');
  return {
    id: String(participant.id ?? ''),
    threadId: String(participant.threadId ?? participant.thread_id ?? ''),
    memberId: String(participant.memberId ?? participant.member_id ?? ''),
    // Trust the server's discriminator; falls back to inferring from agentId
    // when `kind` is absent.
    kind: rawKind === 'user' ? 'user' : rawKind === 'agent' ? 'agent' : agentId ? 'agent' : 'user',
    agentId,
    role: String(participant.role ?? ''),
    credentialId:
      participant.credentialId == null && participant.credential_id == null
        ? null
        : String(participant.credentialId ?? participant.credential_id ?? ''),
    providerId:
      participant.providerId == null && participant.provider_id == null
        ? null
        : String(participant.providerId ?? participant.provider_id ?? ''),
    modelId:
      participant.modelId == null && participant.model_id == null
        ? null
        : String(participant.modelId ?? participant.model_id ?? ''),
    addedAt: String(
      participant.addedAt ??
        participant.added_at ??
        participant.createdAt ??
        participant.created_at ??
        ''
    ),
    systemPromptAddendum:
      (participant.systemPromptAddendum as string | null | undefined) ??
      (participant.system_prompt_addendum as string | null | undefined) ??
      null,
    toolAccessMode:
      (participant.toolAccessMode as string | null | undefined) ??
      (participant.tool_access_mode as string | null | undefined) ??
      null,
    toolAccessAllowList: Array.isArray(participant.toolAccessAllowList)
      ? (participant.toolAccessAllowList as string[])
      : Array.isArray(participant.tool_access_allow_list)
        ? (participant.tool_access_allow_list as string[])
        : null,
    toolAccessDenyList: Array.isArray(participant.toolAccessDenyList)
      ? (participant.toolAccessDenyList as string[])
      : Array.isArray(participant.tool_access_deny_list)
        ? (participant.tool_access_deny_list as string[])
        : null,
    toolOverrides:
      (participant.toolOverrides as Record<string, unknown> | null | undefined) ??
      (participant.tool_overrides as Record<string, unknown> | null | undefined) ??
      null,
    maxToolCallsPerTurn:
      typeof participant.maxToolCallsPerTurn === 'number'
        ? participant.maxToolCallsPerTurn
        : typeof participant.max_tool_calls_per_turn === 'number'
          ? participant.max_tool_calls_per_turn
          : null,
    maxDurationSeconds:
      typeof participant.maxDurationSeconds === 'number'
        ? participant.maxDurationSeconds
        : typeof participant.max_duration_seconds === 'number'
          ? participant.max_duration_seconds
          : null,
    autoRespond:
      typeof participant.autoRespond === 'boolean'
        ? participant.autoRespond
        : typeof participant.auto_respond === 'boolean'
          ? participant.auto_respond
          : true,
    disableFallback:
      typeof participant.disableModelFallback === 'boolean'
        ? participant.disableModelFallback
        : typeof participant.disable_model_fallback === 'boolean'
          ? participant.disable_model_fallback
          : false,
  };
}

/** Finite number or null — guards the nullable token columns against non-numeric junk. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeActivityLogRecord(raw: unknown): ThreadActivityLogRecord {
  const record = asRecord(raw);
  return {
    id: String(record.id ?? ''),
    agentId: String(record.agentId ?? record.agent_id ?? ''),
    runId:
      record.runId == null && record.run_id == null
        ? null
        : String(record.runId ?? record.run_id ?? ''),
    actionType: String(record.actionType ?? record.action_type ?? ''),
    triggerType: String(record.triggerType ?? record.trigger_type ?? ''),
    reason: (record.reason as string | null | undefined) ?? null,
    content: (record.content as string | null | undefined) ?? null,
    tokenEstimate: Number(record.tokenEstimate ?? record.token_estimate ?? 0),
    tool: (record.tool as string | null | undefined) ?? null,
    toolInput:
      (record.toolInput as ThreadActivityLogRecord['toolInput']) ??
      (record.tool_input as ThreadActivityLogRecord['toolInput']) ??
      null,
    toolOutput:
      (record.toolOutput as ThreadActivityLogRecord['toolOutput']) ??
      (record.tool_output as ThreadActivityLogRecord['toolOutput']) ??
      null,
    durationMs:
      record.durationMs == null && record.duration_ms == null
        ? null
        : Number(record.durationMs ?? record.duration_ms ?? 0),
    createdAt: String(record.createdAt ?? record.created_at ?? ''),
    threadId: String(record.threadId ?? record.thread_id ?? ''),
    runStatus: String(record.runStatus ?? record.run_status ?? ''),
    runStartedAt: String(record.runStartedAt ?? record.run_started_at ?? ''),
    runFinishedAt:
      record.runFinishedAt == null && record.run_finished_at == null
        ? null
        : String(record.runFinishedAt ?? record.run_finished_at ?? ''),
    runProviderId:
      record.runProviderId == null && record.run_provider_id == null
        ? null
        : String(record.runProviderId ?? record.run_provider_id ?? ''),
    runModel:
      record.runModel == null && record.run_model == null
        ? null
        : String(record.runModel ?? record.run_model ?? ''),
    // Persisted run token totals (see ThreadActivityLogRecord doc). Absent →
    // null, which leaves the reloaded counter hidden rather than showing a
    // made-up zero.
    runInputTokens: finiteOrNull(record.runInputTokens ?? record.run_input_tokens),
    runOutputTokens: finiteOrNull(record.runOutputTokens ?? record.run_output_tokens),
    runCacheReadTokens: finiteOrNull(record.runCacheReadTokens ?? record.run_cache_read_tokens),
    runCacheCreationTokens: finiteOrNull(
      record.runCacheCreationTokens ?? record.run_cache_creation_tokens
    ),
    runProviderCalls: finiteOrNull(record.runProviderCalls ?? record.run_provider_calls),
  };
}

function normalizeEffectiveModel(raw: unknown): ThreadEffectiveModel {
  const model = asRecord(raw);
  return {
    providerId: String(model.providerId ?? model.provider_id ?? ''),
    modelId: String(model.modelId ?? model.model_id ?? ''),
    credentialId:
      model.credentialId == null && model.credential_id == null
        ? null
        : String(model.credentialId ?? model.credential_id ?? ''),
    source: (model.source as ThreadEffectiveModel['source'] | undefined) ?? 'agent_default',
  };
}

export const threadsApi = {
  get: (threadId: string) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`)).then((data) =>
      normalizeThreadSummary(data)
    ),
  /** Strict routing read for features that must fail closed on unknown modes. */
  getDispatchModeState: (threadId: string) =>
    fetchData<unknown>(getApiUrl(`/threads/${threadId}`)).then((data) => {
      const parsed = parseThreadDispatchMode(data);
      if (parsed.status === 'supported') return parsed.mode;
      return parsed.status === 'missing' ? ('all' as const) : ('unsupported' as const);
    }),
  list: (agentId?: string) => {
    const url = agentId
      ? getApiUrl(`/threads?agentId=${encodeURIComponent(agentId)}`)
      : getApiUrl('/threads');
    return fetchData<ThreadSummary[]>(url).then((data) => data.map(normalizeThreadSummary));
  },
  findBySourcePage: (sourcePageId: string) =>
    fetchData<ThreadSummary[]>(
      getApiUrl(`/threads?sourcePageId=${encodeURIComponent(sourcePageId)}`)
    ).then((data) => data.map(normalizeThreadSummary)),
  /** Live subagent helpers this thread's agents started (the composer strip seeds from it). */
  listSubagents: (threadId: string) =>
    fetchData<{ subagents: SubagentSummary[] }>(getApiUrl(`/threads/${threadId}/subagents`)).then(
      (data) => data.subagents
    ),
  /**
   * Pause a helper (the user's action): its run stops and it is kept. `for`
   * ("15m") or `until` (ISO) also resumes it on its own then.
   */
  pauseSubagent: (
    threadId: string,
    subagentId: string,
    timing: { for?: string; until?: string } = {}
  ) =>
    fetchData<{ subagent: SubagentSummary | null; done: boolean }>(
      getApiUrl(`/threads/${threadId}/subagents/${subagentId}/pause`),
      { method: 'POST', body: JSON.stringify(timing) }
    ),
  /** Resume a paused helper now: it continues where it left off. */
  resumeSubagent: (threadId: string, subagentId: string) =>
    fetchData<{ subagent: SubagentSummary | null }>(
      getApiUrl(`/threads/${threadId}/subagents/${subagentId}/resume`),
      { method: 'POST', body: '{}' }
    ),
  /** Stop a helper and delete it with its thread, at once. */
  removeSubagent: (threadId: string, subagentId: string) =>
    fetchData<{ removed: boolean }>(getApiUrl(`/threads/${threadId}/subagents/${subagentId}`), {
      method: 'DELETE',
    }),
  /** Threads with an agent run in progress right now (seeds live indicators). */
  activeRuns: () =>
    fetchData<{ threadIds: string[] }>(getApiUrl('/threads/active-runs')).then(
      (data) => data.threadIds
    ),
  create: (agentId: string, title?: string) =>
    fetchData<ThreadSummary>(getApiUrl('/threads'), {
      method: 'POST',
      body: JSON.stringify({ agentId, title }),
    }).then((data) => normalizeThreadSummary(data)),
  rename: (threadId: string, title: string) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }).then((data) => normalizeThreadSummary(data)),
  /** Replace the thread-wide system prompt. Null/empty clears it. */
  updateSystemPrompt: (threadId: string, threadSystemPrompt: string | null) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ thread_system_prompt: threadSystemPrompt }),
    }).then((data) => normalizeThreadSummary(data)),
  /** The folder agents start in for this thread, with where it comes from. */
  getWorkingDirectory: (threadId: string) =>
    fetchData<{
      id: string;
      working_directory: string | null;
      effective: string;
      source: ThreadWorkingDirectory['source'];
      project_folder: string | null;
      inherited_override: string | null;
      override_problem: string | null;
    }>(getApiUrl(`/threads/${encodeURIComponent(threadId)}/working-directory`)).then(
      (data): ThreadWorkingDirectory => ({
        id: data.id,
        workingDirectory: data.working_directory,
        effective: data.effective,
        source: data.source,
        projectFolder: data.project_folder,
        inheritedOverride: data.inherited_override,
        overrideProblem: data.override_problem,
      })
    ),
  /**
   * Save this thread's own folder (null clears it, back to the project's
   * folder or Snaglet home). Needs the person's panel credential; the server checks
   * the folder (it must be a real folder inside the project's folder).
   */
  setWorkingDirectory: (threadId: string, workingDirectory: string | null) =>
    fetchData<{ id: string; working_directory: string | null }>(
      getApiUrl(`/threads/${encodeURIComponent(threadId)}/working-directory`),
      {
        method: 'PUT',
        headers: getPanelJsonHeaders(),
        body: JSON.stringify({ working_directory: workingDirectory }),
      }
    ),
  /**
   * This thread's run-ended notification settings. A thread that was never
   * configured answers the defaults (off) rather than 404.
   */
  getNotificationSettings: (threadId: string) =>
    fetchData<ThreadNotificationSettingsResponse>(
      getApiUrl(`/threads/${encodeURIComponent(threadId)}/notification-settings`)
    ).then((data) => data.settings),
  /** Save this thread's run-ended notification settings. */
  setNotificationSettings: (threadId: string, input: UpdateThreadNotificationSettingsRequest) =>
    fetchData<ThreadNotificationSettingsResponse>(
      getApiUrl(`/threads/${encodeURIComponent(threadId)}/notification-settings`),
      { method: 'PUT', body: JSON.stringify(input) }
    ).then((data) => data.settings),
  /** Update the thread's first-class dispatch_mode column. */
  updateDispatchMode: (threadId: string, dispatchMode: 'all' | 'mentioned') =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ dispatch_mode: dispatchMode }),
    }).then((data) => normalizeThreadSummary(data)),
  /**
   * Update the thread-level `maxWaves` cap. `null` = unbounded; a positive
   * number is honored exactly, with no server ceiling (see
   * groupChat/safety.ts). The wire sends -1 for unbounded because the column
   * uses that sentinel to tell "unbounded" from "unset"; the UI uses null.
   */
  updateMaxWaves: (threadId: string, maxWaves: number | null) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ max_waves: maxWaves === null ? -1 : maxWaves }),
    }).then((data) => normalizeThreadSummary(data)),
  /** Update the thread-level conversation-total output-token cap. */
  updateMaxTotalOutputTokens: (threadId: string, maxTotalOutputTokens: number | null) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ max_total_output_tokens: maxTotalOutputTokens }),
    }).then((data) => normalizeThreadSummary(data)),
  // Attach a thread to a project (`null` makes it flat / workspace-level),
  // landing at the top of that list. Threads never live in folders.
  setProject: (threadId: string, projectId: string | null) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({ project_id: projectId }),
    }).then((data) => normalizeThreadSummary(data)),
  /**
   * Place a thread: `projectId` moves it to a project (`null` = flat), at the
   * top of that list unless `sortOrder` is given; `sortOrder` alone reorders
   * it within its current list (0 = top). The threads at or after the slot
   * shift down by one. Only the keys provided are sent; send at least one.
   * 400 bad slot, non-project / archived target or archived thread, 404
   * unknown thread or project.
   */
  setPlacement: (threadId: string, placement: { projectId?: string | null; sortOrder?: number }) =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}`), {
      method: 'PATCH',
      body: JSON.stringify({
        ...(placement.projectId !== undefined ? { project_id: placement.projectId } : {}),
        ...(placement.sortOrder !== undefined ? { sort_order: placement.sortOrder } : {}),
      }),
    }).then((data) => normalizeThreadSummary(data)),
  /**
   * Create a thread in a project (flat when `projectId` is null) with its
   * agents. The first agent rides along on the POST (the server seeds it as
   * the opening participant), the rest join through `addParticipant`.
   *
   * A failed POST rejects — nothing was created. A participant failure
   * never throws the created thread away: the result carries the thread
   * plus the agents that could not be added, so a caller can close its
   * picker and report "created without N agents" rather than retry a
   * create that would duplicate the thread.
   */
  createInProjectWithAgents: async (
    title: string,
    projectId: string | null,
    agentIds: string[]
  ): Promise<ThreadCreateResult> => {
    const [firstAgentId, ...remainingAgentIds] = agentIds;
    if (!firstAgentId) {
      throw new Error('At least one agent is required to create a thread');
    }
    const thread = await fetchData<ThreadSummary>(getApiUrl('/threads'), {
      method: 'POST',
      body: JSON.stringify({ title, project_id: projectId, agentId: firstAgentId }),
    }).then((data) => normalizeThreadSummary(data));
    const failedAgentIds: string[] = [];
    for (const agentId of remainingAgentIds) {
      try {
        await threadsApi.addParticipant(thread.id, agentId);
      } catch {
        failedAgentIds.push(agentId);
      }
    }
    return { thread, failedAgentIds };
  },
  /**
   * Paginated thread messages.
   *
   * Modes (mutually exclusive — first non-null wins):
   *   { around: msgId, limit }   Window of `limit` centered on a message.
   *                              Used when the chat view opens at a result
   *                              from search.
   *   { before: msgId, limit }   `limit` messages strictly older than the
   *                              cursor. Used by "Load more" at the top.
   *   { after: msgId, limit }    `limit` messages strictly newer than the
   *                              cursor. Used when the user is on a
   *                              windowed view and scrolls past its bottom.
   *   {} or no opts              Most recent `limit` (default 50).
   *
   * The response includes `hasMoreOlder` / `hasMoreNewer` flags so the
   * chat view can decide whether to render its paginate affordances, plus
   * `anchorId` in `around` mode so the caller can scroll + flash that row.
   */
  getMessages: async (
    threadId: string,
    opts: {
      signal?: AbortSignal;
      around?: string;
      before?: string;
      after?: string;
      limit?: number;
    } = {}
  ): Promise<{
    messages: ThreadMessage[];
    hasMoreOlder: boolean;
    hasMoreNewer: boolean;
    anchorId?: string;
  }> => {
    // Build the query string manually: getApiUrl() returns a relative path in
    // dev, and `new URL(relative)` throws with no base, which the caller's
    // silent .catch() would turn into an empty thread.
    const params = new URLSearchParams();
    if (opts.around) params.set('around', opts.around);
    else if (opts.before) params.set('before', opts.before);
    else if (opts.after) params.set('after', opts.after);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const query = params.toString();
    const url = getApiUrl(`/threads/${threadId}/messages${query ? `?${query}` : ''}`);
    const r = await fetchJson<
      ApiResponse<{
        messages: ThreadMessage[];
        hasMoreOlder: boolean;
        hasMoreNewer: boolean;
        anchorId?: string;
      }>
    >(url, opts.signal ? { signal: opts.signal } : undefined);
    return {
      messages: r.data.messages.map(normalizeThreadMessage),
      hasMoreOlder: r.data.hasMoreOlder,
      hasMoreNewer: r.data.hasMoreNewer,
      ...(r.data.anchorId ? { anchorId: r.data.anchorId } : {}),
    };
  },
  getActivityLog: (threadId: string, params?: { limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return fetchData<ThreadActivityLogRecord[]>(
      getApiUrl(`/threads/${threadId}/activity-log${query ? `?${query}` : ''}`)
    ).then((data) => data.map(normalizeActivityLogRecord));
  },
  getEffectiveModel: (threadId: string, agentId?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    const query = params.toString();
    const url = getApiUrl(`/threads/${threadId}/model${query ? `?${query}` : ''}`);
    return fetchData<ThreadEffectiveModel>(url).then((data) => normalizeEffectiveModel(data));
  },
  setParticipantModel: (
    threadId: string,
    agentId: string,
    data: {
      credentialId?: string | null;
      modelId?: string | null;
      providerId?: string | null;
      disableFallback?: boolean;
    }
  ) =>
    fetchData<ThreadParticipant>(getApiUrl(`/threads/${threadId}/participants/${agentId}/model`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }).then((data) => normalizeThreadParticipant(data)),
  updateParticipantOverrides: (
    threadId: string,
    agentId: string,
    data: {
      systemPromptAddendum?: string | null;
      expectedSystemPromptAddendum?: string | null;
      toolAccessMode?: string | null;
      toolAccessAllowList?: string[] | null;
      toolAccessDenyList?: string[] | null;
      toolOverrides?: Record<string, unknown> | null;
      maxToolCallsPerTurn?: number | null;
      maxDurationSeconds?: number | null;
      autoRespond?: boolean;
    }
  ) =>
    fetchData<ThreadParticipant>(
      getApiUrl(`/threads/${threadId}/participants/${agentId}/overrides`),
      { method: 'PATCH', body: JSON.stringify(data) }
    ).then((data) => normalizeThreadParticipant(data)),
  listParticipants: (threadId: string) =>
    fetchData<ThreadParticipant[]>(getApiUrl(`/threads/${threadId}/participants`)).then((data) =>
      data.map(normalizeThreadParticipant)
    ),
  /**
   * Full history of summary versions a given agent has compacted in
   * this thread, newest first. Backs the per-agent "Thread summaries"
   * tab in thread settings → Agents.
   */
  listAgentSummaries: (threadId: string, agentId: string) =>
    fetchData<ThreadSummaryRecord[]>(getApiUrl(`/threads/${threadId}/agents/${agentId}/summaries`)),
  /**
   * Fetch a single thread_summaries row by id. Used by the chip-preview
   * modal when the user clicks a `[Title](thread_summary-…)` pill.
   */
  getSummary: (summaryId: string) =>
    fetchData<ThreadSummaryRecord>(
      getApiUrl(`/threads/summaries/${encodeURIComponent(summaryId)}`)
    ),
  /**
   * Fetch a single message row by id. Backs the chip-preview modal for
   * `[Title](message-…)` references — the modal needs `threadId` to mount
   * ChatView focused on the message (same scroll-to-row behavior the
   * command palette uses for message search hits).
   */
  getMessage: (messageId: string) =>
    fetchData<ThreadMessage>(getApiUrl(`/threads/messages/${encodeURIComponent(messageId)}`)).then(
      (data) => normalizeThreadMessage(data)
    ),
  addParticipant: (threadId: string, agentId: string, role: string = 'participant') =>
    fetchData<ThreadParticipant>(getApiUrl(`/threads/${threadId}/participants`), {
      method: 'POST',
      body: JSON.stringify({ agentId, role }),
    }).then((data) => normalizeThreadParticipant(data)),
  removeParticipant: (threadId: string, agentId: string, opts?: { actorAgentId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.actorAgentId) {
      params.set('actorAgentId', opts.actorAgentId);
    }
    const query = params.toString();
    const url = getApiUrl(
      `/threads/${threadId}/participants/${agentId}${query ? `?${query}` : ''}`
    );
    return fetchData<null>(url, {
      method: 'DELETE',
    });
  },
  /**
   * DM conversations of the local user, or of `agentId` when given, newest
   * activity first. DM threads never appear in the ordinary thread lists.
   */
  listDms: (agentId?: string) =>
    fetchData<{ threads: DmThreadSummary[] }>(
      getApiUrl(agentId ? `/threads/dm?agentId=${encodeURIComponent(agentId)}` : '/threads/dm')
    ).then((data) => data.threads),
  /**
   * Find or create the local user's DM thread with `agentId`. Sending in it is
   * the normal chat send, so the agent wakes to answer. Rejects when the agent
   * is unknown (404) or has DMs turned off (409).
   */
  openDm: (agentId: string) =>
    fetchData<{ thread: { id: string; title: string } }>(getApiUrl('/threads/dm'), {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }).then((data) => ({ id: data.thread.id, title: data.thread.title })),
  /** Mark a DM thread read for the local user, up to now. */
  markDmRead: (threadId: string) =>
    fetchData<null>(getApiUrl(`/threads/${threadId}/dm-read`), { method: 'POST' }),
  delete: (threadId: string, opts?: { deleteMemories?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (opts?.deleteMemories) searchParams.set('deleteMemories', 'true');
    const params = searchParams.toString();
    return fetchData<null>(getApiUrl(`/threads/${threadId}${params ? `?${params}` : ''}`), {
      method: 'DELETE',
    });
  },
  /**
   * Clear a thread's messages (and their embeddings) while keeping the thread.
   * Optionally also clears its summaries and/or the memories agents formed from
   * it. The open thread empties via a `socket:thread:cleared` broadcast.
   */
  clear: (threadId: string, opts?: { clearSummaries?: boolean; clearMemories?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (opts?.clearSummaries) searchParams.set('clearSummaries', 'true');
    if (opts?.clearMemories) searchParams.set('clearMemories', 'true');
    const params = searchParams.toString();
    return fetchData<{
      deletedMessages: number;
      clearedSummaries: boolean;
      clearedMemories: boolean;
    }>(getApiUrl(`/threads/${threadId}/clear${params ? `?${params}` : ''}`), { method: 'POST' });
  },
  /**
   * Fork a home thread / user↔agent DM into a real workspace thread: copies
   * the whole history verbatim into a new `kind: 'chat'` thread (optionally
   * scoped to `projectId`, null = flat). The source thread is left untouched.
   * Returns the created workspace thread.
   */
  fork: (
    threadId: string,
    input: { title: string; projectId?: string | null }
  ): Promise<ThreadSummary> =>
    fetchData<ThreadSummary>(getApiUrl(`/threads/${threadId}/fork`), {
      method: 'POST',
      body: JSON.stringify({ title: input.title, projectId: input.projectId ?? null }),
    }).then((data) => normalizeThreadSummary(data)),
  getContextUsage: (
    threadId: string,
    agentId: string,
    options?: {
      /**
       * Force the server to apply the latest thread summary regardless
       * of the auto-compression threshold. Set this on the refresh that
       * fires right after a user-triggered compact so the bar visibly
       * drops on the same client that initiated the compact.
       */
      applySummary?: 'force';
    }
  ) => {
    const params = new URLSearchParams({ agentId });
    if (options?.applySummary === 'force') params.set('applySummary', 'force');
    return fetchData<ThreadContextUsage>(
      getApiUrl(`/threads/${threadId}/context-usage?${params.toString()}`)
    );
  },
  /**
   * Compact one agent's view of the thread synchronously — the response
   * resolves once the per-agent summary is persisted. Slow (calls the model),
   * so callers should show progress UI for the duration.
   */
  compactAgent: (threadId: string, agentId: string) =>
    fetchData<{ agentId: string; durationMs: number }>(getApiUrl(`/threads/${threadId}/compact`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    }),
  /**
   * Server-side in-flight check for the per-agent compact endpoint. Used by
   * ContextWindowPanel on remount so the button still shows "Compacting…"
   * if the user navigated away while a click was in progress.
   */
  getCompactStatus: (threadId: string, agentId: string) =>
    fetchData<{ compacting: boolean; since: string | null }>(
      getApiUrl(`/threads/${threadId}/compact-status?agentId=${encodeURIComponent(agentId)}`)
    ),

  /** Update a message's content (e.g. checkbox toggle autosave). */
  updateMessageContent: (threadId: string, messageId: string, content: string) =>
    fetchData<unknown>(getApiUrl(`/threads/${threadId}/messages/${messageId}`), {
      method: 'PATCH',
      body: JSON.stringify({ content }),
      headers: { 'Content-Type': 'application/json' },
    }),
};

interface ThreadContextUsageLatestSummary {
  version: number;
  /**
   * When this summary version was created — the actual compaction moment and
   * the anchor for "Last compacted … ago". Falls back to `updatedAt` when
   * absent.
   */
  createdAt?: string;
  updatedAt: string;
  messagesCovered: number;
}

export interface ThreadContextUsage {
  threadId: string;
  agentId: string;
  provider: string;
  model: string | null;
  /** Latest persisted summary for this (thread, agent), or null if never compacted. */
  latestSummary?: ThreadContextUsageLatestSummary | null;
  tokens: {
    /**
     * Post-compression size of the whole request — system prompt + tool catalog
     * + messages. Equals systemPromptTokens + toolCatalogTokens + messageTokens.
     */
    estimated: number;
    /** Same total, pre-compression — full thread, for transparency. */
    raw?: number;
    /** Whether compression was applied this turn. */
    compressed?: boolean;
    /** Number of messages retained after compression. */
    keptMessages?: number;
    /** Whether a thread summary was substituted in. */
    threadSummaryUsed?: boolean;
    messagesCounted: number;
    /** Message payload only, post-compression — tool calls and results included. */
    messageTokens: number;
    systemPromptChars: number;
    /** The composed system prompt actually sent, not the agent's persona field. */
    systemPromptTokens: number;
    /** The advertised `tools` payload. */
    toolCatalogTokens: number;
    toolCount: number;
  };
  budget: {
    contextWindowTokens: number;
    maxOutputTokens: number;
    usableBudget: number;
    tokenThreshold: number;
    /** True when overhead alone exhausted the window and the budget was floored. */
    overheadFloored?: boolean;
  };
  percent: number;
  percentOfUsable: number;
  source: string;
}
