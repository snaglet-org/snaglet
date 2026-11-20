import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ProviderMessage } from '@server/services/ProviderChatService';

const resolveUtilityModel = jest.fn(
  async (..._a: unknown[]): Promise<unknown> => ({
    ok: true,
    model: model(),
  })
);
const generateUtilityText = jest.fn(async (..._a: unknown[]): Promise<string> => GOOD);
function model(maxInputChars = 100_000) {
  return {
    providerId: 'anthropic',
    modelId: 'claude-test',
    credentialId: null,
    isLocal: false,
    maxInputChars,
    timeoutMs: 60_000,
    source: 'own-model',
  };
}
const GOOD = 'Decisions: keep the retry budget at three.\nOpen work: add the watcher test.';

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...a: unknown[]) => resolveUtilityModel(...a),
}));
jest.mock('@server/services/summary/generateUtilityText', () => ({
  generateUtilityText: (...a: unknown[]) => generateUtilityText(...a),
}));

import {
  buildHistoryCompactionInstructions,
  splitChunk,
  summarizeFoldedHistory,
} from '@server/services/summary/historyCompactionSummary';

const text = (role: 'user' | 'assistant', content: string): ProviderMessage => ({ role, content });
const folded = (): ProviderMessage[] => [
  text('user', 'Please keep the retry budget at three.'),
  text('assistant', 'Agreed, three it is.'),
];
const promptOf = (call: number) =>
  (generateUtilityText.mock.calls[call] as unknown[])[1] as { system: string; userMessage: string };

beforeEach(() => {
  jest.clearAllMocks();
  resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: model() }));
  generateUtilityText.mockImplementation(async () => GOOD);
});

describe('summarizeFoldedHistory', () => {
  it('summarizes the folded messages whole and returns the model’s notes', async () => {
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      maxOutputTokens: 1_500,
    });
    expect(out).toEqual({
      ok: true,
      text: GOOD,
      modelUsed: 'anthropic/claude-test',
      rolled: true,
    });
    expect(resolveUtilityModel).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'thread-summary', threadId: 't1', agentId: 'a1' })
    );
    expect(promptOf(0).userMessage).toContain('Please keep the retry budget at three.');
    expect(promptOf(0).userMessage).toContain('Agreed, three it is.');
  });

  it('never feeds a summary message back in', async () => {
    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: [
        text('user', '[Historical context summary — earlier turns folded away]\nOLD SUMMARY TEXT'),
        ...folded(),
      ],
      maxOutputTokens: 1_500,
    });
    expect(promptOf(0).userMessage).not.toContain('OLD SUMMARY TEXT');
  });

  it('reads a span too big for the summarizer in chunks, each rewriting the notes the last one left', async () => {
    const big = 'x'.repeat(3_000);
    const many: ProviderMessage[] = [];
    for (let i = 0; i < 6; i++) many.push(text(i % 2 ? 'assistant' : 'user', `${i}:${big}`));
    generateUtilityText.mockImplementationOnce(
      async () => 'PART ONE: the retry budget stays at three.'
    );
    generateUtilityText.mockImplementationOnce(
      async () => 'PART TWO: the retry budget stays at three; the watcher test is open.'
    );
    generateUtilityText.mockImplementation(async () => 'PART MORE: nothing else was decided.');
    resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: model(9_000) }));

    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      maxOutputTokens: 1_000,
    });

    const calls = generateUtilityText.mock.calls.length;
    expect(calls).toBeGreaterThan(2);
    // The notes are replaced chunk by chunk, never joined: the result is the last rewrite.
    expect(out).toEqual({
      ok: true,
      text: 'PART MORE: nothing else was decided.',
      modelUsed: 'anthropic/claude-test',
      rolled: true,
    });
    // The first chunk starts blank; each later one is handed the notes the one before wrote.
    expect(promptOf(0).userMessage).not.toContain('CURRENT NOTES');
    expect(promptOf(0).system).not.toContain('CURRENT NOTES');
    expect(promptOf(1).userMessage).toContain('CURRENT NOTES');
    expect(promptOf(1).userMessage).toContain('PART ONE: the retry budget stays at three.');
    expect(promptOf(1).system).toContain('ONE updated');
    expect(promptOf(2).userMessage).toContain('PART TWO: the retry budget stays at three');
    expect(promptOf(2).userMessage).not.toContain('PART ONE');
    // Every message went to exactly one call.
    const seen = generateUtilityText.mock.calls.map((_, c) => promptOf(c).userMessage).join('\n');
    for (let i = 0; i < 6; i++) expect(seen.split(`${i}:${big}`).length - 1).toBe(1);
  });

  it('sets aside room for the notes in every chunk, so each call still fits the window', async () => {
    const big = 'x'.repeat(3_000);
    const many: ProviderMessage[] = [];
    for (let i = 0; i < 8; i++) many.push(text(i % 2 ? 'assistant' : 'user', `${i}:${big}`));
    let n = 0;
    generateUtilityText.mockImplementation(
      async () => `Decisions: note ${++n}\n${'y'.repeat(1_500)}`
    );
    resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: model(9_000) }));

    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      maxOutputTokens: 1_000,
    });

    const calls = generateUtilityText.mock.calls.length;
    expect(calls).toBeGreaterThan(2);
    expect(out.ok && out.text.startsWith(`Decisions: note ${calls}`)).toBe(true);
    for (let c = 1; c < calls; c++) {
      expect(promptOf(c).userMessage).toContain(`Decisions: note ${c}`);
    }
    for (let c = 0; c < calls; c++) {
      expect(promptOf(c).userMessage.length + promptOf(c).system.length).toBeLessThan(9_000);
    }
  });

  it('rolls the summary so far into the new one in a single call', async () => {
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      priorSummary: 'Decisions: the build runs on port 4001.',
      maxOutputTokens: 1_500,
    });
    expect(out).toMatchObject({ ok: true, text: GOOD, rolled: true });
    expect(generateUtilityText).toHaveBeenCalledTimes(1);
    expect(promptOf(0).userMessage).toContain('CURRENT NOTES');
    expect(promptOf(0).userMessage).toContain('Decisions: the build runs on port 4001.');
    expect(promptOf(0).userMessage).toContain('Please keep the retry budget at three.');
    expect(promptOf(0).system).toContain('ONE updated');
  });

  it('leaves an earlier summary too big to sit beside the transcript unread, for the caller to append to', async () => {
    resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: model(9_000) }));
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      priorSummary: `## Fold 1\n${'z'.repeat(20_000)}`,
      maxOutputTokens: 1_000,
    });
    expect(out).toMatchObject({ ok: true, rolled: false });
    expect(promptOf(0).userMessage).not.toContain('zzzz');
    expect(promptOf(0).userMessage).not.toContain('CURRENT NOTES');
  });

  it('cuts a span smaller when an earlier summary has to ride along in every call', async () => {
    const big = 'x'.repeat(3_000);
    const many: ProviderMessage[] = [];
    for (let i = 0; i < 6; i++) many.push(text(i % 2 ? 'assistant' : 'user', `${i}:${big}`));
    resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: model(40_000) }));
    // 6 x 3,000 characters fit one call at this size on their own.
    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      maxOutputTokens: 1_000,
    });
    expect(generateUtilityText).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    generateUtilityText.mockImplementation(async () => GOOD);
    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      priorSummary: `Decisions: ${'q'.repeat(18_000)}`,
      maxOutputTokens: 8_000,
    });
    expect(generateUtilityText.mock.calls.length).toBeGreaterThan(1);
    for (let c = 0; c < generateUtilityText.mock.calls.length; c++) {
      expect(promptOf(c).userMessage.length + promptOf(c).system.length).toBeLessThan(40_000);
    }
  });

  it('reads a long history in one call when the model window holds it, with room to answer', async () => {
    const big = 'x'.repeat(3_000);
    const many: ProviderMessage[] = [];
    for (let i = 0; i < 40; i++) many.push(text(i % 2 ? 'assistant' : 'user', `${i}:${big}`));
    resolveUtilityModel.mockImplementation(async () => ({
      ok: true,
      model: { ...model(60_000), contextTokens: 200_000 },
    }));

    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      maxOutputTokens: 16_000,
    });

    expect(out).toEqual({
      ok: true,
      text: GOOD,
      modelUsed: 'anthropic/claude-test',
      rolled: true,
    });
    expect(generateUtilityText).toHaveBeenCalledTimes(1);
    const [usedModel, opts] = generateUtilityText.mock.calls[0] as unknown as [
      { timeoutMs: number },
      { maxOutputTokens: number; userMessage: string },
    ];
    expect(opts.maxOutputTokens).toBe(16_000);
    expect(usedModel.timeoutMs).toBeGreaterThanOrEqual(240_000);
    for (let i = 0; i < 40; i++) expect(opts.userMessage).toContain(`${i}:`);
  });

  it('clamps the reply and fits every call into a small summary-model window', async () => {
    const big = 'x'.repeat(3_000);
    const many: ProviderMessage[] = [];
    for (let i = 0; i < 20; i++) many.push(text(i % 2 ? 'assistant' : 'user', `${i}:${big}`));
    resolveUtilityModel.mockImplementation(async () => ({
      ok: true,
      model: { ...model(60_000), contextTokens: 8_192 },
    }));

    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      maxOutputTokens: 16_000,
    });

    expect(generateUtilityText.mock.calls.length).toBeGreaterThan(1);
    for (let c = 0; c < generateUtilityText.mock.calls.length; c++) {
      const opts = (generateUtilityText.mock.calls[c] as unknown[])[1] as {
        maxOutputTokens: number;
        system: string;
        userMessage: string;
      };
      expect(opts.maxOutputTokens).toBeLessThanOrEqual(2_048);
      // Input tokens (at 3 chars each) plus the reply stay inside the 8k window.
      expect(
        (opts.system.length + opts.userMessage.length) / 3 + opts.maxOutputTokens
      ).toBeLessThan(8_192);
    }
  });

  it('never asks for more than the summary model can write in one reply', async () => {
    resolveUtilityModel.mockImplementation(async () => ({
      ok: true,
      model: { ...model(60_000), contextTokens: 200_000, maxOutputTokens: 8_192 },
    }));
    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      maxOutputTokens: 12_288,
    });
    const opts = (generateUtilityText.mock.calls[0] as unknown[])[1] as { maxOutputTokens: number };
    expect(opts.maxOutputTokens).toBe(8_192);
  });

  it('still reads in chunks when the history is bigger than the model window', async () => {
    const big = 'x'.repeat(3_000);
    const many: ProviderMessage[] = [];
    for (let i = 0; i < 40; i++) many.push(text(i % 2 ? 'assistant' : 'user', `${i}:${big}`));
    resolveUtilityModel.mockImplementation(async () => ({
      ok: true,
      model: { ...model(20_000), contextTokens: 20_000 },
    }));
    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: many,
      maxOutputTokens: 4_000,
    });
    expect(generateUtilityText.mock.calls.length).toBeGreaterThan(1);
  });

  it('reports a model that cannot be resolved, with its reason', async () => {
    resolveUtilityModel.mockImplementation(async () => ({
      ok: false,
      reason: 'no-credentials',
      detail: 'no usable credentials for anthropic',
    }));
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      maxOutputTokens: 1_500,
    });
    expect(out).toEqual({
      ok: false,
      reason: 'no-credentials',
      detail: 'no usable credentials for anthropic',
    });
    expect(generateUtilityText).not.toHaveBeenCalled();
  });

  it('reports a generation failure with the model that failed', async () => {
    generateUtilityText.mockImplementation(async () => {
      throw new Error('404 model not found');
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      maxOutputTokens: 1_500,
    });
    expect(out).toEqual({
      ok: false,
      reason: 'generation-failed',
      detail: '404 model not found',
      providerId: 'anthropic',
      modelId: 'claude-test',
    });
  });

  it('discards an unusable reply as a quality-floor failure', async () => {
    generateUtilityText.mockImplementation(async () => "I'm sorry, I cannot summarize this.");
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      maxOutputTokens: 1_500,
    });
    expect(out).toMatchObject({ ok: false, reason: 'quality-floor' });
  });

  it('retries a reply cut off at the output cap on each half, instead of failing the fold', async () => {
    const calls: string[] = [];
    generateUtilityText.mockImplementation(async (...a: unknown[]) => {
      const opts = a[1] as { userMessage: string; onResult?: (m: { truncated: boolean }) => void };
      calls.push(opts.userMessage);
      // The whole span is too long for one reply; each half fits.
      const whole = opts.userMessage.includes('(2 messages');
      opts.onResult?.({ truncated: whole });
      return whole
        ? 'Decisions: the retry budget stays at th'
        : `NOTES ${calls.length}: the retry budget stays at three.`;
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      maxOutputTokens: 1_500,
    });
    expect(calls).toHaveLength(3);
    // The second half rewrites what the first half wrote; the first half starts blank.
    expect(calls[1]).not.toContain('CURRENT NOTES');
    expect(calls[2]).toContain('CURRENT NOTES');
    expect(calls[2]).toContain('NOTES 2: the retry budget stays at three.');
    expect(out).toEqual({
      ok: true,
      text: 'NOTES 3: the retry budget stays at three.',
      modelUsed: 'anthropic/claude-test',
      rolled: true,
    });
  });

  it('keeps the whole lines of a cut-off reply when the chunk cannot be split, and says so', async () => {
    generateUtilityText.mockImplementation(async (...a: unknown[]) => {
      (a[1] as { onResult?: (m: { truncated: boolean }) => void }).onResult?.({ truncated: true });
      return 'Decisions: keep the retry budget at three.\nFacts: the watcher lives in src/wat';
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: [text('user', 'Please keep the retry budget at three.')],
      maxOutputTokens: 1_500,
    });
    expect(out).toEqual({
      ok: true,
      text:
        'Decisions: keep the retry budget at three.\n' +
        '[notes cut off at the summarizer’s output limit]',
      modelUsed: 'anthropic/claude-test',
      rolled: true,
    });
  });

  it('never replaces the earlier summary with a cut-off rewrite; it summarizes the new span alone instead', async () => {
    generateUtilityText.mockImplementation(async (...a: unknown[]) => {
      const opts = a[1] as { userMessage: string; onResult?: (m: { truncated: boolean }) => void };
      const rewriting = opts.userMessage.includes('CURRENT NOTES');
      opts.onResult?.({ truncated: rewriting });
      return rewriting
        ? 'Decisions: kept.\nDone: a lot.\nFacts: the watcher lives in src/wat'
        : 'Decisions: the new span alone.';
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: [text('user', 'Please keep the retry budget at three.')],
      priorSummary: 'Decisions: the earlier notes.\nFacts: a long list.',
      maxOutputTokens: 1_500,
    });
    // Nothing cut off was kept: the caller gets only the new notes, to append.
    expect(out).toEqual({
      ok: true,
      text: 'Decisions: the new span alone.',
      modelUsed: 'anthropic/claude-test',
      rolled: false,
    });
    expect(JSON.stringify(out)).not.toContain('cut off');
    const last = promptOf(generateUtilityText.mock.calls.length - 1);
    expect(last.userMessage).not.toContain('CURRENT NOTES');
  });

  it('falls back to the new span alone, and keeps its whole lines if that is cut off too', async () => {
    generateUtilityText.mockImplementation(async (...a: unknown[]) => {
      (a[1] as { onResult?: (m: { truncated: boolean }) => void }).onResult?.({ truncated: true });
      return 'Decisions: keep the retry budget at three.\nDone: added the watcher test.\nFacts: three cut off at the lim';
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: [text('user', 'Please keep the retry budget at three.')],
      priorSummary: 'Decisions: the earlier notes.',
      maxOutputTokens: 1_500,
    });
    expect(out).toMatchObject({ ok: true, rolled: false });
    expect(out.ok && out.text).toContain('[notes cut off');
  });

  it('does not accept a rewrite that comes back far shorter than the summary it replaces', async () => {
    const prior = `Decisions: ${'the build runs on port 4001. '.repeat(120)}`;
    generateUtilityText.mockImplementation(async (...a: unknown[]) => {
      const opts = a[1] as { userMessage: string };
      return opts.userMessage.includes('CURRENT NOTES')
        ? 'Decisions: only the new span, nothing else.'
        : 'Decisions: the new span, on its own, kept the retry budget at three.';
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      priorSummary: prior,
      maxOutputTokens: 2_000,
    });
    expect(out).toMatchObject({ ok: true, rolled: false });
    expect(out.ok && out.text).toBe(
      'Decisions: the new span, on its own, kept the retry budget at three.'
    );
  });

  it('accepts a rewrite that tightens the summary without gutting it', async () => {
    const prior = `Decisions: ${'the build runs on port 4001. '.repeat(40)}`;
    const tighter = `Decisions: ${'the build runs on port 4001. '.repeat(25)}`;
    generateUtilityText.mockImplementation(async () => tighter);
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      priorSummary: prior,
      maxOutputTokens: 2_000,
    });
    expect(out).toMatchObject({ ok: true, rolled: true });
  });

  it('appends instead of rolling a summary longer than one reply can hold', async () => {
    // 4,000 tokens is 12,000 characters of reply; a 20,000-character summary cannot be rewritten whole.
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      priorSummary: `Decisions: ${'q'.repeat(20_000)}`,
      maxOutputTokens: 4_000,
    });
    expect(out).toMatchObject({ ok: true, rolled: false });
    expect(promptOf(0).userMessage).not.toContain('qqqq');
  });

  it('hands the model the notes without fold headings or a trim marker', async () => {
    await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: folded(),
      priorSummary:
        '[Earlier folds trimmed]\n\n## Fold 3\nDecisions: keep the port at 4001.\n\n## Fold 4\nDone: wrote the watcher test.',
      maxOutputTokens: 1_500,
    });
    const prompt = promptOf(0).userMessage;
    expect(prompt).toContain('Decisions: keep the port at 4001.');
    expect(prompt).toContain('Done: wrote the watcher test.');
    expect(prompt).not.toContain('## Fold');
    expect(prompt).not.toContain('Earlier folds trimmed');
  });

  it('keeps the start and end of a single message bigger than the summarizer window', async () => {
    resolveUtilityModel.mockImplementation(async () => ({ ok: true, model: model(12_000) }));
    const huge = `START-MARK ${'x'.repeat(300_000)} END-MARK`;
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: [text('user', huge), text('assistant', 'Noted.')],
      maxOutputTokens: 1_000,
    });
    expect(out.ok).toBe(true);
    for (let c = 0; c < generateUtilityText.mock.calls.length; c++) {
      const p = promptOf(c);
      expect(p.userMessage.length + p.system.length).toBeLessThan(12_000 + 2_000);
    }
    const sent = generateUtilityText.mock.calls.map((_, c) => promptOf(c).userMessage).join('\n');
    expect(sent).toContain('START-MARK');
    expect(sent).toContain('END-MARK');
    expect(sent).toContain('characters left out');
  });

  it('fails when a cut-off reply on an unsplittable chunk has no whole line to keep', async () => {
    generateUtilityText.mockImplementation(async (...a: unknown[]) => {
      (a[1] as { onResult?: (m: { truncated: boolean }) => void }).onResult?.({ truncated: true });
      return 'Decisions: keep the retry budget at three and the watcher lives in src/wat';
    });
    const out = await summarizeFoldedHistory({
      threadId: 't1',
      agentId: 'a1',
      folded: [text('user', 'Please keep the retry budget at three.')],
      maxOutputTokens: 1_500,
    });
    expect(out).toMatchObject({ ok: false, reason: 'quality-floor' });
  });

  it('stops when the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      summarizeFoldedHistory({
        threadId: 't1',
        agentId: 'a1',
        folded: folded(),
        maxOutputTokens: 1_500,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('buildHistoryCompactionInstructions', () => {
  it('asks for headed sections and self-contained items, so the notes embed and read well in pieces', () => {
    for (const rolling of [false, true]) {
      const system = buildHistoryCompactionInstructions(2_000, rolling);
      expect(system).toContain('"## Decisions"');
      expect(system).toContain('blank line between sections');
      expect(system).toContain('make sense read on its own');
      expect(system).toContain('"the above"');
      // The agent still gets every section it relied on.
      for (const name of [
        'Decisions',
        'Done',
        'Open work',
        'Problems',
        'People and preferences',
        'Facts',
      ]) {
        expect(system).toContain(`${name}:`);
      }
    }
  });
});

describe('splitChunk', () => {
  const toolUse: ProviderMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'c1', name: 'file', input: {} }],
  };
  const toolResult: ProviderMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }],
  };

  it('cuts near the middle', () => {
    const chunk = [
      text('user', 'a'),
      text('assistant', 'b'),
      text('user', 'c'),
      text('assistant', 'd'),
    ];
    expect(splitChunk(chunk)).toEqual([chunk.slice(0, 2), chunk.slice(2)]);
  });

  it('never starts the second half on a tool result', () => {
    const chunk = [text('user', 'a'), toolUse, toolResult, text('assistant', 'd')];
    const halves = splitChunk(chunk);
    expect(halves).not.toBeNull();
    expect(halves![0]).toEqual([chunk[0], toolUse, toolResult]);
    expect(halves![1]).toEqual([chunk[3]]);
  });

  it('returns null when there is nowhere to cut', () => {
    expect(splitChunk([text('user', 'a')])).toBeNull();
    expect(splitChunk([toolUse, toolResult])).toBeNull();
  });
});
