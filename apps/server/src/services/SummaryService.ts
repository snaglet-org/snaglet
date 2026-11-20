/**
 * SummaryService — the thread digest: a narrative summary that preserves who said what,
 * decisions, action items and context. Written only when a person or an agent asks for a
 * Compact; the fold (historyCompactor) is the summary an agent's own context depends on.
 */

import { generateId, isoNow, getErrorMessage } from '@snaglet/shared/utils';
import type { MessageRow } from '@snaglet/db/tables/messages';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import type { ThreadSummaryRow } from '@snaglet/db/tables/thread_summaries';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Messages } from '@snaglet/db/tables/messages';
import { Threads } from '@snaglet/db/tables/threads';
import { Links } from '@snaglet/db/tables/links';
import { embedNode } from './embedding/EmbeddingOrchestrator';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { wsService } from './WebSocketService';
import { resolveModelMetadata } from './metadataResolver';
import { logger } from '@server/config/logger';
import { isHiddenThread } from '@server/services/subagents/helperVisibility';
import { isConversationCompactionEnabled } from '@server/config/conversationCompactionPolicy';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { resolveUtilityModel, type UtilitySkipReason } from './summary/UtilityModelResolver';
import { generateUtilityText } from './summary/generateUtilityText';
import { applySummaryQualityFloor } from './summary/summaryQualityFloor';
import { THREAD_SUMMARY_ACTIVITY_TOOL } from './summary/threadSummaryActivity';
import { checkMemoryGuardrails, recordSummaryGeneration } from './summary/memoryGuardrails';
import { setThreadMemoryStatus } from './summary/MemoryStatusRegistry';
import {
  SIMPLE_THREAD_SUMMARY_INSTRUCTIONS,
  THREAD_SUMMARY_INSTRUCTIONS,
  buildAgentPerspectiveBlock,
  buildFreshThreadSummaryPrompt,
} from './summary/threadSummaryPrompts';
import { appendDigestSection } from './summary/digestSections';
import {
  estimateNewConversationTokens,
  resolveDigestTokenThreshold,
} from './summary/digestTrigger';
import { withSingleFlight } from './summary/utilityConcurrency';

/**
 * Output-token cap for a thread summary. 1024 truncated long-running
 * threads' summaries mid-sentence; 2048 (~8k chars) sits
 * at the quality floor's DEFAULT_MAX_CHARS. A cap hit is still detected via
 * the provider stop reason and discarded — never stored.
 */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2048;
import {
  loadReplaySource,
  type ReplaySource,
} from './SocketService/handlers/chatPhases/replayLoader';
import {
  assembleAgentPayload,
  type ReplayActivityRow,
  type ReplayMessageRow,
} from './SocketService/handlers/chatPhases/replayAssembly';
import { isAgentRunEndedRow } from './SocketService/agentRunEnded';
import { buildSummarizerInput } from './contextWindow/summarizerInput';

interface SummarizationInput {
  threadId: string;
  agentNameMap?: Map<string, string>;
  /** Agent whose perspective shapes the summary. Also used for activity logging. */
  agentId?: string;
  /** Short description of the agent's role, used to focus the summary. */
  agentRole?: string;
  runId?: string;
  /** Skip the `shouldSummarize` threshold gate (e.g. user-triggered manual compaction). */
  force?: boolean;
  /**
   * Skip only the due-ness check (the token threshold), keeping the daily cap and debounce.
   * For a caller that already decided this pair is owed a first digest, as the backfill sweep does
   * by selecting threads that have messages and no summary.
   */
}

/**
 * Outcome of a `generateSummary` pass — skip reasons propagate to the
 * caller instead of a silent void return. `not-due` / `no-new-messages`
 * are normal cadence outcomes, not failures.
 */
export type GenerateSummaryOutcome =
  | { status: 'generated'; providerId: string; modelId: string; summaryId: string }
  | {
      status: 'skipped';
      reason:
        | UtilitySkipReason
        | 'not-due'
        | 'no-new-messages'
        | 'in-flight'
        | 'debounced'
        | 'quality-floor'
        | 'generation-failed'
        | 'compact-conversations-disabled'
        /** The thread's summary is a fold; the folds keep it, a digest would only repeat it. */
        | 'folded';
      detail?: string;
      /**
       * The skip came from a lookup that could not complete (e.g. the
       * database was unreachable), not from a broken configuration. The next
       * pass retries; it must not halt the thread.
       */
      retryable?: true;
      /**
       * The model that was about to write this summary, on the skips that
       * happen after resolution succeeded (`generation-failed`,
       * `quality-floor`). Callers name it in user-facing copy — "which model
       * failed" is the whole fix on a retired/404 model id, and the detail
       * string alone does not carry it.
       */
      providerId?: string;
      modelId?: string;
    };

interface SyncThreadSummaryEmbeddingOptions {
  forceUpsert?: boolean;
  explicit?: boolean;
}

function formatMessageLine(m: MessageRow, agentNameMap?: Map<string, string>): string {
  // thread_event rows are author-less machine narration (role='user' by
  // storage, but not the human speaking) — label them neutrally so the
  // summary doesn't attribute roster/mode changes to "[User]".
  const speaker =
    m.messageType === 'thread_event'
      ? 'event'
      : m.role === 'assistant' && m.agentId
        ? (agentNameMap?.get(m.agentId) ?? 'Agent')
        : m.role === 'user'
          ? 'User'
          : m.role;
  return `[${speaker}]: ${m.content}`;
}

/**
 * Format messages for the summary prompt, packed oldest-first against
 * `budgetChars` (the RESOLVED model's window bounds the input —
 * a 3B local model cannot take a 200-message thread verbatim). Keeping the
 * oldest contiguous prefix matters: persisted coverage may advance only
 * through messages the model actually saw, leaving the remaining suffix for
 * a later pass instead of creating a permanent memory hole.
 */
export function packMessagesForSummary(
  messages: MessageRow[],
  agentNameMap: Map<string, string> | undefined,
  budgetChars: number
): { formatted: string; omitted: number; included: number } {
  const lines = messages.map((m) => formatMessageLine(m, agentNameMap));
  const included: string[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cost = line.length + 2;
    if (included.length > 0 && total + cost > budgetChars) break;
    included.push(line);
    total += cost;
  }
  const omitted = lines.length - included.length;
  let formatted = included.join('\n\n');
  if (omitted > 0) {
    formatted += `\n\n[${omitted} later messages deferred to the next summary pass to fit the summarizer's context window]`;
  }
  return { formatted, omitted, included: included.length };
}

function labelReplayMessageForSummary(
  message: ReplayMessageRow,
  perceivingAgentId: string,
  agentNameMap?: Map<string, string>
): ReplayMessageRow {
  let speaker: string;
  if (message.messageType === 'thread_event') {
    speaker = 'event';
  } else if (message.role === 'user') {
    speaker = 'User';
  } else if (message.agentId) {
    speaker =
      agentNameMap?.get(message.agentId) ??
      (message.agentId === perceivingAgentId ? 'Agent' : 'Peer agent');
  } else {
    speaker = 'Agent';
  }
  return { ...message, content: `[${speaker}]: ${message.content}` };
}

function activityInWindow(
  activity: ReplayActivityRow,
  afterCreatedAt: string | null,
  throughCreatedAt: string
): boolean {
  return (
    (!afterCreatedAt || activity.createdAt > afterCreatedAt) &&
    activity.createdAt <= throughCreatedAt
  );
}

function assembleSummaryPayloadSlice(args: {
  source: ReplaySource;
  messages: MessageRow[];
  perceivingAgentId: string;
  afterCreatedAt: string | null;
  agentNameMap?: Map<string, string>;
}): ReturnType<typeof assembleAgentPayload> {
  const selectedIds = new Set(args.messages.map((message) => message.id));
  const throughCreatedAt = args.messages[args.messages.length - 1]?.createdAt;
  if (!throughCreatedAt) return [];

  const messages = args.source.messages
    .filter((message) => selectedIds.has(message.id))
    .map((message) =>
      labelReplayMessageForSummary(message, args.perceivingAgentId, args.agentNameMap)
    );

  const activityByRun = new Map<string, ReplayActivityRow[]>();
  for (const [runId, activity] of args.source.activityByRun) {
    const selected = activity.filter((row) =>
      activityInWindow(row, args.afterCreatedAt, throughCreatedAt)
    );
    if (selected.length > 0) activityByRun.set(runId, selected);
  }

  const relevantRunIds = new Set<string>(activityByRun.keys());
  for (const message of messages) {
    if (message.runId) relevantRunIds.add(message.runId);
  }
  const runs = args.source.runs
    .filter((run) => relevantRunIds.has(run.id))
    .map((run) => {
      const includedTimes = [
        ...messages
          .filter((message) => message.runId === run.id)
          .map((message) => message.createdAt),
        ...(activityByRun.get(run.id) ?? []).map((activity) => activity.createdAt),
      ];
      return {
        ...run,
        startedAt: includedTimes.reduce(
          (earliest, createdAt) => (createdAt < earliest ? createdAt : earliest),
          includedTimes[0] ?? run.startedAt
        ),
      };
    });

  return assembleAgentPayload({
    perceivingAgentId: args.perceivingAgentId,
    runs,
    messages,
    activityByRun,
  });
}

/**
 * Pack an oldest contiguous message prefix, measuring what the summarizer will actually read: the
 * per-agent replay (own reasoning and tool cycles, peer utterances only, user and event messages)
 * with every message whole and the tool calls condensed by what they are worth
 * (buildSummarizerInput). The prefix grows until the next message would not fit; the first message
 * always goes in, so a pass always advances. Reading size grows with the prefix, so the longest
 * fitting prefix is found by bisection rather than by re-assembling for every length.
 */
function packReplayPayloadForSummary(args: {
  source: ReplaySource;
  messages: MessageRow[];
  perceivingAgentId: string;
  afterCreatedAt: string | null;
  agentNameMap?: Map<string, string>;
  budgetChars: number;
}): { formatted: string; omitted: number; included: number } {
  const render = (count: number): string =>
    buildSummarizerInput(
      assembleSummaryPayloadSlice({ ...args, messages: args.messages.slice(0, count) })
    );

  let low = Math.min(1, args.messages.length); // known to be included
  let high = args.messages.length;
  let formatted = low > 0 ? render(low) : '';
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = render(mid);
    if (candidate.length > args.budgetChars) {
      high = mid - 1;
    } else {
      low = mid;
      formatted = candidate;
    }
  }

  const included = low;
  const omitted = args.messages.length - included;
  if (omitted > 0) {
    formatted += `\n\n[${omitted} later messages deferred to the next summary pass to fit the summarizer's context window]`;
  }
  return { formatted, omitted, included };
}

export async function syncThreadSummaryEmbedding(
  summaryRow: ThreadSummaryRow,
  options?: SyncThreadSummaryEmbeddingOptions
): Promise<void> {
  if (!options?.explicit && !isAutomaticLocalIntelligenceEnabled()) return;
  const summaryText = summaryRow.summaryText?.trim() ?? '';
  if (!summaryText) return;
  // A subagent helper's summaries compact its own context until it is
  // removed, and a DM thread's stay with its two parties; neither is ever
  // searched, so they get no vector.
  if (await isHiddenThread(summaryRow.threadId)) return;

  // forceUpsert is set by manual reembed flows. Normal path: skip when the
  // summary already has an embedding (re-embeds happen via the 1-min sweep).
  if (!options?.forceUpsert) {
    const existing = await Embeddings.listByNode(summaryRow.id);
    if (existing.length > 0) return;
  }

  // A long summary is cut at its headings and paragraph breaks and embedded piece by piece (the
  // sweep does the same), so a search can reach any part of it. One vector over the whole text
  // would only see what the embedding model's window holds.
  const result = await embedNode({ nodeId: summaryRow.id, content: summaryText });
  if (!result.ok && result.skipped !== 'empty') {
    logger.debug(
      `[summary] summary ${summaryRow.id} was not embedded (${result.skipped ?? 'unknown'}): ` +
        `${result.error ?? 'no detail'}`
    );
  }
}

export const summaryService = {
  /**
   * Decides whether enough new conversation has piled up since the last digest to write another:
   * an estimated TOKEN amount (default 20,000; `metadata.summary.tokenThreshold` per model), not a
   * message count. New message text counts, and so does the tool work logged since the boundary,
   * so one tool-heavy run can be due while thirty one-line replies are not.
   */
  async shouldSummarize(args: {
    threadId: string;
    agentId?: string;
    /** The messages after the last digest's boundary. */
    newMessages: readonly MessageRow[];
    /** `createdAt` of the last message the last digest covered; null before the first digest. */
    boundaryCreatedAt: string | null;
  }): Promise<boolean> {
    const effective = args.agentId
      ? await Threads.getEffectiveModel(args.threadId, args.agentId)
      : null;
    const meta = effective
      ? await resolveModelMetadata(effective.providerId, effective.modelId)
      : null;
    const threshold = resolveDigestTokenThreshold(meta?.summary);
    const estimate = (toolChars: number): number =>
      estimateNewConversationTokens({
        messageTexts: args.newMessages
          .filter((m) => m.messageType !== 'thread_event')
          .map((m) => m.content),
        toolChars,
        provider: effective?.providerId ?? 'default',
        modelId: effective?.modelId,
      });
    // The messages alone often settle it; the tool aggregate is one query, asked only if not.
    if (estimate(0) >= threshold) return true;
    if (!args.agentId) return false;
    const toolChars = await AgentActivityLog.sumToolChars(
      args.threadId,
      args.agentId,
      args.boundaryCreatedAt
    );
    return estimate(toolChars) >= threshold;
  },

  async getThreadSummary(threadId: string, agentId?: string): Promise<ThreadSummaryRow | null> {
    // Try agent-scoped summary first, fall back to shared
    let row: ThreadSummaryRow | null = null;
    if (agentId) {
      row = await ThreadSummaries.getByThreadAndAgent(threadId, agentId);
    }
    if (!row) {
      row = await ThreadSummaries.getByThread(threadId);
    }
    if (row) {
      void syncThreadSummaryEmbedding(row).catch((err) => {
        logger.warn(
          `[summary] Lazy thread summary embedding sync failed for thread ${threadId}:`,
          getErrorMessage(err)
        );
      });
    }
    return row;
  },

  async generateSummary(input: SummarizationInput): Promise<GenerateSummaryOutcome> {
    // Hard process-level override. Keep this before single-flight, model
    // resolution, and every database read so all callers (automatic, backfill,
    // and force/manual) share the same no-generation guarantee.
    if (!isConversationCompactionEnabled()) {
      return { status: 'skipped', reason: 'compact-conversations-disabled' };
    }
    // Single-flight per thread+agent: a slow local model must
    // not accumulate racing generations — the loser reports itself skipped
    // and the next turn re-triggers naturally.
    const flightKey = `${input.threadId}:${input.agentId ?? 'shared'}`;
    const outcome = await withSingleFlight(flightKey, () => this._generateSummaryInner(input));
    return outcome ?? { status: 'skipped', reason: 'in-flight' };
  },

  /** Internal: the un-serialized generation pass — call `generateSummary`. */
  async _generateSummaryInner(input: SummarizationInput): Promise<GenerateSummaryOutcome> {
    // Cost guardrails (automatic passes only): global daily cap + per-thread
    // debounce. Checked before any model resolution or DB reads.
    if (!input.force) {
      const blocked = await checkMemoryGuardrails(input.threadId, input.agentId);
      if (blocked) {
        if (blocked.reason === 'daily-cap-reached') {
          setThreadMemoryStatus(input.threadId, input.agentId ?? null, {
            state: 'inactive',
            reason: blocked.reason,
            detail: blocked.detail,
          });
        }
        return { status: 'skipped', reason: blocked.reason, detail: blocked.detail };
      }
    }

    // Due-ness before resolution, deliberately. A resolution skip is what
    // stops the run and blocks the thread (see summaryHalt), so it must only
    // be reported for a pass that was genuinely owed: a two-message thread
    // that has not reached its threshold has nothing to compact yet, and
    // halting it would brick every young thread the moment a summarizer is
    // misconfigured. Cadence outcomes ('not-due' / 'no-new-messages') win over
    // an unavailable model.
    const allMessages = await Messages.listByThreadId(input.threadId);
    // thread_event rows (author-less roster/mode/started narration) must not
    // inflate the summarization trigger, nor the stored messagesCovered that
    // the next trigger compares against — count only real conversational turns.
    const conversationalCount = allMessages.filter((m) => m.messageType !== 'thread_event').length;
    const existing = input.agentId
      ? ((await ThreadSummaries.getByThreadAndAgent(input.threadId, input.agentId)) ??
        (await ThreadSummaries.getByThread(input.threadId)))
      : await ThreadSummaries.getByThread(input.threadId);

    // A fold is the thread's summary once one exists, rolled forward each time the history is
    // folded again. A digest beside it would summarize the same messages a second time.
    if (existing?.compaction) {
      return { status: 'skipped', reason: 'folded' };
    }

    let messagesToSummarize: MessageRow[];
    let previousMessageBoundary: MessageRow | null = null;

    if (existing) {
      const lastIdx = existing.lastMessageId
        ? allMessages.findIndex((m) => m.id === existing.lastMessageId)
        : -1;
      previousMessageBoundary = lastIdx >= 0 ? (allMessages[lastIdx] ?? null) : null;
      // The run-ended UI footer is never summary input. It stays in `allMessages`
      // so an older `lastMessageId` pointing at one still resolves above.
      messagesToSummarize = (lastIdx >= 0 ? allMessages.slice(lastIdx + 1) : allMessages).filter(
        (m) => !isAgentRunEndedRow(m)
      );

      if (messagesToSummarize.length === 0) {
        // Nothing new to summarize — skip even when forced (no-op compact).
        return { status: 'skipped', reason: 'no-new-messages' };
      }
    } else {
      messagesToSummarize = allMessages.filter((m) => !isAgentRunEndedRow(m));
    }

    if (!input.force) {
      const shouldRun =
        messagesToSummarize.length > 0 &&
        (await this.shouldSummarize({
          threadId: input.threadId,
          agentId: input.agentId,
          newMessages: messagesToSummarize,
          boundaryCreatedAt: previousMessageBoundary?.createdAt ?? null,
        }));
      if (!shouldRun) {
        return { status: 'skipped', reason: 'not-due' };
      }
    }

    // Nothing new to summarize — skip even when forced (no-op compact), and never write a
    // digest of an empty thread.
    if (messagesToSummarize.length === 0) {
      return { status: 'skipped', reason: 'no-new-messages' };
    }

    // Agent-owned resolution chain: thread-agent override → agent override →
    // the effective model for this agent in this thread → visible skip.
    const resolution = await resolveUtilityModel({
      purpose: 'thread-summary',
      threadId: input.threadId,
      agentId: input.agentId,
    });
    if (!resolution.ok) {
      logger.warn(
        `[summary] No model available for thread ${input.threadId}: ${resolution.reason}` +
          (resolution.detail ? ` (${resolution.detail})` : '')
      );
      setThreadMemoryStatus(input.threadId, input.agentId ?? null, {
        state: 'inactive',
        reason: resolution.reason,
        detail: resolution.detail,
      });
      return {
        status: 'skipped',
        reason: resolution.reason,
        detail: resolution.detail,
        ...(resolution.retryable ? { retryable: true as const } : {}),
      };
    }
    const resolved = resolution.model;

    // Agent perspective appended to the instruction set so the summary
    // emphasizes what this agent cares about.
    const roleBlock = input.agentRole ? buildAgentPerspectiveBlock(input.agentRole) : '';

    // Budget the message window against the RESOLVED model: the instructions come off the top.
    // The previous digest is not input (see below), so it costs the window nothing.
    const framingOverhead = roleBlock.length + 600;
    const messagesBudget = Math.max(1_000, resolved.maxInputChars - framingOverhead);
    const packed = input.agentId
      ? packReplayPayloadForSummary({
          source: await loadReplaySource(input.threadId, allMessages),
          messages: messagesToSummarize,
          perceivingAgentId: input.agentId,
          afterCreatedAt: previousMessageBoundary?.createdAt ?? null,
          agentNameMap: input.agentNameMap,
          budgetChars: messagesBudget,
        })
      : packMessagesForSummary(messagesToSummarize, input.agentNameMap, messagesBudget);
    if (packed.omitted > 0) {
      logger.info(
        `[summary] thread ${input.threadId}: packed ${messagesToSummarize.length - packed.omitted}/` +
          `${messagesToSummarize.length} new messages into ${resolved.providerId}/${resolved.modelId}'s window`
      );
    }

    // Coverage is a contiguous prefix. Persist and link only what the model
    // saw; the deferred suffix remains after lastMessageId for a later pass.
    const incorporatedMessages = messagesToSummarize.slice(0, packed.included);
    const incorporatedConversationalCount = incorporatedMessages.filter(
      (message) => message.messageType !== 'thread_event'
    ).length;
    const messagesCovered = (existing?.messagesCovered ?? 0) + incorporatedConversationalCount;

    // Only the new real messages are summarized; the previous digest is never fed back in. The
    // result is appended to it as a new section, so earlier text is exactly as it was written.
    const userPrompt = buildFreshThreadSummaryPrompt(packed.formatted, incorporatedMessages.length);

    // All generation goes through the normal provider stack — every chat
    // provider works here (anthropic, openai, ollama, apple-on-device, …).
    // Output contract: plain-text templates + quality floor, one retry
    // with the simplified template, then a VISIBLE skip — a garbage summary
    // must never be written into compaction memory.
    let sectionText: string;
    try {
      // Provider stop signal: a summary that hit the output cap is never
      // stored, even if its last character happens to look like an ending.
      // Providers with no stop reason (local runtimes) never call onResult,
      // so the floor's text-shape ending check stands alone for them.
      let firstTruncated = false;
      const first = await generateUtilityText(resolved, {
        system: THREAD_SUMMARY_INSTRUCTIONS + roleBlock,
        userMessage: userPrompt,
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        onResult: (meta) => {
          firstTruncated = meta.truncated;
        },
      });
      const firstVerdict = applySummaryQualityFloor(first, { providerTruncated: firstTruncated });
      if (firstVerdict.ok) {
        sectionText = firstVerdict.text;
      } else {
        logger.warn(
          `[summary] discarded output from ${resolved.providerId}/${resolved.modelId} ` +
            `(${firstVerdict.problem}) — retrying with simplified prompt`
        );
        let secondTruncated = false;
        const second = await generateUtilityText(resolved, {
          system: SIMPLE_THREAD_SUMMARY_INSTRUCTIONS + roleBlock,
          userMessage: userPrompt,
          maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
          onResult: (meta) => {
            secondTruncated = meta.truncated;
          },
        });
        const secondVerdict = applySummaryQualityFloor(second, {
          providerTruncated: secondTruncated,
        });
        if (!secondVerdict.ok) {
          logger.warn(
            `[summary] discarded retry output from ${resolved.providerId}/${resolved.modelId} ` +
              `(${secondVerdict.problem}) — skipping this pass`
          );
          setThreadMemoryStatus(input.threadId, input.agentId ?? null, {
            state: 'inactive',
            reason: 'quality-floor',
            detail: `${resolved.providerId}/${resolved.modelId}: ${secondVerdict.problem}`,
          });
          return {
            status: 'skipped',
            reason: 'quality-floor',
            detail: `${resolved.providerId}/${resolved.modelId}: ${secondVerdict.problem}`,
            providerId: resolved.providerId,
            modelId: resolved.modelId,
          };
        }
        sectionText = secondVerdict.text;
      }
    } catch (err) {
      const detail = getErrorMessage(err);
      logger.warn(
        `[summary] generation failed on ${resolved.providerId}/${resolved.modelId}: ${detail}`
      );
      setThreadMemoryStatus(input.threadId, input.agentId ?? null, {
        state: 'inactive',
        reason: 'generation-failed',
        detail,
      });
      return {
        status: 'skipped',
        reason: 'generation-failed',
        detail,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
      };
    }

    const summaryText = appendDigestSection(existing?.summaryText, sectionText);

    const lastMessage = incorporatedMessages[incorporatedMessages.length - 1];

    const summaryRow = await ThreadSummaries.insertNewVersion({
      id: generateId('thread_summary'),
      threadId: input.threadId,
      agentId: input.agentId ?? null,
      summaryText,
      // Store the conversational count (events excluded) so it compares on the
      // same scale as the next shouldSummarize trigger, above.
      messagesCovered,
      lastMessageId: lastMessage?.id,
      // Provenance: provider-qualified so quality complaints and selective
      // regeneration can tell which runtime produced a summary.
      modelUsed: `${resolved.providerId}/${resolved.modelId}`,
    });

    try {
      await syncThreadSummaryEmbedding(summaryRow, {
        forceUpsert: true,
        explicit: input.force === true,
      });
    } catch (err) {
      logger.warn(
        `[summary] Failed to upsert thread summary embedding for thread ${input.threadId}:`,
        getErrorMessage(err)
      );
    }

    try {
      await Links.upsert({
        sourceId: summaryRow.id,
        targetId: input.threadId,
        relation: 'summarizes',
        metadata: {
          messages_covered: messagesCovered,
          generated_at: isoNow(),
        },
      });
    } catch (err) {
      logger.warn(
        `[summary] Failed to create graph link for thread ${input.threadId}:`,
        getErrorMessage(err)
      );
    }

    // Per-agent: each agent's summary version links only to the slice of
    // messages it newly incorporated (`incorporatedMessages`). A message in a
    // multi-agent thread can accumulate multiple incoming `summarizes` edges,
    // one per agent that summarized past it.
    for (const msg of incorporatedMessages) {
      try {
        await Links.upsert({
          sourceId: summaryRow.id,
          targetId: msg.id,
          relation: 'summarizes',
          metadata: {
            thread_id: input.threadId,
            agent_id: input.agentId ?? null,
            generated_at: isoNow(),
          },
        });
      } catch (err) {
        logger.warn(
          `[summary] Failed to link summary ${summaryRow.id} → message ${msg.id}:`,
          getErrorMessage(err)
        );
      }
    }
    // Feed summary to agent via activity log + socket broadcast
    if (input.agentId) {
      AgentActivityLog.logActivity({
        agentId: input.agentId,
        runId: input.runId,
        actionType: 'tool_call',
        triggerType: 'cron',
        reason: `Thread summary generated (${messagesCovered} messages covered)`,
        tool: THREAD_SUMMARY_ACTIVITY_TOOL,
        toolOutput: {
          summary: summaryText,
          messages_covered: messagesCovered,
          model_used: `${resolved.providerId}/${resolved.modelId}`,
        },
      }).catch((err) => logger.warn('[summary] Failed to log summary activity:', err));

      wsService.broadcastToChannel(input.threadId, {
        type: 'socket:thread:summary',
        payload: {
          threadId: input.threadId,
          agentId: input.agentId,
          summaryId: summaryRow.id,
          messagesCovered,
          summaryText,
        },
      });
    }

    logger.info(
      `[summary] Generated for thread ${input.threadId} ` +
        `(${messagesCovered} messages covered → ${summaryText.length} chars, ` +
        `model: ${resolved.providerId}/${resolved.modelId}, source: ${resolved.source})`
    );

    // Guardrail bookkeeping + visible memory status.
    recordSummaryGeneration(input.threadId, input.agentId);
    setThreadMemoryStatus(input.threadId, input.agentId ?? null, {
      state: 'active',
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      source: resolved.source,
    });

    return {
      status: 'generated',
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      summaryId: summaryRow.id,
    };
  },
};
