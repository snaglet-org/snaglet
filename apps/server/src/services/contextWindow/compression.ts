/**
 * Sliding-window compression — folds old turns into a compaction prefix while
 * keeping the recent window verbatim, without mutating the original array, so
 * agents with different context windows get independent views.
 */

import type { ProviderMessage, TextMessage } from '@server/services/ProviderChatService';
import { estimateSessionTokens } from '@server/services/TokenEstimator';
import { logger } from '@server/config/logger';
import { TURN_CONTEXT_SENTINEL } from '@server/services/SystemPromptComposer/composeTurnContextTail';
import {
  THREAD_EVENT_ABORT_LINE_PATTERN,
  THREAD_EVENT_LINE_PREFIXES,
} from '@server/services/SocketService/threadEvents';
import {
  RELAYED_LEGEND,
  RELAYED_OPEN,
} from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import type { ContextBudget } from './budget';
import { buildSummary } from './toolResultSummary';
import { buildCompactionSummaryMessage } from './compactionMessage';
import { MAX_DERIVED_TAIL_MESSAGES, SUMMARY_DISCLAIMER, TAIL_BUDGET_FRACTION } from './constants';

export interface CompressionResult {
  messages: ProviderMessage[];
  compressed: boolean;
  originalCount: number;
  keptCount: number;
  estimatedTokens: number;
}

/**
 * Whether a message is a genuine human conversational turn — the thing
 * buildActiveRequestReminder re-pins when compression folds it away. Excludes
 * role='user' shapes that are not the human speaking (the turn-context tail,
 * thread_event narration lines), or the always-last tail would win this scan
 * every time and the reminder would never fire.
 */
function isConversationalUserMessage(message: ProviderMessage): boolean {
  if (message.role !== 'user') return false;
  // The per-turn ephemeral tail (turn-context block) is never a human turn.
  // Prefer the structural flag; the TURN_CONTEXT_SENTINEL prefix check below
  // is a fallback for messages without it.
  if ((message as { ephemeral?: boolean }).ephemeral === true) return false;
  if (typeof message.content === 'string') {
    const trimmed = message.content.trim();
    if (trimmed.length === 0) return false;
    if (trimmed.startsWith(TURN_CONTEXT_SENTINEL)) return false;
    if (THREAD_EVENT_LINE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return false;
    if (THREAD_EVENT_ABORT_LINE_PATTERN.test(trimmed)) return false;
    return true;
  }

  const blocks = message.content;
  // A user turn that carries a tool_result is a tool-cycle turn, not a genuine
  // human conversational message: in a live tool loop, peer/user injections and
  // loop-breaking nudges get folded into the tool_result user turn (see
  // toolDispatch: `[...toolResults, ...appendedText]`), so it looks "textual"
  // but its tool_use lives in the paired assistant message. Re-pinning it above
  // the recent window (via buildActiveRequestReminder) would orphan that
  // tool_result — the exact compaction-boundary 400 (`unexpected tool_use_id`)
  // this scan must never cause. Exclude it; the real human request is a plain
  // user message (or a pure text/image turn) elsewhere in the history.
  if (
    blocks.some(
      (block) =>
        block && typeof block === 'object' && 'type' in block && block.type === 'tool_result'
    )
  ) {
    return false;
  }
  return blocks.some((block) => {
    if (!block || typeof block !== 'object' || !('type' in block)) return false;
    return block.type === 'text' || block.type === 'image';
  });
}

function buildActiveRequestReminder(message: ProviderMessage): ProviderMessage {
  if (typeof message.content === 'string') {
    return {
      role: 'user',
      content: [
        '[Active user request — answer this directly after completing any necessary tool calls]',
        message.content,
      ].join('\n'),
    };
  }

  // Array (multimodal) content: return a copy with any tool_result blocks
  // stripped, so a re-pinned reminder can never reintroduce an orphaned
  // tool_result above the recent window. isConversationalUserMessage already
  // rejects tool_result-bearing turns, so in practice only text/image blocks
  // pass through — this guards against a change in that selection. If
  // stripping would empty the message, fall back to the original
  // (it cannot have been selected as a conversational turn anyway).
  const safeBlocks = message.content.filter(
    (block) =>
      !(block && typeof block === 'object' && 'type' in block && block.type === 'tool_result')
  );
  return safeBlocks.length > 0
    ? ({ role: 'user', content: safeBlocks } as ProviderMessage)
    : message;
}

/** A peer agent's message as replay renders it for another agent: relay-framed assistant text. */
function isRelayedPeerMessage(message: ProviderMessage): boolean {
  return (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    (message.content.startsWith(RELAYED_OPEN) || message.content.startsWith(RELAYED_LEGEND))
  );
}

/**
 * Locate the current-run boundary: the index of the first message of the
 * trailing run of plain user-role turns (the trigger, narration lines, the
 * turn-context tail). Tool cycles and assistant turns end the backward walk;
 * returns messages.length when there is no pending inbound turn. A run started
 * by a peer (subagent brief, @mention) also includes the relay-framed peer
 * message just before, so compression never folds the request being worked
 * on. Capture once at run start and pass it on every iteration: the payload
 * is append-only during a run, so the index stays valid.
 */
export function findCurrentRunBoundary(messages: readonly ProviderMessage[]): number {
  let boundary = messages.length;
  while (boundary > 0) {
    const candidate = messages[boundary - 1]!;
    if (candidate.role !== 'user') break;
    if (
      Array.isArray(candidate.content) &&
      candidate.content.some(
        (block) =>
          block && typeof block === 'object' && 'type' in block && block.type === 'tool_result'
      )
    ) {
      break;
    }
    boundary--;
  }
  const hasHumanTrigger = messages.slice(boundary).some(isConversationalUserMessage);
  if (!hasHumanTrigger && boundary > 0 && isRelayedPeerMessage(messages[boundary - 1]!)) {
    boundary--;
  }
  return boundary;
}

/**
 * Produce a compressed message array if the session exceeds the budget.
 * Returns the original array unchanged if no compression is needed.
 */
export function compressMessages(
  messages: ProviderMessage[],
  budget: ContextBudget,
  systemPrompt: string | undefined,
  /**
   * Summary text to ride the compaction prefix message when compression trims.
   * The turn path passes null: the thread digest (SummaryService) is never agent context, and a
   * fold's real summary is a persisted compaction that replay applies before this runs, so the
   * trimmed span gets an inline fallback digest synthesized from the trimmed messages. Only the
   * post-Compact estimate path passes text, which also gates the force path.
   */
  threadSummary?: string | null,
  /**
   * Skip the threshold + minimum-message guards and trim anyway, as long
   * as a stored summary is available to cover the trimmed span. Used by
   * the post-compact UI estimate path so the user sees their token count
   * actually drop after clicking Compact — even on threads that haven't
   * reached the automatic-compression threshold yet. The runtime path
   * (runAgentTurn) leaves this `false` so short threads keep their
   * full fidelity when the trim isn't actually needed.
   */
  applySummaryUnconditionally?: boolean,
  /**
   * Roster + dispatch-mode snapshot to carry into the compaction summary.
   * Roster/mode live in append-only `thread_event` messages
   * that get folded away when old turns are summarized; restating them here
   * keeps that state in the agent's perceivable context. Optional — the UI
   * estimate path passes nothing.
   */
  carryForward?: string | null,
  /**
   * Log at debug instead of info. The UI usage-estimation path
   * (estimateThreadUsage) runs this same compression as a read-only mirror —
   * nothing is compacted or written — so its passes must not land in the log
   * as if the live turn path had compressed the thread.
   */
  quiet?: boolean,
  /**
   * Index of the first message of the current (in-flight) run (see
   * findCurrentRunBoundary). Messages from here on are the run's working
   * state: never folded into the summary and never counted against the
   * derived-tail clamp, so a small-budget model keeps its own earlier tool
   * exchanges. If the working state alone exceeds the budget, a [context]
   * warning is logged; folding the run itself is runCompaction's job. Omitted
   * by the usage estimator and other non-turn callers.
   */
  currentRunBoundary?: number
): CompressionResult {
  const log = quiet ? logger.debug.bind(logger) : logger.info.bind(logger);
  const estimated = estimateSessionTokens(messages, systemPrompt, budget.provider, budget.modelId);

  // Current-run protection (see the param doc). Clamp garbage input to the
  // array, then pull the boundary back over any tool_result-bearing user turn
  // sitting exactly at it, so the protected tail can never open with a
  // tool_result whose paired tool_use folded into the summary (the exact
  // compaction-boundary 400 the split guard below exists to prevent).
  const hasBoundary = typeof currentRunBoundary === 'number' && Number.isFinite(currentRunBoundary);
  let boundary = hasBoundary
    ? Math.min(Math.max(Math.floor(currentRunBoundary), 0), messages.length)
    : messages.length;
  while (
    hasBoundary &&
    boundary > 0 &&
    boundary < messages.length &&
    messages[boundary].role === 'user' &&
    Array.isArray(messages[boundary].content) &&
    (messages[boundary].content as Array<{ type: string }>).some((b) => b.type === 'tool_result')
  ) {
    boundary--;
  }

  // Capacity honesty: if the current run's own messages alone exceed the
  // usable message budget, no amount of history compression can make this
  // payload fit — say so loudly (matching the budget resolver's "overhead
  // does not fit" style) instead of silently mangling the run's working
  // state. Protection still applies; the in-run compaction pass after this
  // one is what may fold the run.
  const protectedTailTokens =
    hasBoundary && boundary < messages.length
      ? estimateSessionTokens(messages.slice(boundary), undefined, budget.provider, budget.modelId)
      : 0;
  if (protectedTailTokens > budget.usableBudget) {
    logger.warn(
      `[context] current run does not fit ${budget.provider}/${budget.modelId}: ` +
        `the run's own exchanges (${messages.length - boundary} messages since the triggering ` +
        `message) estimate ${protectedTailTokens} tokens against a usable message budget of ` +
        `${budget.usableBudget}. History compression keeps them verbatim; in-run compaction ` +
        `folds the oldest of them next if it can, otherwise expect provider-side truncation or errors.`
    );
  }

  const forceSummary =
    applySummaryUnconditionally === true &&
    threadSummary != null &&
    threadSummary.length > 0 &&
    messages.length >= 2; // need at least one old + one recent to split

  if (
    !forceSummary &&
    (estimated <= budget.tokenThreshold || messages.length < budget.minMessagesBeforeCompression)
  ) {
    return {
      messages,
      compressed: false,
      originalCount: messages.length,
      keptCount: messages.length,
      estimatedTokens: estimated,
    };
  }

  // With a current-run boundary, only messages before it are compressible;
  // the protected tail is carried through verbatim below regardless of size.
  const compressibleCount = hasBoundary ? boundary : messages.length;
  if (hasBoundary && compressibleCount === 0) {
    // The whole payload is the current run (fresh thread, or a garbage
    // boundary clamped to 0) — nothing may fold. Return unchanged; the
    // capacity warning above already fired if it doesn't fit.
    return {
      messages,
      compressed: false,
      originalCount: messages.length,
      keptCount: messages.length,
      estimatedTokens: estimated,
    };
  }

  // Size the recent window from the token budget:
  // fit the verbatim tail in TAIL_BUDGET_FRACTION of usable budget, capped at
  // MAX_DERIVED_TAIL_MESSAGES, so tail size scales with the model window. A
  // model-metadata tailMessages override (budget.tailMessages) wins outright.
  // With a boundary, the window is sized over the compressible history only,
  // and the protected tail never counts against the clamp — but the budget it
  // already consumes comes off the top, so history keeps what genuinely fits
  // beside the run's own working state (floored at 0: protecting the run can
  // starve the history window entirely, never the other way around).
  const avgTokensPerMessage = hasBoundary
    ? estimateSessionTokens(
        messages.slice(0, compressibleCount),
        systemPrompt,
        budget.provider,
        budget.modelId
      ) / compressibleCount
    : estimated / messages.length;
  const historyBudget = hasBoundary
    ? Math.max(0, budget.usableBudget - protectedTailTokens)
    : budget.usableBudget;
  const derivedTail = Math.min(
    Math.floor((historyBudget * TAIL_BUDGET_FRACTION) / avgTokensPerMessage),
    MAX_DERIVED_TAIL_MESSAGES
  );
  const recentCount = Math.max(
    // Floor of 1 without a boundary. With one, the history window may
    // legitimately be 0 — the protected tail supplies the visible working
    // context, so folding all old history is correct under pressure.
    hasBoundary ? 0 : 1,
    Math.min(
      budget.tailMessages ?? derivedTail,
      compressibleCount - 1 // keep at least 1 old message to summarize
    )
  );
  log(
    `[context] tail sizing: derived=${derivedTail} override=${budget.tailMessages ?? 'none'} ` +
      `avgTokens/msg=${Math.round(avgTokensPerMessage)} usable=${budget.usableBudget} → recent=${recentCount}` +
      (hasBoundary ? ` (+${messages.length - boundary} current-run messages protected)` : '')
  );

  // Advance splitIndex forward past any user messages whose content begins
  // with a tool_result block. Slicing inside a tool_use → tool_result pair
  // would orphan the tool_result (the assistant tool_use ends up in the
  // summarized oldMessages, leaving the tool_result with no matching tool_use
  // in the recent window). Anthropic rejects this with "messages.N.content.M:
  // unexpected `tool_use_id` found in `tool_result` blocks".
  // With a boundary the walk is capped at it — the split may consume the whole
  // compressible history, but never advances into the protected current run.
  let splitIndex = compressibleCount - recentCount;
  while (
    splitIndex < compressibleCount &&
    messages[splitIndex].role === 'user' &&
    Array.isArray(messages[splitIndex].content) &&
    (messages[splitIndex].content as Array<{ type: string }>).some((b) => b.type === 'tool_result')
  ) {
    splitIndex++;
  }
  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);
  let latestUserRequestIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isConversationalUserMessage(messages[i]!)) {
      latestUserRequestIndex = i;
      break;
    }
  }
  const activeRequestReminder =
    latestUserRequestIndex >= 0 && latestUserRequestIndex < splitIndex
      ? buildActiveRequestReminder(messages[latestUserRequestIndex]!)
      : null;

  // Stored-summary routing: a stored summary can't sit in the system prompt
  // (system is byte-identical and thread-constant), so it is injected here as
  // the compaction prefix message; with none yet, an inline digest of the
  // trimmed span is synthesized. Either way the roster + dispatch mode are
  // carried forward. A summary regeneration busts only the message prefix,
  // not the system prefix.
  const carryLine = carryForward && carryForward.trim() ? carryForward.trim() : null;
  const summaryMessage: TextMessage = threadSummary
    ? buildCompactionSummaryMessage(threadSummary, carryLine)
    : {
        role: 'user',
        content: buildSummary(oldMessages, budget.maxSummaryChars, carryLine),
      };

  // Tool-heavy loops can push the live user request outside the sliding
  // window. Preserve it explicitly so the model does not mistake an older
  // thread summary for the current instruction.
  const compressed = [
    summaryMessage,
    ...(activeRequestReminder ? [activeRequestReminder] : []),
    ...recentMessages,
  ];
  const compressedTokens = estimateSessionTokens(
    compressed,
    systemPrompt,
    budget.provider,
    budget.modelId
  );

  const protectedCount = messages.length - boundary;
  log(
    `[context] Compressed ${messages.length} messages → summary + ${recentMessages.length} recent ` +
      (hasBoundary
        ? `(${recentMessages.length - protectedCount} history + ${protectedCount} current-run, protected) `
        : '') +
      `(${threadSummary ? 'stored summary' : 'synthesized digest'}` +
      `${carryLine ? ' + roster carry-forward' : ''} as messages[0], ` +
      `${estimated} est. tokens → ${compressedTokens}, budget: ${budget.tokenThreshold})`
  );

  return {
    messages: compressed,
    compressed: true,
    originalCount: messages.length,
    keptCount: recentMessages.length,
    estimatedTokens: compressedTokens,
  };
}
