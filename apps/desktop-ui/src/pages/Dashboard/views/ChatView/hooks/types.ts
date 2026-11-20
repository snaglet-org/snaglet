import type { ThreadMessage } from '@desktop/utils/api';
import type { PageError } from './useThreadHistory';
import type {
  ClarificationRequestPayload,
  ClarificationAnswer,
  ClarificationStatus,
  ToolConfirmationDecision,
  ToolConfirmationRequestPayload,
} from '@snaglet/shared/types';

/**
 * What an agent's status bubble shows, as the server reports it: a run phase,
 * `queued` when the dispatch will run the agent again for a message sent
 * during its last run, or `compacting`.
 */
export type AgentStatus = 'thinking' | 'typing' | 'tool_running' | 'compacting' | 'queued';

export interface StreamingMessage {
  id: string;
  threadId: string;
  role: 'assistant';
  agentId: string;
  runId: string;
  content: string;
  thinkingContent: string;
  toolActivity: NonNullable<ThreadMessage['toolActivity']>;
  createdAt: string;
}

/**
 * One step inside a run's activity bubble. Either a thinking block
 * (accumulated prose) or a tool call (input + output + status). The
 * server persists these to `agent_activity_log`; the client mirrors them
 * here for live display.
 */
export type ActivityStep =
  | {
      kind: 'thinking';
      id: string;
      text: string;
      /** True while still accumulating chunks. False once flushed (next tool call or run end). */
      live: boolean;
      createdAt: string;
    }
  | {
      kind: 'tool_call';
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      output?: string;
      error?: string;
      success?: boolean;
      durationMs?: number;
      /** running until socket:tool:result arrives. */
      status: 'running' | 'done';
      createdAt: string;
    }
  | {
      /** Inline system notice — e.g. model fallback / cache reset. */
      kind: 'note';
      id: string;
      text: string;
      createdAt: string;
    };

/**
 * Compaction-time memory-extraction notice from a
 * `socket:thread:memory-extraction` frame. Not a message row: it lives only in
 * this pane's state. The payload's `dropped` count is left out because it
 * undercounts by design.
 */
export interface MemoryExtractionNotice {
  /** Client-generated unique id (list key). */
  id: string;
  agentId: string;
  saved: number;
  proposed: number;
  /** Client arrival time (ISO) — sorts the notice into the stream. */
  createdAt: string;
}

/** All activity for a single run. Keyed by runId in the activities map. */
export interface RunActivity {
  runId: string;
  agentId: string;
  threadId: string;
  steps: ActivityStep[];
  /** 'live' = run still in flight; 'complete' = socket:done seen or loaded from DB. */
  status: 'live' | 'complete';
  startedAt: string;
  finishedAt: string | null;
}

export interface UseChatStreamResult {
  /** Combined persisted + streaming messages, sorted by created_at. */
  messages: ThreadMessage[];
  /**
   * Per-run activity bubbles. Each entry holds thinking + tool steps in
   * chronological order, hydrated from agent_activity_log on thread
   * load and from socket events while a run is live. Keyed by runId.
   */
  activities: Map<string, RunActivity>;
  /**
   * agentId → the status its bubble shows: every agent whose turn is running
   * or starting, plus any queued for another run. Empty when there are none.
   */
  agentStatuses: Map<string, AgentStatus>;
  /**
   * Ephemeral memory-extraction notices for this thread, in arrival order.
   * Rendered as quiet meta lines in the stream; cleared on thread change
   * and never persisted.
   */
  memoryExtractions: MemoryExtractionNotice[];
  /** True once the WS session has been confirmed (composer can send). */
  ready: boolean;
  /** True while the initial REST fetch is in flight. */
  loading: boolean;
  /**
   * Why the thread's history or participants failed to load; null when they
   * loaded. While set, an empty transcript or roster is a failure, not an
   * empty thread, and the view should offer `retryHistory`.
   */
  historyError: string | null;
  /** Re-run the failed history load. */
  retryHistory: () => void;
  /** True when at least one agent has an active status or is streaming. */
  working: boolean;
  /**
   * Live wave number (1-indexed) during a multi-wave dispatch; null when idle
   * or during single-wave runs (the continuing frame only fires from wave 2).
   */
  currentWave: number | null;
  /** Number of agent participants on this thread (per REST fetch). */
  participantCount: number;
  /** IDs of agents currently on the thread. Drives the add-agent picker. */
  participantAgentIds: string[];
  /** Re-fetch the participant list — call after add/remove to sync state. */
  refetchParticipants: () => Promise<void>;
  /** Send a user message via the chat handler. No-op until `ready`. */
  sendMessage: (text: string) => void;
  /** Aborts the in-flight run on the server. Safe to call when idle. */
  stopGeneration: () => void;
  /** Aborts one agent's in-flight run without stopping its peers. */
  stopAgentGeneration: (agentId: string) => void;
  /** The agent's pending Ask request, or null. Drives the Q/A form above the composer. */
  pendingClarification: ClarificationRequestPayload | null;
  /** Submit (or dismiss) the user's answers to a clarification request. */
  respondToClarification: (
    callId: string,
    status: ClarificationStatus,
    answers: Record<string, ClarificationAnswer>
  ) => void;
  /** Tool calls currently parked for human approval, in arrival order. */
  pendingToolConfirmations: ToolConfirmationRequestPayload[];
  /** Resolve a parked confirmation and optionally persist an allow-list choice. */
  respondToToolConfirmation: (callId: string, decision: ToolConfirmationDecision) => void;
  /** True when there are messages older than the loaded window. Drives the
   *  "Load more" affordance at the top of the message list. */
  hasMoreOlder: boolean;
  /** True when the loaded window doesn't include the live tail (opened at a
   *  search hit, say); the list auto-loads forward past the bottom. */
  hasMoreNewer: boolean;
  /** True while a paginate-older/-newer fetch is in flight. */
  paginating: boolean;
  /** The last older/newer page that failed to load; null once one loads. */
  pageError: PageError | null;
  /** Prepend an older page (no-op when there's nothing older). */
  loadOlder: () => Promise<void>;
  /** Append a newer page (no-op when caught up to the live tail). */
  loadNewer: () => Promise<void>;
  /** When the hook initialized in `around` mode, the anchor message id
   *  the message list lands on. Null on a regular open. */
  initialFocusMessageId: string | null;
  /**
   * Request id paired with `initialFocusMessageId` (set in the same update,
   * null while a load is in flight). Forwarded to MessageList in place of the
   * raw navigation prop so a new request never meets a stale anchor.
   */
  initialFocusRequestId: number | null;
  /**
   * True when the anchor came from a navigation (held in view and
   * highlighted), false when a trim reload re-centered on it (landed only).
   */
  initialFocusIsNavigation: boolean;
  /** Hint shown when the user sends a group-thread message without @mentioning
   *  any agent. Null when no hint is active. */
  dispatchHint: string | null;
  /** Dismiss the dispatch hint. */
  clearDispatchHint: () => void;
  /** The last send the server rejected before any run started, with the typed
   *  text (so the composer can restore it) and the reason. Null after a
   *  successful send or once the composer has consumed it. */
  lastSendError: { text: string; message: string } | null;
  /** Clear the surfaced send error — call after restoring the text into the
   *  composer so it isn't re-applied. */
  clearSendError: () => void;
}
