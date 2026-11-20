/**
 * The palette's entry filter text: `entry:`, `table:<name> entry:` typed or
 * pasted (bare, multi-word or quoted name), `<name> entry:` after a Table
 * chip, and the query text sent to the server for each.
 */
import { describe, expect, it } from 'vitest';
import { entryFilterFromText, entryServerQuery, keepTables, planPaletteSearch } from './searchPlan';

describe('entryFilterFromText', () => {
  it('turns entry: on for every table, keeping what follows', () => {
    expect(entryFilterFromText('entry:', false)).toEqual({
      filter: { table: null },
      remainder: '',
    });
    expect(entryFilterFromText('Entry: orchid', false)).toEqual({
      filter: { table: null },
      remainder: 'orchid',
    });
  });

  it('reads table:<name> entry: with a bare, multi-word or quoted name', () => {
    expect(entryFilterFromText('table:item_list entry: orchid', false)).toEqual({
      filter: { table: 'item_list' },
      remainder: 'orchid',
    });
    expect(entryFilterFromText('table:item list entry:', false)).toEqual({
      filter: { table: 'item list' },
      remainder: '',
    });
    expect(entryFilterFromText('table:“Item list” entry: orchid', false)).toEqual({
      filter: { table: 'Item list' },
      remainder: 'orchid',
    });
  });

  it('reads <name> entry: only after a Table chip', () => {
    expect(entryFilterFromText('"Item list" entry:', true)).toEqual({
      filter: { table: 'Item list' },
      remainder: '',
    });
    expect(entryFilterFromText('"Item list" entry:', false)).toBeNull();
    expect(entryFilterFromText('item_list', true)).toBeNull();
  });

  it('leaves other text alone', () => {
    expect(entryFilterFromText('orchid', false)).toBeNull();
    expect(entryFilterFromText('table:item', false)).toBeNull();
    expect(entryFilterFromText('notes about entry: x', false)).toBeNull();
  });
});

describe('entryServerQuery', () => {
  it('quotes the table name and trims the keywords', () => {
    expect(entryServerQuery({ table: null }, ' orchid ')).toBe('entry: orchid');
    expect(entryServerQuery({ table: null }, '')).toBe('entry:');
    expect(entryServerQuery({ table: 'Item list' }, 'orchid')).toBe(
      'table:"Item list" entry: orchid'
    );
    expect(entryServerQuery({ table: 'say "hi"' }, 'x')).toBe('table:"say hi" entry: x');
  });
});

describe('entryFilterFromText aliases and colon form', () => {
  it('reads entries:/row:/rows: like entry:', () => {
    for (const word of ['entries', 'row', 'rows']) {
      expect(entryFilterFromText(`${word}: quotes`, false)).toEqual({
        filter: { table: null },
        remainder: 'quotes',
      });
    }
  });

  it('reads name:entry: after a table chip and typed whole', () => {
    expect(entryFilterFromText('work_items:entry: due', true)).toEqual({
      filter: { table: 'work_items' },
      remainder: 'due',
    });
    expect(entryFilterFromText('table:work_items:entry: due', false)).toEqual({
      filter: { table: 'work_items' },
      remainder: 'due',
    });
  });
});

describe('planPaletteSearch', () => {
  it('asks for rows beside an unfiltered search and a table-only one', () => {
    expect(planPaletteSearch({ term: ' x ' })).toMatchObject({ query: 'x', includeEntries: true });
    expect(planPaletteSearch({ term: 'x', kinds: ['table'] })).toMatchObject({
      kinds: ['table'],
      includeEntries: true,
    });
  });

  it('asks for no rows under any other kind, a file filter, or when rows cannot be shown', () => {
    expect(planPaletteSearch({ term: 'x', kinds: ['doc'] }).includeEntries).toBe(false);
    expect(planPaletteSearch({ term: 'x', fsFilter: 'file' })).toMatchObject({
      query: 'file: x',
      kinds: undefined,
      includeEntries: false,
    });
    expect(planPaletteSearch({ term: 'x', allowEntries: false }).includeEntries).toBe(false);
  });

  it('plans an entry search as rows only, scoped to its table', () => {
    expect(
      planPaletteSearch({ term: 'x', kinds: ['doc'], entryFilter: { table: 'Reading list' } })
    ).toEqual({
      query: 'table:"Reading list" entry: x',
      kinds: undefined,
      includeEntries: false,
      entryOnly: true,
      rowLimit: null,
    });
  });
});

describe('row limits and table keeping', () => {
  it('gives the same row limits on every surface', () => {
    expect(planPaletteSearch({ term: 'x' }).rowLimit).toBe(5);
    expect(planPaletteSearch({ term: 'x', kinds: ['table'] }).rowLimit).toBe(8);
    expect(planPaletteSearch({ term: 'x', kinds: ['doc'] }).rowLimit).toBe(0);
  });

  it('keeps up to two tables when other kinds fill the list', () => {
    const hits = ['d1', 'd2', 'd3', 't1', 't2', 't3'];
    expect(keepTables(hits, (h) => h.startsWith('t'), 4)).toEqual(['d1', 'd2', 't1', 't2']);
  });
});
