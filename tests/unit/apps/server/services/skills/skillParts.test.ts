/**
 * skillParts: line-boundary splitting and the numbered-part results the
 * `skill` tool returns for files too long for one tool result.
 */
import { describe, expect, it } from '@jest/globals';
import { pageSkillText, splitAtLines } from '@server/services/skills/skillParts';

const lines = (n: number, width = 40) =>
  Array.from(
    { length: n },
    (_, i) => `${String(i + 1).padStart(4, '0')} ${'x'.repeat(width)}\n`
  ).join('');

describe('splitAtLines', () => {
  it('breaks only after a newline and joins back to the exact text', () => {
    const text = lines(100);
    const parts = splitAtLines(text, 1_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.body).join('')).toBe(text);
    for (const p of parts) {
      expect(p.body.length).toBeLessThanOrEqual(1_000);
      expect(p.body.endsWith('\n')).toBe(true);
      expect(p.endsMidLine).toBe(false);
    }
  });

  it('keeps CRLF pairs together and a last line with no newline', () => {
    const text = 'one\r\ntwo\r\nthree';
    const parts = splitAtLines(text, 6);
    expect(parts.map((p) => p.body)).toEqual(['one\r\n', 'two\r\n', 'three']);
  });

  it('cuts a single line longer than a part, marking those parts as mid-line', () => {
    const long = 'y'.repeat(250);
    const text = `short\n${long}\nafter\n`;
    const parts = splitAtLines(text, 100);
    expect(parts.map((p) => p.body).join('')).toBe(text);
    expect(parts[0]).toEqual({ body: 'short\n', endsMidLine: false });
    expect(parts[1]).toEqual({ body: 'y'.repeat(100), endsMidLine: true });
    expect(parts[2]).toEqual({ body: 'y'.repeat(100), endsMidLine: true });
    // The tail of the long line starts the next part, and whole lines follow it.
    expect(parts[3]).toEqual({ body: `${'y'.repeat(50)}\nafter\n`, endsMidLine: false });
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(5)}`;
    const parts = splitAtLines(text, 10);
    expect(parts.map((p) => p.body).join('')).toBe(text);
    expect(parts[0].body).toBe('a'.repeat(9));
    expect(parts[1].body.startsWith('😀')).toBe(true);
  });
});

describe('pageSkillText', () => {
  const VERSION = 'abcdef012345';
  const base = {
    version: VERSION,
    header: (at: { n: number; total: number } | null) =>
      `[Skill demo · version ${VERSION}${at ? ` · part ${at.n} of ${at.total}` : ''}]`,
    call: { op: 'load', slug: 'demo' },
    label: "Skill 'demo'",
    expectedVersion: undefined as unknown,
  };
  const next = (n: number) => `{"op":"load","slug":"demo","part":${n},"version":"${VERSION}"}`;

  it('returns the whole text under its header when it fits in one result', () => {
    const out = pageSkillText({
      ...base,
      text: 'short body\n',
      maxResultChars: 1_000,
      part: undefined,
    });
    expect(out).toBe(`[Skill demo · version ${VERSION}]\nshort body\n`);
    expect(() =>
      pageSkillText({ ...base, text: 'short body\n', maxResultChars: 1_000, part: 2 })
    ).toThrow("Skill 'demo' has 1 part; part 2 does not exist.");
  });

  it('splits a long text into parts that each fit max_result_chars, with a footer on all but the last', () => {
    const text = lines(400); // ~18,000 chars
    const max = 2_000;
    const first = pageSkillText({ ...base, text, maxResultChars: max, part: undefined });
    const total = Number(/part 1 of (\d+)/.exec(first)?.[1]);
    expect(total).toBeGreaterThan(8);

    const bodies: string[] = [];
    for (let n = 1; n <= total; n++) {
      const out = pageSkillText({ ...base, text, maxResultChars: max, part: n });
      expect(out.length).toBeLessThanOrEqual(max);
      const [head, ...rest] = out.split('\n');
      expect(head).toBe(`[Skill demo · version ${VERSION} · part ${n} of ${total}]`);
      let body = rest.join('\n');
      // The next-part call carries the version, tying every part to one copy.
      const footer = `[Part ${n} of ${total} — call skill ${next(n + 1)} for the next part]`;
      if (n < total) {
        expect(body.endsWith(footer)).toBe(true);
        body = body.slice(0, -footer.length);
      } else {
        expect(body).not.toContain('[Part ');
      }
      bodies.push(body);
    }
    // Every part ends on a line boundary, and the parts rebuild the file exactly.
    expect(bodies.every((b) => b.endsWith('\n'))).toBe(true);
    expect(bodies.join('')).toBe(text);
  });

  it('accepts a numeric string for part, and refuses a bad or out-of-range one', () => {
    const text = lines(400);
    const page = (part: unknown) => pageSkillText({ ...base, text, maxResultChars: 2_000, part });
    expect(page('2')).toBe(page(2));
    const total = Number(/part 1 of (\d+)/.exec(page(1))?.[1]);
    expect(() => page(total + 1)).toThrow(
      `Skill 'demo' has ${total} parts; part ${total + 1} does not exist. Ask for part 1 to ${total}.`
    );
    for (const bad of [0, -1, 1.5, 'two', true]) {
      expect(() => page(bad)).toThrow('part must be a whole number, 1 or more.');
    }
  });

  it('checks the version: a match (or an 8+ char prefix) passes, a mismatch says start again', () => {
    const text = lines(400);
    const page = (expectedVersion: unknown, part = 2) =>
      pageSkillText({ ...base, text, maxResultChars: 2_000, part, expectedVersion });
    const plain = page(undefined);
    expect(page(VERSION)).toBe(plain);
    expect(page(VERSION.slice(0, 8))).toBe(plain);
    expect(page(`${VERSION}0123`)).toBe(plain); // the full 16-char content hash
    const total = Number(/part 2 of (\d+)/.exec(plain)?.[1]);
    for (const stale of ['0123456789ab', VERSION.slice(0, 4)]) {
      expect(() => page(stale)).toThrow(
        `Skill 'demo' changed since that part (now version ${VERSION}, ${total} parts). Start again from part 1.`
      );
    }
    expect(() => page(42)).toThrow('version must be the version string from a part footer.');
    // A file that now fits whole still reports the change, as one part.
    expect(() =>
      pageSkillText({
        ...base,
        text: 'short\n',
        maxResultChars: 2_000,
        part: 2,
        expectedVersion: 'ffffffffffff',
      })
    ).toThrow(`(now version ${VERSION}, 1 part). Start again from part 1.`);
  });

  it('marks a part that ends inside a single over-long line', () => {
    const text = `intro\n${'z'.repeat(5_000)}\nend\n`;
    const out = pageSkillText({ ...base, text, maxResultChars: 2_000, part: 2 });
    expect(
      out.endsWith(`\n[Part 2 of 4, ends mid-line — call skill ${next(3)} for the next part]`)
    ).toBe(true);
    expect(out.length).toBeLessThanOrEqual(2_000);
  });

  it('sizes parts from max_result_chars: a larger setting means fewer parts', () => {
    const text = lines(400);
    const totalAt = (max: number) =>
      Number(
        /part 1 of (\d+)/.exec(pageSkillText({ ...base, text, maxResultChars: max, part: 1 }))?.[1]
      );
    expect(totalAt(2_000)).toBeGreaterThan(totalAt(6_000));
    expect(totalAt(6_000)).toBeGreaterThan(1);
    // At 30,000 the whole text fits: no parts at all.
    expect(pageSkillText({ ...base, text, maxResultChars: 30_000, part: 1 })).toBe(
      `[Skill demo · version ${VERSION}]\n${text}`
    );
  });

  it('never returns a part over the limit: too little room for header + footer is an error', () => {
    const text = lines(400);
    // Header + footer need nearly 200 characters; 230 leaves less than a 100-char body.
    expect(() => pageSkillText({ ...base, text, maxResultChars: 230, part: 1 })).toThrow(
      /Skill 'demo' is too long for one tool result and cannot be split into parts that fit: max_result_chars is 230 and a part's header and footer alone need \d+\. Raise the max_result_chars setting, or use a shorter file path\./
    );
    // A small but workable setting still pages, every part within it.
    const out = pageSkillText({ ...base, text, maxResultChars: 400, part: 3 });
    expect(out.length).toBeLessThanOrEqual(400);
    // A very long read path eats the room the same way.
    const longPath = {
      ...base,
      call: { op: 'read', slug: 'demo', path: `${'d/'.repeat(900)}f.md` },
    };
    expect(() => pageSkillText({ ...longPath, text, maxResultChars: 2_000, part: 1 })).toThrow(
      /cannot be split into parts that fit/
    );
  });
});
