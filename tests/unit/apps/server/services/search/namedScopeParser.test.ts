/**
 * The trailing scope-phrase parser.
 *
 * This is the half of named-project scope that decides whether the words
 * "in <something>" were a scope request or just English. It has to get that
 * right without a database, because the answer determines whether we bother
 * asking one.
 *
 * The interesting cases are all negative. "notes in progress" must not be read
 * as a scope request, and a half-typed `in "Pay` must not be read as anything
 * at all — a palette calls this on every keystroke, so every intermediate
 * state of a phrase is a real input.
 */

import { describe, expect, it } from '@jest/globals';
import { parseTrailingScopePhrase } from '@server/services/search/namedScope';

const names = (query: string) => parseTrailingScopePhrase(query)?.candidates.map((c) => c.name);

describe('quoted phrases are an explicit request', () => {
  it('splits the name from the rest of the query', () => {
    expect(parseTrailingScopePhrase('rotation policy in "Payments Platform"')).toEqual({
      quoted: true,
      candidates: [{ name: 'Payments Platform', residual: 'rotation policy' }],
    });
  });

  it('accepts curly quotes, which macOS substitutes while typing', () => {
    expect(parseTrailingScopePhrase('rotation policy in “Payments Platform”')).toEqual({
      quoted: true,
      candidates: [{ name: 'Payments Platform', residual: 'rotation policy' }],
    });
  });

  it('keeps a name that itself contains the word in', () => {
    // Quoting exists precisely so this is unambiguous.
    expect(names('costs in "Vega in Orbit"')).toEqual(['Vega in Orbit']);
  });

  it('offers exactly one reading — a quoted name is not a guess', () => {
    expect(parseTrailingScopePhrase('a in b in "Ledger"')?.candidates).toHaveLength(1);
  });

  it('tolerates trailing whitespace after the closing quote', () => {
    expect(names('costs in "Ledger"   ')).toEqual(['Ledger']);
  });
});

describe('unquoted phrases offer every reading', () => {
  it('splits a single separator', () => {
    expect(parseTrailingScopePhrase('rotation policy in Ledger')).toEqual({
      quoted: false,
      candidates: [{ name: 'Ledger', residual: 'rotation policy' }],
    });
  });

  it('prefers the rightmost separator but keeps the longer readings', () => {
    // "notes in progress in Ledger" is far more likely to mean the project
    // "Ledger" than one called "progress in Ledger" — but a project can be
    // named that, so both readings survive, shortest first.
    expect(parseTrailingScopePhrase('notes in progress in Ledger')).toEqual({
      quoted: false,
      candidates: [
        { name: 'Ledger', residual: 'notes in progress' },
        { name: 'progress in Ledger', residual: 'notes' },
      ],
    });
  });

  it('matches the separator regardless of case', () => {
    expect(names('rotation policy IN Ledger')).toEqual(['Ledger']);
    expect(names('rotation policy In Ledger')).toEqual(['Ledger']);
  });

  it('bounds how many readings it will offer', () => {
    const candidates = parseTrailingScopePhrase('a in b in c in d in e in f')?.candidates ?? [];
    expect(candidates).toHaveLength(4);
    // Still rightmost-first after the cap.
    expect(candidates[0]).toEqual({ name: 'f', residual: 'a in b in c in d in e' });
  });
});

describe('what is not a scope phrase', () => {
  it.each([
    ['no separator at all', 'payments rotation policy'],
    ['"in" inside a word', 'the invoice pipeline'],
    ['"in" after a hyphen, not whitespace', 'walk-in clinic notes'],
    ['a separator with nothing after it', 'rotation policy in'],
    ['an empty query', ''],
    ['whitespace only', '   '],
  ])('%s', (_label, query) => {
    expect(parseTrailingScopePhrase(query)).toBeNull();
  });

  it('refuses a phrase with no query in front of it', () => {
    // `in Ledger` would leave an empty search term under a strict scope. The
    // empty-query path browses by kind and ignores scope entirely, so this
    // would return unscoped rows labeled strict — a leak, not a search.
    expect(parseTrailingScopePhrase('in Ledger')).toBeNull();
    expect(parseTrailingScopePhrase('in "Ledger"')).toBeNull();
  });

  it('ignores a half-typed quoted phrase instead of guessing', () => {
    // Every prefix of `in "Ledger"` is typed on the way to typing it.
    expect(parseTrailingScopePhrase('costs in "')).toBeNull();
    expect(parseTrailingScopePhrase('costs in "Led')).toBeNull();
    expect(parseTrailingScopePhrase('costs in “Led')).toBeNull();
  });

  it('refuses an absurdly long name rather than querying on it', () => {
    expect(parseTrailingScopePhrase(`costs in "${'x'.repeat(201)}"`)).toBeNull();
    expect(names(`costs in "${'x'.repeat(200)}"`)).toEqual(['x'.repeat(200)]);
  });
});

describe('the residual is what actually gets searched', () => {
  it('drops the phrase and nothing else', () => {
    const parsed = parseTrailingScopePhrase('unpaid invoice reconciliation in "Ledger"');
    expect(parsed?.candidates[0].residual).toBe('unpaid invoice reconciliation');
  });

  it('trims the gap left behind by the phrase', () => {
    expect(parseTrailingScopePhrase('unpaid invoices   in   "Ledger"')?.candidates[0]).toEqual({
      name: 'Ledger',
      residual: 'unpaid invoices',
    });
  });

  it('preserves a leading kind-ish word in the residual', () => {
    // The route strips `kind:` prefixes before this runs; anything else in the
    // residual is search text and must survive untouched.
    expect(parseTrailingScopePhrase('draft spec in Ledger')?.candidates[0].residual).toBe(
      'draft spec'
    );
  });
});
