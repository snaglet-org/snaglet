/** The lexical table scoring behind search(kinds:["entry"]) without a `table`. */
import { describe, expect, it } from '@jest/globals';
import type { TableField } from '@snaglet/shared/types';
import { rowQuery, scoreTable, tableTerms } from '@snaglet/db/tables/table_entries/tableMatch';

function field(name: string, extra: Partial<TableField> = {}): TableField {
  return {
    id: `f-${name}`,
    tableId: 't',
    columnName: `f_${name}`,
    name,
    type: 'text',
    managed: false,
    isTitle: false,
    options: null,
    description: null,
    ...extra,
  } as unknown as TableField;
}

describe('tableTerms', () => {
  it('drops words about how to read the results and stems plurals', () => {
    expect(tableTerms('latest task about the memories')).toEqual(['task', 'memory']);
    expect(tableTerms('Embedding tables task')).toEqual(['embedding', 'table', 'task']);
    expect(tableTerms('the latest')).toEqual([]);
    // Filler words and one- or two-letter words say nothing about a table.
    expect(tableTerms('zzzz-no-such-thing')).toEqual(['zzzz']);
    expect(tableTerms('show me what is in my ai notes')).toEqual(['note']);
    expect(tableTerms('tasks task TASK')).toEqual(['task']);
  });
});

describe('rowQuery', () => {
  it('drops the words that named the table and keeps the rest, quoted phrases whole', () => {
    expect(rowQuery('task memories', ['task'])).toBe('memories');
    expect(rowQuery('Tasks "embedding tables" memories', ['task'])).toBe(
      '"embedding tables" memories'
    );
    expect(rowQuery('tasks', ['task'])).toBe('');
    expect(rowQuery('memories', [])).toBe('memories');
  });
});

describe('scoreTable', () => {
  const status = field('Status', {
    type: 'select',
    options: [
      { id: 'a', label: 'Doing', color: null },
      { id: 'b', label: 'Done', color: null },
    ] as TableField['options'],
  });

  it('ranks a table-name word above a field name, an option and a description', () => {
    const byName = scoreTable(['task'], 'Tasks', []);
    const byField = scoreTable(['task'], 'Backlog', [field('Task owner')]);
    const byOption = scoreTable(['doing'], 'Backlog', [status]);
    const byDescription = scoreTable(['rollout'], 'Backlog', [
      field('Notes', { description: 'Plan the rollout' }),
    ]);
    expect(byName.score).toBeGreaterThan(byField.score);
    expect(byField.score).toBeGreaterThan(byOption.score);
    expect(byOption.score).toBeGreaterThan(byDescription.score);
    expect(byDescription.score).toBeGreaterThan(0);
  });

  it('says why: the name, the field and the option', () => {
    expect(scoreTable(['task'], 'Tasks', []).why).toEqual(['name has "task"']);
    expect(scoreTable(['task'], 'Tasks', []).nameTerms).toEqual(['task']);
    expect(scoreTable(['doing'], 'Backlog', [status]).nameTerms).toEqual([]);
    expect(scoreTable(['doing'], 'Backlog', [status]).why).toEqual([
      'field "Status" option "Doing"',
    ]);
  });

  it('counts a table that explains more of the terms above one that explains a single term', () => {
    const both = scoreTable(['task', 'doing'], 'Tasks', [status]);
    const one = scoreTable(['task', 'doing'], 'Tasks', []);
    expect(both.score).toBeGreaterThan(one.score);
  });

  it('is zero when nothing matches, and ignores managed fields', () => {
    expect(scoreTable(['zebra'], 'Tasks', [status])).toEqual({ score: 0, why: [], nameTerms: [] });
    expect(scoreTable(['created'], 'Tasks', [field('created_at', { managed: true })]).score).toBe(
      0
    );
  });

  it('matches a word prefix of three or more letters, not two', () => {
    expect(scoreTable(['embed'], 'Embedding jobs', []).score).toBeGreaterThan(0);
    expect(scoreTable(['em'], 'Embedding jobs', []).score).toBe(0);
  });
});
