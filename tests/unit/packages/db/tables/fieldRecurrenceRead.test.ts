import { describe, expect, it } from '@jest/globals';
import type { TableFieldRecurrence } from '@snaglet/shared/types';
import {
  storedRecurrence,
  toField,
  type RawField,
} from '@snaglet/db/tables/table_fields/fieldRows';

const raw = (recurrence: RawField['recurrence']): RawField => ({
  id: 'field-1111111111111-aaaaaaaaa',
  table_id: 'table-1111111111111-aaaaaaaaa',
  column_name: 'due',
  name: 'due',
  description: null,
  type: 'date',
  nullable: true,
  default_value: null,
  default_expression: null,
  reference_table_id: null,
  reference_kind: null,
  position: 0,
  managed: false,
  revision: 1,
  collapsed: false,
  width: null,
  is_title: false,
  multiple: false,
  is_range: false,
  options: null,
  recurrence,
  state: 'active',
  state_changed_at: null,
  held_by: null,
});

const SETTING: TableFieldRecurrence = {
  statusFieldId: null,
  doneOptionIds: [],
  resetOptionId: null,
};

/** An older row's setting: it still stores the per-field week start. */
const OLDER = { ...SETTING, weekStart: 'SU' } as TableFieldRecurrence;

describe('a repeat setting read from its row', () => {
  it('ignores the week start an older row stores: repeats start weeks on Monday', () => {
    expect(toField(raw(OLDER)).recurrence).toEqual(SETTING);
  });

  it('never writes one back', () => {
    expect(storedRecurrence(OLDER)).toEqual(SETTING);
    expect(storedRecurrence(null)).toBeNull();
  });

  it('a field that does not repeat carries no recurrence key', () => {
    expect('recurrence' in toField(raw(null))).toBe(false);
  });
});
