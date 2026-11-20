/**
 * sentenceSegmenter — streaming text -> speakable segments. Covers sentence
 * boundaries, abbreviations/decimals, newlines, incremental delivery, and the
 * grouping of fenced code / tables / lists into single block segments.
 */

import { describe, expect, it } from '@jest/globals';
import {
  createSentenceSegmenter,
  segmentText,
  type TextSegment,
} from '@server/services/voice/sentenceSegmenter';

const texts = (segs: TextSegment[]): string[] => segs.map((s) => s.text);

describe('segmentText — sentences', () => {
  it('splits on terminators, keeping punctuation', () => {
    const segs = segmentText('Hello there. How are you? I am fine!');
    expect(texts(segs)).toEqual(['Hello there.', 'How are you?', 'I am fine!']);
    expect(segs.every((s) => s.kind === 'sentence')).toBe(true);
  });

  it('does not split on common abbreviations', () => {
    expect(texts(segmentText('Dr. Smith met Mr. Lee at 5 p.m. today.'))).toEqual([
      'Dr. Smith met Mr. Lee at 5 p.m. today.',
    ]);
  });

  it('does not split inside decimals', () => {
    expect(texts(segmentText('It costs 3.14 dollars total.'))).toEqual([
      'It costs 3.14 dollars total.',
    ]);
  });

  it('treats newlines as boundaries', () => {
    expect(texts(segmentText('Line one\nLine two\nLine three'))).toEqual([
      'Line one',
      'Line two',
      'Line three',
    ]);
  });

  it('collapses blank lines between paragraphs', () => {
    expect(texts(segmentText('First para.\n\nSecond para.'))).toEqual([
      'First para.',
      'Second para.',
    ]);
  });

  it('treats a run of terminators as a single boundary', () => {
    // "Wait..." and "really?!" are each complete spoken units.
    expect(texts(segmentText('Wait... really?! Yes.'))).toEqual(['Wait...', 'really?!', 'Yes.']);
  });
});

describe('createSentenceSegmenter — streaming', () => {
  it('emits a sentence as soon as it is unambiguously complete', () => {
    const seg = createSentenceSegmenter();
    expect(texts(seg.push('Hello the'))).toEqual([]);
    expect(texts(seg.push('re. How'))).toEqual(['Hello there.']);
    expect(texts(seg.push(' are you?'))).toEqual([]);
    expect(texts(seg.flush())).toEqual(['How are you?']);
  });

  it('holds a terminator until the following whitespace confirms it', () => {
    const seg = createSentenceSegmenter();
    // "3." could be a decimal continuing; only a following space confirms.
    expect(texts(seg.push('Version 3'))).toEqual([]);
    expect(texts(seg.push('.'))).toEqual([]);
    expect(texts(seg.push('14 is out.'))).toEqual([]);
    expect(texts(seg.flush())).toEqual(['Version 3.14 is out.']);
  });

  it('reset() discards buffered state', () => {
    const seg = createSentenceSegmenter();
    seg.push('Half a sen');
    seg.reset();
    expect(texts(seg.flush())).toEqual([]);
  });
});

describe('segmentText — code fences', () => {
  it('emits a fenced block as one code segment', () => {
    const segs = segmentText('```js\nconst x = 1;\nconsole.log(x);\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('code');
    expect(segs[0].text).toContain('const x = 1;');
  });

  it('separates prose around a fence', () => {
    const segs = segmentText('Before.\n```\nx\n```\nAfter.');
    expect(segs.map((s) => s.kind)).toEqual(['sentence', 'code', 'sentence']);
    expect(texts(segs)).toEqual(['Before.', '```\nx\n```', 'After.']);
  });

  it('never splits a sentence-like line inside a fence', () => {
    const segs = segmentText('```\nHello. World. Foo.\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('code');
  });

  it('does not treat inline backticks as a fence', () => {
    const segs = segmentText('Use the `git status` command now.');
    expect(segs.map((s) => s.kind)).toEqual(['sentence']);
  });

  it('holds an unterminated fence until flush', () => {
    const seg = createSentenceSegmenter();
    expect(texts(seg.push('```\ncode line'))).toEqual([]);
    const out = seg.flush();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('code');
  });
});

describe('segmentText — lists and tables', () => {
  it('groups consecutive list items into one list segment', () => {
    const segs = segmentText('- alpha\n- beta\n- gamma\n');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('list');
    expect(segs[0].text).toBe('- alpha\n- beta\n- gamma');
  });

  it('groups ordered lists too', () => {
    const segs = segmentText('1. first\n2. second\n');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('list');
  });

  it('groups a markdown table into one table segment', () => {
    const segs = segmentText('| Name | Age |\n| --- | --- |\n| Ada | 36 |\n');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('table');
  });

  it('a lone pipe line is prose, not a table', () => {
    const segs = segmentText('Run a | b to pipe output.\n');
    expect(segs.map((s) => s.kind)).toEqual(['sentence']);
  });

  it('separates a list from following prose', () => {
    const segs = segmentText('- one\n- two\nThat is the list.');
    expect(segs.map((s) => s.kind)).toEqual(['list', 'sentence']);
  });

  it('holds an open list until a non-list line or flush', () => {
    const seg = createSentenceSegmenter();
    expect(texts(seg.push('- one\n- two\n'))).toEqual([]); // still open
    const out = seg.flush();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('list');
    expect(out[0].text).toBe('- one\n- two');
  });
});

describe('segmentText — edge cases', () => {
  it('returns nothing for empty input', () => {
    expect(segmentText('')).toEqual([]);
    expect(segmentText('   \n  ')).toEqual([]);
  });

  it('emits a final unterminated sentence at flush', () => {
    expect(texts(segmentText('No terminator here'))).toEqual(['No terminator here']);
  });
});
