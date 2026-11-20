import { describe, expect, it } from 'vitest';
import { TABLE_SELECT_MAX_OPTIONS, TABLE_SELECT_OPTION_ID_PATTERN } from '@snaglet/shared/types';
import {
  addSelectOption,
  moveSelectOption,
  removeSelectOption,
  reconcileSelectOptions,
  renameSelectOption,
  selectOptionEditProblem,
  type SelectOptionsValue,
} from './selectFieldDefinition';

const value: SelectOptionsValue = {
  options: [
    { id: 'opt-first', label: 'Todo', color: 'blue' },
    { id: 'opt-second', label: 'Done', color: 'green' },
  ],
  defaultValue: 'Todo',
};

describe('select field option edits', () => {
  it('renames a selected default atomically while retaining option identity and color', () => {
    expect(renameSelectOption(value, 0, 'Ready')).toEqual({
      options: [{ id: 'opt-first', label: 'Ready', color: 'blue' }, value.options[1]],
      defaultValue: 'Ready',
    });
    expect(value.options[0].label).toBe('Todo');
  });

  it('preserves ordered multiple defaults through rename and removal', () => {
    const multiple = { ...value, defaultValue: ['Done', 'Todo'] };
    const renamed = renameSelectOption(multiple, 0, 'Ready');
    expect(renamed.defaultValue).toEqual(['Done', 'Ready']);
    expect(removeSelectOption(renamed, 1)).toEqual({
      options: [{ id: 'opt-first', label: 'Ready', color: 'blue' }],
      defaultValue: ['Ready'],
    });
  });

  it('clears a removed single default and leaves unrelated defaults untouched', () => {
    expect(removeSelectOption(value, 0).defaultValue).toBeNull();
    expect(removeSelectOption(value, 1).defaultValue).toBe('Todo');
    expect(removeSelectOption({ ...value, defaultValue: [] }, 0).defaultValue).toEqual([]);
  });

  it('mints a stable id and selects the least-used palette color on add', () => {
    const added = addSelectOption(value, 'Waiting');
    expect(added.options.slice(0, 2)).toEqual(value.options);
    expect(added.options[2]).toEqual({
      id: expect.stringMatching(TABLE_SELECT_OPTION_ID_PATTERN),
      label: 'Waiting',
      color: 'yellow',
    });
    expect(renameSelectOption(added, 2, 'Review').options[2].id).toBe(added.options[2].id);
    expect(added.defaultValue).toBe('Todo');
  });

  it('reorders only metadata and preserves selection order', () => {
    const multiple = { ...value, defaultValue: ['Todo', 'Done'] };
    expect(moveSelectOption(multiple, 0, 1)).toEqual({
      options: [value.options[1], value.options[0]],
      defaultValue: ['Todo', 'Done'],
    });
    expect(moveSelectOption(value, 0, -1)).toBe(value);
    expect(moveSelectOption(value, 1, 1)).toBe(value);
    expect(removeSelectOption(value, 9)).toBe(value);
    expect(renameSelectOption(value, 9, 'Missing')).toBe(value);
  });

  it.each(['', ' ', 'line\nbreak', 'x'.repeat(101), 'TODO'])(
    'rejects an invalid or duplicate added label %j',
    (label) => expect(selectOptionEditProblem(value.options, label)).not.toBeNull()
  );

  it('allows a case-only rename of the same option, but not a duplicate of another', () => {
    expect(selectOptionEditProblem(value.options, 'TODO', 0)).toBeNull();
    expect(selectOptionEditProblem(value.options, 'done', 0)).toContain('listed twice');
  });

  it('enforces the option limit without preventing renames at the limit', () => {
    const options = Array.from({ length: TABLE_SELECT_MAX_OPTIONS }, (_item, index) => ({
      label: `Option ${index}`,
    }));
    expect(selectOptionEditProblem(options, 'Extra')).toContain('at most 100');
    expect(selectOptionEditProblem(options, 'Renamed', 0)).toBeNull();
  });

  it('reconciles saved metadata without overwriting queued rename, color, order or removals', () => {
    const sent: SelectOptionsValue = {
      options: [...value.options, { id: 'opt-removed', label: 'Remove', color: 'gray' }],
      defaultValue: ['Todo', 'Remove'],
    };
    const current: SelectOptionsValue = {
      options: [
        { id: 'opt-second', label: 'Done', color: 'pink' },
        { id: 'opt-first', label: 'Ready', color: 'blue' },
        { id: 'opt-new', label: 'Review', color: 'yellow' },
      ],
      defaultValue: ['Ready'],
    };
    expect(reconcileSelectOptions(sent, current, sent)).toEqual(current);
  });

  it('adopts server ids and colors for unchanged options and canonical empty defaults', () => {
    const sent: SelectOptionsValue = { options: [{ label: 'Todo' }], defaultValue: null };
    const saved: SelectOptionsValue = { options: [value.options[0]], defaultValue: [] };
    expect(reconcileSelectOptions(sent, sent, saved)).toEqual(saved);
  });

  it('appends discovered conversion options but adopts a matching queued option without duplicates', () => {
    const sent: SelectOptionsValue = { options: [], defaultValue: null };
    const current: SelectOptionsValue = {
      options: [{ id: 'opt-client', label: 'Todo', color: 'pink' }],
      defaultValue: 'Todo',
    };
    expect(reconcileSelectOptions(sent, current, value)).toEqual({
      options: [{ ...value.options[0], color: 'pink' }, value.options[1]],
      defaultValue: 'Todo',
    });
  });

  it('keeps a queued default change when the server responds with an earlier default', () => {
    expect(
      reconcileSelectOptions(value, { ...value, defaultValue: 'Done' }, value).defaultValue
    ).toBe('Done');
  });
});
