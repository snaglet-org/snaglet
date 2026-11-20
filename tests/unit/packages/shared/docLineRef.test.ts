import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HEADING_FRAGMENT_SOURCE } from '@snaglet/shared/utils/docHeadingRef';
import {
  LINE_FRAGMENT_SQL_SOURCE,
  formatLineFragment,
  lineRefLabel,
  parseLineFragment,
  sliceLineRef,
  splitLineRef,
  withLineRef,
} from '@snaglet/shared/utils/docLineRef';
import { LINE_FRAGMENT_FIXTURES, OUT_OF_ORDER_FRAGMENTS } from '../../../support/lineLinkFixtures';

const ID = 'doc-1111111111111-aaaaaaaaa';
const SQL_FRAGMENT = new RegExp(`^(?:${LINE_FRAGMENT_SQL_SOURCE})$`);

describe('doc line links — parse', () => {
  it('reads one line, a span and a char-precise span', () => {
    expect(parseLineFragment('L12')).toEqual({ startLine: 12, endLine: 12 });
    expect(parseLineFragment('L12-L20')).toEqual({ startLine: 12, endLine: 20 });
    expect(parseLineFragment('L12:5-L14:30')).toEqual({
      startLine: 12,
      endLine: 14,
      startChar: 5,
      endChar: 30,
    });
  });

  it('rejects backwards, zero, half-char and junk fragments', () => {
    for (const bad of ['L0', 'L20-L12', 'L12:5-L14', 'L3:9-L3:2', 'heading', 'L', 'L1-']) {
      expect(parseLineFragment(bad)).toBeNull();
    }
  });

  // The chip label reads `L3–5`, so people and agents write the link the
  // same way; markdown parsers also percent-encode the en dash in an href.
  it.each(LINE_FRAGMENT_FIXTURES.map(({ fragment, lines }) => [fragment, lines] as const))(
    'reads %s as its range, or as no range',
    (fragment, lines) => {
      expect(parseLineFragment(fragment)).toEqual(lines);
      expect(splitLineRef(`${ID}#${fragment}`)).toEqual(
        lines ? { id: ID, lines } : { id: `${ID}#${fragment}`, lines: null }
      );
    }
  );

  it.each(OUT_OF_ORDER_FRAGMENTS)('rejects the backwards or empty range %s', (fragment) => {
    expect(parseLineFragment(fragment)).toBeNull();
  });

  it('splits an href into bare id + range and leaves other hashes alone', () => {
    expect(splitLineRef(`${ID}#L4-L9`)).toEqual({ id: ID, lines: { startLine: 4, endLine: 9 } });
    expect(splitLineRef(ID)).toEqual({ id: ID, lines: null });
    expect(splitLineRef(`${ID}#intro`)).toEqual({ id: `${ID}#intro`, lines: null });
  });

  it('round-trips format ↔ parse', () => {
    for (const f of ['L7', 'L7-L9', 'L7:2-L9:4']) {
      expect(formatLineFragment(parseLineFragment(f)!)).toBe(f);
    }
    expect(withLineRef(ID, { startLine: 3, endLine: 5 })).toBe(`${ID}#L3-L5`);
    expect(lineRefLabel({ startLine: 3, endLine: 5 })).toBe('L3–5');
  });
});

describe('doc line links — slice', () => {
  const doc = ['# Title', 'alpha beta', 'gamma delta', 'epsilon'].join('\n');

  it('returns the inclusive line span', () => {
    const s = sliceLineRef(doc, { startLine: 2, endLine: 3 });
    expect(s.text).toBe('alpha beta\ngamma delta');
    expect(s).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4, clamped: false });
  });

  it('trims to chars, 1-indexed and inclusive, on one or many lines', () => {
    expect(sliceLineRef(doc, { startLine: 2, endLine: 2, startChar: 7, endChar: 10 }).text).toBe(
      'beta'
    );
    expect(sliceLineRef(doc, { startLine: 2, endLine: 3, startChar: 7, endChar: 5 }).text).toBe(
      'beta\ngamma'
    );
  });

  it('clamps past the end and flags a range that starts past it', () => {
    expect(sliceLineRef(doc, { startLine: 3, endLine: 99 })).toMatchObject({
      text: 'gamma delta\nepsilon',
      endLine: 4,
      clamped: true,
    });
    expect(sliceLineRef(doc, { startLine: 9, endLine: 9 })).toMatchObject({
      text: '',
      outOfRange: true,
    });
  });
});

describe('doc line links — the doc-link trigger grammar', () => {
  // The database counts a link by regex (packages/db/migrations/0001_init.sql),
  // so its fragment grammar must accept what parseLineFragment accepts. The
  // DB integration test (docLineLinkTrigger.test.ts) runs the real trigger on
  // the same fixtures; this one keeps the SQL text in step without a database.
  it.each(LINE_FRAGMENT_FIXTURES.map(({ fragment, lines }) => [fragment, lines !== null] as const))(
    'the SQL grammar agrees with the parser on %s',
    (fragment, isRange) => {
      // JavaScript reads the PostgreSQL source the same way: plain classes,
      // \u escapes and non-capturing groups only.
      expect(SQL_FRAGMENT.test(fragment)).toBe(isRange);
    }
  );

  it('still matches a backwards range, which a regex cannot order', () => {
    for (const fragment of OUT_OF_ORDER_FRAGMENTS) expect(SQL_FRAGMENT.test(fragment)).toBe(true);
  });

  it('is the exact fragment both doc-link trigger functions use', () => {
    const baseline = readFileSync(
      join(__dirname, '../../../../packages/db/migrations/0001_init.sql'),
      'utf8'
    );
    const fragment = `(?:#(?:${LINE_FRAGMENT_SQL_SOURCE}|${HEADING_FRAGMENT_SOURCE}))?\\)`;
    const docLinkRegexes = baseline
      .split('\n')
      .filter((line) => line.includes("'!?\\[([^\\]]*)\\]\\("));
    expect(docLinkRegexes).toHaveLength(2);
    for (const line of docLinkRegexes) expect(line).toContain(fragment);
  });
});
