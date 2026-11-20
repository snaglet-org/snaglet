import { describe, expect, it } from 'vitest';

import { highlightMarkdownSource, type SourceLine } from './sourceHighlight';

/** `kind[level]: marked spans`, markers in ‹›, styled spans as kind{text}. */
function show(line: SourceLine): string {
  const spans = line.spans
    .map((span) => (span.kind === 'plain' ? span.text : `${span.kind}{${span.text}}`))
    .join('');
  return `${line.kind}${line.level ?? ''}: ${spans}`;
}

const lines = (text: string) => highlightMarkdownSource(text).map(show);

describe('highlightMarkdownSource', () => {
  it('keeps every character, in order, so the overlay lines up with the text', () => {
    const text =
      '# Title\n\nSome **bold**, *it*, `code`, ~~gone~~ and [a link](https://x.test).\n' +
      '- item\n  1. [ ] task\n> quote\n```ts\nconst a = 1;\n```\n---\n\n';
    const joined = highlightMarkdownSource(text)
      .map((line) => line.spans.map((span) => span.text).join(''))
      .join('\n');
    expect(joined).toBe(text);
  });

  it.each([1, 2, 3, 4, 5, 6])('styles a level %i heading as soon as "# " is typed', (level) => {
    const hashes = '#'.repeat(level);
    expect(lines(`${hashes} `)).toEqual([`heading${level}: marker{${hashes} }`]);
    expect(lines(`${hashes} Title`)).toEqual([`heading${level}: marker{${hashes} }Title`]);
  });

  it('leaves "#" without a space, and seven hashes, as text', () => {
    expect(lines('#tag')).toEqual(['text: #tag']);
    expect(lines('####### x')).toEqual(['text: ####### x']);
  });

  it('marks list, task and quote markers', () => {
    expect(lines('- a\n* b\n+ c\n12. d\n- [x] e\n> f')).toEqual([
      'list: marker{- }a',
      'list: marker{* }b',
      'list: marker{+ }c',
      'list: marker{12. }d',
      'list: marker{- [x] }e',
      'quote: marker{> }f',
    ]);
  });

  it('marks inline spans with their markers', () => {
    expect(lines('a **b** *c* _d_ `e` ~~f~~ [g](h)')).toEqual([
      'text: a marker{**}bold{b}marker{**} marker{*}italic{c}marker{*} ' +
        'marker{_}italic{d}marker{_} code{`e`} marker{~~}strike{f}marker{~~} ' +
        'marker{[}link{g}marker{](}url{h}marker{)}',
    ]);
  });

  it('keeps snake_case words and lone stars as text', () => {
    expect(lines('snake_case_name and 2 * 3 * 4')).toEqual(['text: snake_case_name and 2 * 3 * 4']);
  });

  it('treats everything inside a fence as code, markdown included', () => {
    expect(lines('```js\n# not a heading\n**x**\n```\nafter')).toEqual([
      'fence: marker{```js}',
      'code: # not a heading',
      'code: **x**',
      'fence: marker{```}',
      'text: after',
    ]);
  });

  it('marks a divider', () => {
    expect(lines('---\n***\n_ _ _')).toEqual([
      'rule: marker{---}',
      'rule: marker{***}',
      'rule: marker{_ _ _}',
    ]);
  });
});
