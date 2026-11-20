/**
 * runCompactor — in-run context compaction for one model attempt.
 *
 * promptBuilder calls `compact` when a payload is still over the trigger after
 * tool-result condensing and history compression — i.e. the run's own
 * exchanges are what does not fit. The oldest part of the run (span rules in
 * contextWindow/runCompaction) is summarized as task state by the agent's
 * summary model (the same resolution SummaryService uses) and replaced, in the
 * run's message array, by one `[Earlier in this run, summarized]` message.
 *
 * Failure never fails the run: no summary model, a failed/slow call or an
 * unusable reply each fall back to a deterministic digest of the span, with a
 * warning. With COMPACT_CONVERSATIONS=false no model is asked and nothing is
 * persisted. A Stop (the run's abort signal) still aborts.
 *
 * `record` logs the one info line per compaction and persists the summary as
 * an activity row on the run (see runCompactionRecord for why it lives there).
 * The step is broadcast like a tool call so the run's activity shows it live.
 */

import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { isConversationCompactionEnabled } from '@server/config/conversationCompactionPolicy';
import {
  applyRunCompaction,
  buildRunSpanDigest,
  runSummaryMaxOutputTokens,
  selectRunCompactionSpan,
  spanMessagesToFold,
  type ContextBudget,
  type RunCompactionSpan,
} from '@server/services/ContextWindowService';
import {
  RUN_COMPACTION_ACTIVITY_TOOL,
  type RunCompactionActivityInput,
  type RunCompactionActivityOutput,
  type RunCompactionSource,
} from '@server/services/contextWindow/runCompactionRecord';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import { LogsService } from '@server/services/LogsService';
import { generateUtilityText } from '@server/services/summary/generateUtilityText';
import {
  buildRunSummaryInstructions,
  buildRunSummaryPrompt,
  renderRunSpanForSummary,
} from '@server/services/summary/runSummaryPrompts';
import { applySummaryQualityFloor } from '@server/services/summary/summaryQualityFloor';
import { resolveUtilityModel } from '@server/services/summary/UtilityModelResolver';
import { THREAD_EVENT_LINE_PREFIXES } from '@server/services/SocketService/threadEvents';
import { RELAYED_CLOSE, RELAYED_LEGEND, RELAYED_OPEN } from './replayAssembly';

/** Longest goal text handed to the summarizer (and never over a quarter of its input). */
const GOAL_MAX_CHARS = 4_000;
/** Room for the instructions, labels and goal around the transcript. */
const PROMPT_FRAME_CHARS = 2_000;
/** A local summarizer may first wait for the single local-provider slot. */
const SLOT_WAIT_MARGIN_MS = 30_000;
/** ~chars per token, for the digest's size cap (summary subsystem heuristic). */
const DIGEST_CHARS_PER_TOKEN = 3.5;

type RunCompactionBroadcast = (message: {
  type: 'socket:tool:call' | 'socket:tool:result';
  payload: Record<string, unknown>;
}) => void;

interface RunCompactorContext {
  readonly threadId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly runId: string;
  readonly sessionId: string;
  /** Where the run's head (trigger + turn-context tail) starts. */
  readonly currentRunBoundary: number;
  /** Length of the message array when the turn loop started appending to it. */
  readonly runStartIndex: number;
  readonly abortSignal: AbortSignal;
  readonly broadcast?: RunCompactionBroadcast;
}

interface RunCompactionOutcome {
  /** 1-based count of compactions in this run. */
  readonly compaction: number;
  readonly callId: string;
  readonly foldedMessages: number;
  readonly foldedCycles: number;
  readonly keptMessages: number;
  readonly tokensBefore: number;
  readonly summary: string;
  readonly source: RunCompactionSource;
  readonly modelUsed: string | null;
  readonly fallbackReason: string | null;
  /** False under COMPACT_CONVERSATIONS=false: nothing is stored. */
  readonly persist: boolean;
  readonly startedAt: number;
}

export interface RunCompactor {
  /**
   * Compact `messages` in place if a span qualifies. Call only when the built
   * payload is over `budget.tokenThreshold`. Returns null when nothing folded.
   * Rejects with an AbortError when the run is stopped meanwhile.
   */
  compact(
    messages: ProviderMessage[],
    budget: ContextBudget,
    payloadTokens: number
  ): Promise<RunCompactionOutcome | null>;
  /** Log, broadcast and persist a compaction once the payload was rebuilt. */
  record(outcome: RunCompactionOutcome, tokensAfter: number, budget: ContextBudget): Promise<void>;
  /** Compactions so far in this run. */
  count(): number;
  /**
   * The front of the message list lost `removed` messages (a history fold): the run's head and
   * start indexes move up by that much.
   */
  shiftIndexes(removed: number): void;
}

function abortError(): DOMException {
  return new DOMException('run aborted during context compaction', 'AbortError');
}

/** Reject as soon as `signal` aborts, whatever `work` is still doing. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function messageText(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The run's request: its head minus the ephemeral turn-context tail and
 * thread-event narration, relay framing removed.
 */
function runGoalText(
  messages: readonly ProviderMessage[],
  currentRunBoundary: number,
  runStartIndex: number,
  maxChars: number
): string {
  const head = messages
    .slice(Math.max(0, currentRunBoundary), Math.max(0, runStartIndex))
    .filter((message) => (message as { ephemeral?: boolean }).ephemeral !== true)
    .map((message) =>
      messageText(message)
        .replace(RELAYED_LEGEND, '')
        .split('\n')
        .filter((line) => line.trim() !== RELAYED_OPEN && line.trim() !== RELAYED_CLOSE)
        .join('\n')
        .trim()
    )
    .filter((text) => !THREAD_EVENT_LINE_PREFIXES.some((prefix) => text.startsWith(prefix)))
    .filter((text) => text.length > 0)
    .join('\n\n');
  return head.length > maxChars
    ? `${head.slice(0, maxChars)}… [+${head.length - maxChars} chars]`
    : head;
}

export function createRunCompactor(initial: RunCompactorContext): RunCompactor {
  let compactions = 0;
  // The two indexes follow the list when a history fold shortens it from the front.
  let ctx = initial;

  const broadcast = (
    type: 'socket:tool:call' | 'socket:tool:result',
    payload: Record<string, unknown>
  ): void => {
    try {
      ctx.broadcast?.({
        type,
        payload: { sessionId: ctx.sessionId, agentId: ctx.agentId, runId: ctx.runId, ...payload },
      });
    } catch (err) {
      LogsService.warn('run compaction broadcast failed', { error: getErrorMessage(err) });
    }
  };

  /** Model-written summary, or null plus the reason it could not be had. */
  const summarize = async (
    messages: readonly ProviderMessage[],
    span: RunCompactionSpan,
    folded: ProviderMessage[],
    maxOutputTokens: number
  ): Promise<{ text: string | null; modelUsed: string | null; reason: string | null }> => {
    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: ctx.threadId,
      agentId: ctx.agentId,
    });
    if (!resolution.ok) {
      return {
        text: null,
        modelUsed: null,
        reason: `no summary model: ${resolution.reason}${resolution.detail ? ` (${resolution.detail})` : ''}`,
      };
    }
    const model = resolution.model;
    const modelUsed = `${model.providerId}/${model.modelId}`;
    // A small local summarizer gets proportionally less of each part; the
    // transcript keeps at least a quarter of its input.
    const quarter = Math.floor(model.maxInputChars / 4);
    const goal = runGoalText(
      messages,
      ctx.currentRunBoundary,
      ctx.runStartIndex,
      Math.min(GOAL_MAX_CHARS, quarter)
    );
    const transcriptBudget = Math.max(
      quarter,
      model.maxInputChars - goal.length - (span.previousSummary?.length ?? 0) - PROMPT_FRAME_CHARS
    );
    const userMessage = buildRunSummaryPrompt({
      goal,
      previousSummary: span.previousSummary,
      transcript: renderRunSpanForSummary(folded, transcriptBudget),
      foldedMessages: folded.length,
    });

    const deadline = new AbortController();
    const deadlineMs = model.timeoutMs + SLOT_WAIT_MARGIN_MS;
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const onRunAbort = (): void => deadline.abort();
    ctx.abortSignal.addEventListener('abort', onRunAbort, { once: true });
    let truncated = false;
    try {
      const raw = await untilAborted(
        generateUtilityText(model, {
          system: buildRunSummaryInstructions(maxOutputTokens),
          userMessage,
          maxOutputTokens,
          signal: deadline.signal,
          onResult: (meta) => {
            truncated = meta.truncated;
          },
        }),
        deadline.signal
      );
      const verdict = applySummaryQualityFloor(raw, {
        providerTruncated: truncated,
        // Sectioned notes often end on a path or value, which a
        // terminal-punctuation check would reject.
        structured: true,
        maxChars: maxOutputTokens * 6,
      });
      if (!verdict.ok) return { text: null, modelUsed, reason: `${modelUsed}: ${verdict.problem}` };
      return { text: verdict.text, modelUsed, reason: null };
    } catch (err) {
      if (ctx.abortSignal.aborted) throw abortError();
      const reason = deadline.signal.aborted
        ? `${modelUsed}: no summary within ${deadlineMs}ms`
        : `${modelUsed}: ${getErrorMessage(err)}`;
      return { text: null, modelUsed, reason };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onRunAbort);
    }
  };

  return {
    count: () => compactions,

    shiftIndexes(removed) {
      if (!Number.isFinite(removed) || removed <= 0) return;
      ctx = {
        ...ctx,
        currentRunBoundary: Math.max(0, ctx.currentRunBoundary - removed),
        runStartIndex: Math.max(0, ctx.runStartIndex - removed),
      };
    },

    async compact(messages, budget, payloadTokens) {
      if (ctx.abortSignal.aborted) throw abortError();
      if (payloadTokens <= budget.tokenThreshold) return null;
      const span = selectRunCompactionSpan(messages, ctx.runStartIndex, budget);
      if (!span) {
        logger.debug(
          `[context] run ${ctx.runId} over threshold (${payloadTokens} > ${budget.tokenThreshold}) ` +
            'but nothing in it is worth folding'
        );
        return null;
      }

      const compaction = compactions + 1;
      const callId = `run-compaction-${ctx.runId}-${compaction}`;
      const startedAt = Date.now();
      const folded = spanMessagesToFold(messages, span);
      const keptMessages = messages.length - span.end;
      broadcast('socket:tool:call', {
        callId,
        toolName: RUN_COMPACTION_ACTIVITY_TOOL,
        toolInput: {
          compaction,
          folded_messages: folded.length,
          folded_tool_cycles: span.foldedCycles,
          kept_messages: keptMessages,
          tokens_before: payloadTokens,
          token_threshold: budget.tokenThreshold,
        },
        requiresConfirmation: false,
      });

      const maxOutputTokens = runSummaryMaxOutputTokens(budget);
      const enabled = isConversationCompactionEnabled();
      let summary: string | null = null;
      let modelUsed: string | null = null;
      let fallbackReason: string | null = enabled ? null : 'COMPACT_CONVERSATIONS=false';
      try {
        if (enabled) {
          const result = await summarize(messages, span, folded, maxOutputTokens);
          summary = result.text;
          modelUsed = result.modelUsed;
          fallbackReason = result.reason;
        }
        if (ctx.abortSignal.aborted) throw abortError();
      } catch (err) {
        if (!ctx.abortSignal.aborted) {
          fallbackReason = getErrorMessage(err);
        } else {
          broadcast('socket:tool:result', {
            callId,
            success: false,
            output: '',
            error: 'Run stopped during compaction',
            durationMs: Date.now() - startedAt,
          });
          throw abortError();
        }
      }

      const source: RunCompactionSource = summary ? 'model' : 'digest';
      if (!summary) {
        summary = buildRunSpanDigest(
          folded,
          span.previousSummary,
          Math.floor(maxOutputTokens * DIGEST_CHARS_PER_TOKEN)
        );
        if (enabled) {
          LogsService.warn('run compaction fell back to a digest', {
            agentName: ctx.agentName,
            threadId: ctx.threadId,
            runId: ctx.runId,
            reason: fallbackReason ?? 'unknown',
          });
        }
      }

      applyRunCompaction(messages, span, summary);
      compactions = compaction;
      return {
        compaction,
        callId,
        foldedMessages: folded.length,
        foldedCycles: span.foldedCycles,
        keptMessages,
        tokensBefore: payloadTokens,
        summary,
        source,
        modelUsed,
        fallbackReason,
        persist: enabled,
        startedAt,
      };
    },

    async record(outcome, tokensAfter, budget) {
      logger.info(
        `[context] run compacted: agent=${ctx.agentName} run=${ctx.runId} #${outcome.compaction} ` +
          `folded ${outcome.foldedMessages} messages (${outcome.foldedCycles} tool cycles) into a ` +
          `${outcome.source === 'model' ? `summary by ${outcome.modelUsed}` : 'digest'}, ` +
          `kept ${outcome.keptMessages} recent messages; est. tokens ${outcome.tokensBefore} → ` +
          `${tokensAfter} (threshold ${budget.tokenThreshold})`
      );
      const durationMs = Date.now() - outcome.startedAt;
      broadcast('socket:tool:result', {
        callId: outcome.callId,
        success: true,
        output: outcome.summary,
        durationMs,
      });
      if (!outcome.persist) return;

      const toolInput: RunCompactionActivityInput = {
        compaction: outcome.compaction,
        folded_messages: outcome.foldedMessages,
        folded_tool_cycles: outcome.foldedCycles,
        kept_messages: outcome.keptMessages,
        tokens_before: outcome.tokensBefore,
        tokens_after: tokensAfter,
        token_threshold: budget.tokenThreshold,
      };
      const toolOutput: RunCompactionActivityOutput = {
        output: outcome.summary,
        source: outcome.source,
        model_used: outcome.modelUsed,
        fallback_reason: outcome.fallbackReason,
      };
      try {
        await AgentActivityLog.logActivity({
          agentId: ctx.agentId,
          runId: ctx.runId,
          actionType: 'tool_call',
          triggerType: 'chat_nudge',
          reason: `Run context compacted (${outcome.foldedMessages} messages folded)`,
          tool: RUN_COMPACTION_ACTIVITY_TOOL,
          toolInput,
          toolOutput,
          durationMs,
        });
      } catch (err) {
        LogsService.warn('run compaction summary was not saved', {
          agentName: ctx.agentName,
          threadId: ctx.threadId,
          runId: ctx.runId,
          error: getErrorMessage(err),
        });
      }
    },
  };
}
