/**
 * Socket relay message types — typed WS contracts for agent chat.
 *
 * Client → server messages allow the Snaglet UI (or any consumer) to:
 *   - Create a chat session with a specific agent
 *   - Send messages and receive streaming deltas
 *   - Abort in-progress responses
 *   - Query agent availability
 *
 * Server → client messages deliver session confirmations, response
 * chunks, completion signals, and error reports.
 */

/** Create a new chat session bound to an agent. */
export interface SocketSessionCreateMsg {
  type: 'socket:session:create';
  payload: {
    agentId: string;
    label?: string;
    /** Optional pane ids, echoed back on a rejection so the client can route it. */
    threadId?: string;
    sessionId?: string;
  };
}

/** Send a chat message within an existing session. */
export interface SocketChatSendMsg {
  type: 'socket:chat:send';
  payload: {
    sessionId: string;
    message: string;
    parallelDispatch?: boolean;
    /**
     * Origin of the send. `mention-handoff` bypasses the thread-compacting
     * guard because it's continuation of an in-flight chain, not new user
     * intent. Defaults to `user` when omitted.
     */
    source?: 'user' | 'mention-handoff';
  };
  id?: string;
}

/** Request abort of an in-progress response. */
export interface SocketChatAbortMsg {
  type: 'socket:chat:abort';
  payload: { sessionId: string; agent_id?: string };
}

/** Request the current status of all known agents. */
export interface SocketAgentsListMsg {
  type: 'socket:agents:list';
  payload: null;
}

/** Trigger thread-wide context compaction for all participant agents. */
export interface SocketThreadCompactMsg {
  type: 'socket:thread:compact';
  payload: { sessionId: string };
}

/** Confirms session creation with the assigned session ID. */
export interface SocketSessionCreatedMsg {
  type: 'socket:session:created';
  payload: {
    sessionId: string;
    agentId: string;
    threadId: string;
    title: string | null;
    participantAgentIds?: string[];
    /** Agent IDs the thread shows a status for right now (running, starting or queued). */
    activeAgentIds?: string[];
    /** Each of those agents' status, keyed by agent ID. */
    activeAgentStatuses?: Record<string, AgentShownStatus>;
    /** True when a thread-wide compaction is in progress (so the UI can rehydrate state). */
    compacting?: boolean;
    /** If the session was interrupted, the last partial message to restore in the UI. */
    interruptedMessage?: string;
  };
}

/** Server emitted a persisted chat message that should be rendered immediately. */
export interface SocketChatMessageCreatedMsg {
  type: 'socket:chat:message_created';
  payload: {
    id: string;
    threadId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    agent_id?: string | null;
    created_at?: string;
    message_type?: 'question' | 'message' | 'thread_event';
    response_options?: ResponseOption[] | null;
    resolved?: boolean;
    injected_during_run?: boolean;
    /**
     * Outbound-linter follow-up: when set, this message was auto-authored
     * by the server in response to fabricated node ids in the named
     * agent's previous reply. The body opens with @<that agent>'s handle
     * so the mention dispatch path re-wakes them. UI should render
     * distinctly from a real user message.
     */
    linter_target_agent_id?: string | null;
    /** Ids the linter flagged as not present in `public.nodes`. */
    fabricated_ids?: string[];
    /**
     * Run-failure descriptor: when set, this message is a system-style
     * notice that an agent run hit an error (timeout, model failure,
     * rate limit, runtime exception). The UI renders it as a distinct
     * error bubble; the failing agent's id sits on `agent_id` so the
     * bubble can be attributed in the chrome.
     */
    run_error?: ChatRunErrorPayload;
  };
}

/**
 * A persisted message's content was edited through
 * PATCH /threads/:threadId/messages/:messageId (e.g. a checkbox toggle).
 * Broadcast to the thread's room only after the update succeeds, to every
 * viewer including the editor. Clients replace the content of the message
 * with this id and ignore an id they do not hold.
 */
export interface SocketChatMessageUpdatedMsg {
  type: 'socket:chat:message_updated';
  payload: {
    threadId: string;
    id: string;
    content: string;
    /** When the edit was saved, ISO 8601 UTC. */
    updatedAt: string;
  };
}

/**
 * Why an agent's run failed. `no_model` means the agent has no usable model
 * and never started a run: the fix is on the agent's page, not in the thread.
 * `output_limit` means the reply stopped at the model's output limit, so it
 * is missing or ends mid-way.
 */
export type RunErrorKind =
  | 'timeout'
  | 'model_failure'
  | 'rate_limit'
  | 'runtime'
  | 'aborted'
  | 'no_model'
  | 'output_limit';

/** Structured shape carried on a `socket:chat:message_created` for run failures. */
export interface ChatRunErrorPayload {
  kind: RunErrorKind;
  summary: string;
  provider?: string | null;
  model_id?: string | null;
  agent_name?: string | null;
}

/** Streaming text chunk from the agent — one chunk per token/word. */
export interface SocketDeltaMsg {
  type: 'socket:delta';
  payload: { sessionId: string; text: string; agentId?: string; runId?: string };
}

/**
 * Token usage for one run, summed across every provider call the run made.
 *
 * A run is not a single provider call: the turn loop calls the provider once
 * per tool cycle and re-sends the whole prompt each time, so the prompt is
 * billed again on every cycle. `billedInputTokens` is therefore the honest
 * cost figure (Σ per-call input), while `inputTokens` on `SocketDoneMsg.usage`
 * remains the last call's prompt size — the context-window proxy the
 * compaction detector in MessageList compares across messages. The two mean
 * different things and must not be conflated.
 */
export interface RunTokenUsagePayload {
  /** Σ over provider calls of that call's input (fresh + cache read + cache creation). */
  billedInputTokens: number;
  /** Σ over provider calls of output tokens. */
  outputTokens: number;
  /** Σ over provider calls of cache-read input tokens (billed at ~10% of fresh). */
  cacheReadTokens: number;
  /**
   * Σ over provider calls of cache-CREATION input tokens (billed at ~125% of
   * fresh). Already included inside `billedInputTokens` — this is a breakdown
   * figure for display, not an addend. Anthropic is the only provider that
   * reports it today; elsewhere it stays 0.
   */
  cacheCreationTokens: number;
  /** Provider calls this run has started. */
  providerCalls: number;
}

/**
 * Incremental token usage for an in-flight run, emitted while it executes so
 * the message bubble can show the counter climbing. Coalesced server-side
 * (see runTokenMeter) — never one frame per provider event.
 */
export interface SocketRunUsageMsg {
  type: 'socket:run:usage';
  payload: RunTokenUsagePayload & {
    sessionId: string;
    threadId: string;
    agentId: string;
    runId: string;
    /** True on the last frame of the run; the totals are then final. */
    final: boolean;
  };
}

/** Signals that the agent has finished responding. */
export interface SocketDoneMsg {
  type: 'socket:done';
  payload: {
    sessionId: string;
    reply: string;
    durationMs: number;
    agentId?: string;
    runId?: string;
    usage?: {
      /**
       * The last provider call's prompt size. A context-window proxy, not a
       * billed total — MessageList reads it to detect compaction by watching
       * this shrink between an agent's messages.
       */
      inputTokens?: number;
      /** Σ output tokens across the run's provider calls. */
      outputTokens?: number;
      contextWindowTokens?: number;
      /** Σ input tokens across the run's provider calls — the billed figure. */
      billedInputTokens?: number;
      /** Σ cache-read input tokens across the run's provider calls. */
      cacheReadTokens?: number;
      /** Provider calls the run made. */
      providerCalls?: number;
      /** Times the run compacted its own context mid-run; absent when it never did. */
      runCompactions?: number;
    };
    messageType?: 'question' | 'message';
    responseOptions?: ResponseOption[] | null;
    passed?: boolean;
  };
}

export interface ResponseOption {
  label: string;
  value: string;
}

/** Agent typing state changed for the session. */
export interface SocketAgentTypingMsg {
  type: 'socket:agent:typing';
  payload: {
    sessionId: string;
    agentId: string;
    isTyping: boolean;
  };
}

/**
 * What an agent's status bubble shows: a run phase, or `queued` when the
 * dispatch will run the agent again for a message sent during its last run.
 */
type AgentShownStatus = 'thinking' | 'typing' | 'tool_running' | 'queued';

/** Agent runtime status changed for the session. */
export interface SocketAgentStatusMsg {
  type: 'socket:agent:status';
  payload: {
    sessionId: string;
    agentId: string;
    status: 'idle' | AgentShownStatus;
  };
}

/** Agent status list in response to socket:agents:list. */
export interface SocketAgentsMsg {
  type: 'socket:agents';
  payload: {
    agents: Array<{ id: string; label: string; status: 'online' | 'offline' | 'unknown' }>;
  };
}

/** Server notifies client that the agent is calling a tool. */
export interface SocketToolCallMsg {
  type: 'socket:tool:call';
  payload: {
    sessionId: string;
    callId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    requiresConfirmation: boolean;
  };
}

/** Server sends tool execution result to client. */
export interface SocketToolResultMsg {
  type: 'socket:tool:result';
  payload: {
    sessionId: string;
    callId: string;
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
  };
}

/** Client confirms or denies a tool call that requires confirmation. */
export interface SocketToolConfirmMsg {
  type: 'socket:tool:confirm';
  payload: import('./tool-confirmation').ToolConfirmationResponsePayload;
}

/** Notifies client which model an agent is actually using (including after fallback). */
export interface SocketAgentModelMsg {
  type: 'socket:agent:model';
  payload: {
    sessionId: string;
    agentId: string;
    providerId: string;
    modelId: string;
    source: string;
  };
}

/**
 * Notifies the client that the previous model candidate failed and the run is
 * retrying with the next candidate in the chain. Only emitted when the failed
 * candidate was not a user-pinned override — pinned overrides surface a
 * `socket:error` instead and stop the run.
 */
export interface SocketAgentModelFallbackMsg {
  type: 'socket:agent:model:fallback';
  payload: {
    sessionId: string;
    agentId: string;
    fromProviderId: string;
    fromModelId: string;
    toProviderId: string;
    toModelId: string;
    reason: string;
  };
}

/**
 * The current provider stream ended transiently and will be retried once with
 * the same model. Clients must discard deltas for this run before new chunks
 * arrive so partial output from the failed attempt is not concatenated.
 */
export interface SocketAgentStreamRetryMsg {
  type: 'socket:agent:stream:retry';
  payload: {
    sessionId: string;
    agentId: string;
    runId: string | null;
    delayMs: number;
  };
}

/** Streaming thinking/reasoning chunk from the agent during extended thinking. */
export interface SocketThinkingChunkMsg {
  type: 'socket:thinking:chunk';
  payload: { sessionId: string; agentId?: string; text: string; runId?: string };
}

/** Agent is starting another response round within the same conversation turn. */
export interface SocketAgentContinuingMsg {
  type: 'socket:agent:continuing';
  payload: { sessionId: string; agentId: string };
}

/** Error response for any failed socket operation. */
export interface SocketThreadSummaryMsg {
  type: 'socket:thread:summary';
  payload: {
    threadId: string;
    agentId: string;
    summaryId: string;
    messagesCovered: number;
    summaryText: string;
  };
}

export interface SocketErrorMsg {
  type: 'socket:error';
  payload: {
    sessionId?: string;
    threadId?: string;
    agentId?: string;
    runId?: string | null;
    /** Set when the error ends an agent's turn and its kind is known. */
    kind?: RunErrorKind;
    message: string;
  };
}

/**
 * Thread compaction started. Without `agentId` this is a thread-wide compact
 * (all participants). With `agentId` it's the per-agent path triggered from
 * the context-window viewer's Compact button.
 */
export interface SocketThreadCompactStartedMsg {
  type: 'socket:thread:compact:started';
  payload: { threadId: string; totalAgents: number; agentId?: string };
}

/** Progress update as each agent's compaction completes. */
export interface SocketThreadCompactProgressMsg {
  type: 'socket:thread:compact:progress';
  payload: { threadId: string; completed: number; total: number; agentId: string };
}

/** Compaction finished successfully. `agentId` set on the per-agent path. */
export interface SocketThreadCompactCompleteMsg {
  type: 'socket:thread:compact:complete';
  payload: { threadId: string; totalAgents: number; durationMs: number; agentId?: string };
}

/** Compaction failed or was aborted. `agentId` set on the per-agent path. */
export interface SocketThreadCompactErrorMsg {
  type: 'socket:thread:compact:error';
  payload: { threadId: string; message: string; agentId?: string };
}

/**
 * Compaction-time memory extraction wrote something for one agent: the deltas
 * the UI can surface ("N memories saved, M proposed"). Emitted best-effort
 * after `socket:thread:compact:complete` (extraction is fire-and-forget), and
 * only when saved or proposed is non-zero. `proposed` counts member-scoped
 * facts stored inert, awaiting explicit human approval; `duplicates` counts
 * writes that refreshed an existing key instead of adding a row; `dropped`
 * counts candidates discarded (invalid, ambiguous owner, or failed save).
 */
export interface SocketThreadMemoryExtractionMsg {
  type: 'socket:thread:memory-extraction';
  payload: {
    threadId: string;
    agentId: string;
    saved: number;
    proposed: number;
    duplicates?: number;
    dropped: number;
  };
}
