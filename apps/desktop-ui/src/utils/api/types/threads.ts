/**
 * Type definitions for threads, messages, participants, and activity logs.
 */
import type { RunErrorKind, SubagentNotice, SubagentStatus } from '@snaglet/shared/types';

export interface ThreadSummary {
  id: string;
  /** First agent in the participant list (when present), used where a list
   *  shows one participant. Threads have no single owner. */
  agentId: string;
  title: string | null;
  /**
   * The project container this thread is scoped to, or `null` for a flat
   * (workspace-level) thread. Threads never live in folders, so this is the
   * thread's only placement (`nodes.project_id` on the server).
   */
  projectId: string | null;
  maxAgentDispatches: number | null;
  /** `null` = settings default; `-1` on the wire means unbounded. */
  maxWaves: number | null;
  maxTotalOutputTokens: number | null;
  /** Thread-wide system prompt (threads.thread_system_prompt). */
  threadSystemPrompt: string | null;
  /**
   * Per-turn dispatch routing — first-class column on `threads`.
   * Cadence (parallel vs sequential) is implicit: `all` and
   * `mentioned` run agents in parallel.
   * Defaults to `'all'` when omitted by the server.
   */
  dispatchMode?: 'all' | 'mentioned';
  /**
   * Set on a subagent helper's hidden thread: the thread whose agent
   * started the helper. Such a thread is in no list; it opens by id only.
   */
  parentThreadId?: string | null;
  /**
   * `'dm'` for a direct-message thread (which opens in the DM pane, never the
   * chat view); `'chat'` for every other thread. Unset when the server omits it.
   */
  kind?: 'chat' | 'dm';
  createdAt: string;
  updatedAt: string;
}

/** Where agents of a thread start, and where that comes from (GET /threads/:id/working-directory). */
export interface ThreadWorkingDirectory {
  id: string;
  /** This thread's own saved folder; null = none saved. */
  workingDirectory: string | null;
  /** The folder agents actually start in. */
  effective: string;
  /** A saved thread folder, the project's linked folder, or Snaglet home. */
  source: 'thread' | 'project' | 'home';
  /** The thread's project folder on disk, when it has one. */
  projectFolder: string | null;
  /** A folder saved on a parent thread that this thread inherits (null when it has its own). */
  inheritedOverride: string | null;
  /** Set when a saved folder fails validation, so agents fall back. */
  overrideProblem: string | null;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: string;
  agentId: string | null;
  /**
   * `metadata.originalAgentName`: set when a deleted agent's message was
   * repointed to the ghost system actor. Absent on a ghost row = a system post
   * (hook notice), shown as `system`.
   */
  originalAgentName?: string | null;
  externalSender?: { memberId: string; name: string } | null;
  /**
   * Raw label for a `from` send that didn't resolve to a known agent/member
   * (server: messages.external_sender). Unlike `externalSender` (connection-
   * level MCP-caller attribution) this is the per-message caller-claimed
   * label. Shown as the bubble's sender line when present.
   */
  externalSenderLabel?: string | null;
  content: string;
  createdAt: string;
  /**
   * Client-only: true for an optimistic user echo the server has not yet
   * confirmed (no matching socket:chat:message_created). A `socket:chat:queued`
   * ack does not clear it. Renders as a dimmed "sending" bubble.
   */
  pending?: boolean;
  messageType?: 'question' | 'message' | 'thread_event';
  responseOptions?: Array<{ label: string; value: string }> | null;
  resolved?: boolean;
  thinkingContent?: string | null;
  toolActivity?: Array<{
    callId: string;
    toolName: string;
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    success?: boolean;
    durationMs?: number;
  }> | null;
  injectedDuringRun?: boolean;
  /**
   * Outbound-linter follow-up: when set, this message was auto-authored
   * by the server because the named agent's previous reply contained ids
   * that didn't resolve in the database. UI renders it as a verification
   * row rather than a user bubble.
   */
  linterTargetAgentId?: string | null;
  /** Ids the linter flagged as fabricated in the offender's message. */
  fabricatedIds?: string[] | null;
  /** Run that produced this message — null for user messages. */
  runId?: string | null;
  /** Cumulative token usage for the producing run. Null for user messages and
   *  for assistant messages saved without usage. `contextWindowTokens` is the
   *  model's context window at run time, the denominator for the usage percent. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    contextWindowTokens?: number;
    /** Times the run compacted its own context mid-run; absent when it never did. */
    runCompactions?: number;
  } | null;
  /**
   * Run-failure descriptor: when set, this assistant message represents an
   * agent run that failed mid-stream (timeout, model failure, rate limit,
   * runtime exception). UI renders the row as an error bubble instead of a
   * normal agent reply. Set by `persistRunErrorMessage` on the server.
   */
  runError?: ThreadMessageRunError | null;
  /**
   * The "what changed since your last turn" delta this agent was injected with
   * at wake, rendered as a block above the message. Live-stream only (carried
   * in socket:done) — not persisted, so it's absent after reload.
   */
  wakeDelta?: string | null;
  /**
   * Per-agent opening-message context packs (agentId → rendered pack text)
   * from the message's metadata, written once by the retrieval pipeline and
   * rendered as the "injected context" disclosure on the user bubble.
   */
  contextPacks?: Record<string, string> | null;
  /**
   * Set on a subagent helper's result row in its parent thread (a
   * `thread_event` whose metadata.event_kind is `subagent_finished`). Read
   * from the row's metadata on reload and from the broadcast's `subagent`
   * object live, so both render the same compact result line.
   */
  subagentResult?: ThreadMessageSubagentResult | null;
}

/** Which helper a subagent result row reports on (see SubagentResultMetadata). */
export interface ThreadMessageSubagentResult {
  subagentId: string;
  name: string;
  /** The helper's hidden thread; null when it was already gone. */
  threadId: string | null;
  orchestratorAgentId: string;
  orchestratorName: string;
  status: Exclude<SubagentStatus, 'running'>;
  /** Set on a notice: the helper was paused or removed rather than reporting. */
  notice?: SubagentNotice;
  /** Who paused or removed it (the orchestrator's own name when it did). */
  noticeBy?: string | null;
  /** A timed pause's end. */
  resumeAt?: string | null;
}

/** UI shape of the message-level run_error descriptor (mirrors ChatRunErrorPayload). */
interface ThreadMessageRunError {
  kind: RunErrorKind;
  summary: string;
  provider?: string | null;
  modelId?: string | null;
  agentName?: string | null;
}

type ActivityActionType =
  | 'create_post'
  | 'comment'
  | 'message_reply'
  | 'skip'
  | 'browse_web'
  | 'tool_call'
  | 'tool_discovery_failure'
  | 'thinking';

export interface ThreadActivityLogRecord {
  id: string;
  agentId: string;
  runId: string | null;
  actionType: ActivityActionType | string;
  triggerType: string;
  reason: string | null;
  /** Text payload — the accumulated thinking-block prose for `thinking` rows. */
  content: string | null;
  tokenEstimate: number;
  tool: string | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: Record<string, unknown> | null;
  durationMs: number | null;
  createdAt: string;
  threadId: string;
  runStatus: string;
  runStartedAt: string;
  runFinishedAt: string | null;
  runProviderId: string | null;
  runModel: string | null;
  /**
   * Persisted run totals from the joined `runs` row, used to restore a
   * finished run's token counter after reload. `runInputTokens` is the run's
   * cumulative billed input (Σ across every provider call, cache re-reads
   * included), not a context-window size. Null when not recorded (e.g. the
   * run is still in flight).
   */
  runInputTokens: number | null;
  runOutputTokens: number | null;
  runCacheReadTokens: number | null;
  runCacheCreationTokens: number | null;
  runProviderCalls: number | null;
}

export interface ThreadEffectiveModel {
  providerId: string;
  modelId: string;
  credentialId: string | null;
  source: 'thread_override' | 'agent_default';
}

export interface ThreadParticipant {
  /** thread_participants row primary key — the stable handle for removal. */
  id: string;
  threadId: string;
  /** FK -> members(id): the participant's principal identity. */
  memberId: string;
  /** 'agent' for AI agents, 'user' for humans. */
  kind: 'agent' | 'user';
  /** Set for agent participants; empty string for non-agent (user) principals. */
  agentId: string;
  role: string;
  credentialId: string | null;
  providerId: string | null;
  modelId: string | null;
  addedAt: string;
  /** Appended to the agent's base system prompt for this thread only. */
  systemPromptAddendum: string | null;
  toolAccessMode: string | null;
  toolAccessAllowList: string[] | null;
  toolAccessDenyList: string[] | null;
  toolOverrides: Record<string, unknown> | null;
  maxToolCallsPerTurn: number | null;
  maxDurationSeconds: number | null;
  autoRespond: boolean;
  disableFallback: boolean;
}

/**
 * One row from `public.thread_summaries`, as returned by
 * `GET /api/threads/:id/agents/:agentId/summaries`. Not to be confused with
 * `ThreadSummary`, which models a thread record.
 */
export interface ThreadSummaryRecord {
  id: string;
  threadId: string;
  agentId: string | null;
  summaryText: string;
  /** Cumulative lifetime coverage across versions (trim bookkeeping). */
  messagesCovered: number;
  /** Messages this compaction folded in — derived server-side, delta vs. prior versions. */
  messagesInWindow: number;
  /** Set when this version is a fold; its counts are turns (replay units), not messages. */
  compaction?: Record<string, unknown> | null;
  lastMessageId: string | null;
  modelUsed: string | null;
  version: number;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One DM conversation as a member sees it (`GET /api/threads/dm`). `unread`
 * counts the messages the viewing member has not read: the agent's own count
 * when the list was asked for an agent, the local user's otherwise.
 */
export interface DmThreadSummary {
  id: string;
  /** Server title, "A ↔ B". */
  title: string;
  /** The other party of the conversation. */
  withName: string;
  withKind: 'agent' | 'user';
  /** Set when the other party is an agent. */
  withAgentId?: string;
  unread: number;
  lastMessageAt: string | null;
}
