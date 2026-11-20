/**
 * Shared types for the per-agent turn (runAgentTurn): the stable per-session
 * dependencies and the mutable orchestrator state shared across sibling turns
 * in the same wave. Types used entirely inside a single phase module should
 * live in that module.
 *
 * Design rules:
 *  - No runtime code in this file — pure types/interfaces only.
 *  - No imports from sibling phase modules (would create a cycle).
 *  - Prefer narrow, single-purpose shapes over wide mega-contexts.
 */

import type { ConversationPassKind, UnattendedWake, WakeOrigin } from '@snaglet/shared/types';
import type { agentService } from '@server/services/AgentService';
import type { ThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import type { ConversationBudget } from '@server/services/ConversationBudget';
import type { MentionContext } from '@server/services/PerceptionService';
import type { WaveTurnResult } from '../chatHelpers';
import type { SocketSession } from '@server/services/SocketService/types';

// runAgentTurn — per-agent turn types
//
// Context splits into two parts:
//  - deps   — services, transport, and constants stable across the whole session.
//  - shared — mutable orchestrator state shared across sibling turns in the same
//             wave (dispatch counters, mention queues, token tallies).
//
// Abort is threaded via AbortSignal on the deps object.

/**
 * Stable per-session dependencies. Built once by the orchestrator and reused
 * for every agent turn in the session.
 */
export interface RunAgentTurnDeps {
  /**
   * The SocketService-level session record (SocketSession), not the
   * per-turn ChatSession. The turn body accesses `session.threadId` directly;
   * typed as SocketSession to preserve that shape.
   */
  readonly session: SocketSession;
  readonly sessionId: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly clientId: string;
  readonly meta: {
    readonly clientId: string;
    readonly channel?: string;
    readonly messageId?: string;
  };
  readonly isGroup: boolean;
  readonly participantAgentIds: readonly string[];
  readonly softDispatchThreshold: number;
  readonly hardDispatchCeiling: number;
  readonly agentTimeoutMs: number;
  /**
   * Per-model-call stream-idle limit in ms (`agent.stream_idle_timeout_seconds`).
   * 0 / undefined = off. See chatPhases/streamIdleWatchdog.ts.
   */
  readonly streamIdleTimeoutMs?: number;

  readonly threadRuntimeConfig: ThreadRuntimeConfig | null;
  readonly activeRunIds: Set<string>;
  readonly previewMessage: (value: string, max?: number) => string;
  readonly toToolText: (value: unknown) => string;
  readonly triggerMessageId: string | undefined;
  /** Agents that have been woken via a mention during this request (mutable). */
  readonly wokenByMention: Set<string>;
  /** Helper: does a mentioned id correspond to a live participant? */
  readonly isParticipantMention: (mentionedId: string) => boolean;
  /** Helper: register a new per-turn agent id with dispatch tracking. */
  readonly startAgent: (id: string) => void;
  /** Hard ceiling on dispatches per agent within a single request. */
  readonly HARD_DISPATCH_CEILING: number;
  /** Shared set of agent ids already dispatched in this wave (mutable). */
  readonly dispatchSet: Set<string>;

  readonly wsService: {
    sendToClient(clientId: string, msg: unknown): void;
    broadcastToChannel(channel: string, msg: unknown): void;
  };
  readonly agentService: typeof agentService;

  readonly abortController: AbortController;
  readonly convBudget: ConversationBudget;
  // `activeRunTracker` is intentionally not in deps: the factory imports the
  // runtime singleton directly, so passing it here would only duplicate the
  // import surface.

  readonly agentNameMap: Map<string, string>;
  readonly agentRoleMap: Map<string, string>;

  readonly resolveParticipantId: (mentionedId: string) => string | undefined;
  readonly buildMentionContext: (agentId: string) => MentionContext | undefined;
  /**
   * Re-read the thread's agent roster if an agent joined or left since the run
   * last read it (dispatch/liveRoster.ts). Awaited before resolving the
   * @-mentions of a reply, an utterance or a mid-run message, so a mention of
   * an agent added during the run wakes it and one of a removed agent does
   * not. `isGroup`, `participantAgentIds`, `agentNameMap`,
   * `resolveParticipantId` and `isParticipantMention` reflect the result.
   * Optional so test doubles may omit it.
   */
  readonly refreshRoster?: () => Promise<void>;

  // Parallel cadence is implicit in the routing mode (set by chatHandlers
  // from thread.dispatch_mode): 'all' and 'mentioned' run parallel. There is no
  // separate `parallelOnMentionSetting`.
  readonly effectiveParallelDispatch: boolean;
  /**
   * Thread-level dispatch routing mode (from threads.dispatch_mode). Threaded
   * into the system prompt so agents in `mentioned` mode know they will only
   * be reached if explicitly @mentioned — and therefore must @mention peers
   * they want to wake.
   */
  readonly dispatchMode: 'all' | 'mentioned';
  /** A DM / home thread (`threads.kind = 'dm'`): no routing or group framing. */
  readonly isDm?: boolean;
  /** A subagent helper's own thread (`threads.parent_thread_id` set). Fixed for the thread's life. */
  readonly isHelperThread?: boolean;

  /**
   * Floor-gated generation (voice threads): pause / resume the dispatch
   * per-agent turn timeout (withTimeout) for `agentId` while its run is parked
   * on the speaking floor, so parked time is not charged against the timeout.
   * Optional — absent for non-voice callers; the
   * turn loop calls them only when a voice session is active.
   * The dispatcher owns the per-turn timer and routes these to it.
   */
  readonly pauseTurnTimeout?: (agentId: string) => void;
  readonly resumeTurnTimeout?: (agentId: string) => void;
  /**
   * True when a newer turn for `agentId` has registered its own controller
   * since the turn owning `controller` started. The end-of-turn teardown skips
   * clearing shared per-agent state (running set, mention/pending queues,
   * floor, turn stats) when superseded, so a timed-out turn abandoned by the
   * dispatch cannot clobber its replacement when it finally settles. Optional —
   * absent means "never superseded".
   */
  readonly isTurnSuperseded?: (agentId: string, controller: AbortController) => boolean;
  /**
   * Set when an automation started this dispatch. Threaded into every
   * tool call's context.
   */
  readonly wakeOrigin?: WakeOrigin;
  /**
   * Set when an automation or a hook started this dispatch: a tool call that
   * would ask a person follows this policy instead of waiting (toolDispatch).
   */
  readonly unattended?: UnattendedWake;
}

/**
 * Mutable orchestrator state shared across sibling turns in a wave.
 * runAgentTurn reads and writes these; the orchestrator owns their lifecycle.
 */
export interface RunAgentTurnSharedState {
  readonly runningAgents: Set<string>;
  readonly agentMentionQueues: Map<string, string[]>;
  readonly agentDispatchCount: Map<string, number>;
  readonly agentSoftThresholdNotified: Set<string>;
  readonly passedAgents: Set<string>;
  /**
   * HOW each agent left the conversation (last write wins) — feeds the
   * conversation stop-reason attribution (an all-passed ending where some
   * agent's final pass was a repetition auto-pass reports 'stagnation') and
   * the structured end-of-run log.
   */
  readonly passKinds: Map<string, ConversationPassKind>;
  /**
   * Replaced (not mutated) at the top of every wave by the orchestrator.
   * `runAgentTurn` reads it as `shared.currentWaveResults` so the freshest
   * array is always observed.
   */
  currentWaveResults: WaveTurnResult[];
  /**
   * Each agent's recent posted replies (newest last, bounded by
   * STAGNATION_POLICY.window) — the comparison window for repetition
   * detection.
   */
  readonly recentRepliesByAgent: Map<string, string[]>;
  /**
   * Consecutive similar-reply strikes per agent. Incremented when a reply is
   * too similar to a recent own reply (the reply still posts), reset by a
   * genuinely different reply; auto-pass at STAGNATION_POLICY.strikesToPass.
   */
  readonly stagnationStrikes: Map<string, number>;
  tokenTotals: { input: number; output: number };
  /** Synced from the orchestrator's outer counter at the top of each wave. */
  conversationRound: number;
}
