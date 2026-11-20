import { describe, expect, it } from '@jest/globals';
import type { TableField, TableFieldDefinition } from '@snaglet/shared/types';
import {
  normalizeTableFieldDefinition,
  tableEntryValueProblem,
  tableFieldDefinitionProblem,
  tableFieldRecurrenceProblem,
  tableFieldWidthProblem,
} from '@snaglet/shared/utils';

const text: TableFieldDefinition = {
  name: 'test_field',
  description: 'Customer’s preferred name — 表示名.',
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
};

describe('tableFieldDefinitionProblem', () => {
  it('allows prose descriptions while names must be real column identifiers', () => {
    expect(tableFieldDefinitionProblem(text)).toBeNull();
    expect(tableFieldDefinitionProblem({ ...text, name: 'Test Field' })).toContain('Use only');
    expect(tableFieldDefinitionProblem({ ...text, name: 'order' })).toContain('reserved SQL word');
    for (const name of ['id', 'created_at', 'position'])
      expect(tableFieldDefinitionProblem({ ...text, name })).toContain('system column');
    expect(tableFieldDefinitionProblem({ ...text, description: 'x'.repeat(2001) })).toContain(
      '2000'
    );
    expect(tableFieldDefinitionProblem({ ...text, description: 'bad\0text' })).toContain('null');
  });

  it.each(['0', '-0.125', '99999999999999999999999999.123', '+.5'])(
    'accepts a precision-preserving decimal default %s',
    (defaultValue) => {
      expect(tableFieldDefinitionProblem({ ...text, type: 'number', defaultValue })).toBeNull();
    }
  );

  it.each(['NaN', 'Infinity', '1e3', '', '1,000', '1.2.3'])(
    'rejects invalid numeric default %s',
    (defaultValue) => {
      expect(tableFieldDefinitionProblem({ ...text, type: 'number', defaultValue })).toContain(
        'decimal'
      );
    }
  );

  it.each(['2024-02-29', '2026-09-25', '0001-01-01'])(
    'accepts exact calendar date %s',
    (defaultValue) => {
      expect(tableFieldDefinitionProblem({ ...text, type: 'date', defaultValue })).toBeNull();
    }
  );

  it.each(['2025-02-29', '2026-04-31', '2026-00-00', '0000-01-01', 'today', '2026-9-25'])(
    'rejects invalid date %s',
    (defaultValue) => {
      expect(tableFieldDefinitionProblem({ ...text, type: 'date', defaultValue })).toContain(
        'valid default date'
      );
    }
  );

  it.each([
    '2026-10-01',
    '2026-10-01T15:30',
    '2026-10-01 15:30:05',
    '2026-10-01T15:30:05.123456Z',
    '2026-10-01T15:30+05:30',
    '2026-10-01T15:30-0700',
    '2026-10-01T15:30+13',
  ])('accepts ISO 8601 datetime default %s', (defaultValue) => {
    expect(tableFieldDefinitionProblem({ ...text, type: 'datetime', defaultValue })).toBeNull();
  });

  it.each([
    '2026-02-29T10:00',
    '2026-10-01T24:00',
    '2026-10-01T15:60',
    '2026-10-01T15:30:00.1234567Z',
    '2026-10-01T15:30+16:00',
    '2026-10-01Z',
    '2026-10-01t15:30',
    'Oct 1 2026 3:30 PM',
    '',
  ])('rejects invalid datetime default %s', (defaultValue) => {
    expect(tableFieldDefinitionProblem({ ...text, type: 'datetime', defaultValue })).toContain(
      'valid default date and time'
    );
  });

  it('requires type-appropriate defaults and nullable custom-table relations', () => {
    expect(
      tableFieldDefinitionProblem({ ...text, type: 'checkbox', defaultValue: false })
    ).toBeNull();
    expect(
      tableFieldDefinitionProblem({ ...text, type: 'checkbox', defaultValue: 'false' })
    ).toContain('true or false');
    const relation: TableFieldDefinition = {
      ...text,
      type: 'relation',
      referenceTableId: 'table-1111111111111-aaaaaaaaa',
    };
    expect(tableFieldDefinitionProblem(relation)).toBeNull();
    const single = { ...relation, multiple: false };
    expect(tableFieldDefinitionProblem({ ...single, nullable: false })).toContain('empty');
    expect(tableFieldDefinitionProblem({ ...single, defaultValue: [] })).toContain('default');
    expect(tableFieldDefinitionProblem({ ...relation, defaultValue: 'row-id' })).toContain(
      'default'
    );
    expect(
      tableFieldDefinitionProblem({ ...relation, referenceTableId: 'table-builtin-docs' })
    ).toContain('custom');
    expect(
      tableFieldDefinitionProblem({ ...text, referenceTableId: relation.referenceTableId })
    ).toContain('Only relation');
  });

  it('accepts either empty form for a multiple relation and refuses it elsewhere', () => {
    const relation: TableFieldDefinition = {
      ...text,
      type: 'relation',
      referenceTableId: 'table-1111111111111-aaaaaaaaa',
      multiple: true,
    };
    for (const patch of [
      {},
      { nullable: false },
      { defaultValue: [] as [] },
      { nullable: false, defaultValue: [] as [] },
    ])
      expect(tableFieldDefinitionProblem({ ...relation, ...patch })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...relation, defaultValue: 'x' })).toContain('default');
    // Left out, `multiple` is undecided (an update keeps the field's setting),
    // so both relation forms pass here; the model re-checks once it is known.
    const { multiple: _multiple, ...undecided } = relation;
    expect(tableFieldDefinitionProblem({ ...undecided, nullable: false })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...text, multiple: true })).toContain(
      'Only relation fields can link to multiple'
    );
    expect(
      tableFieldDefinitionProblem({ ...relation, multiple: 'yes' as unknown as boolean })
    ).toContain('true or false');
    expect(normalizeTableFieldDefinition({ ...relation, multiple: true })).toEqual({
      ...relation,
      nullable: false,
      defaultValue: [],
    });
    expect(normalizeTableFieldDefinition({ ...text, multiple: false })).toEqual({
      ...text,
      multiple: false,
    });
  });
});

describe('tableEntryValueProblem for relations', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const field: TableField = {
    ...text,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'links',
    type: 'relation',
    referenceTableId: 'table-1111111111111-bbbbbbbbb',
    nullable: false,
    defaultValue: [],
    position: 3,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    multiple: true,
    range: false,
  };

  it('accepts an ordered list of unique entry UUIDs, or null for none', () => {
    expect(tableEntryValueProblem(field, [uuid(2), uuid(1)])).toBeNull();
    expect(tableEntryValueProblem(field, [])).toBeNull();
    expect(tableEntryValueProblem(field, null)).toBeNull();
    expect(
      tableEntryValueProblem(
        field,
        Array.from({ length: 100 }, (_, n) => uuid(n))
      )
    ).toBeNull();
  });

  it('refuses scalars, bad ids, duplicates and more than 100 links', () => {
    expect(tableEntryValueProblem(field, uuid(1))).toContain('related table');
    expect(tableEntryValueProblem(field, [uuid(1), 'bad'])).toContain('related table');
    expect(tableEntryValueProblem(field, [uuid(1), 7])).toContain('related table');
    expect(tableEntryValueProblem(field, [uuid(1), uuid(1).toUpperCase()])).toContain('only once');
    expect(
      tableEntryValueProblem(
        field,
        Array.from({ length: 101 }, (_, n) => uuid(n))
      )
    ).toContain('at most 100');
  });

  it('keeps a single relation to one UUID or null', () => {
    const single = { ...field, multiple: false, nullable: true, defaultValue: null };
    expect(tableEntryValueProblem(single, uuid(1))).toBeNull();
    expect(tableEntryValueProblem(single, null)).toBeNull();
    expect(tableEntryValueProblem(single, [uuid(1)])).toContain('related table');
  });
});

describe('tableEntryValueProblem for datetimes', () => {
  const field: TableField = {
    ...text,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'due_at',
    name: 'due_at',
    type: 'datetime',
    position: 3,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    multiple: false,
    range: false,
  };

  it('accepts ISO 8601 with or without an offset and names the format otherwise', () => {
    expect(tableEntryValueProblem(field, '2026-10-01T15:30')).toBeNull();
    expect(tableEntryValueProblem(field, '2026-10-01T22:30:00Z')).toBeNull();
    expect(tableEntryValueProblem(field, null)).toBeNull();
    expect(tableEntryValueProblem(field, '10/01/2026')).toBe(
      'Enter a valid date and time in ISO 8601 format, like 2026-10-01T15:30 or 2026-10-01T22:30:00Z.'
    );
    expect(tableEntryValueProblem(field, true)).toContain('ISO 8601');
  });

  it('keeps the managed created_at read-only', () => {
    const createdAt = { ...field, name: 'created_at', columnName: 'created_at', managed: true };
    expect(tableEntryValueProblem(createdAt, '2026-10-01T15:30')).toContain('managed by Snaglet');
  });
});

describe('tableFieldDefinitionProblem for date ranges', () => {
  const date: TableFieldDefinition = { ...text, type: 'date', range: true };

  it('lets date and datetime fields hold an end, with no default', () => {
    expect(tableFieldDefinitionProblem(date)).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, type: 'datetime' })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, nullable: false })).toBeNull();
    // Off, or left out (an update keeps the field's setting), changes nothing.
    expect(tableFieldDefinitionProblem({ ...date, range: false, defaultValue: '2026-10-12' })).toBe(
      null
    );
    const { range: _range, ...undecided } = date;
    expect(tableFieldDefinitionProblem({ ...undecided, defaultValue: '2026-10-12' })).toBeNull();
  });

  it.each(['text', 'number', 'checkbox', 'select'] as const)(
    'refuses an end on a %s field',
    (type) => {
      expect(
        tableFieldDefinitionProblem({
          ...date,
          type,
          ...(type === 'select' ? { options: [{ label: 'a' }] } : {}),
        })
      ).toBe('Only date and datetime fields can have an end date.');
    }
  );

  it('refuses a relation with an end', () => {
    expect(
      tableFieldDefinitionProblem({
        ...date,
        type: 'relation',
        referenceTableId: 'table-1111111111111-aaaaaaaaa',
      })
    ).toBe('Only date and datetime fields can have an end date.');
  });

  it('refuses a default and a non-boolean flag on a range, and lets it repeat', () => {
    for (const defaultValue of ['2026-10-12', '2026-10-12/2026-10-15'])
      expect(tableFieldDefinitionProblem({ ...date, defaultValue })).toBe(
        'A field with an end date cannot have a default value.'
      );
    expect(
      tableFieldDefinitionProblem({ ...date, type: 'datetime', defaultValue: '2026-10-12T09:00' })
    ).toBe('A field with an end date cannot have a default value.');
    expect(tableFieldDefinitionProblem({ ...date, range: 'yes' as unknown as boolean })).toBe(
      'Field range must be true or false.'
    );
    const recurrence = {
      statusFieldId: 'field-1111111111111-status',
      doneOptionIds: ['opt-done'],
      resetOptionId: null,
    };
    expect(tableFieldDefinitionProblem({ ...date, recurrence })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, type: 'datetime', recurrence })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, range: false, recurrence })).toBeNull();
  });
});

describe('tableEntryValueProblem for date ranges', () => {
  const ZONE = 'Pacific/Auckland';
  const base: TableField = {
    ...text,
    id: 'field-1111111111111-aaaaaaaaa',
    tableId: 'table-1111111111111-aaaaaaaaa',
    columnName: 'stay',
    name: 'stay',
    type: 'date',
    position: 3,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    multiple: false,
    range: true,
    options: null,
    referenceKind: null,
  };
  const at: TableField = { ...base, name: 'slot', columnName: 'slot', type: 'datetime' };
  const DATE_FORM =
    'Write a date range as start/end, like 2026-10-12/2026-10-15 (both days included), or as one date.';
  const TIME_FORM =
    'Write a date and time range as start/end, like 2026-10-12T09:00/2026-10-12T10:30, or as one date and time.';

  it('accepts a span, a single day and null on a date range', () => {
    for (const value of ['2026-10-12/2026-10-15', '2026-10-12', '2026-10-12/2026-10-12', null])
      expect(tableEntryValueProblem(base, value, ZONE)).toBeNull();
    expect(tableEntryValueProblem({ ...base, nullable: false }, null, ZONE)).toBe(
      'stay is required.'
    );
  });

  it('accepts instants and wall times, single or spans, on a datetime range', () => {
    for (const value of [
      '2026-10-12T09:00/2026-10-12T10:30',
      '2026-10-12T09:00:00Z/2026-10-12T23:30:00+13:00',
      '2026-10-12T09:00',
      '2026-10-12/2026-10-13',
    ])
      expect(tableEntryValueProblem(at, value, ZONE)).toBeNull();
  });

  it('compares the two ends as instants, so offsets cannot hide a reversed range', () => {
    // 09:00 in Auckland (+13:00) is 20:00Z the day before, after 08:00Z.
    expect(tableEntryValueProblem(at, '2026-10-12T09:00/2026-10-11T21:00Z', ZONE)).toBeNull();
    expect(tableEntryValueProblem(at, '2026-10-12T09:00/2026-10-11T19:00Z', ZONE)).toBe(
      `The end is before the start. ${TIME_FORM}`
    );
  });

  it('refuses reversed, malformed and wrong-kind values, naming the right form', () => {
    expect(tableEntryValueProblem(base, '2026-10-15/2026-10-12', ZONE)).toBe(
      `The end is before the start. ${DATE_FORM}`
    );
    expect(tableEntryValueProblem(base, '2026-10-12/2026-10-13/2026-10-14', ZONE)).toBe(
      `Write a range as start/end, with one slash. ${DATE_FORM}`
    );
    expect(tableEntryValueProblem(base, '2026-10-12T09:00/2026-10-13', ZONE)).toBe(
      `The range's start must be a date like 2026-10-12. ${DATE_FORM}`
    );
    expect(tableEntryValueProblem(base, '2026-02-30', ZONE)).toContain(DATE_FORM);
    for (const value of [true, ['2026-10-12', '2026-10-15'], 20261012])
      expect(tableEntryValueProblem(base, value, ZONE)).toBe(DATE_FORM);
  });

  it('refuses a shortened end or a duration, which agents tend to write', () => {
    for (const value of ['2026-01-31T15:30/17:00', '2026-01-31T15:30/PT1H'])
      expect(tableEntryValueProblem(at, value, ZONE)).toBe(
        `The range's end must be a date and time like 2026-10-12T09:00. ${TIME_FORM}`
      );
    expect(tableEntryValueProblem(at, '/2026-01-31T17:00', ZONE)).toBe(
      `The range's start is empty. ${TIME_FORM}`
    );
  });

  it('leaves plain date fields to their own rules', () => {
    const plain = { ...base, range: false };
    expect(tableEntryValueProblem(plain, '2026-10-12', ZONE)).toBeNull();
    expect(tableEntryValueProblem(plain, '2026-10-12/2026-10-15', ZONE)).toContain(
      'valid date in YYYY-MM-DD'
    );
  });
});

describe('tableFieldRecurrenceProblem', () => {
  const ok = {
    statusFieldId: 'field-1111111111111-status',
    doneOptionIds: ['opt-done'],
    resetOptionId: 'opt-todo',
  };
  const date: TableFieldDefinition = { ...text, type: 'date' };

  it('accepts a well-formed setting on date and datetime fields only', () => {
    expect(tableFieldRecurrenceProblem(ok)).toBeNull();
    expect(tableFieldRecurrenceProblem({ ...ok, resetOptionId: null })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, recurrence: ok as never })).toBeNull();
    expect(
      tableFieldDefinitionProblem({ ...date, type: 'datetime', recurrence: ok as never })
    ).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, recurrence: null })).toBeNull();
    expect(tableFieldDefinitionProblem({ ...text, recurrence: ok as never })).toContain(
      'Only date and datetime'
    );
  });

  it('accepts a setting with no status field (rows completed with Done / Skip)', () => {
    const none = { statusFieldId: null, doneOptionIds: [], resetOptionId: null };
    expect(tableFieldRecurrenceProblem(none)).toBeNull();
    expect(tableFieldDefinitionProblem({ ...date, recurrence: none as never })).toBeNull();
    expect(tableFieldRecurrenceProblem({ ...none, doneOptionIds: ['opt-done'] })).toContain(
      'Without a status field'
    );
    expect(tableFieldRecurrenceProblem({ ...none, resetOptionId: 'opt-todo' })).toContain(
      'Without a status field'
    );
  });

  it('rejects malformed settings with a reason', () => {
    const cases: Array<[unknown, string]> = [
      [[], 'must be an object'],
      [{ ...ok, extra: true }, 'no extra'],
      [{ ...ok, statusFieldId: 'status' }, 'statusFieldId'],
      [{ ...ok, doneOptionIds: [] }, 'doneOptionIds'],
      [{ ...ok, doneOptionIds: ['done'] }, 'doneOptionIds'],
      [{ ...ok, doneOptionIds: ['opt-done', 'opt-done'] }, 'only once'],
      [{ ...ok, resetOptionId: 'todo' }, 'resetOptionId'],
      [{ ...ok, resetOptionId: 'opt-done' }, 'cannot be one'],
      // Repeats start weeks on Monday: there is no week start to set.
      [{ ...ok, weekStart: 'MO' }, 'no weekStart'],
    ];
    for (const [value, message] of cases)
      expect(tableFieldRecurrenceProblem(value)).toContain(message);
  });
});

describe('tableFieldWidthProblem', () => {
  it('allows auto (null) and whole px from 64 to 800, nothing else', () => {
    for (const width of [null, 64, 240, 800]) expect(tableFieldWidthProblem(width)).toBeNull();
    for (const width of [63, 801, 0, -64, 120.5, Number.NaN, Infinity, '240', true, [240], {}])
      expect(tableFieldWidthProblem(width)).toBe(
        'width must be a whole number of pixels from 64 to 800, or null for auto.'
      );
    expect(tableFieldWidthProblem(undefined)).not.toBeNull();
  });
});
