import { describe, expect, it } from 'vitest';
import type { TableField, TableFieldDefinition } from '@snaglet/shared/types';
import {
  repeatProblem,
  shownCalendarId,
  statusDefaults,
  statusFieldsOf,
  stripForType,
  withDoneOption,
} from './fieldEditorDraft';

function f(extra: Partial<TableField>): TableField {
  return {
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 't',
    columnName: 'c',
    name: 'Due',
    description: null,
    type: 'datetime',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    options: null,
    position: 0,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    ...extra,
  } as TableField;
}
const due = f({});
const end = f({ id: 'field-2222222222222-bbbbbbbbb', name: 'Ends' });
const day = f({ id: 'field-3333333333333-ccccccccc', name: 'Day', type: 'date' });
const status = f({
  id: 'field-4444444444444-ddddddddd',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
});
const tags = f({
  id: 'field-5555555555555-eeeeeeeee',
  type: 'select',
  multiple: true,
  options: [],
});
const fields = [due, end, day, status, tags];
const base: TableFieldDefinition = {
  name: 'Due',
  description: null,
  type: 'datetime',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
};
const rec = {
  statusFieldId: status.id,
  doneOptionIds: ['opt-done'],
  resetOptionId: 'opt-todo',
};

describe('field lists', () => {
  it('status choices are single selects only', () => {
    expect(statusFieldsOf(fields, due.id).map((x) => x.id)).toEqual([status.id]);
  });
});

describe('status choices', () => {
  const four = [
    { id: 'opt-todo', label: 'To do', color: 'gray' as const },
    { id: 'opt-doing', label: 'Doing', color: 'blue' as const },
    { id: 'opt-done', label: 'Done', color: 'green' as const },
    { id: 'opt-wont', label: 'Won’t do', color: 'red' as const },
  ];
  it('a picked field starts on its last option as done and its first as the reset', () => {
    expect(statusDefaults(status)).toEqual({
      doneOptionIds: ['opt-done'],
      resetOptionId: 'opt-todo',
    });
    expect(statusDefaults(f({ type: 'select', options: four }))).toEqual({
      doneOptionIds: ['opt-wont'],
      resetOptionId: 'opt-todo',
    });
    expect(statusDefaults(f({ type: 'select', options: [four[0]] }))).toEqual({
      doneOptionIds: ['opt-todo'],
      resetOptionId: null,
    });
    expect(statusDefaults(f({ type: 'select', options: [] }))).toEqual({
      doneOptionIds: [],
      resetOptionId: null,
    });
  });
  it('sets or adds a done option; a reset that becomes done moves to the next option left', () => {
    expect(withDoneOption(rec, four, 0, 'opt-wont')).toEqual({
      ...rec,
      doneOptionIds: ['opt-wont'],
    });
    expect(withDoneOption(rec, four, 1, 'opt-wont').doneOptionIds).toEqual([
      'opt-done',
      'opt-wont',
    ]);
    expect(withDoneOption(rec, four, 0, 'opt-todo')).toMatchObject({
      doneOptionIds: ['opt-todo'],
      resetOptionId: 'opt-doing',
    });
    const allButReset = { ...rec, doneOptionIds: ['opt-doing', 'opt-done', 'opt-wont'] };
    expect(withDoneOption(allButReset, four, 3, 'opt-todo').resetOptionId).toBeNull();
    // A value another done select already has is not added twice.
    expect(withDoneOption(rec, four, 1, 'opt-done').doneOptionIds).toEqual(['opt-done']);
  });
});

describe('shownCalendarId', () => {
  it('a new field shows None', () => {
    expect(shownCalendarId(base)).toBeNull();
  });
  it('falls back to the saved field until the draft names a choice', () => {
    const saved = f({ calendarId: 'cal-1' });
    expect(shownCalendarId(base, saved)).toBe('cal-1');
    expect(shownCalendarId({ ...base, calendarId: null }, saved)).toBeNull();
  });
});

describe('stripForType', () => {
  it('date types keep the binding; non-date types send none', () => {
    const d = { ...base, calendarId: 'cal-1' };
    expect(stripForType(d).calendarId).toBe('cal-1');
    expect(stripForType({ ...d, type: 'date', range: true }).calendarId).toBe('cal-1');
    const text = stripForType({ ...d, type: 'text', recurrence: rec });
    expect(text).not.toHaveProperty('calendarId');
    expect(text).not.toHaveProperty('recurrence');
    expect(stripForType({ ...d, type: 'text', recurrence: null }).recurrence).toBeNull();
  });
});

describe('repeatProblem (client mirror of assertRecurrenceTargets)', () => {
  it('accepts a complete setting', () => {
    expect(repeatProblem({ ...base, recurrence: rec }, due, fields)).toBeNull();
  });
  it('repeats without a status field (Done / Skip only)', () => {
    expect(
      repeatProblem(
        {
          ...base,
          recurrence: { ...rec, statusFieldId: null, doneOptionIds: [], resetOptionId: null },
        },
        due,
        fields
      )
    ).toBeNull();
  });
  it('a chosen status field must be a single select of this table', () => {
    expect(
      repeatProblem({ ...base, recurrence: { ...rec, statusFieldId: 'field-9' } }, due, fields)
    ).toMatch(/field of this table/);
    expect(
      repeatProblem({ ...base, recurrence: { ...rec, statusFieldId: tags.id } }, due, fields)
    ).toMatch(/single select/);
  });
  it('needs a done option, named options that exist, and reset not done', () => {
    expect(
      repeatProblem({ ...base, recurrence: { ...rec, doneOptionIds: [] } }, due, fields)
    ).toMatch(/at least one status of Status/);
    expect(
      repeatProblem({ ...base, recurrence: { ...rec, doneOptionIds: ['opt-gone'] } }, due, fields)
    ).toMatch(/options of Status/);
    expect(
      repeatProblem({ ...base, recurrence: { ...rec, resetOptionId: 'opt-done' } }, due, fields)
    ).toMatch(/cannot also count as done/);
  });
  it('a repeating field can change type (its rows lose their repeat; the editor says so)', () => {
    const saved = f({ recurrence: rec });
    expect(repeatProblem({ ...base, type: 'date' }, saved, fields)).toBeNull();
  });
});
