import { describe, expect, it } from '@jest/globals';
import { WordPieceTokenizer } from '@server/services/reranking/WordPieceTokenizer';

function tokenizer(): WordPieceTokenizer {
  const tokens = [
    '[PAD]',
    '[UNK]',
    '[CLS]',
    '[SEP]',
    'which',
    'planet',
    'is',
    'red',
    'mars',
    'invest',
    '##or',
    'update',
  ];
  return new WordPieceTokenizer(new Map(tokens.map((token, index) => [token, index])));
}

describe('WordPieceTokenizer', () => {
  it('encodes BERT sequence pairs with segment ids', () => {
    const encoded = tokenizer().encodePair('Which planet', 'Mars is red', 16);

    expect(encoded.inputIds).toEqual([2, 4, 5, 3, 8, 6, 7, 3]);
    expect(encoded.tokenTypeIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(encoded.attentionMask).toEqual(new Array(8).fill(1));
  });

  it('uses wordpiece suffix tokens', () => {
    const encoded = tokenizer().encodePair('Investor update', 'red', 16);

    expect(encoded.inputIds).toEqual([2, 9, 10, 11, 3, 7, 3]);
  });

  it('truncates pairs to the requested sequence length', () => {
    const encoded = tokenizer().encodePair('which planet is red', 'mars is red planet', 7);

    expect(encoded.inputIds).toHaveLength(7);
    expect(encoded.inputIds[0]).toBe(2);
    expect(encoded.inputIds.at(-1)).toBe(3);
  });

  it('encodes single sequences as [CLS] tokens [SEP] with one segment', () => {
    const encoded = tokenizer().encodeSingle('which planet is red', 16);

    expect(encoded.inputIds).toEqual([2, 4, 5, 6, 7, 3]);
    expect(encoded.tokenTypeIds).toEqual([0, 0, 0, 0, 0, 0]);
    expect(encoded.attentionMask).toEqual(new Array(6).fill(1));
  });

  it('truncates single sequences to the requested length, keeping CLS/SEP', () => {
    const encoded = tokenizer().encodeSingle('which planet is red mars is red planet', 5);

    expect(encoded.inputIds).toHaveLength(5);
    expect(encoded.inputIds[0]).toBe(2);
    expect(encoded.inputIds.at(-1)).toBe(3);
    // Body survives in order: which, planet, is.
    expect(encoded.inputIds.slice(1, 4)).toEqual([4, 5, 6]);
  });

  it('rejects single-sequence budgets below CLS+SEP', () => {
    expect(() => tokenizer().encodeSingle('red', 1)).toThrow(/at least 2/);
  });
});
