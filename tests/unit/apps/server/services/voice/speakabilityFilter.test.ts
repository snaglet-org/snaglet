/**
 * speakabilityFilter — how a segment should sound. Covers placeholder
 * substitution for structured blocks, markdown stripping, mention
 * normalization, list handling, and placeholder de-duplication.
 */

import { describe, expect, it } from '@jest/globals';
import {
  cleanProseForSpeech,
  filterSegment,
  filterSegments,
  toSpeech,
} from '@server/services/voice/speakabilityFilter';
import type { TextSegment } from '@server/services/voice/sentenceSegmenter';

const seg = (kind: TextSegment['kind'], text: string): TextSegment => ({ kind, text });

describe('cleanProseForSpeech', () => {
  it('strips emphasis and inline code', () => {
    expect(cleanProseForSpeech('Hello **world** and `code` here')).toBe(
      'Hello world and code here'
    );
    expect(cleanProseForSpeech('Some _italic_ and *stars*')).toBe('Some italic and stars');
  });

  it('unwraps links to their text and replaces bare URLs', () => {
    expect(cleanProseForSpeech('See [the docs](https://example.com) now')).toBe('See the docs now');
    expect(cleanProseForSpeech('Visit https://example.com/path today')).toBe('Visit a link today');
  });

  it('normalizes @mentions to plain names', () => {
    expect(cleanProseForSpeech('@Ada can you check with @sam-lee')).toBe(
      'Ada can you check with sam-lee'
    );
  });

  it('strips heading and blockquote markers', () => {
    expect(cleanProseForSpeech('## Section title')).toBe('Section title');
    expect(cleanProseForSpeech('> quoted line')).toBe('quoted line');
  });

  it('collapses whitespace', () => {
    expect(cleanProseForSpeech('a    b\tc')).toBe('a b c');
  });
});

describe('cleanProseForSpeech — wikilinks / node references', () => {
  const DOC_ID = 'doc-1111111111111-y1c4z6wb3';

  it('speaks a titled node link as its title, never the raw id', () => {
    expect(
      cleanProseForSpeech(`See [Co-located test files silently skipped by Jest](${DOC_ID}) now.`)
    ).toBe('See Co-located test files silently skipped by Jest now.');
  });

  it('speaks a kind noun when the link label is the raw id', () => {
    expect(cleanProseForSpeech(`[${DOC_ID}](${DOC_ID})`)).toBe('doc');
  });

  it('speaks a kind noun for a titleless include (![](doc-…))', () => {
    expect(cleanProseForSpeech(`![](${DOC_ID})`)).toBe('doc');
  });

  it('keeps the alt label of a titled include', () => {
    expect(cleanProseForSpeech(`![Diagram](${DOC_ID})`)).toBe('Diagram');
  });

  it('replaces a bare node id sitting in prose with the kind noun', () => {
    expect(cleanProseForSpeech(`See ${DOC_ID} for details.`)).toBe('See doc for details.');
  });

  it('speaks the kind noun for other node kinds', () => {
    expect(cleanProseForSpeech('Open thread-1111111111111-zzz9 please.')).toBe(
      'Open thread please.'
    );
    expect(cleanProseForSpeech('memory-1111111111111-mmm1 has it.')).toBe('memory has it.');
  });

  it('speaks a sketch reference as its title, or the "sketch" noun for a bare id', () => {
    const SKETCH_ID = 'sketch-1111111111111-aaaaaaaaa';
    expect(cleanProseForSpeech(`Review [Login wireframe](${SKETCH_ID}) first.`)).toBe(
      'Review Login wireframe first.'
    );
    expect(cleanProseForSpeech(`${SKETCH_ID} shows the flow.`)).toBe('sketch shows the flow.');
    expect(cleanProseForSpeech(`[${SKETCH_ID}](${SKETCH_ID})`)).toBe('sketch');
  });

  it('speaks a post reference as its title, or the "post" noun for a bare id', () => {
    const POST_ID = 'post-1111111111111-aaaaaaaaa';
    expect(cleanProseForSpeech(`Read [Release plan](${POST_ID}) first.`)).toBe(
      'Read Release plan first.'
    );
    expect(cleanProseForSpeech(`${POST_ID} covers it.`)).toBe('post covers it.');
    expect(cleanProseForSpeech(`[${POST_ID}](${POST_ID})`)).toBe('post');
  });

  it('handles Obsidian-style [[label]] wikilinks by speaking the label', () => {
    expect(cleanProseForSpeech('Check the [[The Team]] page.')).toBe('Check the The Team page.');
  });

  it('speaks a kind noun for a bare-id [[doc-…]] wikilink', () => {
    expect(cleanProseForSpeech(`Check [[${DOC_ID}]] now.`)).toBe('Check doc now.');
  });

  it('prefers the alias of a [[target|alias]] wikilink', () => {
    expect(cleanProseForSpeech(`[[${DOC_ID}|The Team]]`)).toBe('The Team');
  });

  it('resolves multiple node links in one sentence', () => {
    expect(
      cleanProseForSpeech(
        'See [First](doc-1111111111111-aaaa) then [Second](thread-2222222222222-bbbb).'
      )
    ).toBe('See First then Second.');
  });

  it('leaves plain prose and ordinary URL links untouched', () => {
    expect(cleanProseForSpeech('Plain text, nothing to resolve.')).toBe(
      'Plain text, nothing to resolve.'
    );
    expect(cleanProseForSpeech('Read [the guide](https://example.com/x).')).toBe('Read the guide.');
  });
});

describe('filterSegment — placeholders', () => {
  it('replaces code blocks with a spoken placeholder', () => {
    const r = filterSegment(seg('code', '```\nx = 1\n```'));
    expect(r.kind).toBe('placeholder');
    expect(r.placeholderFor).toBe('code');
    expect(r.speak).toMatch(/code block/i);
  });

  it('replaces tables with a spoken placeholder', () => {
    const r = filterSegment(seg('table', '| a | b |\n| - | - |'));
    expect(r.kind).toBe('placeholder');
    expect(r.speak).toMatch(/table/i);
  });

  it('replaces long lists with a placeholder', () => {
    const list = '- a\n- b\n- c\n- d\n- e\n- f';
    const r = filterSegment(seg('list', list));
    expect(r.kind).toBe('placeholder');
    expect(r.placeholderFor).toBe('list');
  });

  it('speaks a short list item-by-item', () => {
    const r = filterSegment(seg('list', '- buy milk\n- walk dog'));
    expect(r.kind).toBe('sentence');
    expect(r.speak).toBe('buy milk. walk dog.');
  });

  it('honors a custom list threshold', () => {
    const r = filterSegment(seg('list', '- a\n- b\n- c'), { maxListItems: 2 });
    expect(r.kind).toBe('placeholder');
  });
});

describe('filterSegment — sentences', () => {
  it('cleans a prose sentence', () => {
    const r = filterSegment(seg('sentence', 'Ping @Ada about the **plan**.'));
    expect(r.kind).toBe('sentence');
    expect(r.speak).toBe('Ping Ada about the plan.');
  });

  it('returns empty for whitespace-only prose', () => {
    expect(filterSegment(seg('sentence', '   ')).kind).toBe('empty');
    expect(toSpeech(seg('sentence', '   '))).toBeNull();
  });
});

describe('filterSegments — batch', () => {
  it('drops empties and de-dupes consecutive identical placeholders', () => {
    const out = filterSegments([
      seg('sentence', 'Here is a table.'),
      seg('table', '| a |'),
      seg('table', '| b |'),
      seg('sentence', '   '),
      seg('sentence', 'Done.'),
    ]);
    expect(out.map((r) => r.speak)).toEqual([
      'Here is a table.',
      "I've put a table in the thread.",
      'Done.',
    ]);
  });
});
