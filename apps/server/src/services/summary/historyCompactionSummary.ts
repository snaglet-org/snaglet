/**
 * The summary that stands in for folded-away conversation history.
 *
 * The folded span is read whole (summarizerInput: messages kept, tool calls condensed by their
 * worth) by the agent's summary model, together with the summary so far, and the model writes ONE
 * updated summary that replaces it: what still holds is kept, what the new span brings is added,
 * what it reverses or finishes is updated in place. A span too big for the model's window is read
 * in consecutive chunks the same way, each rewriting the summary the chunk before it left.
 * Nothing is concatenated, so the summary stays one piece of about the size of one reply.
 *
 * An earlier summary too big to sit beside the transcript is not read; the result is then only the
 * new span's notes (`rolled: false`) and the caller appends them to it.
 *
 * Failure comes back as a value, not a throw, so the caller can raise the summary halt with the
 * model named. Only a stop of the run throws (AbortError).
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import { buildSummarizerInput } from '@server/services/contextWindow/summarizerInput';
import { generateUtilityText } from './generateUtilityText';
import { applySummaryQualityFloor } from './summaryQualityFloor';
import { COMPACTION_FOLDS_TRIMMED_MARKER } from './compactionSummarySections';
import { resolveUtilityModel, type UtilitySkipReason } from './UtilityModelResolver';

/** Room for the instructions and labels around the transcript. */
const PROMPT_FRAME_CHARS = 1_500;
/** The least transcript a chunk gets, however small the summarizer's window. */
const MIN_CHUNK_CHARS = 2_000;
/** Ceiling on the transcript of one history-summary call, however large the model's window. */
const HISTORY_INPUT_CHARS_CAP = 400_000;
/** Chars per token assumed when fitting a transcript to a window (a little pessimistic). */
const CHARS_PER_TOKEN = 3;
/** The reply may use at most this share of the summary model's own window. */
const MAX_REPLY_WINDOW_SHARE = 0.25;
/** Tokens kept free in the window for the instructions and framing. */
const WINDOW_FRAME_TOKENS = 2_000;
/** A long reply takes minutes to stream; the 60 s cloud default would cut it off. */
const HISTORY_CALL_TIMEOUT_MS = 240_000;
/** How many times a rejected chunk may be halved and retried before it is given up on. */
const MAX_SPLIT_DEPTH = 3;
/** The summary so far may take at most this share of the room beside the transcript. */
const PRIOR_SUMMARY_ROOM_SHARE = 0.6;
/** An earlier summary is rolled only while it is at most this share of one reply. */
const PRIOR_SUMMARY_REPLY_SHARE = 0.8;
/** A rewrite shorter than this share of the summary it replaced is taken as lossy, not accepted. */
const MIN_REWRITE_SHARE = 0.35;
/** Words asked for when rewriting a summary: less than a full reply, so the next fold fits too. */
const ROLLED_WORDS_PER_TOKEN = 0.35;
/** Appended to notes the summarizer was cut off in, when the chunk could not be split further. */
const CUT_OFF_MARKER = '[notes cut off at the summarizer’s output limit]';

export type HistorySummaryResult =
  | {
      ok: true;
      /** The whole updated summary when `rolled`; otherwise only the new span's notes. */
      text: string;
      modelUsed: string;
      rolled: boolean;
    }
  | {
      ok: false;
      reason: UtilitySkipReason | 'generation-failed' | 'quality-floor';
      detail?: string;
      providerId?: string;
      modelId?: string;
      retryable?: true;
    };

function words(maxOutputTokens: number, rolling: boolean): number {
  return Math.max(80, Math.floor(maxOutputTokens * (rolling ? ROLLED_WORDS_PER_TOKEN : 0.45)));
}

/** The notes of an earlier summary, minus any fold headings and trim marker an older layout added. */
function plainNotes(summary: string): string {
  return summary
    .replace(COMPACTION_FOLDS_TRIMMED_MARKER, '')
    .replace(/^## Fold \d+[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildHistoryCompactionInstructions(
  maxOutputTokens: number,
  hasCurrentNotes = false
): string {
  return [
    'You condense an earlier part of a conversation for an AI agent that took part in it. That',
    'part is about to be removed from the agent’s context; your notes replace it, and the agent',
    'keeps working from them. The notes are also split into pieces and searched later, so write',
    'them to be read in pieces. Use these sections, in this order. Write each name as a markdown',
    'heading on its own line (for example "## Decisions") and leave a blank line between sections:',
    '',
    'Decisions: what was decided, by whom, and why. Include approaches tried and dropped.',
    'Done: what was built, changed, sent or found — exact paths, ids, names and results.',
    'Open work: what is unfinished, asked for but not done, or waiting on someone.',
    'Problems: errors and failures not yet resolved, with the exact message.',
    'People and preferences: what the user or others asked for, their constraints and style,',
    'close to verbatim.',
    'Facts: other values the agent will need again — ids, names, URLs, settings, numbers.',
    '',
    'Write each item as its own short line that starts with what it is about (the feature, file,',
    'person or id), then what happened. Every item must make sense read on its own: name the',
    'subject again instead of writing "it", "that", "the above" or "as before", and never point to',
    'another part of the notes. Keep items about the same subject together. Do not pad or repeat',
    'facts to do this; one clear line per item is enough.',
    '',
    ...(hasCurrentNotes
      ? [
          'CURRENT NOTES cover the conversation before the part you are given. Write ONE updated',
          'set of notes that replaces them: keep what is still true or still needed, add what the',
          'new part brings, and where the new part changes, reverses or finishes something, update',
          'that item in place (say what changed in a few words) instead of keeping both. Shorten',
          'old detail that no longer matters before dropping anything the agent could still need.',
          '',
          'Rules: use only the CURRENT NOTES and the conversation you are given.',
        ]
      : [
          'Rules: summarize ONLY the conversation you are given; say nothing about what came before it.',
        ]),
    'Keep ids, paths, names and error text exactly as written. Use only what the record shows;',
    'never invent a result, and say "unclear" where the record is. Write "None" for an empty',
    `section. Output only the notes, no preamble. Keep it under ${words(maxOutputTokens, hasCurrentNotes)} words.`,
  ].join('\n');
}

function buildHistoryCompactionPrompt(
  transcript: string,
  messageCount: number,
  currentNotes = ''
): string {
  const conversation = `CONVERSATION TO CONDENSE (${messageCount} messages, oldest first):\n${transcript}`;
  return currentNotes
    ? `CURRENT NOTES (to be replaced by your updated notes):\n${currentNotes}\n\n${conversation}`
    : conversation;
}

function isToolResultTurn(message: ProviderMessage): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some((block) => 'type' in block && block.type === 'tool_result')
  );
}

/**
 * Consecutive chunks of `messages`, each rendering within `budgetChars` where it can. A chunk
 * starts only where a tool exchange is not split (a tool_result stays with its tool_use); a single
 * exchange over budget is a chunk of its own. The first message of a chunk always goes in, so the
 * split always advances. Rendered size grows with the chunk, so the end is found by bisection.
 */
function chunkForSummarizer(
  messages: readonly ProviderMessage[],
  budgetChars: number
): ProviderMessage[][] {
  const canCutBefore = (i: number): boolean =>
    i >= messages.length || !isToolResultTurn(messages[i]!);
  const chunks: ProviderMessage[][] = [];
  let start = 0;
  while (start < messages.length) {
    let low = start + 1; // known to be included
    let high = messages.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (buildSummarizerInput(messages.slice(start, mid)).length > budgetChars) high = mid - 1;
      else low = mid;
    }
    let end = low;
    while (end > start + 1 && !canCutBefore(end)) end -= 1;
    if (!canCutBefore(end)) {
      end = low;
      while (end < messages.length && !canCutBefore(end)) end += 1;
    }
    chunks.push(messages.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * `chunk` cut into two at a place that keeps every tool_result with its tool_use, nearest the
 * middle; null when it has no such place.
 */
export function splitChunk(
  chunk: readonly ProviderMessage[]
): [ProviderMessage[], ProviderMessage[]] | null {
  const middle = Math.floor(chunk.length / 2);
  for (let offset = 0; offset < chunk.length; offset++) {
    for (const at of [middle + offset, middle - offset]) {
      if (at > 0 && at < chunk.length && !isToolResultTurn(chunk[at]!)) {
        return [chunk.slice(0, at), chunk.slice(at)];
      }
    }
  }
  return null;
}

function abortError(): DOMException {
  return new DOMException('run aborted during context compaction', 'AbortError');
}

export async function summarizeFoldedHistory(args: {
  threadId: string;
  agentId: string;
  folded: readonly ProviderMessage[];
  /** The summary the thread carries so far, to be rolled into the new one. */
  priorSummary?: string | null;
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<HistorySummaryResult> {
  if (args.signal?.aborted) throw abortError();

  const resolution = await resolveUtilityModel({
    purpose: 'thread-summary',
    threadId: args.threadId,
    agentId: args.agentId,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      reason: resolution.reason,
      ...(resolution.detail ? { detail: resolution.detail } : {}),
      ...(resolution.retryable ? { retryable: true as const } : {}),
    };
  }
  const model = resolution.model;
  const modelUsed = `${model.providerId}/${model.modelId}`;
  // The reply allowance comes from the chat model's budget; it must also fit the summary model's
  // own window and the longest reply it can write.
  const maxOutputTokens = Math.min(
    args.maxOutputTokens,
    model.contextTokens ? Math.floor(model.contextTokens * MAX_REPLY_WINDOW_SHARE) : Infinity,
    model.maxOutputTokens ?? Infinity
  );
  // The with-notes wording is the longer one; budgeting by it covers both.
  const system = buildHistoryCompactionInstructions(maxOutputTokens, true);
  // The whole folded span goes to one call whenever the model's window holds it, beside the
  // reply; it is read in consecutive chunks only when it does not.
  const inputChars = model.contextTokens
    ? Math.min(
        HISTORY_INPUT_CHARS_CAP,
        Math.floor((model.contextTokens - maxOutputTokens - WINDOW_FRAME_TOKENS) * CHARS_PER_TOKEN)
      )
    : model.maxInputChars;
  const room = Math.max(MIN_CHUNK_CHARS, inputChars - system.length - PROMPT_FRAME_CHARS);
  const replyChars = maxOutputTokens * CHARS_PER_TOKEN;
  const callModel = { ...model, timeoutMs: Math.max(model.timeoutMs, HISTORY_CALL_TIMEOUT_MS) };

  // The summary so far is rolled into the new one when it fits beside the transcript. Otherwise it
  // is left alone and only the new span is summarized, for the caller to append.
  const priorText = plainNotes(args.priorSummary ?? '');
  // Rolled only while it fits beside the transcript AND a rewrite of it fits one reply: a summary
  // longer than the reply cannot be rewritten whole without being cut off or squeezed.
  const rolled =
    !priorText ||
    (priorText.length <= room * PRIOR_SUMMARY_ROOM_SHARE &&
      priorText.length <= replyChars * PRIOR_SUMMARY_REPLY_SHARE);
  const startNotes = rolled ? priorText : '';

  const failure = (
    reason: 'generation-failed' | 'quality-floor',
    detail: string
  ): Extract<HistorySummaryResult, { ok: false }> => ({
    ok: false,
    reason,
    detail,
    providerId: model.providerId,
    modelId: model.modelId,
  });

  let cutOffRewrite = false;

  // One chunk, read with the notes so far, to the updated notes. A reply the quality floor rejects
  // (most often one cut off at the output cap) is retried on each half of the chunk, the second
  // half reading what the first wrote, so one bad chunk does not throw away the work before it and
  // send the next turn back to the start. A chunk that cannot be split further keeps what the
  // model wrote, cut back to its last whole line and marked as cut off.
  const summarizeChunk = async (
    chunk: readonly ProviderMessage[],
    depth: number,
    currentNotes: string
  ): Promise<{ ok: true; text: string } | Extract<HistorySummaryResult, { ok: false }>> => {
    if (args.signal?.aborted) throw abortError();
    let transcript = buildSummarizerInput(chunk);
    if (!transcript.trim()) return { ok: true, text: currentNotes };
    // One message can be bigger than the window by itself (a pasted file); a prompt the provider
    // refuses would read as the model failing. Keep its start and end.
    const limit = Math.max(MIN_CHUNK_CHARS, room - currentNotes.length);
    if (transcript.length > limit) {
      const head = Math.floor(limit * 0.6);
      const tail = limit - head;
      transcript =
        `${transcript.slice(0, head)}\n[... ${transcript.length - limit} characters left out ` +
        `to fit the summarizer's window ...]\n${transcript.slice(transcript.length - tail)}`;
    }
    let truncated = false;
    let raw: string;
    try {
      raw = await generateUtilityText(callModel, {
        system: buildHistoryCompactionInstructions(maxOutputTokens, currentNotes !== ''),
        userMessage: buildHistoryCompactionPrompt(transcript, chunk.length, currentNotes),
        maxOutputTokens,
        ...(args.signal ? { signal: args.signal } : {}),
        onResult: (meta) => {
          truncated = meta.truncated;
        },
      });
    } catch (err) {
      if (args.signal?.aborted) throw abortError();
      return failure('generation-failed', getErrorMessage(err));
    }
    const floor = { structured: true, maxChars: maxOutputTokens * 6 };
    const verdict = applySummaryQualityFloor(raw, { ...floor, providerTruncated: truncated });
    if (verdict.ok) return { ok: true, text: verdict.text };

    const halves = depth < MAX_SPLIT_DEPTH ? splitChunk(chunk) : null;
    logger.warn(
      `[context] history summary chunk of ${chunk.length} messages rejected by ${modelUsed}: ` +
        `${verdict.problem}${halves ? ' — retrying on each half' : ''}`
    );
    if (halves) {
      let notes = currentNotes;
      for (const half of halves) {
        const out = await summarizeChunk(half, depth + 1, notes);
        if (!out.ok) return out;
        notes = out.text;
      }
      return { ok: true, text: notes };
    }
    if (truncated && currentNotes) {
      // This reply is the whole rewritten summary: cutting it at its last line would drop the
      // sections after it, notes the earlier summary held. Nothing is kept; see the fallback below.
      cutOffRewrite = true;
    } else if (truncated) {
      // Keep only whole lines: a reply with no line break has nothing complete to keep.
      const cutAt = raw.trim().lastIndexOf('\n');
      const kept = cutAt > 0 ? applySummaryQualityFloor(raw.trim().slice(0, cutAt), floor) : null;
      if (kept?.ok) return { ok: true, text: `${kept.text}\n${CUT_OFF_MARKER}` };
    }
    return failure('quality-floor', `${modelUsed}: ${verdict.problem}`);
  };

  // Every call carries the notes so far: at most one reply long once the first call has run, or the
  // earlier summary if that is longer. Room for them is set aside before the span is cut; a span
  // that fits whole with nothing to carry still goes in one call.
  const readSpan = async (
    start: string
  ): Promise<{ ok: true; text: string } | Extract<HistorySummaryResult, { ok: false }>> => {
    const carried = Math.max(replyChars, start.length);
    const cutWith = (reserve: number) =>
      chunkForSummarizer(args.folded, Math.max(MIN_CHUNK_CHARS, room - reserve));
    let chunks = cutWith(start ? carried : 0);
    if (!start && chunks.length > 1) chunks = cutWith(carried);

    let notes = start;
    for (const chunk of chunks) {
      const out = await summarizeChunk(chunk, 0, notes);
      if (!out.ok) return out;
      notes = out.text;
    }
    return { ok: true, text: notes };
  };

  let result = await readSpan(startNotes);
  let rolledIn = rolled;
  // A rewrite that comes back far shorter than the summary it replaces has dropped things, however
  // well formed it is; it is not allowed to replace it.
  const shrunk =
    result.ok &&
    startNotes !== '' &&
    result.text.length < MIN_REWRITE_SHARE * Math.min(startNotes.length, replyChars);
  if ((!result.ok && cutOffRewrite && startNotes) || shrunk) {
    // The rewrite of the earlier summary was cut off or lost too much. Keep the earlier summary as
    // it is and summarize only the new span, for the caller to append.
    logger.warn(
      `[context] rewriting the earlier summary ${shrunk ? 'came back far shorter' : 'was cut off'} ` +
        `on ${modelUsed}; summarizing the new span alone`
    );
    cutOffRewrite = false;
    rolledIn = false;
    result = await readSpan('');
  }
  if (!result.ok) return result;
  return { ok: true, text: result.text, modelUsed, rolled: rolledIn };
}
