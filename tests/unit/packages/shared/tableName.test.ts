import { describe, expect, it } from '@jest/globals';
import { formatTableName, tableNameProblem } from '@snaglet/shared/utils';

const FORMAT = 'Use only lowercase letters, numbers, and underscores, like work_experience.';

describe('tableNameProblem', () => {
  it.each(['work_experience', 'a1', 'reading_list_2026', 'a'.repeat(63), '  test_table  '])(
    'accepts real identifier %j',
    (name) => expect(tableNameProblem(name)).toBeNull()
  );

  it.each([
    'Work Experience',
    'Work_Experience',
    'work experience',
    'work-experience',
    'Test.Table',
    "user's_table",
    'test;drop',
    'café',
    '資料',
    'tasks_😀',
    'test\ntable',
  ])('rejects non-identifier characters in %j', (name) =>
    expect(tableNameProblem(name)).toBe(FORMAT)
  );

  it.each(['_leading', '___', '2026_projects', '1'])(
    'requires a leading lowercase letter in %j',
    (name) => expect(tableNameProblem(name)).toBe('Start the table name with a lowercase letter.')
  );

  it.each(['order', 'user', 'select', 'table', 'where'])('rejects reserved SQL word %j', (name) =>
    expect(tableNameProblem(name)).toBe(`"${name}" is a reserved SQL word. Choose another name.`)
  );

  it('reserves the system columns for fields only', () => {
    for (const name of ['id', 'created_at', 'position']) {
      expect(tableNameProblem(name)).toBeNull();
      expect(tableNameProblem(name, 'field')).toBe(
        `"${name}" is a system column every table already has. Choose another name.`
      );
    }
  });

  it('retains empty-name and length validation with the right noun', () => {
    expect(tableNameProblem('   ')).toBe('Enter a table name.');
    expect(tableNameProblem('   ', 'field')).toBe('Enter a field name.');
    expect(tableNameProblem('a'.repeat(64))).toBe('Table names can be at most 63 characters.');
    expect(tableNameProblem('a'.repeat(64), 'field')).toBe(
      'Field names can be at most 63 characters.'
    );
    expect(tableNameProblem('9', 'field')).toBe('Start the field name with a lowercase letter.');
  });
});

describe('formatTableName', () => {
  it.each([
    ['WorkExperience', 'workexperience'],
    ['READING_LIST', 'reading_list'],
    ['work experience', 'work_experience'],
    ['Work Experience', 'work_experience'],
    ['Reading List 2026', 'reading_list_2026'],
  ])('lowercases capitals and turns spaces into underscores in %j', (value, expected) =>
    expect(formatTableName(value)).toBe(expected)
  );

  it('turns each run of whitespace, from a paste, into one underscore', () => {
    expect(formatTableName('Work   Experience')).toBe('work_experience');
    expect(formatTableName('Work\tExperience\nNotes')).toBe('work_experience_notes');
    expect(formatTableName('Work \u00a0\r\n Experience')).toBe('work_experience');
    const pasted = 'Quarterly Planning Notes For The Whole Team '.repeat(4);
    expect(formatTableName(pasted)).toBe('quarterly_planning_notes_for_the_whole_team_'.repeat(4));
    expect(formatTableName(pasted)).toHaveLength(pasted.length);
  });

  it.each(['work_experience', 'a1', 'reading_list_2026', '', 'a'.repeat(64)])(
    'leaves already-formatted text %j alone',
    (value) => expect(formatTableName(value)).toBe(value)
  );

  it.each([
    'work-experience',
    'test.table',
    "user's_table",
    'café',
    '資料',
    'tasks_😀',
    '2026_projects',
    '_leading',
    'École',
  ])('never drops, adds or rewrites any other character in %j', (value) =>
    expect(formatTableName(value)).toBe(value)
  );

  it('keeps leading and trailing whitespace as underscores, for tableNameProblem to report', () => {
    expect(formatTableName(' Work')).toBe('_work');
    expect(tableNameProblem(formatTableName(' Work'))).toBe(
      'Start the table name with a lowercase letter.'
    );
    expect(formatTableName('work ')).toBe('work_');
    expect(tableNameProblem(formatTableName('Work-Experience'))).toBe(FORMAT);
  });

  it('is idempotent and keeps prefixes stable, so inputs can map the caret', () => {
    const value = 'My  Work\tLog 2026 ';
    const formatted = formatTableName(value);
    expect(formatTableName(formatted)).toBe(formatted);
    for (let end = 0; end <= value.length; end += 1)
      expect(formatted.startsWith(formatTableName(value.slice(0, end)))).toBe(true);
  });
});
