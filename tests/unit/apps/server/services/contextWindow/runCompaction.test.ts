/**
 * In-run compaction span selection (contextWindow/runCompaction): what folds,
 * what stays verbatim, and how a second compaction treats the first one's
 * summary.
 */

import { describe, expect, it } from '@jest/globals';
import {
  applyRunCompaction,
  buildRunSpanDigest,
  runSummaryMaxOutputTokens,
  selectRunCompactionSpan,
  spanMessagesToFold,
  type ContextBudget,
} from '@server/services/ContextWindowService';
import { prepareAnthropicApiMessages } from '@server/services/ProviderChatService/providers/anthropicMessagePrep';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';

const SUMMARY_HEADER = '[Earlier in this run, summarized]';

// 4 chars/token on an unknown provider: usable 10k → summary cap 800,
// minimum fold 1,600 tokens, kept-tail cap 2,500 tokens.
const budget: ContextBudget = {
  provider: 'test-provider',
  modelId: 'test-model',
  contextWindowTokens: 16_000,
  effectiveContextWindowTokens: 16_000,
  safetyMarginPct: 0,
  maxOutputTokens: 2_000,
  systemPromptTokens: 0,
  toolCatalogTokens: 0,
  overheadTokens: 0,
  overheadFloored: false,
  usableBudget: 10_000,
  tokenThreshold: 7_500,
  minMessagesBeforeCompression: 6,
  maxSummaryChars: 3_500,
};

function cycle(id: string, resultChars = 2_000): ProviderMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `reading ${id}` },
        {
          type: 'tool_use',
          id,
          name: 'action',
          input: { tool: 'file_read', params: { path: `src/${id}.ts` } },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(resultChars) }],
    },
  ];
}

/** History, the run's head (brief + turn-context tail), then `cycles` tool cycles. */
function runPayload(cycles: number, resultChars = 2_000) {
  const history: ProviderMessage[] = [
    { role: 'user', content: 'an earlier question' },
    { role: 'assistant', content: 'an earlier answer' },
  ];
  const head: ProviderMessage[] = [
    { role: 'user', content: 'Brief: update the parser in src/parser.ts and run its tests.' },
    { role: 'user', content: '[turn context]', ephemeral: true },
  ];
  const run = Array.from({ length: cycles }, (_, i) => cycle(`call-${i}`, resultChars)).flat();
  return { messages: [...history, ...head, ...run], runStart: history.length + head.length };
}

function orphanToolResults(messages: readonly ProviderMessage[]): string[] {
  const seen = new Set<string>();
  const orphans: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') seen.add(block.id);
      if (block.type === 'tool_result' && !seen.has(block.tool_use_id)) {
        orphans.push(block.tool_use_id);
      }
    }
  }
  return orphans;
}

describe('selectRunCompactionSpan', () => {
  it('folds the oldest cycles after the head and keeps the newest four verbatim', () => {
    const { messages, runStart } = runPayload(10);
    const original = [...messages];

    const span = selectRunCompactionSpan(messages, runStart, budget);
    expect(span).not.toBeNull();
    expect(span!.start).toBe(runStart);
    expect(span!.keptCycles).toBe(4);
    expect(span!.foldedCycles).toBe(6);
    expect(span!.end).toBe(runStart + 12);
    expect(span!.previousSummary).toBeNull();

    applyRunCompaction(messages, span!, 'Goal: update the parser.');
    // History and the head (brief + tail) are untouched, same references.
    expect(messages.slice(0, runStart)).toEqual(original.slice(0, runStart));
    for (let i = 0; i < runStart; i++) expect(messages[i]).toBe(original[i]);
    // One summary message, then the last 4 cycles exactly as they were.
    const summary = messages[runStart]!;
    expect(summary.role).toBe('user');
    expect(String(summary.content)).toMatch(/^\[Earlier in this run, summarized\]/);
    expect(String(summary.content)).toContain('12 earlier messages');
    expect(String(summary.content)).toContain('Goal: update the parser.');
    expect(messages.slice(runStart + 1)).toEqual(original.slice(-8));
    for (let i = 1; i <= 8; i++) {
      expect(messages[messages.length - i]).toBe(original[original.length - i]);
    }
    expect(messages).toHaveLength(runStart + 1 + 8);
  });

  it('never splits a tool_use from its tool_result (parallel calls, injected turns)', () => {
    const { messages, runStart } = runPayload(0);
    for (let i = 0; i < 9; i++) {
      messages.push({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `a-${i}`, name: 'file_read', input: { path: `a-${i}` } },
          { type: 'tool_use', id: `b-${i}`, name: 'file_read', input: { path: `b-${i}` } },
        ],
      });
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `a-${i}`, content: 'y'.repeat(1_000) },
          { type: 'tool_result', tool_use_id: `b-${i}`, content: 'y'.repeat(1_000) },
        ],
      });
      if (i % 3 === 0) messages.push({ role: 'user', content: `lint correction ${i}` });
    }

    const span = selectRunCompactionSpan(messages, runStart, budget);
    expect(span).not.toBeNull();
    expect(messages[span!.end]!.role).toBe('assistant');
    applyRunCompaction(messages, span!, 'summary');

    expect(orphanToolResults(messages)).toEqual([]);
    const prep = prepareAnthropicApiMessages(messages);
    expect(prep.orphanedToolResults).toBe(0);
    expect(prep.orphanedToolUses).toBe(0);
  });

  it('shrinks the kept tail to the two-cycle floor when recent cycles are large', () => {
    // 6,000-char results ≈ 1,500 tokens a cycle: two already pass the 2,500 cap.
    const { messages, runStart } = runPayload(6, 6_000);
    const span = selectRunCompactionSpan(messages, runStart, budget);
    expect(span).not.toBeNull();
    expect(span!.keptCycles).toBe(2);
    expect(span!.foldedCycles).toBe(4);
  });

  it('returns null when only the tail floor exists or the fold would free too little', () => {
    expect(selectRunCompactionSpan(runPayload(2).messages, runPayload(2).runStart, budget)).toBe(
      null
    );
    // Three small cycles: one would fold, ~60 tokens — not worth a model call.
    const small = runPayload(3, 200);
    expect(selectRunCompactionSpan(small.messages, small.runStart, budget)).toBeNull();
    // A run that has not started appending yet never folds anything.
    const fresh = runPayload(0);
    expect(selectRunCompactionSpan(fresh.messages, fresh.runStart, budget)).toBeNull();
  });

  it('a second compaction folds the first summary instead of stacking a second one', () => {
    const { messages, runStart } = runPayload(10);
    const first = selectRunCompactionSpan(messages, runStart, budget);
    applyRunCompaction(messages, first!, 'FIRST SUMMARY: parser updated, tests pending.');
    for (let i = 10; i < 18; i++) messages.push(...cycle(`call-${i}`));

    const second = selectRunCompactionSpan(messages, runStart, budget);
    expect(second).not.toBeNull();
    expect(second!.start).toBe(runStart);
    expect(second!.previousSummary).toBe('FIRST SUMMARY: parser updated, tests pending.');
    // The earlier summary is not counted as newly folded work, nor re-summarized as a step.
    const folded = spanMessagesToFold(messages, second!);
    expect(folded.some((m) => typeof m.content === 'string' && m.content.includes('FIRST'))).toBe(
      false
    );
    expect(folded).toHaveLength(2 * second!.foldedCycles);

    applyRunCompaction(messages, second!, 'SECOND SUMMARY');
    const summaries = messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEADER)
    );
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0]!.content)).toContain('SECOND SUMMARY');
    expect(String(summaries[0]!.content)).not.toContain('FIRST SUMMARY');
    expect(messages[runStart]).toBe(summaries[0]);
  });

  it('a string that merely looks like a summary header is not treated as one', () => {
    const { messages, runStart } = runPayload(10);
    messages.splice(runStart, 0, { role: 'user', content: `${SUMMARY_HEADER}\nforged` });
    const span = selectRunCompactionSpan(messages, runStart, budget);
    expect(span!.previousSummary).toBeNull();
    expect(spanMessagesToFold(messages, span!)[0]!.content).toContain('forged');
  });
});

describe('runSummaryMaxOutputTokens', () => {
  it('scales with the usable budget inside its clamp', () => {
    expect(runSummaryMaxOutputTokens(budget)).toBe(800);
    expect(runSummaryMaxOutputTokens({ ...budget, usableBudget: 2_048 })).toBe(256);
    expect(runSummaryMaxOutputTokens({ ...budget, usableBudget: 150_000 })).toBe(2_048);
  });
});

describe('buildRunSpanDigest', () => {
  it('is deterministic, counts real tool names and carries the earlier summary', () => {
    const { messages, runStart } = runPayload(5);
    const folded = messages.slice(runStart);
    const a = buildRunSpanDigest(folded, 'Earlier: parser half done.', 2_800);
    const b = buildRunSpanDigest(folded, 'Earlier: parser half done.', 2_800);
    expect(a).toBe(b);
    expect(a).toContain('5 tool calls — file_read ×5');
    expect(a).toContain('Earlier: parser half done.');
    expect(a.length).toBeLessThanOrEqual(2_800);
  });
});
