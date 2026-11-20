/**
 * summaryQualityFloor — the summary output contract: garbage from small models
 * (refusals, truncation, over/under-length) is detected and discarded
 * rather than written into compaction memory.
 */

import { describe, expect, it } from '@jest/globals';
import { applySummaryQualityFloor } from '@server/services/summary/summaryQualityFloor';

describe('applySummaryQualityFloor', () => {
  it('accepts a normal narrative summary', () => {
    const text =
      'The user asked the agent to refactor the search module. The agent proposed a plan, ' +
      'the user approved it, and the agent completed the first two steps. Next step: tests.';
    expect(applySummaryQualityFloor(text)).toEqual({ ok: true, text });
  });

  it('strips a leading "Summary:" label', () => {
    const verdict = applySummaryQualityFloor(
      'Summary: The team agreed to ship on Friday after fixing the login bug.'
    );
    expect(verdict).toEqual({
      ok: true,
      text: 'The team agreed to ship on Friday after fixing the login bug.',
    });
  });

  it('rejects empty output', () => {
    expect(applySummaryQualityFloor('   \n ')).toMatchObject({
      ok: false,
      problem: 'empty output',
    });
  });

  it('rejects too-short output', () => {
    expect(applySummaryQualityFloor('Chat happened.')).toMatchObject({
      ok: false,
      problem: expect.stringContaining('too short'),
    });
  });

  it('rejects refusals', () => {
    for (const refusal of [
      'I cannot summarize this conversation as it contains sensitive content.',
      "I'm sorry, but I am unable to provide a summary of this discussion here.",
      'As an AI, I do not have access to the previous conversation you mentioned.',
      'There is no conversation provided for me to summarize in this request.',
    ]) {
      expect(applySummaryQualityFloor(refusal)).toMatchObject({
        ok: false,
        problem: expect.stringContaining('refusal'),
      });
    }
  });

  it('does not flag summaries that merely contain refusal-like words later', () => {
    const text =
      'The agent explained that it cannot access the private repo and the user granted access. ' +
      'They then reviewed the failing tests together and fixed two of them.';
    expect(applySummaryQualityFloor(text).ok).toBe(true);
  });

  it('rejects mid-sentence truncation (token-limit cut)', () => {
    expect(
      applySummaryQualityFloor(
        'The user and the agent discussed the deployment pipeline and decided to'
      )
    ).toMatchObject({ ok: false, problem: expect.stringContaining('truncated') });
  });

  // A cut that ends on an opening backtick ("Backlog row `") must not pass
  // CLEAN_ENDING_PATTERN. These run with no provider stop reason, i.e. the
  // local/Ollama path where the ending check stands alone.
  it('rejects a cut right after an opening backtick', () => {
    expect(
      applySummaryQualityFloor(
        'The agent timeout work was restructured into smaller steps. Backlog row `'
      )
    ).toMatchObject({ ok: false, problem: expect.stringContaining('truncated') });
  });

  it('rejects an unbalanced inline code span', () => {
    expect(
      applySummaryQualityFloor(
        'The agent logged the bug and claimed it. The row is `row-0001 and the fix is pending.'
      )
    ).toMatchObject({ ok: false, problem: expect.stringContaining('unbalanced backticks') });
  });

  it('rejects an unclosed fenced code block', () => {
    expect(
      applySummaryQualityFloor('The fix was drafted as follows.\n```ts\nconst cap = 2048;')
    ).toMatchObject({ ok: false, problem: expect.stringContaining('fenced code block') });
  });

  it.each(['*', '**', '_'])('rejects a dangling %s marker', (marker) => {
    expect(
      applySummaryQualityFloor(
        `The team reviewed the search routing plan and the next steps were ${marker}`
      )
    ).toMatchObject({ ok: false, problem: expect.stringContaining('truncated') });
  });

  it('accepts balanced code spans, fences, and closing emphasis', () => {
    for (const text of [
      'Commits `abc1234` and `def5678` shipped the routing work, recorded as `row-0001`.',
      'The change set the cap:\n```ts\nconst cap = 2048;\n```\nTests passed.',
      'The migration remains **dev only**',
      'The id field is named `post_id`',
    ]) {
      expect(applySummaryQualityFloor(text)).toMatchObject({ ok: true });
    }
  });

  it('accepts structured notes ending on a path, but still rejects real cuts', () => {
    const notes = 'Goal: map the files.\nFacts:\n- base folder apps/server/src/services';
    expect(applySummaryQualityFloor(notes).ok).toBe(false);
    expect(applySummaryQualityFloor(notes, { structured: true })).toEqual({
      ok: true,
      text: notes,
    });
    expect(applySummaryQualityFloor(`${notes}\n- open: \``, { structured: true })).toMatchObject({
      ok: false,
    });
    expect(
      applySummaryQualityFloor(notes, { structured: true, providerTruncated: true })
    ).toMatchObject({ ok: false });
  });

  it('rejects a provider-reported cap hit even when the ending looks clean', () => {
    expect(
      applySummaryQualityFloor('Everything looked fine and the work was complete.', {
        providerTruncated: true,
      })
    ).toMatchObject({ ok: false, problem: expect.stringContaining('output token cap') });
  });

  it('rejects over-length parroting', () => {
    const text = 'A sentence that repeats. '.repeat(500) + 'The end.';
    expect(applySummaryQualityFloor(text)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('too long'),
    });
  });

  it('respects custom bounds', () => {
    const text = 'Decisions were made about the roadmap and the next release date was fixed.';
    expect(applySummaryQualityFloor(text, { minChars: 200 })).toMatchObject({ ok: false });
    expect(applySummaryQualityFloor(text, { minChars: 10 }).ok).toBe(true);
  });
});
