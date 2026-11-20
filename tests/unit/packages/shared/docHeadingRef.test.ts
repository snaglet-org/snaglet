import {
  docHeadings,
  docOutline,
  formatHeadingFragment,
  headingRangeForLines,
  headingRefLabel,
  resolveDocAnchor,
  findHeadingSection,
  headingRefFor,
  headingSlug,
  parseHeadingFragment,
  parseInDocHeadingHref,
  sliceDocAnchor,
  splitDocRef,
} from '@snaglet/shared/utils/docHeadingRef';

const ID = 'doc-1111111111111-aaaaaaaaa';

const MD = [
  '# Scraping', //                 1
  '', //                           2
  '## Rate limits', //             3
  '- 10 rpm', //                   4
  '### Retries', //                5
  '- back off on 429', //          6
  '', //                           7
  '## Costs', //                   8
  'cheap', //                      9
  '```md', //                      10
  '## Not a heading', //           11
  '```', //                        12
  '### Rate limits', //            13
  'api-level limits', //           14
  '## Rate limits', //             15
  'again', //                      16
].join('\n');

describe('heading links — parse and slug', () => {
  it('parses #h= and #hN= and rejects junk', () => {
    expect(parseHeadingFragment('h=rate-limits')).toEqual({ slug: 'rate-limits' });
    expect(parseHeadingFragment('h3=rate-limits')).toEqual({ slug: 'rate-limits', level: 3 });
    expect(parseHeadingFragment('h7=x')).toBeNull();
    expect(parseHeadingFragment('h=')).toBeNull();
    expect(parseHeadingFragment('L12')).toBeNull();
  });

  it('slugs like GitHub', () => {
    expect(headingSlug('Rate limits')).toBe('rate-limits');
    expect(headingSlug('What’s **new** in `v2`?')).toBe('whats-new-in-v2');
    expect(headingSlug('[Penny](doc-1-a) & Firecrawl')).toBe('penny--firecrawl');
  });

  it('splits either fragment off a doc id', () => {
    expect(splitDocRef(`${ID}#h3=costs`)).toEqual({
      id: ID,
      anchor: { heading: { slug: 'costs', level: 3 } },
    });
    expect(splitDocRef(`${ID}#L4-L6`).anchor).toEqual({ lines: { startLine: 4, endLine: 6 } });
    expect(splitDocRef(`${ID}#intro`)).toEqual({ id: `${ID}#intro`, anchor: null });
  });
});

describe('in-doc heading links — no doc id', () => {
  it('reads #h= in every form a doc link takes', () => {
    expect(parseInDocHeadingHref('#h=costs')).toEqual({ slug: 'costs' });
    expect(parseInDocHeadingHref('#h3=rate-limits')).toEqual({ slug: 'rate-limits', level: 3 });
    expect(parseInDocHeadingHref('#h=costs..h=rate-limits-2')).toEqual({
      slug: 'costs',
      to: { slug: 'rate-limits-2' },
    });
  });

  it("reads GitHub's #slug as the heading #h=slug names", () => {
    expect(parseInDocHeadingHref('#rate-limits-1')).toEqual({ slug: 'rate-limits-1' });
    expect(parseInDocHeadingHref('#Rate-Limits')).toEqual({ slug: 'rate-limits' });
    expect(parseInDocHeadingHref('#caf%C3%A9')).toEqual({ slug: 'café' });
    for (const h of docHeadings(MD)) {
      const ref = parseInDocHeadingHref(`#${h.slug}`);
      expect(ref && findHeadingSection(MD, ref)?.heading.line).toBe(h.line);
    }
  });

  it('is null for anything else', () => {
    for (const href of [
      '',
      '#',
      'h=costs',
      `${ID}#h=costs`,
      'https://example.org/#costs',
      '#two words',
      '#v1.2',
      '#h=a..h=b..h=c',
      '#%E0%A4%A',
    ]) {
      expect(parseInDocHeadingHref(href)).toBeNull();
    }
  });
});

describe('heading links — finding sections', () => {
  it('lists headings, skipping fenced code, numbering repeats', () => {
    const hs = docHeadings(MD);
    expect(hs.map((h) => [h.level, h.slug, h.levelSlug])).toEqual([
      [1, 'scraping', 'scraping'],
      [2, 'rate-limits', 'rate-limits'],
      [3, 'retries', 'retries'],
      [2, 'costs', 'costs'],
      [3, 'rate-limits-1', 'rate-limits'],
      [2, 'rate-limits-2', 'rate-limits-1'],
    ]);
  });

  it('a section runs to the next same-or-higher heading, sub-headings included', () => {
    expect(findHeadingSection(MD, { slug: 'rate-limits' })?.lines).toEqual({
      startLine: 3,
      endLine: 6,
    });
    expect(sliceDocAnchor(MD, { heading: { slug: 'retries' } }).text).toBe(
      '### Retries\n- back off on 429'
    );
  });

  it('#hN= picks the heading at that level', () => {
    expect(findHeadingSection(MD, { slug: 'rate-limits', level: 3 })?.lines).toEqual({
      startLine: 13,
      endLine: 14,
    });
    expect(findHeadingSection(MD, { slug: 'rate-limits-1', level: 2 })?.lines.startLine).toBe(15);
  });

  it('a #hN= link whose heading changed level still resolves, with a note', () => {
    const s = findHeadingSection(MD, { slug: 'costs', level: 3 });
    expect(s?.lines.startLine).toBe(8);
    expect(s?.note).toMatch(/now level 2/);
  });

  it('survives lines added above (the point of heading links)', () => {
    const edited = 'new note\nmore notes\n\n' + MD;
    expect(findHeadingSection(edited, { slug: 'retries' })?.lines).toEqual({
      startLine: 8,
      endLine: 9,
    });
  });

  it('says so when the heading is gone', () => {
    const r = sliceDocAnchor(MD, { heading: { slug: 'pricing' } });
    expect(r.text).toBeNull();
    expect(r.note).toMatch(/No heading "h=pricing"/);
  });
});

describe('heading links — what the copy button makes', () => {
  it('plain #h= normally, #hN= when the name repeats at another level', () => {
    expect(headingRefFor(MD, 8)).toEqual({ slug: 'costs' });
    expect(headingRefFor(MD, 13)).toEqual({ slug: 'rate-limits', level: 3 });
    expect(headingRefFor(MD, 15)).toEqual({ slug: 'rate-limits-1', level: 2 });
    expect(headingRefFor(MD, 4)).toBeNull();
  });

  it('every heading link the button makes resolves back to its own heading', () => {
    for (const h of docHeadings(MD)) {
      const ref = headingRefFor(MD, h.line)!;
      expect(findHeadingSection(MD, ref)?.heading.line).toBe(h.line);
    }
  });
});

describe('heading ranges — #h=a..h=b', () => {
  const PLAN = [
    '# Plan', //            1
    '## Part 1', //         2
    'one', //               3
    '### Detail', //        4
    'deep', //              5
    '## Part 2', //         6
    'two', //               7
    '## Part 3', //         8
    'three', //             9
    '', //                  10
    '## Appendix', //       11
    'extra', //             12
  ].join('\n');

  it('parses, formats and labels a range', () => {
    const ref = parseHeadingFragment('h=part-1..h2=part-3');
    expect(ref).toEqual({ slug: 'part-1', to: { slug: 'part-3', level: 2 } });
    expect(formatHeadingFragment(ref!)).toBe('h=part-1..h2=part-3');
    expect(headingRefLabel(ref!)).toBe('§ part-1 … h2 part-3');
    expect(parseHeadingFragment('h=a..h=b..h=c')).toBeNull();
    expect(parseHeadingFragment('h=a..')).toBeNull();
    expect(parseHeadingFragment('h=a..h=a')).toEqual({ slug: 'a' });
    expect(splitDocRef(`${ID}#h=part-1..h=part-3`).anchor).toEqual({
      heading: { slug: 'part-1', to: { slug: 'part-3' } },
    });
  });

  it('runs from the first section start to the last section end', () => {
    const r = sliceDocAnchor(PLAN, { heading: { slug: 'part-1', to: { slug: 'part-3' } } });
    expect(r.lines).toEqual({ startLine: 2, endLine: 9 });
    expect(r.text).not.toContain('Appendix');
  });

  it('covers a parent section when the end is nested inside the start', () => {
    expect(
      resolveDocAnchor(PLAN, { heading: { slug: 'part-1', to: { slug: 'detail' } } }).lines
    ).toEqual({ startLine: 2, endLine: 5 });
  });

  it('says which end is missing, and refuses an out-of-order range', () => {
    expect(
      resolveDocAnchor(PLAN, { heading: { slug: 'part-1', to: { slug: 'part-9' } } }).note
    ).toMatch(/No heading "h=part-9"/);
    const back = resolveDocAnchor(PLAN, { heading: { slug: 'part-3', to: { slug: 'part-1' } } });
    expect(back.lines).toBeNull();
    expect(back.note).toMatch(/out of order/);
  });

  it('a selection from a heading across 2+ headings copies a range; others stay lines', () => {
    expect(headingRangeForLines(PLAN, { startLine: 2, endLine: 9 })).toEqual({
      ref: { slug: 'part-1', to: { slug: 'part-3' } },
      text: 'Part 1 … Part 3',
    });
    expect(headingRangeForLines(PLAN, { startLine: 3, endLine: 9 })).toBeNull();
    expect(headingRangeForLines(PLAN, { startLine: 2, endLine: 3 })).toBeNull();
  });
});

describe('docOutline: line endings and fences', () => {
  it('reads headings and heading links in a CRLF doc', () => {
    const content = '# One\r\n\r\ntext\r\n\r\n## Two\r\ntext';
    expect(docOutline(content).map((h) => [h.level, h.text, h.line, h.ref.slug])).toEqual([
      [1, 'One', 1, 'one'],
      [2, 'Two', 5, 'two'],
    ]);
    expect(resolveDocAnchor(content, { heading: { slug: 'two' } }).lines).toEqual({
      startLine: 5,
      endLine: 6,
    });
  });

  it('closes a fence only on a bare run at least as long as the opening one', () => {
    const content = [
      '```js', //  1
      'code', //  2
      '```js', //  3  an info string: still code
      '# inside code', //  4
      '```', //  5  closes
      '# Real', //  6
      '````', //  7
      '```', //  8  too short to close
      '# also code', //  9
      '`````', // 10  longer closes
      '# After', // 11
    ].join('\n');
    expect(docOutline(content).map((h) => [h.text, h.line])).toEqual([
      ['Real', 6],
      ['After', 11],
    ]);
  });
});
