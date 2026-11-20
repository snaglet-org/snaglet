import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  getDb,
  transaction,
  TableCatalog,
  TableEntries,
  TableFields,
  quoteIdentifier,
} from '@snaglet/db';
import { hashEntryVersion } from '@snaglet/db/tables/table_entries/entrySchema';
import type {
  CreateTableFieldRequest,
  TableField,
  TableSelectOptionInput,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';

const SOURCE = 'table-1111111111111-selecttbl';
const SOURCE_NAME = 'select_source';
const SOURCE_SQL = `user_tables.${quoteIdentifier(SOURCE_NAME)}`;
const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';
const ROW_C = '33333333-3333-4333-8333-333333333333';

let serial = 0;
function definition(patch: Partial<CreateTableFieldRequest> = {}): CreateTableFieldRequest {
  serial += 1;
  return {
    id: `field-1111111111111-sel${serial}`,
    name: `field_${serial}`,
    description: null,
    type: 'select',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...patch,
  };
}
function edit(
  field: TableField,
  patch: Partial<UpdateTableFieldRequest> = {}
): UpdateTableFieldRequest {
  if (field.managed || field.type === 'uuid') throw new Error('Managed field');
  return {
    name: field.name,
    description: field.description,
    type: field.type,
    nullable: field.nullable,
    defaultValue: field.defaultValue,
    referenceTableId: field.referenceTableId,
    multiple: field.multiple,
    options: field.options,
    expectedRevision: field.revision,
    ...patch,
  };
}
/** The field's options as a request would send them back. */
function optionsOf(field: TableField): TableSelectOptionInput[] {
  return (field.options ?? []).map((option) => ({ ...option }));
}
async function clean(): Promise<void> {
  await getDb().query('DELETE FROM public.table_fields WHERE table_id = $1', [SOURCE]);
  await getDb().query(`DROP TABLE IF EXISTS ${SOURCE_SQL} CASCADE`);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [SOURCE]);
}
/** Column values in row order (`position`, then id). */
async function column(field: TableField): Promise<unknown[]> {
  const { rows } = await getDb().query<{ value: unknown }>(
    `SELECT ${quoteIdentifier(field.columnName)} AS value FROM ${SOURCE_SQL} ORDER BY position, id`
  );
  return rows.map((row) => row.value);
}
async function insertRaw(field: TableField, id: string, value: unknown): Promise<void> {
  const cast = field.multiple ? 'text[]' : 'text';
  await getDb().query(
    `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(field.columnName)}) VALUES ($1, $2::${cast})`,
    [id, value]
  );
}
/** Insert the row or set this column on it. */
async function setRaw(field: TableField, id: string, value: unknown): Promise<void> {
  const cast = field.multiple ? 'text[]' : 'text';
  const column = quoteIdentifier(field.columnName);
  await getDb().query(
    `INSERT INTO ${SOURCE_SQL} (id, ${column}) VALUES ($1, $2::${cast})
     ON CONFLICT (id) DO UPDATE SET ${column} = EXCLUDED.${column}`,
    [id, value]
  );
}
async function checkOid(field: TableField): Promise<number | undefined> {
  const { rows } = await getDb().query<{ oid: number }>(
    `SELECT oid::int AS oid FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
    [SOURCE_SQL, `ck_${field.id.replace(/-/g, '_')}`]
  );
  return rows[0]?.oid;
}
async function schemaVersion(): Promise<string> {
  return (await TableEntries.listEntries(SOURCE)).schemaVersion;
}

describe('select fields (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await transaction(async (tx) => {
      await TableCatalog.createCustomPhysicalTable(SOURCE_NAME, SOURCE, tx);
      await TableCatalog.registerCustom(
        { id: SOURCE, name: SOURCE_NAME, tableName: SOURCE_NAME },
        tx
      );
      await TableFields.registerInitialFields(SOURCE, tx);
    });
  });
  afterAll(clean);

  it('creates a text column whose CHECK admits only option labels, with ids and calm colors assigned', async () => {
    const { field, created } = await TableFields.createField(
      SOURCE,
      definition({
        name: 'status',
        options: [{ label: 'todo' }, { label: 'doing', color: 'orange' }, { label: 'done' }],
        defaultValue: 'todo',
      })
    );
    expect(created).toBe(true);
    expect(field).toMatchObject({ type: 'select', multiple: false, defaultValue: 'todo' });
    expect(field.options?.map((option) => [option.label, option.color])).toEqual([
      ['todo', 'blue'],
      ['doing', 'orange'],
      ['done', 'green'],
    ]);
    for (const option of field.options ?? []) expect(option.id).toMatch(/^opt-[a-z0-9-]+$/);
    expect(new Set(field.options?.map((option) => option.id)).size).toBe(3);
    expect(await TableFields.listFields(SOURCE)).toContainEqual(field);
    const physical = await TableCatalog.physicalColumns({
      origin: 'custom',
      tableName: SOURCE_NAME,
    });
    expect(physical.find((entry) => entry.name === 'status')?.dataType).toBe('text');

    await insertRaw(field, ROW_A, 'doing');
    await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1)`, [ROW_B]);
    await getDb().query(`INSERT INTO ${SOURCE_SQL} (id, status) VALUES ($1, NULL)`, [ROW_C]);
    expect(await column(field)).toEqual(['doing', 'todo', null]);
    await expect(insertRaw(field, ROW_C.replace('3333', '4444'), 'blocked')).rejects.toMatchObject({
      code: '23514',
    });
    // Other fields keep null options.
    for (const other of (await TableFields.listFields(SOURCE)).filter(
      (candidate) => candidate.type !== 'select'
    ))
      expect(other.options).toBeNull();
  });

  it('adds a select with no options to a table that already has entries', async () => {
    await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1), ($2)`, [ROW_A, ROW_B]);
    const single = (await TableFields.createField(SOURCE, definition({ options: [] }))).field;
    const multi = (
      await TableFields.createField(
        SOURCE,
        definition({ multiple: true, nullable: false, defaultValue: [], options: [] })
      )
    ).field;
    expect(await column(single)).toEqual([null, null]);
    expect(await column(multi)).toEqual([[], []]);
    await expect(insertRaw(single, ROW_C, 'x')).rejects.toMatchObject({ code: '23514' });
  });

  it('creates a never-null text[] multi-select with a list default and the same CHECK', async () => {
    const { field } = await TableFields.createField(
      SOURCE,
      definition({
        name: 'tags',
        multiple: true,
        nullable: true,
        options: [{ label: 'urgent' }, { label: 'later' }, { label: 'blocked' }],
        defaultValue: ['later'],
      })
    );
    expect(field).toMatchObject({ multiple: true, nullable: false, defaultValue: ['later'] });
    await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1)`, [ROW_A]);
    await insertRaw(field, ROW_B, ['blocked', 'urgent']);
    expect(await column(field)).toEqual([['later'], ['blocked', 'urgent']]);
    await expect(insertRaw(field, ROW_C, ['urgent', 'nope'])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      getDb().query(`INSERT INTO ${SOURCE_SQL} (id, tags) VALUES ($1, NULL)`, [ROW_C])
    ).rejects.toMatchObject({ code: '23502' });

    // A null or missing multi-select default is the empty list.
    const empty = await TableFields.createField(
      SOURCE,
      definition({ name: 'labels', multiple: true, options: [{ label: 'a' }] })
    );
    expect(empty.field).toMatchObject({ nullable: false, defaultValue: [] });
    expect(await column(empty.field)).toEqual([[], []]);
  });

  it('hashes fields without options with the option-less formula', async () => {
    const { field: status } = await TableFields.createField(
      SOURCE,
      definition({ name: 'status', options: [{ label: 'a' }] })
    );
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
    const { rows: metadata } = await getDb().query<{ id: string }>(
      'SELECT id, default_expression FROM public.table_fields WHERE table_id = $1',
      [SOURCE]
    );
    const shape = (await TableFields.listFields(SOURCE))
      .map(
        ({
          collapsed: _c,
          isTitle: _t,
          multiple: _m,
          range: _r,
          referenceKind: _k,
          options,
          ...field
        }) => ({
          ...field,
          position: 0,
          ...(field.id === status.id ? { options } : {}),
        })
      )
      .sort(byId);
    expect(await schemaVersion()).toBe(
      hashEntryVersion([SOURCE, SOURCE_NAME, shape, metadata.sort(byId)])
    );
  });

  it('refuses malformed options and defaults before any schema change', async () => {
    const refused: Array<[Partial<CreateTableFieldRequest>, string]> = [
      [{ options: [{ label: 'a' }], defaultValue: 'b' }, 'Choose one of the options'],
      [{ options: [{ label: 'Todo' }, { label: 'todo' }] }, 'listed twice'],
      [{ options: [{ label: ' padded' }] }, 'cannot start or end with spaces'],
      [{ options: [{ label: 'two\nlines' }] }, 'line breaks'],
      [{ options: [{ label: '' }] }, 'non-empty'],
      [{ options: [{ label: 'x'.repeat(101) }] }, 'at most 100'],
      [
        { options: [{ label: 'a', color: 'teal' as never }] },
        'Option colors are blue, green, yellow',
      ],
      [{ options: [{ label: 'a', id: 'bad id' }] }, 'Option ids must look like'],
      [
        {
          options: [
            { label: 'a', id: 'opt-1' },
            { label: 'b', id: 'opt-1' },
          ],
        },
        'appear only once',
      ],
      [
        { options: Array.from({ length: 101 }, (_, index) => ({ label: `o${index}` })) },
        'at most 100 options',
      ],
      [{ options: [{ label: 'a', extra: true } as never] }, 'Each option must be'],
      [{ multiple: true, options: [{ label: 'a' }], defaultValue: 'a' }, 'is a list of options'],
      [{ multiple: true, options: [{ label: 'a' }], defaultValue: ['a', 'a'] }, 'only once'],
      [{ options: [{ label: 'a' }], defaultValue: ['a'] }, 'Choose one option'],
      [{ type: 'text', options: [{ label: 'a' }] }, 'Only select fields have options.'],
      [{ referenceTableId: SOURCE }, 'Only relation fields can reference another table.'],
    ];
    for (const [patch, message] of refused)
      await expect(TableFields.createField(SOURCE, definition(patch))).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(message),
      });
    // An omitted option list is an empty one: only null fits.
    await expect(
      TableFields.createField(SOURCE, definition({ defaultValue: 'x' }))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      (await TableFields.listFields(SOURCE)).filter((field) => field.type === 'select')
    ).toEqual([]);
  });

  it('replays a create exactly, pinning only the ids and colors the request gave', async () => {
    const input = definition({ name: 'stage', options: [{ label: 'a' }, { label: 'b' }] });
    const first = await TableFields.createField(SOURCE, input);
    const replay = await TableFields.createField(SOURCE, input);
    expect(replay).toEqual({ field: first.field, created: false });
    await expect(
      TableFields.createField(SOURCE, { ...input, options: [{ label: 'a' }, { label: 'c' }] })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      TableFields.createField(SOURCE, {
        ...input,
        options: [{ label: 'a', color: 'red' }, { label: 'b' }],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('validates entry values against the options and keeps multi-select order', async () => {
    const status = (
      await TableFields.createField(
        SOURCE,
        definition({ name: 'status', options: [{ label: 'todo' }, { label: 'done' }] })
      )
    ).field;
    const tags = (
      await TableFields.createField(
        SOURCE,
        definition({
          name: 'tags',
          multiple: true,
          options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
        })
      )
    ).field;
    const version = await schemaVersion();
    const created = await TableEntries.createEntry(SOURCE, {
      id: ROW_A,
      values: { [status.id]: 'done', [tags.id]: ['c', 'a'] },
      schemaVersion: version,
    });
    expect(created.entry.values).toMatchObject({ [status.id]: 'done', [tags.id]: ['c', 'a'] });
    const cleared = await TableEntries.updateEntry(SOURCE, ROW_A, {
      values: { [status.id]: null, [tags.id]: null },
      schemaVersion: version,
      expectedRevision: created.entry.revision,
    });
    expect(cleared.entry.values).toMatchObject({ [status.id]: null, [tags.id]: [] });

    const refused: Array<[Record<string, unknown>, string]> = [
      [{ [status.id]: 'blocked' }, '"blocked" is not an option of status. Options: todo, done.'],
      [{ [status.id]: ['todo'] }, 'status takes one option.'],
      [{ [tags.id]: ['a', 'a'] }, 'Choose each option only once.'],
      [{ [tags.id]: ['a', 'z'] }, '"z" is not an option of tags. Options: a, b, c.'],
      [{ [tags.id]: 'a' }, 'tags takes a list of options.'],
    ];
    for (const [values, message] of refused)
      await expect(
        TableEntries.createEntry(SOURCE, {
          id: ROW_B,
          values: values as never,
          schemaVersion: version,
        })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(message) });
  });

  describe('option changes', () => {
    async function seededSingle(): Promise<TableField> {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({
          name: 'status',
          options: [{ label: 'todo' }, { label: 'doing' }, { label: 'done' }],
        })
      );
      await setRaw(field, ROW_A, 'todo');
      await setRaw(field, ROW_B, 'doing');
      await setRaw(field, ROW_C, 'done');
      return field;
    }
    async function seededMulti(): Promise<TableField> {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({
          name: 'tags',
          multiple: true,
          options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
          defaultValue: ['a'],
        })
      );
      await setRaw(field, ROW_A, ['c', 'a', 'b']);
      await setRaw(field, ROW_B, ['b']);
      await setRaw(field, ROW_C, []);
      return field;
    }

    it('renames an option in every row, keeping its id and color, and rebuilds the CHECK', async () => {
      const field = await seededSingle();
      const oid = await checkOid(field);
      const options = optionsOf(field);
      options[0] = { ...options[0]!, label: 'backlog' };
      const updated = await TableFields.updateField(SOURCE, field.id, edit(field, { options }));
      expect(updated.revision).toBe(field.revision + 1);
      expect(updated.options).toEqual([
        { ...field.options![0]!, label: 'backlog' },
        field.options![1],
        field.options![2],
      ]);
      expect(await column(field)).toEqual(['backlog', 'doing', 'done']);
      expect(await checkOid(field)).toEqual(expect.any(Number));
      expect(await checkOid(field)).not.toBe(oid);
      await expect(insertRaw(field, ROW_A.replace('1111', '5555'), 'todo')).rejects.toMatchObject({
        code: '23514',
      });
      await insertRaw(field, ROW_A.replace('1111', '5555'), 'backlog');
    });

    it('swaps two labels in one statement and follows renames through lists', async () => {
      const single = await seededSingle();
      const options = optionsOf(single);
      options[0] = { ...options[0]!, label: 'done' };
      options[2] = { ...options[2]!, label: 'todo' };
      await TableFields.updateField(SOURCE, single.id, edit(single, { options }));
      expect(await column(single)).toEqual(['done', 'doing', 'todo']);

      const multi = await seededMulti();
      const listed = optionsOf(multi);
      listed[0] = { ...listed[0]!, label: 'b' };
      listed[1] = { ...listed[1]!, label: 'a' };
      const updated = await TableFields.updateField(
        SOURCE,
        multi.id,
        // The default names the new label of the option it meant.
        edit(multi, { options: listed, defaultValue: ['b'] })
      );
      expect(updated.defaultValue).toEqual(['b']);
      expect(await column(multi)).toEqual([['c', 'b', 'a'], ['a'], []]);
    });

    it('reorders and recolors as metadata only: no data rewrite and no CHECK rebuild', async () => {
      const field = await seededSingle();
      const oid = await checkOid(field);
      expect(oid).toEqual(expect.any(Number));
      const reordered = [...optionsOf(field)].reverse();
      reordered[0] = { ...reordered[0]!, color: 'gray' };
      const updated = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { options: reordered })
      );
      expect(updated.options?.map((option) => [option.label, option.color])).toEqual([
        ['done', 'gray'],
        ['doing', field.options![1]!.color],
        ['todo', field.options![0]!.color],
      ]);
      expect(updated.revision).toBe(field.revision + 1);
      expect(await checkOid(field)).toBe(oid);
      expect(await column(field)).toEqual(['todo', 'doing', 'done']);
    });

    it('adds options by widening the CHECK and keeps them on edits that leave options out', async () => {
      const field = await seededSingle();
      const updated = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { options: [...optionsOf(field), { label: 'blocked' }] })
      );
      expect(updated.options?.map((option) => option.label)).toEqual([
        'todo',
        'doing',
        'done',
        'blocked',
      ]);
      await insertRaw(field, ROW_A.replace('1111', '5555'), 'blocked');
      const { options: _omitted, ...withoutOptions } = edit(updated, {
        description: 'Where the work is.',
      });
      const described = await TableFields.updateField(SOURCE, field.id, withoutOptions);
      expect(described.options).toEqual(updated.options);
    });

    it('removes every option from a select whose rows are empty or hold them', async () => {
      const single = await seededSingle();
      const cleared = await TableFields.updateField(
        SOURCE,
        single.id,
        edit(single, { options: [] })
      );
      expect(cleared.options).toEqual([]);
      expect(await column(single)).toEqual([null, null, null]);
    });

    it('clears a removed option from single values and lists, keeping list order', async () => {
      const single = await seededSingle();
      await TableFields.updateField(
        SOURCE,
        single.id,
        edit(single, { options: optionsOf(single).filter((option) => option.label !== 'doing') })
      );
      expect(await column(single)).toEqual(['todo', null, 'done']);
      await expect(insertRaw(single, ROW_A.replace('1111', '5555'), 'doing')).rejects.toMatchObject(
        { code: '23514' }
      );

      const multi = await seededMulti();
      const updated = await TableFields.updateField(
        SOURCE,
        multi.id,
        edit(multi, {
          options: optionsOf(multi).filter((option) => option.label !== 'a'),
          defaultValue: [],
        })
      );
      expect(updated.defaultValue).toEqual([]);
      expect(await column(multi)).toEqual([['c', 'b'], ['b'], []]);
    });

    it('replaces a removed option with the default of a required select, else refuses while in use', async () => {
      const field = await seededSingle();
      const required = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { nullable: false, defaultValue: 'todo' })
      );
      const withoutDefault = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(required, { defaultValue: null })
      );
      const withoutDone = optionsOf(withoutDefault).filter((option) => option.label !== 'done');
      await expect(
        TableFields.updateField(SOURCE, field.id, edit(withoutDefault, { options: withoutDone }))
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          '1 entry uses a removed option. Give this field a default to replace it, or make it optional first.',
      });
      expect(await column(field)).toEqual(['todo', 'doing', 'done']);
      expect((await TableFields.listFields(SOURCE)).find((f) => f.id === field.id)).toEqual(
        withoutDefault
      );

      await TableFields.updateField(
        SOURCE,
        field.id,
        edit(withoutDefault, { options: withoutDone, defaultValue: 'doing' })
      );
      expect(await column(field)).toEqual(['todo', 'doing', 'doing']);

      // Optional again: a removal clears, even from a column that was NOT NULL.
      const current = (await TableFields.listFields(SOURCE)).find((f) => f.id === field.id)!;
      await TableFields.updateField(
        SOURCE,
        field.id,
        edit(current, {
          nullable: true,
          defaultValue: null,
          options: optionsOf(current).filter((option) => option.label !== 'doing'),
        })
      );
      expect(await column(field)).toEqual(['todo', null, null]);
    });

    it('fills empty rows with the default when a select becomes required', async () => {
      const field = await seededSingle();
      await getDb().query(`UPDATE ${SOURCE_SQL} SET status = NULL WHERE id = $1`, [ROW_B]);
      await expect(
        TableFields.updateField(SOURCE, field.id, edit(field, { nullable: false }))
      ).rejects.toMatchObject({ statusCode: 409 });
      await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { nullable: false, defaultValue: 'done' })
      );
      expect(await column(field)).toEqual(['todo', 'done', 'done']);
    });

    it('counts the entries holding each option', async () => {
      const single = await seededSingle();
      await insertRaw(single, ROW_A.replace('1111', '5555'), 'todo');
      expect(await TableFields.selectOptionUsage(SOURCE, single.id)).toEqual({
        [single.options![0]!.id]: 2,
        [single.options![1]!.id]: 1,
        [single.options![2]!.id]: 1,
      });
      const multi = await seededMulti();
      expect(await TableFields.selectOptionUsage(SOURCE, multi.id)).toEqual({
        [multi.options![0]!.id]: 2,
        [multi.options![1]!.id]: 2,
        [multi.options![2]!.id]: 1,
      });
      const title = (await TableFields.listFields(SOURCE)).find((field) => field.isTitle)!;
      await expect(TableFields.selectOptionUsage(SOURCE, title.id)).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        TableFields.selectOptionUsage(SOURCE, 'field-1111111111111-missing')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('treats a dropped CHECK as schema drift for entries and field edits', async () => {
      const field = await seededSingle();
      await getDb().query(
        `ALTER TABLE ${SOURCE_SQL} DROP CONSTRAINT ${quoteIdentifier(`ck_${field.id.replace(/-/g, '_')}`)}`
      );
      await expect(TableEntries.listEntries(SOURCE)).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        TableFields.updateField(SOURCE, field.id, edit(field, { description: 'x' }))
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('conversions', () => {
    async function textField(values: Array<string | null>): Promise<TableField> {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ name: 'stage', type: 'text' })
      );
      for (const [index, value] of values.entries())
        await getDb().query(`INSERT INTO ${SOURCE_SQL} (id, stage, position) VALUES ($1, $2, $3)`, [
          randomUUID(),
          value,
          index,
        ]);
      return field;
    }

    it('turns text into a select with one option per distinct value, in row order', async () => {
      const field = await textField(['  doing ', 'todo', null, '', 'doing', 'done']);
      const updated = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'select', options: [{ label: 'done', color: 'gray' }] })
      );
      expect(updated.options?.map((option) => [option.label, option.color])).toEqual([
        ['done', 'gray'],
        ['doing', 'blue'],
        ['todo', 'green'],
      ]);
      expect(await column(field)).toEqual(['doing', 'todo', null, null, 'doing', 'done']);
      await expect(
        insertRaw(field, '99999999-1111-4111-8111-111111111111', 'other')
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('turns an all-empty text field into a select with no options', async () => {
      // `x = ANY ('{}')` is false even for NULL, so the CHECK must admit NULL explicitly.
      const field = await textField([null, null, '  ']);
      const updated = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'select', options: [] })
      );
      expect(updated).toMatchObject({ type: 'select', options: [], nullable: true });
      expect(await column(field)).toEqual([null, null, null]);
      await expect(
        insertRaw(field, '99999999-1111-4111-8111-111111111111', 'other')
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('turns text into a multi-select by wrapping each value', async () => {
      const field = await textField(['a', null, 'b']);
      const updated = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'select', multiple: true, options: null })
      );
      expect(updated).toMatchObject({ multiple: true, nullable: false, defaultValue: [] });
      expect(updated.options?.map((option) => option.label)).toEqual(['a', 'b']);
      expect(await column(field)).toEqual([['a'], [], ['b']]);
    });

    it('fills blanks of a required text field turned select with the new default', async () => {
      const field = await textField(['a', 'b']);
      const required = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { nullable: false, defaultValue: '' })
      );
      await getDb().query(`UPDATE ${SOURCE_SQL} SET stage = '' WHERE stage = 'b'`);
      await expect(
        TableFields.updateField(
          SOURCE,
          field.id,
          edit(required, { type: 'select', defaultValue: null, options: undefined })
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      const updated = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(required, { type: 'select', defaultValue: 'a', options: undefined })
      );
      expect(updated).toMatchObject({ type: 'select', nullable: false, defaultValue: 'a' });
      expect(await column(field)).toEqual(['a', 'a']);
    });

    it('refuses text that cannot become options, with an explanation, and changes nothing', async () => {
      const cases: Array<[Array<string | null>, string]> = [
        [Array.from({ length: 101 }, (_, index) => `v${index}`), 'more than 100 distinct values'],
        [['Todo', 'todo'], 'differ only by capitalization'],
        [['x'.repeat(101)], 'cannot become an option'],
        [['line\nbreak'], 'cannot become an option'],
      ];
      for (const [values, message] of cases) {
        await clean();
        await transaction(async (tx) => {
          await TableCatalog.createCustomPhysicalTable(SOURCE_NAME, SOURCE, tx);
          await TableCatalog.registerCustom(
            { id: SOURCE, name: SOURCE_NAME, tableName: SOURCE_NAME },
            tx
          );
          await TableFields.registerInitialFields(SOURCE, tx);
        });
        const field = await textField(values);
        await expect(
          TableFields.updateField(
            SOURCE,
            field.id,
            edit(field, { type: 'select', options: undefined })
          )
        ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(message) });
        expect((await TableFields.listFields(SOURCE)).find((f) => f.id === field.id)).toEqual(
          field
        );
      }
    });

    it('keeps labels when a select becomes text, joining a list', async () => {
      const { field: single } = await TableFields.createField(
        SOURCE,
        definition({ name: 'status', options: [{ label: 'todo' }, { label: 'done' }] })
      );
      const { field: multi } = await TableFields.createField(
        SOURCE,
        definition({
          name: 'tags',
          multiple: true,
          options: [{ label: 'a' }, { label: 'b' }],
        })
      );
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, status, tags, position) VALUES ($1, 'todo', '{b,a}', 1), ($2, NULL, '{}', 2)`,
        [ROW_A, ROW_B]
      );
      const text = await TableFields.updateField(
        SOURCE,
        single.id,
        edit(single, { type: 'text', options: null })
      );
      expect(text).toMatchObject({ type: 'text', options: null });
      expect(await column(single)).toEqual(['todo', null]);
      await TableFields.updateField(
        SOURCE,
        multi.id,
        edit(multi, {
          type: 'text',
          multiple: false,
          options: null,
          defaultValue: null,
          nullable: true,
        })
      );
      expect(await column(multi)).toEqual(['b, a', null]);
      const { rows } = await getDb().query(
        `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' AND conname LIKE 'ck\\_%'`,
        [SOURCE_SQL]
      );
      expect(rows).toEqual([]);
    });

    it('wraps a select into a list and unwraps a list only when no entry has several options', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({
          name: 'status',
          options: [{ label: 'todo' }, { label: 'done' }],
          defaultValue: 'todo',
        })
      );
      await insertRaw(field, ROW_A, 'done');
      await getDb().query(`INSERT INTO ${SOURCE_SQL} (id, status) VALUES ($1, NULL)`, [ROW_B]);
      const multi = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { multiple: true, defaultValue: ['todo'] })
      );
      expect(multi).toMatchObject({ multiple: true, nullable: false, defaultValue: ['todo'] });
      expect(await column(field)).toEqual([['done'], []]);
      await expect(insertRaw(multi, ROW_C, ['x'])).rejects.toMatchObject({ code: '23514' });

      await getDb().query(`UPDATE ${SOURCE_SQL} SET status = '{todo,done}' WHERE id = $1`, [ROW_B]);
      await expect(
        TableFields.updateField(
          SOURCE,
          field.id,
          edit(multi, { multiple: false, nullable: true, defaultValue: null })
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('more than one option'),
      });
      await getDb().query(`UPDATE ${SOURCE_SQL} SET status = '{todo}' WHERE id = $1`, [ROW_B]);
      const single = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(multi, { multiple: false, nullable: true, defaultValue: null })
      );
      expect(single).toMatchObject({ multiple: false, nullable: true });
      expect(await column(field)).toEqual(['done', 'todo']);
    });

    it('refuses populated select ↔ number/relation changes but converts empty fields', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ name: 'status', options: [{ label: '1' }] })
      );
      await insertRaw(field, ROW_A, '1');
      await expect(
        TableFields.updateField(SOURCE, field.id, edit(field, { type: 'number', options: null }))
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('text first') });
      await expect(
        TableFields.updateField(
          SOURCE,
          field.id,
          edit(field, { type: 'relation', options: null, referenceTableId: SOURCE })
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      await getDb().query(`UPDATE ${SOURCE_SQL} SET status = NULL`);
      const number = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'number', options: null })
      );
      expect(number).toMatchObject({ type: 'number', options: null });
      const { field: amount } = await TableFields.createField(
        SOURCE,
        definition({ name: 'amount', type: 'number' })
      );
      await getDb().query(`UPDATE ${SOURCE_SQL} SET amount = 3`);
      await expect(
        TableFields.updateField(
          SOURCE,
          amount.id,
          edit(amount, { type: 'select', options: [{ label: '3' }] })
        )
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('text first') });
    });
  });
});
