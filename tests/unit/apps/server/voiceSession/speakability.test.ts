/**
 * speakability — the `Segmenter` seam composes the real sentence segmenter
 * + speakability filter. This is a thin integration check
 * that the composition speaks prose, strips markup/@, and placeholders
 * structured blocks; the exhaustive rules live in the engine-lane suites
 * (sentenceSegmenter.test.ts + speakabilityFilter.test.ts).
 */

import { engineSegmenter } from '@server/services/SocketService/voiceSession/speakability';

const texts = (raw: string) => engineSegmenter.segment(raw).map((s) => s.text);

describe('engineSegmenter', () => {
  it('splits prose into sentences', () => {
    expect(texts('On it. Checking the logs now.')).toEqual(['On it.', 'Checking the logs now.']);
  });

  it('strips markdown emphasis, inline code, and the @ sigil', () => {
    expect(texts('Hey **Nova**, run `deploy` for @Vega now.')).toEqual([
      'Hey Nova, run deploy for Vega now.',
    ]);
  });

  it('replaces a code fence with a spoken placeholder', () => {
    expect(texts('```\nconst x = 1;\n```')).toEqual(["I've put a code block in the thread."]);
  });

  it('replaces a markdown table with a spoken placeholder', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    expect(texts(table)).toEqual(["I've put a table in the thread."]);
  });

  it('returns nothing for empty input', () => {
    expect(texts('   ')).toEqual([]);
  });
});
