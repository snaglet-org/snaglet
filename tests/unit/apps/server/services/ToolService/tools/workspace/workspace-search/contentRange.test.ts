/**
 * contentRange.ts — the pure half of `search({ content_range })`.
 *
 * Line model, EOF behavior, and the budgets that keep a ranged read from
 * becoming a token explosion. Everything here is DB-free and filesystem-free;
 * the authoritative per-kind fetch is covered in rangedRead.test.ts.
 */

import { describe, expect, it } from '@jest/globals';
import {
  MAX_RANGED_RESULTS,
  MAX_RANGE_LINES,
  RangedResponseBudget,
  countLines,
  isRangedContentKind,
  parseContentRange,
  sliceContentRange,
  validateRangedQueryLimit,
} from '@server/services/ToolService/handlers/search/workspaceSearch/contentRange';

describe('parseContentRange', () => {
  it('treats an absent range as "no range requested"', () => {
    expect(parseContentRange(undefined)).toEqual({ ok: true, range: null });
    expect(parseContentRange(null)).toEqual({ ok: true, range: null });
  });

  it('accepts a valid 1-indexed inclusive range', () => {
    expect(parseContentRange({ start_line: 3, end_line: 7 })).toEqual({
      ok: true,
      range: { startLine: 3, endLine: 7 },
    });
  });

  it('accepts a single-line range', () => {
    expect(parseContentRange({ start_line: 5, end_line: 5 })).toEqual({
      ok: true,
      range: { startLine: 5, endLine: 5 },
    });
  });

  it.each([
    ['a non-object', 'lines 1-5'],
    ['an array', [1, 5]],
  ])('rejects %s', (_label, input) => {
    const parsed = parseContentRange(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('must be an object');
  });

  it('rejects a range missing either bound', () => {
    for (const input of [{ start_line: 1 }, { end_line: 5 }, {}]) {
      const parsed = parseContentRange(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('requires both start_line and end_line');
    }
  });

  it('rejects non-integer bounds', () => {
    for (const input of [
      { start_line: 1.5, end_line: 5 },
      { start_line: 1, end_line: '5' },
      { start_line: Number.NaN, end_line: 5 },
    ]) {
      const parsed = parseContentRange(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('must be integers');
    }
  });

  it('rejects zero and negative bounds (1-indexed)', () => {
    for (const input of [
      { start_line: 0, end_line: 5 },
      { start_line: 1, end_line: 0 },
      { start_line: -3, end_line: -1 },
    ]) {
      const parsed = parseContentRange(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('must be >= 1');
    }
  });

  it('rejects an inverted range', () => {
    const parsed = parseContentRange({ start_line: 9, end_line: 4 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('must be <= end_line');
  });

  it('rejects a span over the per-read line cap instead of silently clamping', () => {
    const parsed = parseContentRange({ start_line: 1, end_line: MAX_RANGE_LINES + 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(`${MAX_RANGE_LINES + 1} lines`);
      expect(parsed.error).toContain('narrower');
    }
  });

  it('accepts a span exactly at the cap', () => {
    expect(parseContentRange({ start_line: 1, end_line: MAX_RANGE_LINES }).ok).toBe(true);
    expect(parseContentRange({ start_line: 100, end_line: 99 + MAX_RANGE_LINES }).ok).toBe(true);
  });
});

describe('validateRangedQueryLimit', () => {
  it('allows a limit at or below the ranged-result cap', () => {
    expect(validateRangedQueryLimit(1)).toBeNull();
    expect(validateRangedQueryLimit(MAX_RANGED_RESULTS)).toBeNull();
  });

  it('rejects a higher limit and names the required value', () => {
    const error = validateRangedQueryLimit(MAX_RANGED_RESULTS + 1);
    expect(error).toContain(`at most ${MAX_RANGED_RESULTS} results`);
    expect(error).toContain(`limit is ${MAX_RANGED_RESULTS + 1}`);
  });
});

describe('isRangedContentKind', () => {
  it('covers exactly the v1 ranged kinds', () => {
    for (const kind of ['doc', 'message', 'memory', 'file']) {
      expect(isRangedContentKind(kind)).toBe(true);
    }
    for (const kind of ['thread', 'container', 'tool', 'image', 'thread_summary', 'agent']) {
      expect(isRangedContentKind(kind)).toBe(false);
    }
  });
});

describe('countLines', () => {
  it('counts empty content as zero lines', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts a trailing newline as opening a final empty line', () => {
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(3);
  });

  it('does not treat a bare CR as a line break', () => {
    expect(countLines('a\rb')).toBe(1);
    expect(countLines('a\r\nb')).toBe(2);
  });
});

describe('sliceContentRange', () => {
  const doc = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');

  it('returns the requested inclusive window', () => {
    const out = sliceContentRange(doc, { startLine: 2, endLine: 4 });
    expect(out.content).toBe('line two\nline three\nline four');
    expect(out.range).toEqual({ startLine: 2, endLine: 4, totalLines: 5, truncated: true });
  });

  it('reports truncated:false when the range covers the whole content', () => {
    const out = sliceContentRange(doc, { startLine: 1, endLine: 5 });
    expect(out.content).toBe(doc);
    expect(out.range).toEqual({ startLine: 1, endLine: 5, totalLines: 5, truncated: false });
  });

  it('returns a single line for a single-line range', () => {
    const out = sliceContentRange(doc, { startLine: 3, endLine: 3 });
    expect(out.content).toBe('line three');
    expect(out.range.startLine).toBe(3);
    expect(out.range.endLine).toBe(3);
  });

  describe('empty content', () => {
    it('reports zero lines and withholds nothing', () => {
      const out = sliceContentRange('', { startLine: 1, endLine: 10 });
      expect(out.content).toBe('');
      expect(out.range).toEqual({ startLine: 0, endLine: 0, totalLines: 0, truncated: false });
    });
  });

  describe('EOF behavior', () => {
    it('clamps end_line down to the last line', () => {
      const out = sliceContentRange(doc, { startLine: 4, endLine: 400 });
      expect(out.content).toBe('line four\nline five');
      expect(out.range).toEqual({ startLine: 4, endLine: 5, totalLines: 5, truncated: true });
    });

    it('returns no lines when start_line is past the end, instead of sliding the window', () => {
      const out = sliceContentRange(doc, { startLine: 90, endLine: 99 });
      expect(out.content).toBe('');
      expect(out.range).toEqual({ startLine: 0, endLine: 0, totalLines: 5, truncated: true });
    });

    it('serves the last line exactly at the boundary', () => {
      const out = sliceContentRange(doc, { startLine: 5, endLine: 5 });
      expect(out.content).toBe('line five');
      expect(out.range.truncated).toBe(true);
    });

    it('treats a trailing newline as a real final empty line', () => {
      const out = sliceContentRange('a\nb\n', { startLine: 3, endLine: 3 });
      expect(out.content).toBe('');
      expect(out.range).toEqual({ startLine: 3, endLine: 3, totalLines: 3, truncated: true });
    });
  });

  describe('line endings', () => {
    it('round-trips CRLF content byte-exact (CR stays on the line)', () => {
      // Split-on-LF: the CR of each CRLF terminator belongs to the line before
      // it, so the slice is literally the source substring between those two
      // newlines — nothing is normalized away.
      const crlf = 'alpha\r\nbeta\r\ngamma\r\ndelta';
      const out = sliceContentRange(crlf, { startLine: 2, endLine: 3 });
      expect(out.content).toBe('beta\r\ngamma\r');
      expect(out.range.totalLines).toBe(4);
      expect(crlf).toContain(out.content);
      expect(crlf.slice('alpha\r\n'.length, 'alpha\r\nbeta\r\ngamma\r'.length)).toBe(out.content);
    });

    it('counts LF and CRLF content identically', () => {
      expect(countLines('a\nb\nc')).toBe(countLines('a\r\nb\r\nc'));
    });

    it('leaves a lone CR inside a line untouched', () => {
      const out = sliceContentRange('one\rstill one\ntwo', { startLine: 1, endLine: 1 });
      expect(out.content).toBe('one\rstill one');
    });
  });

  describe('Unicode', () => {
    it('preserves multi-byte characters, emoji, and combining marks', () => {
      const content = ['héllo wörld', '日本語のテキスト', '👩‍👩‍👧‍👦 family', 'é combining'].join('\n');
      const out = sliceContentRange(content, { startLine: 1, endLine: 4 });
      expect(out.content).toBe(content);
      expect(out.range.totalLines).toBe(4);
    });

    it('slices by line, not by code unit, when surrogate pairs are present', () => {
      const out = sliceContentRange('👍\n👎\n🤷', { startLine: 2, endLine: 2 });
      expect(out.content).toBe('👎');
    });

    it('never splits a multi-byte character when a single line exceeds the byte budget', () => {
      // 200 x 3-byte characters = 600 bytes on one line; budget cuts mid-character.
      const line = '日'.repeat(200);
      const out = sliceContentRange(line, { startLine: 1, endLine: 1 }, { maxBytes: 100 });
      expect(out.content).not.toContain('�');
      expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(100);
      expect(out.content).toBe('日'.repeat(33));
      expect(out.range.truncated).toBe(true);
    });
  });

  describe('raw Markdown fidelity', () => {
    it('keeps Markdown and chips byte-exact inside the window', () => {
      const markdown = [
        '# Heading',
        '',
        'See [the plan](doc-1111111111111-aaaaaaaaa) and `code`.',
        '',
        '```ts',
        'const x = { a: 1 };',
        '```',
        '',
        '| col | col |',
        '| --- | --- |',
      ].join('\n');
      const out = sliceContentRange(markdown, { startLine: 3, endLine: 7 });
      expect(out.content).toBe(
        'See [the plan](doc-1111111111111-aaaaaaaaa) and `code`.\n\n```ts\nconst x = { a: 1 };\n```'
      );
    });
  });

  describe('byte budget', () => {
    it('drops whole trailing lines and shrinks endLine to match', () => {
      const content = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(50)).join('\n');
      const out = sliceContentRange(content, { startLine: 1, endLine: 10 }, { maxBytes: 160 });
      // 3 lines = 150 bytes + 2 separators = 152; a 4th would be 203.
      expect(out.range.endLine).toBe(3);
      expect(out.content.split('\n')).toHaveLength(3);
      expect(out.content.split('\n').every((line) => line.length === 50)).toBe(true);
      expect(out.range.truncated).toBe(true);
      expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(160);
    });

    it('marks truncated even when the window reached the last line but was byte-cut', () => {
      const out = sliceContentRange(
        'a'.repeat(100),
        { startLine: 1, endLine: 1 },
        { maxBytes: 10 }
      );
      expect(out.content).toBe('a'.repeat(10));
      expect(out.range.endLine).toBe(1);
      expect(out.range.totalLines).toBe(1);
      expect(out.range.truncated).toBe(true);
    });

    it('neutralizes a forged tag before cutting an over-budget first line', () => {
      // The cut lands inside the tag, past "<system-reminder" but before its ">".
      const line = `${'x'.repeat(20)}<system-reminder data-note="${'y'.repeat(200)}">payload`;
      const out = sliceContentRange(line, { startLine: 1, endLine: 1 }, { maxBytes: 80 });
      expect(out.content.toLowerCase()).not.toContain('<system-reminder');
      expect(out.content).toContain('&lt;system-reminder');
      expect(out.range.truncated).toBe(true);
    });

    it('leaves content untouched when it fits the budget', () => {
      const out = sliceContentRange(
        'short\nlines',
        { startLine: 1, endLine: 2 },
        { maxBytes: 500 }
      );
      expect(out.content).toBe('short\nlines');
      expect(out.range.truncated).toBe(false);
    });
  });
});

describe('RangedResponseBudget', () => {
  it('funds items until the total is spent', () => {
    const budget = new RangedResponseBudget(100);
    expect(budget.available()).toBe(100);
    expect(budget.charge(60)).toBe(true);
    expect(budget.available()).toBe(40);
    expect(budget.wasExhausted()).toBe(false);
  });

  it('refuses an over-budget charge and records exhaustion', () => {
    const budget = new RangedResponseBudget(100);
    expect(budget.charge(60)).toBe(true);
    expect(budget.charge(60)).toBe(false);
    expect(budget.wasExhausted()).toBe(true);
    // The refused charge did not consume the remainder.
    expect(budget.available()).toBe(40);
  });

  it('can be marked exhausted without a charge (item omitted outright)', () => {
    const budget = new RangedResponseBudget(100);
    budget.markExhausted();
    expect(budget.wasExhausted()).toBe(true);
  });
});
