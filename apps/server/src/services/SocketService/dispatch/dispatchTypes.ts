/**
 * dispatchTypes — shared type surface for the dispatch wave loop.
 *
 * Extracted verbatim from dispatchToThread.ts. `DispatchResult` and
 * `InternalDispatchDeps` are re-exported from dispatchToThread.ts so every
 * existing importer (`buildDispatchDeps`, `chatHandlers`, …) keeps its current
 * import path unchanged.
 */
import type { parseMentions } from '@server/services/MentionParser';
import type { ConversationStopReason, UnattendedWake, WakeOrigin } from '@snaglet/shared/types';
import type { ThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import type { ConversationBudgetSeed } from '@server/services/ConversationBudget';
import type { SocketSession } from '@server/services/SocketService/types';

type MentionParseResult = ReturnType<typeof parseMentions>;

/**
 * Observable outcome of a dispatch.
 *
 * Tagged on `ok` so callers exhaustively handle the failure modes.
 * `wakeCount` counts agents that ran `runAgentTurn` at least once.
 * `capHit` indicates the wave loop terminated at the conversation wave cap
 * (`ConversationBudget.waveLimitReached`) rather than natural completion.
 */
export type DispatchResult =
  | {
      ok: true;
      wakeCount: number;
      capHit: boolean;
      reason:
        | 'completed'
        | 'cap_hit'
        | 'cancelled'
        | 'no_dispatch'
        | 'queued_for_post_run'
        /** Refused by a summary halt; replayed once the halt lifts. */
        | 'held_for_summary_halt';
      /**
       * Why the conversation ended (stop-reason taxonomy). Absent for outcomes that
       * never ran a wave loop (busy-skip / queued_for_post_run / held / not-found).
       */
      stopReason?: ConversationStopReason;
    }
  | {
      ok: false;
      reason: 'fanout_exceeded';
      wakeCount: 0;
      capHit: false;
    };

/**
 * Internal dispatch dependencies — closed-over locals from the original
 * handleChatSend body that the extracted code needs.
 *
 * Services (wsService, agentService, etc.) are imported directly, matching
 * the original chatHandlers.ts pattern. We only thread through values that
 * cannot be reconstructed inside the function.
 */
export interface InternalDispatchDeps {
  // — Identity / session —
  session: SocketSession;
  sessionId: string;
  threadName: string;
  isGroup: boolean;
  meta: { clientId: string; userId?: string };

  // — Input message —
  message: string;
  triggerMessageId: string | undefined;

  // — Participants / agents —
  participantAgentIds: string[];
  agentNameMap: Map<string, string>;
  agentRoleMap: Map<string, string>;
  resolveParticipantId: (mentionedId: string) => string | undefined;
  isParticipantMention: (mentionedId: string) => boolean;
  /**
   * An agent id left out of the roster: the tool path's sender, so its own
   * post never wakes it. Kept out when a run re-reads the roster (liveRoster).
   */
  rosterExcludeAgentId?: string;
  /**
   * The thread's roster version taken just before `participantAgentIds` was
   * read (rosterVersion.ts), so a run notices a change made in between.
   */
  rosterVersion?: number;

  // — Mention parse result —
  mentions: MentionParseResult;

  // — Dispatch routing —
  dispatchSet: Set<string>;
  dispatchRouting: 'all' | 'mentioned';
  effectiveParallelDispatch: boolean;

  // — Thread runtime config —
  thread: {
    dispatchMode?: 'all' | 'mentioned' | null;
    /** 'dm' for a DM / home thread: no routing, no group framing. */
    kind?: 'chat' | 'dm';
    /** Set for a subagent helper's own thread. */
    parentThreadId?: string | null;
    maxAgentDispatches?: number | null;
  } | null;
  threadRuntimeConfig: ThreadRuntimeConfig | null;

  /**
   * Consumption carried over from an ended run into its self-healing
   * redispatch (undelivered mid-run messages). The continuation shares the
   * ended conversation's budget — see ConversationBudgetSeed. Absent for
   * every genuinely new dispatch.
   */
  budgetSeed?: ConversationBudgetSeed;

  /** The dispatch's wake marker (an automation), passed to every turn. */
  wakeOrigin?: WakeOrigin;

  /**
   * Set when an automation or a hook started this dispatch: nobody is there
   * to confirm a tool call, so its turns follow this policy instead of
   * prompting (see unattendedWake.ts). Absent for a person's dispatch.
   */
  unattended?: UnattendedWake;
}
