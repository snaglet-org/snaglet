import { findTransclusions, transcludedDocIds } from '@snaglet/shared/utils/transclusions';
import { lineRefOffsets, sliceLineRef, type LineRef } from '@snaglet/shared/utils/docLineRef';

describe('findTransclusions', () => {
  it('finds doc transclusions with label, part and position, and skips links', () => {
    const content = 'Intro\n![Setup](doc-b#h=install)\nSee [B](doc-b) and ![](doc-c)';
    const hits = findTransclusions(content);
    expect(hits.map((h) => [h.docId, h.ref, h.label])).toEqual([
      ['doc-b', 'doc-b#h=install', 'Setup'],
      ['doc-c', 'doc-c', ''],
    ]);
    expect(content.slice(hits[0]!.index, hits[0]!.index + hits[0]!.length)).toBe(
      '![Setup](doc-b#h=install)'
    );
    expect(hits[0]!.anchor).toEqual({ heading: { slug: 'install' } });
  });

  it('ignores code, images and non-doc targets', () => {
    const content = [
      '`![](doc-in-code)`',
      '```',
      '![](doc-in-fence)',
      '```',
      '![logo](https://example.com/logo.png)',
      '![](image-1)',
      '![](doc-real)',
    ].join('\n');
    expect(transcludedDocIds(content)).toEqual(['doc-real']);
  });

  it('lists each transcluded doc once, in order', () => {
    expect(transcludedDocIds('![](doc-b) ![](doc-a) ![x](doc-b#L1)')).toEqual(['doc-b', 'doc-a']);
  });
});

describe('lineRefOffsets', () => {
  const content = 'one\ntwo two\nthree\n\nfive';
  const cases: LineRef[] = [
    { startLine: 1, endLine: 1 },
    { startLine: 2, endLine: 3 },
    { startLine: 4, endLine: 5 },
    { startLine: 3, endLine: 9 },
    { startLine: 2, endLine: 2, startChar: 5, endChar: 7 },
    { startLine: 2, endLine: 3, startChar: 2, endChar: 4 },
    { startLine: 2, endLine: 9, startChar: 2, endChar: 4 },
    { startLine: 1, endLine: 1, startChar: 9, endChar: 12 },
  ];

  it.each(cases)('matches sliceLineRef for %o', (lines) => {
    const range = lineRefOffsets(content, lines);
    expect(range).not.toBeNull();
    expect(content.slice(range!.start, range!.end)).toBe(sliceLineRef(content, lines).text);
  });

  it('is null past the end of the doc', () => {
    expect(lineRefOffsets(content, { startLine: 9, endLine: 9 })).toBeNull();
  });
});

describe('findTransclusions: fences', () => {
  it('keeps code open past a fence line with an info string or a shorter run', () => {
    const content = ['````md', '```js', '![](doc-in-code)', '```', '````', '![](doc-real)\r'].join(
      '\n'
    );
    expect(transcludedDocIds(content)).toEqual(['doc-real']);
  });
});
