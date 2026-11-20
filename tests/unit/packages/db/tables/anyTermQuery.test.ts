import { describe, expect, it } from '@jest/globals';
import { anyTermQueryText, MAX_QUERY_TERMS } from '@snaglet/db/tables/memories/anyTermQuery';

describe('anyTermQueryText', () => {
  it('joins words with the websearch "or" keyword', () => {
    expect(anyTermQueryText('prompt caching tokens')).toBe('prompt or caching or tokens');
  });

  it('splits hyphenated words instead of emitting phrase operators', () => {
    expect(anyTermQueryText('re-run cache-breakpoint')).toBe('re or run or cache or breakpoint');
  });

  it('splits apostrophes so contractions and possessives never form a quote', () => {
    expect(anyTermQueryText("don't use the user's tree")).toBe(
      'don or t or use or the or user or s or tree'
    );
  });

  it('strips websearch and tsquery syntax so nothing negates, quotes or phrases', () => {
    expect(anyTermQueryText('"quoted" -excluded & | <-> :* !bang (group)')).toBe(
      'quoted or excluded or bang or group'
    );
  });

  it('drops a literal "or", lowercases and de-duplicates', () => {
    expect(anyTermQueryText('Tax OR tax or TAX deadlines')).toBe('tax or deadlines');
  });

  it('keeps letters and digits from any script', () => {
    expect(anyTermQueryText('café 0035 naïve')).toBe('café or 0035 or naïve');
  });

  it('caps a long paste at the first MAX_QUERY_TERMS unique words', () => {
    expect(MAX_QUERY_TERMS).toBe(32);
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    // Repeats before the cap must not use up slots: the cap counts unique words.
    const pasted = ['w0', 'w0', 'W1', ...words].join(' ');
    const terms = anyTermQueryText(pasted).split(' or ');
    expect(terms).toHaveLength(MAX_QUERY_TERMS);
    expect(terms).toEqual(words.slice(0, MAX_QUERY_TERMS));
  });

  it('leaves a query at or under the cap untouched', () => {
    const words = Array.from({ length: MAX_QUERY_TERMS }, (_, i) => `w${i}`);
    expect(anyTermQueryText(words.join(' '))).toBe(words.join(' or '));
  });

  it('returns empty text for punctuation-only input', () => {
    expect(anyTermQueryText('  !!! -- ')).toBe('');
    expect(anyTermQueryText('')).toBe('');
  });
});
