/**
 * Quick search's entry query forms, parsed without a database:
 * `entry: <keywords>` and `table:<name> entry: <keywords>`, the name bare,
 * multi-word or quoted (straight or curly quotes), and any other query left
 * alone so the ordinary `table:` name search keeps working.
 */
import { describe, expect, it } from '@jest/globals';
import { parseEntryQuery } from '@server/services/search/paletteEntrySearch';

describe('parseEntryQuery', () => {
  it('reads entry: across every table, keywords trimmed', () => {
    expect(parseEntryQuery('entry: orchid plan')).toEqual({
      tableName: null,
      keywords: 'orchid plan',
    });
    expect(parseEntryQuery('  Entry:orchid ')).toEqual({ tableName: null, keywords: 'orchid' });
    expect(parseEntryQuery('entry:')).toEqual({ tableName: null, keywords: '' });
  });

  it('reads table:<name>:entry: (a colon instead of a space) the same way', () => {
    expect(parseEntryQuery('table:work_items:entry:some query here')).toEqual({
      tableName: 'work_items',
      keywords: 'some query here',
    });
    expect(parseEntryQuery('table:"Item list":entry: orchid')).toEqual({
      tableName: 'Item list',
      keywords: 'orchid',
    });
    expect(parseEntryQuery('table:tasks:entry:')).toEqual({ tableName: 'tasks', keywords: '' });
    expect(parseEntryQuery('table:tasks:other')).toBeNull();
  });

  it('reads table:<name> entry: with a bare, multi-word or quoted name', () => {
    expect(parseEntryQuery('table:tasks entry: orchid')).toEqual({
      tableName: 'tasks',
      keywords: 'orchid',
    });
    expect(parseEntryQuery('table:item list entry: orchid')).toEqual({
      tableName: 'item list',
      keywords: 'orchid',
    });
    expect(parseEntryQuery('table:"Item list" entry: orchid')).toEqual({
      tableName: 'Item list',
      keywords: 'orchid',
    });
    expect(parseEntryQuery('TABLE: “Item list”entry: "exact phrase"')).toEqual({
      tableName: 'Item list',
      keywords: '"exact phrase"',
    });
    expect(parseEntryQuery('table:tasks entry:')).toEqual({ tableName: 'tasks', keywords: '' });
  });

  it('treats an empty table name as every table', () => {
    expect(parseEntryQuery('table: entry: orchid')).toEqual({
      tableName: null,
      keywords: 'orchid',
    });
  });

  it('leaves every other query alone', () => {
    expect(parseEntryQuery('orchid')).toBeNull();
    expect(parseEntryQuery('table:tasks')).toBeNull();
    expect(parseEntryQuery('table:"Item list')).toBeNull();
    expect(parseEntryQuery('doc: entry: orchid')).toBeNull();
    expect(parseEntryQuery('notes about entry: orchid')).toBeNull();
  });
});
