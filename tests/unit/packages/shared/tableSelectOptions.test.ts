import { describe, expect, it } from '@jest/globals';
import type { TableField, TableFieldDefinition, TableSelectOption } from '@snaglet/shared/types';
import {
  normalizeTableFieldDefinition,
  resolveSelectOptions,
  selectOptionChanges,
  selectValueProblem,
  tableEntryValueProblem,
  tableFieldDefinitionProblem,
} from '@snaglet/shared/utils';

const select: TableFieldDefinition = {
  name: 'status',
  description: null,
  type: 'select',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  options: [{ label: 'todo' }, { label: 'done' }],
};

const OPTIONS: TableSelectOption[] = [
  { id: 'opt-a', label: 'todo', color: 'blue' },
  { id: 'opt-b', label: 'doing', color: 'green' },
  { id: 'opt-c', label: 'done', color: 'yellow' },
];

function field(patch: Partial<TableField> = {}): TableField {
  return {
    id: 'field-1111111111111-status',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'status',
    name: 'status',
    description: null,
    type: 'select',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    range: false,
    options: OPTIONS,
    position: 3,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    ...patch,
  };
}

describe('select field definitions', () => {
  it('accepts labels, ids, palette colors and a default among the options', () => {
    expect(tableFieldDefinitionProblem(select)).toBeNull();
    expect(
      tableFieldDefinitionProblem({
        ...select,
        options: [{ id: 'opt-1790000000000-abc', label: 'todo', color: 'gray' }],
        defaultValue: 'todo',
      })
    ).toBeNull();
    expect(
      tableFieldDefinitionProblem({
        ...select,
        multiple: true,
        defaultValue: ['done', 'todo'],
      })
    ).toBeNull();
    // Left out, the options are the field's current ones, which the model checks.
    const { options: _options, ...kept } = select;
    expect(tableFieldDefinitionProblem({ ...kept, defaultValue: 'anything' })).toBeNull();
  });

  it.each([
    [{ defaultValue: 'blocked' }, 'Choose one of the options for the default.'],
    [{ defaultValue: true }, 'Choose one of the options for the default.'],
    [{ multiple: true, defaultValue: 'todo' }, 'A multi-select default is a list of options.'],
    [{ multiple: false, defaultValue: ['todo'] }, 'Choose one option, or none, for the default.'],
    [{ multiple: true, defaultValue: ['todo', 'todo'] }, 'List each default option only once.'],
    [{ multiple: true, defaultValue: ['x'] }, 'Choose default options from the field options.'],
    [{ options: [{ label: 'a' }, { label: 'A' }] }, 'The option "A" is listed twice.'],
    [{ options: 'a,b' }, 'Options must be a list.'],
    [{ options: ['a'] }, 'Each option must be { id?, label, color? }.'],
    [{ options: [{ label: 'a', color: 'teal' }] }, 'Option colors are blue, green, yellow'],
    [{ options: [{ label: 'a', id: 'OPT-1' }] }, 'Option ids must look like'],
    [{ options: [{ label: 'tab\there' }] }, 'line breaks or control characters'],
    [{ referenceTableId: 'table-1111111111111-aaaaaaaaa' }, 'Only relation fields can reference'],
  ])('refuses %j', (patch, message) => {
    expect(tableFieldDefinitionProblem({ ...select, ...patch } as TableFieldDefinition)).toEqual(
      expect.stringContaining(message)
    );
  });

  it('refuses options on other types but accepts null there', () => {
    expect(tableFieldDefinitionProblem({ ...select, type: 'text' })).toBe(
      'Only select fields have options.'
    );
    expect(tableFieldDefinitionProblem({ ...select, type: 'text', options: null })).toBeNull();
  });

  it('stores a multi-select as never null, keeping its list default', () => {
    expect(
      normalizeTableFieldDefinition({ ...select, multiple: true, defaultValue: ['todo'] })
    ).toMatchObject({ nullable: false, defaultValue: ['todo'] });
    expect(
      normalizeTableFieldDefinition({ ...select, multiple: true, defaultValue: null })
    ).toMatchObject({ nullable: false, defaultValue: [] });
    expect(normalizeTableFieldDefinition({ ...select, multiple: false })).toMatchObject({
      nullable: true,
      defaultValue: null,
    });
  });
});

describe('resolveSelectOptions', () => {
  let minted = 0;
  const mint = () => `opt-new-${++minted}`;

  it('keeps known ids and colors, mints ids, and gives new options the least-used color', () => {
    minted = 0;
    expect(
      resolveSelectOptions(
        OPTIONS,
        [
          { id: 'opt-c', label: 'finished' },
          { label: 'blocked' },
          { id: 'opt-a', label: 'todo', color: 'red' },
          { label: 'later' },
          { id: 'opt-client', label: 'waiting' },
        ],
        mint
      )
    ).toEqual([
      { id: 'opt-c', label: 'finished', color: 'yellow' },
      { id: 'opt-new-1', label: 'blocked', color: 'blue' },
      { id: 'opt-a', label: 'todo', color: 'red' },
      { id: 'opt-new-2', label: 'later', color: 'green' },
      { id: 'opt-client', label: 'waiting', color: 'orange' },
    ]);
  });

  it('never mints an id that a listed or removed option already has', () => {
    const ids = ['opt-a', 'opt-b', 'opt-fresh'];
    const next = resolveSelectOptions(
      OPTIONS,
      [{ id: 'opt-b', label: 'x' }, { label: 'y' }],
      () => ids.shift()!
    );
    expect(next.map((option) => option.id)).toEqual(['opt-b', 'opt-fresh']);
  });
});

describe('selectOptionChanges', () => {
  it('matches options by id: renames, removals and whether the label set changed', () => {
    const next: TableSelectOption[] = [
      { id: 'opt-c', label: 'todo', color: 'yellow' },
      { id: 'opt-a', label: 'done', color: 'blue' },
      { id: 'opt-d', label: 'blocked', color: 'red' },
    ];
    expect(selectOptionChanges(OPTIONS, next)).toEqual({
      renames: [
        { from: 'todo', to: 'done' },
        { from: 'done', to: 'todo' },
      ],
      removed: ['doing'],
      labelsChanged: true,
    });
    const reordered = [...OPTIONS]
      .reverse()
      .map((option) => ({ ...option, color: 'gray' as const }));
    expect(selectOptionChanges(OPTIONS, reordered)).toEqual({
      renames: [],
      removed: [],
      labelsChanged: false,
    });
  });
});

describe('select values', () => {
  it('takes one label, or null when optional', () => {
    expect(tableEntryValueProblem(field(), 'doing')).toBeNull();
    expect(tableEntryValueProblem(field(), null)).toBeNull();
    expect(tableEntryValueProblem(field({ nullable: false }), null)).toBe('status is required.');
    expect(tableEntryValueProblem(field(), 'Doing')).toBe(
      '"Doing" is not an option of status. Options: todo, doing, done.'
    );
    expect(tableEntryValueProblem(field(), true)).toBe(
      'status takes one option. Options: todo, doing, done.'
    );
  });

  it('takes an ordered list of distinct labels for a multi-select, null meaning []', () => {
    const tags = field({ name: 'tags', multiple: true, nullable: false, defaultValue: [] });
    expect(tableEntryValueProblem(tags, ['done', 'todo'])).toBeNull();
    expect(tableEntryValueProblem(tags, [])).toBeNull();
    expect(tableEntryValueProblem(tags, null)).toBeNull();
    expect(tableEntryValueProblem(tags, ['todo', 'todo'])).toBe('Choose each option only once.');
    expect(tableEntryValueProblem(tags, 'todo')).toBe(
      'tags takes a list of options. Options: todo, doing, done.'
    );
    expect(tableEntryValueProblem(tags, ['todo', 'x'])).toBe(
      '"x" is not an option of tags. Options: todo, doing, done.'
    );
  });

  it('says when there are no options, and cuts a long list short', () => {
    expect(selectValueProblem(field({ options: [] }), 'a')).toBe(
      '"a" is not an option of status. status has no options yet.'
    );
    const many = Array.from({ length: 35 }, (_, index) => ({
      id: `opt-${index}`,
      label: `o${index}`,
      color: 'blue' as const,
    }));
    expect(selectValueProblem(field({ options: many }), 'x')).toMatch(
      /Options: o0, o1, .*, o29, … \(35 in all\)\.$/
    );
  });
});
