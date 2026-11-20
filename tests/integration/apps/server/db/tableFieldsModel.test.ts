import { beforeEach, afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  getDb,
  transaction,
  TableCatalog,
  TableEntries,
  TableFields,
  quoteIdentifier,
} from '@snaglet/db';
import type {
  CreateTableFieldRequest,
  TableField,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';

const SOURCE = 'table-1111111111111-fieldsource';
const TARGET = 'table-1111111111111-fieldtarget';
// A custom table's name is its real physical name.
const SOURCE_NAME = 'field_source';
const TARGET_NAME = 'field_target';
const SOURCE_SQL = `user_tables.${quoteIdentifier(SOURCE_NAME)}`;
const TARGET_SQL = `user_tables.${quoteIdentifier(TARGET_NAME)}`;
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const TITLE_ID = `field-title-${SOURCE}`;
const MANAGED_ID = `field-managed-${SOURCE}-id`;
const MANAGED_CREATED_AT = `field-managed-${SOURCE}-created_at`;
/** New tables start with Name, id and created_at; created fields follow. */
const FIRST = 3;
let serial = 0;
function definition(patch: Partial<CreateTableFieldRequest> = {}): CreateTableFieldRequest {
  serial += 1;
  return {
    id: `field-1111111111111-${serial}`,
    name: `field_${serial}`,
    description: null,
    type: 'text',
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
    expectedRevision: field.revision,
    ...patch,
  };
}
async function clean(): Promise<void> {
  await getDb().query('DELETE FROM public.table_fields WHERE table_id = ANY($1::text[])', [
    [SOURCE, TARGET],
  ]);
  await getDb().query(`DROP TABLE IF EXISTS ${SOURCE_SQL}, ${TARGET_SQL} CASCADE`);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = ANY($1::text[])', [
    [SOURCE, TARGET],
  ]);
}
async function value(field: TableField): Promise<unknown> {
  const { rows } = await getDb().query<Record<string, unknown>>(
    `SELECT ${quoteIdentifier(field.columnName)}::text AS value FROM ${SOURCE_SQL} LIMIT 1`
  );
  return rows[0]?.value;
}
async function physicalType(field: TableField): Promise<string | undefined> {
  const rows = await TableCatalog.physicalColumns({ origin: 'custom', tableName: SOURCE_NAME });
  return rows.find((row) => row.name === field.columnName)?.dataType;
}

describe('editable table fields (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await transaction(async (tx) => {
      for (const [id, tableName] of [
        [SOURCE, SOURCE_NAME],
        [TARGET, TARGET_NAME],
      ]) {
        await TableCatalog.createCustomPhysicalTable(tableName, id, tx);
        await TableCatalog.registerCustom({ id, name: tableName, tableName }, tx);
        await TableFields.registerInitialFields(id, tx);
      }
    });
  });
  afterAll(clean);

  it('registers the Name and managed fields and creates durable named metadata with a physical column', async () => {
    const initial = await TableFields.listFields(SOURCE);
    expect(
      initial.map((field) => [field.id, field.name, field.type, field.managed, field.position])
    ).toEqual([
      [TITLE_ID, 'name', 'text', false, 0],
      [MANAGED_ID, 'id', 'uuid', true, 1],
      [MANAGED_CREATED_AT, 'created_at', 'datetime', true, 2],
    ]);
    expect(initial.map((field) => field.isTitle)).toEqual([true, false, false]);
    expect(initial[0]).toMatchObject({ nullable: false, defaultValue: '', revision: 1 });
    expect(await physicalType(initial[0])).toBe('text');
    const input = definition({
      name: 'project_notes',
      description: 'Why this exists — for agents.',
      defaultValue: "A quote: ' and a slash \\",
    });
    const { field, created } = await TableFields.createField(SOURCE, input);
    expect(created).toBe(true);
    expect(field).toMatchObject({
      ...input,
      tableId: SOURCE,
      // The field's name is its real column name.
      columnName: 'project_notes',
      position: FIRST,
      revision: 1,
      managed: false,
      isTitle: false,
    });
    await getDb().query(`INSERT INTO ${SOURCE_SQL} DEFAULT VALUES`);
    expect(await value(field)).toBe(input.defaultValue);
    expect(await value(initial[0])).toBe('');
    expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
    expect(await TableFields.createField(SOURCE, input)).toEqual({ field, created: false });
  });

  it('keeps the Name field text but lets it be renamed and edited like any field', async () => {
    const [title] = await TableFields.listFields(SOURCE);
    for (const type of ['number', 'date', 'checkbox'] as const)
      await expect(
        TableFields.updateField(SOURCE, TITLE_ID, edit(title, { type, defaultValue: null }))
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'The Name field must stay a text field.',
      });
    await expect(
      TableFields.updateField(
        SOURCE,
        TITLE_ID,
        edit(title, {
          type: 'relation',
          referenceTableId: TARGET,
          nullable: true,
          defaultValue: null,
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    const renamed = await TableFields.updateField(
      SOURCE,
      TITLE_ID,
      edit(title, { name: 'title', description: 'What the entry is called.', nullable: true })
    );
    expect(renamed).toMatchObject({
      id: TITLE_ID,
      name: 'title',
      columnName: 'title',
      nullable: true,
      isTitle: true,
      revision: 2,
      position: 0,
    });
    expect(await physicalType(renamed)).toBe('text');
    // isTitle is not part of the create/update definition, so it cannot move.
    const { field } = await TableFields.createField(SOURCE, {
      ...definition(),
      isTitle: true,
    } as CreateTableFieldRequest);
    expect(field.isTitle).toBe(false);
  });

  it('serializes concurrent create retries and duplicate names without leaving columns', async () => {
    const input = definition({ name: 'unique_name' });
    const result = await Promise.all([
      TableFields.createField(SOURCE, input),
      TableFields.createField(SOURCE, input),
    ]);
    expect(result.map((r) => r.created).sort()).toEqual([false, true]);
    expect(result[0].field).toEqual(result[1].field);
    await expect(
      TableFields.createField(SOURCE, definition({ name: 'unique_name' }))
    ).rejects.toMatchObject({ statusCode: 409 });
    // id, created_at, the row-order position, name, and exactly one created field.
    expect(
      await TableCatalog.physicalColumns({ origin: 'custom', tableName: SOURCE_NAME })
    ).toHaveLength(5);
  });

  it('renames the real column with the field, keeps its id and data, and rejects stale edits', async () => {
    const { field } = await TableFields.createField(SOURCE, definition());
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ('kept')`
    );
    const updated = await TableFields.updateField(
      SOURCE,
      field.id,
      edit(field, { name: 'renamed', description: 'Meaning of this field.' })
    );
    expect(updated).toMatchObject({
      id: field.id,
      columnName: 'renamed',
      revision: 2,
      name: 'renamed',
    });
    const columns = (
      await TableCatalog.physicalColumns({ origin: 'custom', tableName: SOURCE_NAME })
    ).map((column) => column.name);
    expect(columns).toContain('renamed');
    expect(columns).not.toContain(field.columnName);
    expect(await value(updated)).toBe('kept');
    await expect(TableFields.updateField(SOURCE, field.id, edit(field))).rejects.toMatchObject({
      statusCode: 409,
      details: { field: updated },
    });
    expect(await TableFields.updateField(SOURCE, field.id, edit(updated))).toEqual(updated);
  });

  it('makes required scalar fields with defaults and preserves exact numeric precision', async () => {
    await getDb().query(`INSERT INTO ${SOURCE_SQL} DEFAULT VALUES`);
    const decimal = '12345678901234567890.12345678901234567890';
    const { field } = await TableFields.createField(
      SOURCE,
      definition({ type: 'number', defaultValue: decimal, nullable: false })
    );
    expect(await value(field)).toBe(decimal);
    await expect(
      TableFields.createField(SOURCE, definition({ nullable: false }))
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await TableFields.listFields(SOURCE)).toHaveLength(FIRST + 1);
  });

  it.each([
    ['number', '12345678901234567890.123', 'numeric'],
    ['date', '2024-02-29', 'date'],
    ['checkbox', 'false', 'boolean'],
  ] as const)(
    'converts valid text to %s without losing its value and back to text',
    async (type, contents, sqlType) => {
      const { field } = await TableFields.createField(SOURCE, definition());
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
        [contents]
      );
      const converted = await TableFields.updateField(SOURCE, field.id, edit(field, { type }));
      expect(await physicalType(converted)).toBe(sqlType);
      expect(await value(converted)).toBe(contents);
      const text = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(converted, { type: 'text' })
      );
      expect(await value(text)).toBe(contents);
    }
  );

  it.each([
    ['number', 'NaN'],
    ['number', '1e-999999'],
    ['number', 'not a number'],
    ['date', '2025-02-29'],
    ['checkbox', 'yes'],
  ] as const)(
    'rolls back invalid text conversion to %s including metadata and defaults',
    async (type, contents) => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ defaultValue: 'initial' })
      );
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
        [contents]
      );
      await expect(
        TableFields.updateField(
          SOURCE,
          field.id,
          edit(field, { type, defaultValue: null, name: 'not_saved' })
        )
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await physicalType(field)).toBe('text');
      expect(await value(field)).toBe(contents);
      expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
      await getDb().query(`INSERT INTO ${SOURCE_SQL} DEFAULT VALUES`);
      const { rows } = await getDb().query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${SOURCE_SQL} WHERE ${quoteIdentifier(field.columnName)} = 'initial') AS present`
      );
      expect(rows[0]?.present).toBe(true);
    }
  );

  it.each(['0001-01-01 BC', '12000-01-01', 'infinity', '-infinity'])(
    'preserves unusual PostgreSQL date %s when converting to text',
    async (contents) => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'date' }));
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1::date)`,
        [contents]
      );
      const converted = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'text' })
      );
      expect(await value(converted)).toBe(contents);
    }
  );

  it('only commits one of two concurrent edits of the same revision', async () => {
    const { field } = await TableFields.createField(SOURCE, definition());
    const results = await Promise.allSettled([
      TableFields.updateField(SOURCE, field.id, edit(field, { name: 'first' })),
      TableFields.updateField(SOURCE, field.id, edit(field, { name: 'second' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure).toMatchObject({ reason: { statusCode: 409 } });
    expect((await TableFields.listFields(SOURCE))[FIRST].revision).toBe(2);
  });

  it('rolls back a rename and type conversion when the new name is taken', async () => {
    await TableFields.createField(SOURCE, definition({ name: 'taken_name' }));
    const { field } = await TableFields.createField(SOURCE, definition());
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ('12.34')`
    );
    await expect(
      TableFields.updateField(SOURCE, field.id, edit(field, { name: 'taken_name', type: 'number' }))
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await physicalType(field)).toBe('text');
    expect(await value(field)).toBe('12.34');
    expect((await TableFields.listFields(SOURCE))[FIRST + 1]).toEqual(field);
  });

  it('refuses numbers beyond PostgreSQL numeric precision without rounding or saving metadata', async () => {
    const { field } = await TableFields.createField(SOURCE, definition());
    const decimal = `0.${'0'.repeat(17000)}1`;
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
      [decimal]
    );
    await expect(
      TableFields.updateField(SOURCE, field.id, edit(field, { type: 'number' }))
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await physicalType(field)).toBe('text');
    expect(await value(field)).toBe(decimal);
    expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
  });

  it('refuses dependent-view type changes with an actionable conflict and preserves the view', async () => {
    const { field } = await TableFields.createField(SOURCE, definition());
    await getDb().query(
      `CREATE VIEW user_tables.field_dependency_test AS SELECT ${quoteIdentifier(field.columnName)} FROM ${SOURCE_SQL}`
    );
    try {
      await expect(
        TableFields.updateField(SOURCE, field.id, edit(field, { type: 'number' }))
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await physicalType(field)).toBe('text');
      expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
      await getDb().query('SELECT * FROM user_tables.field_dependency_test');
    } finally {
      await getDb().query('DROP VIEW IF EXISTS user_tables.field_dependency_test');
    }
  });

  describe('making a field required', () => {
    const EMPTY_ROW = ROW_ID;
    const FILLED_ROW = '22222222-2222-4222-8222-222222222222';
    /** One entry with the field empty and one holding `filled`. */
    async function seed(field: TableField, filled: string): Promise<void> {
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(field.columnName)}) VALUES ($1, NULL), ($2, $3)`,
        [EMPTY_ROW, FILLED_ROW, filled]
      );
    }
    /** The field's API value and each entry's revision, by entry id. */
    async function entries(field: TableField) {
      const { entries: listed } = await TableEntries.listEntries(SOURCE);
      return Object.fromEntries(
        listed.map((entry) => [entry.id, { value: entry.values[field.id], rev: entry.revision }])
      );
    }
    async function nullable(field: TableField): Promise<boolean | undefined> {
      const rows = await TableCatalog.physicalColumns({ origin: 'custom', tableName: SOURCE_NAME });
      return rows.find((row) => row.name === field.columnName)?.nullable;
    }

    it('fills only the empty values from the new default and bumps their revisions', async () => {
      const { field } = await TableFields.createField(SOURCE, definition());
      await seed(field, 'kept');
      const before = await entries(field);
      const required = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { nullable: false, defaultValue: 'x' })
      );
      expect(required).toMatchObject({ nullable: false, defaultValue: 'x', revision: 2 });
      expect(await nullable(required)).toBe(false);
      const after = await entries(required);
      expect(after[EMPTY_ROW]?.value).toBe('x');
      expect(after[FILLED_ROW]?.value).toBe('kept');
      expect(after[EMPTY_ROW]?.rev).not.toBe(before[EMPTY_ROW]?.rev);
    });

    it('converts text to a required checkbox, filling empty values after the conversion', async () => {
      const { field } = await TableFields.createField(SOURCE, definition());
      await seed(field, 'true');
      const before = await entries(field);
      const checkbox = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'checkbox', nullable: false, defaultValue: false })
      );
      expect(checkbox).toMatchObject({ type: 'checkbox', nullable: false, defaultValue: false });
      expect(await physicalType(checkbox)).toBe('boolean');
      expect(await nullable(checkbox)).toBe(false);
      const after = await entries(checkbox);
      expect(after[EMPTY_ROW]?.value).toBe(false);
      expect(after[FILLED_ROW]?.value).toBe(true);
      expect(after[EMPTY_ROW]?.rev).not.toBe(before[EMPTY_ROW]?.rev);
    });

    it('fills a number field made required with its default', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'number' }));
      await seed(field, '12.50');
      const required = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { nullable: false, defaultValue: '0' })
      );
      expect(await nullable(required)).toBe(false);
      const after = await entries(required);
      expect(after[EMPTY_ROW]?.value).toBe('0');
      expect(after[FILLED_ROW]?.value).toBe('12.50');
    });

    it('still refuses a required edit without a default while values are empty', async () => {
      const { field } = await TableFields.createField(SOURCE, definition());
      await seed(field, 'true');
      for (const patch of [{ nullable: false }, { type: 'checkbox' as const, nullable: false }])
        await expect(
          TableFields.updateField(SOURCE, field.id, edit(field, patch))
        ).rejects.toMatchObject({
          statusCode: 409,
          message:
            'Existing rows have empty values. Keep this field optional or fill those values first.',
        });
      expect(await nullable(field)).toBe(true);
      expect(await physicalType(field)).toBe('text');
      expect((await entries(field))[EMPTY_ROW]?.value).toBeNull();
      expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
    });

    it('fills an emptied list converted to a required text field', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'relation', referenceTableId: TARGET, multiple: true })
      );
      await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1)`, [EMPTY_ROW]);
      const text = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, {
          type: 'text',
          referenceTableId: null,
          multiple: false,
          nullable: false,
          defaultValue: 'none',
        })
      );
      expect(text).toMatchObject({ type: 'text', multiple: false, nullable: false });
      expect(await nullable(text)).toBe(false);
      expect((await entries(text))[EMPTY_ROW]?.value).toBe('none');
    });
  });

  it('creates real nullable relation FKs, rejects missing targets, and sets null on row deletion', async () => {
    const { field } = await TableFields.createField(
      SOURCE,
      definition({ type: 'relation', referenceTableId: TARGET })
    );
    await expect(
      getDb().query(
        `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
        [ROW_ID]
      )
    ).rejects.toMatchObject({ code: '23503' });
    await getDb().query(`INSERT INTO ${TARGET_SQL} (id) VALUES ($1)`, [ROW_ID]);
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
      [ROW_ID]
    );
    expect(await value(field)).toBe(ROW_ID);
    await expect(
      TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'text', referenceTableId: null })
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await getDb().query(`DELETE FROM ${TARGET_SQL} WHERE id = $1`, [ROW_ID]);
    expect(await value(field)).toBeNull();
    const converted = await TableFields.updateField(
      SOURCE,
      field.id,
      edit(field, { type: 'text', referenceTableId: null })
    );
    expect(await physicalType(converted)).toBe('text');
    expect(await value(converted)).toBeNull();
  });

  it('supports self relations and simultaneous opposing relations without deadlocks', async () => {
    const [left, right] = await Promise.all([
      TableFields.createField(SOURCE, definition({ type: 'relation', referenceTableId: TARGET })),
      TableFields.createField(TARGET, definition({ type: 'relation', referenceTableId: SOURCE })),
    ]);
    expect(left.field.referenceTableId).toBe(TARGET);
    expect(right.field.referenceTableId).toBe(SOURCE);
    const self = await TableFields.createField(
      SOURCE,
      definition({ type: 'relation', referenceTableId: SOURCE })
    );
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(self.field.columnName)}) VALUES ($1, $1)`,
      [ROW_ID]
    );
    expect(await value(self.field)).toBe(ROW_ID);
  });

  it('only changes relation targets when all existing links are empty', async () => {
    const { field } = await TableFields.createField(
      SOURCE,
      definition({ type: 'relation', referenceTableId: TARGET })
    );
    await getDb().query(`INSERT INTO ${TARGET_SQL} (id) VALUES ($1)`, [ROW_ID]);
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
      [ROW_ID]
    );
    await expect(
      TableFields.updateField(SOURCE, field.id, edit(field, { referenceTableId: SOURCE }))
    ).rejects.toMatchObject({ statusCode: 409 });
    await getDb().query(`UPDATE ${SOURCE_SQL} SET ${quoteIdentifier(field.columnName)} = NULL`);
    const changed = await TableFields.updateField(
      SOURCE,
      field.id,
      edit(field, { referenceTableId: SOURCE })
    );
    expect(changed.referenceTableId).toBe(SOURCE);
  });

  it('renames a relation column while its foreign key keeps the field-id name', async () => {
    const { field } = await TableFields.createField(
      SOURCE,
      definition({ type: 'relation', referenceTableId: TARGET })
    );
    await getDb().query(`INSERT INTO ${TARGET_SQL} (id) VALUES ($1)`, [ROW_ID]);
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (${quoteIdentifier(field.columnName)}) VALUES ($1)`,
      [ROW_ID]
    );
    const renamed = await TableFields.updateField(
      SOURCE,
      field.id,
      edit(field, { name: 'linked_target' })
    );
    expect(renamed).toMatchObject({ id: field.id, columnName: 'linked_target' });
    expect(await value(renamed)).toBe(ROW_ID);
    const { rows } = await getDb().query<{ conname: string; column: string }>(
      `SELECT con.conname, att.attname AS column
         FROM pg_constraint con
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        WHERE con.conrelid = $1::regclass AND con.contype = 'f'`,
      [SOURCE_SQL]
    );
    expect(rows).toEqual([
      { conname: `fk_${field.id.replace(/-/g, '_')}`, column: 'linked_target' },
    ]);
  });

  it('allows empty scalar fields to become relations', async () => {
    const { field } = await TableFields.createField(SOURCE, definition({ type: 'number' }));
    await getDb().query(`INSERT INTO ${SOURCE_SQL} DEFAULT VALUES`);
    const relation = await TableFields.updateField(
      SOURCE,
      field.id,
      edit(field, { type: 'relation', referenceTableId: TARGET })
    );
    expect(await physicalType(relation)).toBe('uuid');
    expect(await value(relation)).toBeNull();
  });

  it('refuses builtins, managed edits, non-null relations, and cross-table field IDs', async () => {
    await expect(TableFields.createField('table-builtin-docs', definition())).rejects.toMatchObject(
      { statusCode: 403 }
    );
    await expect(
      TableFields.createField(
        SOURCE,
        definition({ type: 'relation', referenceTableId: 'table-builtin-docs' })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      TableFields.createField(
        SOURCE,
        definition({ type: 'relation', referenceTableId: TARGET, nullable: false })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    const managed = (await TableFields.listFields(SOURCE))[1];
    await expect(
      TableFields.updateField(SOURCE, managed.id, { ...definition(), expectedRevision: 1 })
    ).rejects.toMatchObject({ statusCode: 403 });
    const { field } = await TableFields.createField(TARGET, definition());
    await expect(TableFields.updateField(SOURCE, field.id, edit(field))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it.each(['type', 'default', 'nullable'] as const)(
    'detects external %s schema drift before overwriting it',
    async (change) => {
      const { field } = await TableFields.createField(SOURCE, definition());
      const action =
        change === 'type'
          ? 'TYPE varchar(10)'
          : change === 'default'
            ? "SET DEFAULT 'external'"
            : 'SET NOT NULL';
      await getDb().query(
        `ALTER TABLE ${SOURCE_SQL} ALTER COLUMN ${quoteIdentifier(field.columnName)} ${action}`
      );
      await expect(
        TableFields.updateField(SOURCE, field.id, edit(field, { description: 'Not Saved' }))
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
    }
  );

  it('detects a missing relation constraint and leaves metadata unchanged', async () => {
    const { field } = await TableFields.createField(
      SOURCE,
      definition({ type: 'relation', referenceTableId: TARGET })
    );
    await getDb().query(
      `ALTER TABLE ${SOURCE_SQL} DROP CONSTRAINT ${quoteIdentifier(`fk_${field.id.replace(/-/g, '_')}`)}`
    );
    await expect(
      TableFields.updateField(SOURCE, field.id, edit(field, { description: 'Not Saved' }))
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reorders every field, managed included, without bumping revisions', async () => {
    const first = (await TableFields.createField(SOURCE, definition())).field;
    const second = (await TableFields.createField(SOURCE, definition())).field;
    const before = await TableFields.listFields(SOURCE);
    const ids = before.map((field) => field.id);
    expect(ids).toEqual([TITLE_ID, MANAGED_ID, MANAGED_CREATED_AT, first.id, second.id]);
    const next = [second.id, MANAGED_CREATED_AT, first.id, TITLE_ID, MANAGED_ID];
    const reordered = await TableFields.reorderFields(SOURCE, next);
    expect(reordered.map((field) => [field.id, field.position])).toEqual(
      next.map((id, index) => [id, index])
    );
    expect(reordered.map((field) => field.revision).sort()).toEqual(
      before.map((field) => field.revision).sort()
    );
    const third = (await TableFields.createField(SOURCE, definition())).field;
    expect(third.position).toBe(next.length);
    expect((await TableFields.listFields(SOURCE)).at(-1)?.id).toBe(third.id);
  });

  it('refuses reorders that are not an exact permutation or target builtins', async () => {
    const field = (await TableFields.createField(SOURCE, definition())).field;
    const ids = (await TableFields.listFields(SOURCE)).map((item) => item.id);
    for (const bad of [
      ids.slice(1),
      [...ids, 'field-1111111111111-missing'],
      [ids[0], ...ids.slice(0, -1)],
    ]) {
      await expect(TableFields.reorderFields(SOURCE, bad)).rejects.toMatchObject({
        statusCode: expect.any(Number),
      });
    }
    await expect(
      TableFields.reorderFields(SOURCE, [...ids.slice(0, -1), 'field-1111111111111-other'])
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(TableFields.reorderFields('table-builtin-docs', [])).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await TableFields.listFields(SOURCE)).map((item) => item.id)).toEqual(ids);
    expect(field.position).toBe(FIRST);
  });

  it('inserts a field at an interior slot, shifting later fields without schema churn', async () => {
    const first = (await TableFields.createField(SOURCE, definition())).field;
    const second = (await TableFields.createField(SOURCE, definition())).field;
    const input = definition({ beforeFieldId: first.id });
    const placed = await TableFields.createField(SOURCE, input);
    expect(placed).toMatchObject({
      created: true,
      field: { id: input.id, position: FIRST, revision: 1 },
    });
    expect(placed.field).not.toHaveProperty('beforeFieldId');
    const fields = await TableFields.listFields(SOURCE);
    expect(fields.map((field) => [field.id, field.position])).toEqual(
      [TITLE_ID, MANAGED_ID, MANAGED_CREATED_AT, input.id, first.id, second.id].map((id, index) => [
        id,
        index,
      ])
    );
    // Positions persist, and shifted fields keep every other attribute.
    expect(fields[FIRST]).toEqual(placed.field);
    expect(fields[FIRST + 1]).toEqual({ ...first, position: FIRST + 1 });
    expect(fields[FIRST + 2]).toEqual({ ...second, position: FIRST + 2 });
    // The entry schema version matches the same field set in append order.
    const placedVersion = (await TableEntries.listEntries(SOURCE)).schemaVersion;
    await TableFields.reorderFields(SOURCE, [
      TITLE_ID,
      MANAGED_ID,
      MANAGED_CREATED_AT,
      first.id,
      second.id,
      input.id,
    ]);
    expect((await TableEntries.listEntries(SOURCE)).schemaVersion).toBe(placedVersion);
    const appended = (await TableFields.createField(SOURCE, definition())).field;
    expect(appended.position).toBe(FIRST + 3);
    expect((await TableFields.listFields(SOURCE)).at(-1)).toEqual(appended);
  });

  it('inserts before a managed field and skips placement on exact replays', async () => {
    const input = definition({ beforeFieldId: MANAGED_ID });
    const { field } = await TableFields.createField(SOURCE, input);
    expect(field.position).toBe(1);
    const expected = [TITLE_ID, input.id, MANAGED_ID, MANAGED_CREATED_AT].map((id, index) => [
      id,
      index,
    ]);
    const read = async () =>
      (await TableFields.listFields(SOURCE)).map((item) => [item.id, item.position]);
    expect(await read()).toEqual(expected);
    for (const beforeFieldId of [
      MANAGED_ID,
      MANAGED_CREATED_AT,
      'field-1111111111111-missing',
      undefined,
    ]) {
      expect(await TableFields.createField(SOURCE, { ...input, beforeFieldId })).toEqual({
        field,
        created: false,
      });
    }
    expect(await read()).toEqual(expected);
  });

  it('refuses a missing, own or other-table beforeFieldId before any schema change', async () => {
    const other = (await TableFields.createField(TARGET, definition())).field;
    const fields = await TableFields.listFields(SOURCE);
    const columns = await TableCatalog.physicalColumns({
      origin: 'custom',
      tableName: SOURCE_NAME,
    });
    const self = definition();
    for (const input of [
      definition({ beforeFieldId: 'field-1111111111111-missing' }),
      definition({ beforeFieldId: other.id }),
      definition({ beforeFieldId: `field-managed-${TARGET}-id` }),
      { ...self, beforeFieldId: self.id },
    ]) {
      await expect(TableFields.createField(SOURCE, input)).rejects.toMatchObject({
        statusCode: 400,
        message: 'The field to insert before no longer exists.',
      });
    }
    expect(await TableFields.listFields(SOURCE)).toEqual(fields);
    expect(
      await TableCatalog.physicalColumns({ origin: 'custom', tableName: SOURCE_NAME })
    ).toEqual(columns);
  });

  it('keeps positions contiguous across concurrent inserts and appends', async () => {
    const anchor = (await TableFields.createField(SOURCE, definition())).field;
    const left = definition({ beforeFieldId: anchor.id });
    const right = definition({ beforeFieldId: anchor.id });
    const tail = definition();
    const results = await Promise.all(
      [left, right, tail].map((input) => TableFields.createField(SOURCE, input))
    );
    expect(results.map((result) => result.created)).toEqual([true, true, true]);
    const fields = await TableFields.listFields(SOURCE);
    expect(fields.map((field) => field.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const ids = fields.map((field) => field.id);
    expect(ids.slice(0, FIRST)).toEqual([TITLE_ID, MANAGED_ID, MANAGED_CREATED_AT]);
    expect([...ids.slice(FIRST, FIRST + 2)].sort()).toEqual([left.id, right.id].sort());
    expect(ids.slice(FIRST + 2)).toEqual([anchor.id, tail.id]);
  });

  it('toggles collapsed on custom and managed fields without revision or schema churn', async () => {
    const { field } = await TableFields.createField(SOURCE, definition());
    const fields = await TableFields.listFields(SOURCE);
    expect(fields.map((item) => item.collapsed)).toEqual([false, false, false, false]);
    const version = (await TableEntries.listEntries(SOURCE)).schemaVersion;

    const on = await TableFields.setFieldCollapsed(SOURCE, field.id, true);
    expect(on).toEqual({ field: { ...field, collapsed: true }, changed: true });
    expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(on.field);
    expect(await TableFields.setFieldCollapsed(SOURCE, field.id, true)).toEqual({
      field: on.field,
      changed: false,
    });
    const managed = await TableFields.setFieldCollapsed(SOURCE, MANAGED_CREATED_AT, true);
    expect(managed).toEqual({ field: { ...fields[2], collapsed: true }, changed: true });

    // An entry write holding the pre-toggle version still succeeds.
    expect((await TableEntries.listEntries(SOURCE)).schemaVersion).toBe(version);
    const entry = await TableEntries.createEntry(SOURCE, {
      id: ROW_ID,
      values: {},
      schemaVersion: version,
    });
    expect(entry.created).toBe(true);

    const off = await TableFields.setFieldCollapsed(SOURCE, field.id, false);
    expect(off).toEqual({ field, changed: true });
    expect(await TableFields.listFields(SOURCE)).toEqual([
      fields[0],
      fields[1],
      { ...fields[2], collapsed: true },
      field,
    ]);
  });

  it('keeps collapsed columns through reorders and placed creates', async () => {
    const first = (await TableFields.createField(SOURCE, definition())).field;
    const second = (await TableFields.createField(SOURCE, definition())).field;
    await TableFields.setFieldCollapsed(SOURCE, first.id, true);
    await TableFields.setFieldCollapsed(SOURCE, MANAGED_ID, true);
    await TableFields.reorderFields(SOURCE, [
      second.id,
      first.id,
      TITLE_ID,
      MANAGED_CREATED_AT,
      MANAGED_ID,
    ]);
    const placed = await TableFields.createField(SOURCE, definition({ beforeFieldId: first.id }));
    expect(placed.field).toMatchObject({ position: 1, collapsed: false });
    expect(
      (await TableFields.listFields(SOURCE)).map((field) => [field.id, field.collapsed])
    ).toEqual([
      [second.id, false],
      [placed.field.id, false],
      [first.id, true],
      [TITLE_ID, false],
      [MANAGED_CREATED_AT, false],
      [MANAGED_ID, true],
    ]);
  });

  it('sets widths as a view preference that reorders, collapse toggles and updates keep', async () => {
    const first = (await TableFields.createField(SOURCE, definition())).field;
    const second = (await TableFields.createField(SOURCE, definition())).field;
    const version = (await TableEntries.listEntries(SOURCE)).schemaVersion;
    expect(await TableFields.setFieldView(SOURCE, first.id, { width: 320 })).toEqual({
      field: { ...first, width: 320 },
      changed: true,
    });
    expect(await TableFields.setFieldView(SOURCE, first.id, { width: 320 })).toEqual({
      field: { ...first, width: 320 },
      changed: false,
    });
    await TableFields.setFieldView(SOURCE, MANAGED_ID, { width: 96 });
    await TableFields.setFieldCollapsed(SOURCE, first.id, true);
    await TableFields.reorderFields(SOURCE, [
      second.id,
      first.id,
      TITLE_ID,
      MANAGED_CREATED_AT,
      MANAGED_ID,
    ]);
    // Widths, like collapsing and order, are left out of the entry schema version.
    expect((await TableEntries.listEntries(SOURCE)).schemaVersion).toBe(version);
    const { id: _id, ...rename } = definition({ name: 'renamed_width_field' });
    const updated = await TableFields.updateField(SOURCE, first.id, {
      ...rename,
      expectedRevision: first.revision,
    });
    expect(updated).toMatchObject({ collapsed: true, width: 320, revision: first.revision + 1 });
    expect(
      (await TableFields.listFields(SOURCE)).map((field) => [field.id, field.width ?? null])
    ).toEqual([
      [second.id, null],
      [first.id, 320],
      [TITLE_ID, null],
      [MANAGED_CREATED_AT, null],
      [MANAGED_ID, 96],
    ]);
    await expect(TableFields.setFieldView(SOURCE, first.id, { width: 63 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(TableFields.setFieldView(SOURCE, first.id, {})).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      TableFields.setFieldView('table-builtin-docs', first.id, { width: 200 })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses collapse toggles for unknown fields, other tables and builtins', async () => {
    const other = (await TableFields.createField(TARGET, definition())).field;
    for (const [tableId, fieldId, statusCode] of [
      [SOURCE, 'field-1111111111111-missing', 404],
      [SOURCE, other.id, 404],
      [SOURCE, `field-managed-${TARGET}-id`, 404],
      ['table-1111111111111-missing', other.id, 404],
      ['table-builtin-docs', other.id, 403],
    ] as const) {
      await expect(TableFields.setFieldCollapsed(tableId, fieldId, true)).rejects.toMatchObject({
        statusCode,
      });
    }
    await expect(
      TableFields.setFieldCollapsed(SOURCE, MANAGED_ID, 'true' as unknown as boolean)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await TableFields.listFields(TARGET)).map((field) => field.collapsed)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect((await TableFields.listFields(SOURCE)).map((field) => field.collapsed)).toEqual([
      false,
      false,
      false,
    ]);
  });

  describe('multiple relations', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const underscored = (id: string) => id.replace(/-/g, '_');
    async function column(field: TableField) {
      const { rows } = await getDb().query<{
        type: string;
        nullable: boolean;
        default_expression: string | null;
      }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_expression
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1::regclass AND a.attname = $2`,
        [SOURCE_SQL, field.columnName]
      );
      const { rows: index } = await getDb().query<{ method: string }>(
        `SELECT am.amname AS method FROM pg_class i JOIN pg_am am ON am.oid = i.relam
           JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = 'user_tables' AND i.relname = $1`,
        [`${underscored(field.id)}_links_idx`]
      );
      const { rows: keys } = await getDb().query(
        "SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f' AND conname = $2",
        [SOURCE_SQL, `fk_${underscored(field.id)}`]
      );
      return { ...rows[0], index: index[0]?.method ?? null, foreignKey: keys.length > 0 };
    }
    async function linksOf(field: TableField): Promise<unknown[]> {
      const { rows } = await getDb().query<{ value: unknown }>(
        `SELECT to_json(${quoteIdentifier(field.columnName)}) AS value FROM ${SOURCE_SQL} ORDER BY id`
      );
      return rows.map((row) => row.value);
    }
    const list = { type: 'uuid[]', nullable: false, default_expression: "'{}'::uuid[]" };

    it('creates an indexed uuid[] list without a foreign key, normalizing empty forms', async () => {
      const input = definition({ type: 'relation', referenceTableId: TARGET, multiple: true });
      const { field, created } = await TableFields.createField(SOURCE, input);
      expect(created).toBe(true);
      expect(field).toMatchObject({
        type: 'relation',
        referenceTableId: TARGET,
        multiple: true,
        nullable: false,
        defaultValue: [],
      });
      expect(await column(field)).toEqual({ ...list, index: 'gin', foreignKey: false });
      await getDb().query(`INSERT INTO ${SOURCE_SQL} DEFAULT VALUES`);
      expect(await linksOf(field)).toEqual([[]]);
      // Replays match in either empty form; a different multiplicity is a conflict.
      expect(await TableFields.createField(SOURCE, input)).toEqual({ field, created: false });
      expect(
        await TableFields.createField(SOURCE, { ...input, nullable: false, defaultValue: [] })
      ).toEqual({ field, created: false });
      await expect(
        TableFields.createField(SOURCE, { ...input, multiple: false })
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        TableFields.createField(SOURCE, definition({ multiple: true }))
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('turns a single relation into a list, keeping each link', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'relation', referenceTableId: TARGET })
      );
      await getDb().query(`INSERT INTO ${TARGET_SQL} (id) VALUES ($1)`, [uuid(11)]);
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(field.columnName)}) VALUES ($1, $2), ($3, NULL)`,
        [uuid(1), uuid(11), uuid(2)]
      );
      const listed = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { multiple: true })
      );
      expect(listed).toMatchObject({
        multiple: true,
        nullable: false,
        defaultValue: [],
        revision: 2,
      });
      expect(await column(listed)).toEqual({ ...list, index: 'gin', foreignKey: false });
      expect(await linksOf(listed)).toEqual([[uuid(11)], []]);
    });

    it('turns a list back into a single relation only with at most one existing link each', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'relation', referenceTableId: TARGET, multiple: true })
      );
      await getDb().query(`INSERT INTO ${TARGET_SQL} (id) VALUES ($1), ($2)`, [uuid(11), uuid(12)]);
      const links = quoteIdentifier(field.columnName);
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, ${links}) VALUES ($1, $2), ($3, '{}'), ($4, $5)`,
        [uuid(1), [uuid(11)], uuid(2), uuid(3), [uuid(11), uuid(12)]]
      );
      const single = () =>
        TableFields.updateField(
          SOURCE,
          field.id,
          edit(field, { multiple: false, nullable: true, defaultValue: null })
        );
      await expect(single()).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('link to more than one entry'),
      });
      // A dangling id (possible only through raw SQL) would block the foreign key.
      await getDb().query(`UPDATE ${SOURCE_SQL} SET ${links} = $2 WHERE id = $1`, [
        uuid(3),
        [uuid(99)],
      ]);
      await expect(single()).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('no longer exist'),
      });
      expect((await TableFields.listFields(SOURCE)).find((item) => item.id === field.id)).toEqual(
        field
      );
      await getDb().query(`UPDATE ${SOURCE_SQL} SET ${links} = $2 WHERE id = $1`, [
        uuid(3),
        [uuid(12)],
      ]);
      const converted = await single();
      expect(converted).toMatchObject({ multiple: false, nullable: true, defaultValue: null });
      expect(await column(converted)).toEqual({
        type: 'uuid',
        nullable: true,
        default_expression: null,
        index: null,
        foreignKey: true,
      });
      expect(await linksOf(converted)).toEqual([uuid(11), null, uuid(12)]);
    });

    it('keeps a list when an update leaves multiple out, and retargets it only while empty', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'relation', referenceTableId: TARGET, multiple: true })
      );
      // A caller that omits the flag, sending the single-relation empty forms.
      const described = await TableFields.updateField(SOURCE, field.id, {
        ...edit(field, { description: 'Linked targets.' }),
        nullable: true,
        defaultValue: null,
      });
      expect(described).toMatchObject({ multiple: true, nullable: false, revision: 2 });
      const retargeted = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(described, { referenceTableId: SOURCE })
      );
      expect(retargeted).toMatchObject({ multiple: true, referenceTableId: SOURCE });
      expect(await column(retargeted)).toEqual({ ...list, index: 'gin', foreignKey: false });
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(field.columnName)}) VALUES ($1, $2)`,
        [uuid(1), [uuid(1)]]
      );
      const toText = {
        type: 'text' as const,
        referenceTableId: null,
        multiple: false,
        defaultValue: null,
        nullable: true,
      };
      for (const patch of [{ referenceTableId: TARGET }, toText])
        await expect(
          TableFields.updateField(SOURCE, field.id, edit(retargeted, patch))
        ).rejects.toMatchObject({
          statusCode: 409,
          message: 'Clear the existing relation values before changing this field type or target.',
        });
      await getDb().query(`DELETE FROM ${SOURCE_SQL}`);
      const text = await TableFields.updateField(SOURCE, field.id, edit(retargeted, toText));
      expect(await column(text)).toEqual({
        type: 'text',
        nullable: true,
        default_expression: null,
        index: null,
        foreignKey: false,
      });
    });
  });

  describe('date and time fields', () => {
    /** The user's zone for these tests: neither UTC nor the machine running them. */
    const ZONE = 'Pacific/Auckland';
    const ROWS = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000007',
    ];
    beforeEach(() => {
      const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
        this: Intl.DateTimeFormat
      ) {
        return { ...resolved.call(this), timeZone: ZONE };
      });
    });
    afterEach(() => jest.restoreAllMocks());

    /** One entry per value, in order, stored through `cast`. */
    async function seed(field: TableField, values: string[], cast = ''): Promise<void> {
      for (const [index, contents] of values.entries())
        await getDb().query(
          `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(field.columnName)}) VALUES ($1, $2${cast})`,
          [ROWS[index], contents]
        );
    }
    /** Each entry's value as text, in seed order; datetimes as UTC ISO. */
    async function values(field: TableField): Promise<unknown[]> {
      const column = quoteIdentifier(field.columnName);
      const { rows } = await getDb().query<{ value: string | null }>(
        `SELECT ${
          field.type === 'datetime'
            ? `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
            : `${column}::text`
        } AS value FROM ${SOURCE_SQL} ORDER BY id`
      );
      return rows.map((row) => row.value);
    }

    it('creates a datetime column whose offset-less default is read in the user zone', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'datetime', defaultValue: '2026-10-01T15:30' })
      );
      expect(field).toMatchObject({
        type: 'datetime',
        managed: false,
        defaultValue: '2026-10-01T02:30:00.000000Z',
      });
      expect(await physicalType(field)).toBe('timestamp with time zone');
      await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1)`, [ROWS[0]]);
      expect(await values(field)).toEqual(['2026-10-01T02:30:00.000000Z']);
      // The exact retry matches the stored default; the recorded default
      // expression survives the drift checks of later edits and entry reads.
      expect(
        await TableFields.createField(SOURCE, {
          ...definition({ type: 'datetime', defaultValue: '2026-10-01T15:30' }),
          id: field.id,
          name: field.name,
        })
      ).toEqual({ field, created: false });
      const described = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { description: 'When it is due.' })
      );
      expect(described.revision).toBe(2);
      const { entries } = await TableEntries.listEntries(SOURCE);
      expect(entries[0]?.values[field.id]).toBe('2026-10-01T02:30:00.000000Z');
      await expect(
        TableFields.createField(
          SOURCE,
          definition({ type: 'datetime', defaultValue: '2026-10-01 3:30 PM' })
        )
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('turns dates into midnight in the user zone and back into the same dates', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', defaultValue: '2026-01-31' })
      );
      await seed(field, ['2026-10-01', '2026-07-01', '2024-02-29'], '::date');
      const datetime = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'datetime' })
      );
      expect(datetime).toMatchObject({
        type: 'datetime',
        // Auckland is +13:00 in summer and +12:00 in winter.
        defaultValue: '2026-01-30T11:00:00.000000Z',
      });
      expect(await physicalType(datetime)).toBe('timestamp with time zone');
      expect(await values(datetime)).toEqual([
        '2026-09-30T11:00:00.000000Z',
        '2026-06-30T12:00:00.000000Z',
        '2024-02-28T11:00:00.000000Z',
      ]);
      const date = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(datetime, { type: 'date', defaultValue: '2026-01-31' })
      );
      expect(await physicalType(date)).toBe('date');
      expect(await values(date)).toEqual(['2026-10-01', '2026-07-01', '2024-02-29']);
    });

    it('keeps the user-zone calendar date when a time is dropped', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'datetime' }));
      // 20:00Z is already the next morning in Auckland; 10:00Z is the same day.
      await seed(field, ['2026-10-01T20:00:00Z', '2026-10-01T10:00:00Z'], '::timestamptz');
      const date = await TableFields.updateField(SOURCE, field.id, edit(field, { type: 'date' }));
      expect(await values(date)).toEqual(['2026-10-02', '2026-10-01']);
    });

    it('refuses infinite and out-of-range dates instead of converting them', async () => {
      for (const contents of ['infinity', '0001-01-01 BC']) {
        const { field } = await TableFields.createField(SOURCE, definition({ type: 'date' }));
        await getDb().query(`DELETE FROM ${SOURCE_SQL}`);
        await seed(field, [contents], '::date');
        await expect(
          TableFields.updateField(SOURCE, field.id, edit(field, { type: 'datetime' }))
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await physicalType(field)).toBe('date');
      }
    });

    it('converts ISO 8601 text to datetimes, reading offset-less values in the user zone', async () => {
      const { field } = await TableFields.createField(SOURCE, definition());
      await seed(field, [
        '2026-10-01T15:30',
        '2026-10-01T22:30:00Z',
        '2026-10-01 15:30:00+05:30',
        '2026-10-01T15:30-0700',
        '2026-10-01T15:30+13',
        '2026-10-01',
        '2026-10-01T15:30:00.123456Z',
      ]);
      const datetime = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { type: 'datetime' })
      );
      expect(await values(datetime)).toEqual([
        '2026-10-01T02:30:00.000000Z',
        '2026-10-01T22:30:00.000000Z',
        '2026-10-01T10:00:00.000000Z',
        '2026-10-01T22:30:00.000000Z',
        '2026-10-01T02:30:00.000000Z',
        '2026-09-30T11:00:00.000000Z',
        '2026-10-01T15:30:00.123456Z',
      ]);
    });

    it.each(['2026-10-01T15:30 PST', '10/01/2026', '2026-10-01T25:00', '2026-02-30T10:00'])(
      'refuses text holding %s without changing the field',
      async (contents) => {
        const { field } = await TableFields.createField(SOURCE, definition());
        await seed(field, ['2026-10-01T15:30', contents]);
        await expect(
          TableFields.updateField(SOURCE, field.id, edit(field, { type: 'datetime' }))
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await physicalType(field)).toBe('text');
        expect(await values(field)).toEqual(['2026-10-01T15:30', contents]);
        expect((await TableFields.listFields(SOURCE))[FIRST]).toEqual(field);
      }
    );

    it('writes datetimes as user-zone ISO text with the offset, which converts back exactly', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'datetime' }));
      const instants = [
        '2026-10-01T02:30:00.000000Z',
        '2026-07-01T03:30:00.500000Z',
        '2026-10-01T15:30:00.123456Z',
      ];
      await seed(field, instants, '::timestamptz');
      const text = await TableFields.updateField(SOURCE, field.id, edit(field, { type: 'text' }));
      expect(await values(text)).toEqual([
        '2026-10-01T15:30:00+13:00',
        '2026-07-01T15:30:00.5+12:00',
        '2026-10-02T04:30:00.123456+13:00',
      ]);
      const back = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(text, { type: 'datetime' })
      );
      expect(await values(back)).toEqual(instants);
    });

    it('fills empty values from the default when a datetime becomes required', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'datetime' }));
      await seed(field, ['2026-10-01T02:30:00Z'], '::timestamptz');
      await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1)`, [ROWS[1]]);
      const required = await TableFields.updateField(
        SOURCE,
        field.id,
        edit(field, { nullable: false, defaultValue: '2026-12-25T09:00' })
      );
      expect(required).toMatchObject({
        nullable: false,
        defaultValue: '2026-12-24T20:00:00.000000Z',
      });
      expect(await values(required)).toEqual([
        '2026-10-01T02:30:00.000000Z',
        '2026-12-24T20:00:00.000000Z',
      ]);
    });

    it('keeps the managed created_at read-only', async () => {
      const createdAt = (await TableFields.listFields(SOURCE))[2];
      expect(createdAt).toMatchObject({ name: 'created_at', type: 'datetime', managed: true });
      await expect(
        TableFields.updateField(SOURCE, MANAGED_CREATED_AT, {
          ...definition({ type: 'datetime', name: 'created_at_renamed' }),
          expectedRevision: 1,
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('date ranges', () => {
    /** The user's zone: neither UTC nor the machine; DST starts on 27 September 2026. */
    const ZONE = 'Pacific/Auckland';
    const ROWS = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ];
    beforeEach(() => {
      const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
        this: Intl.DateTimeFormat
      ) {
        return { ...resolved.call(this), timeZone: ZONE };
      });
    });
    afterEach(() => jest.restoreAllMocks());

    /** One entry per value, in ROWS order, written through the entry API (null = empty). */
    async function write(field: TableField, values: Array<string | null>): Promise<void> {
      for (const [index, contents] of values.entries()) {
        const { schemaVersion } = await TableEntries.listEntries(SOURCE);
        await TableEntries.createEntry(SOURCE, {
          id: ROWS[index] ?? '',
          values: { [field.id]: contents },
          schemaVersion,
        });
      }
    }
    /** Each entry's value as the entry API reads it, in ROWS order. */
    async function read(field: TableField): Promise<unknown[]> {
      const { entries } = await TableEntries.listEntries(SOURCE, { pageSize: 100 });
      return [...entries]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((entry) => entry.values[field.id]);
    }
    /** Whether every empty cell is SQL NULL (never an unbounded range), in ROWS order. */
    async function nulls(field: TableField): Promise<boolean[]> {
      const { rows } = await getDb().query<{ empty: boolean }>(
        `SELECT ${quoteIdentifier(field.columnName)} IS NULL AS empty FROM ${SOURCE_SQL} ORDER BY id`
      );
      return rows.map((row) => row.empty);
    }
    const retype = (field: TableField, patch: Partial<UpdateTableFieldRequest>) =>
      TableFields.updateField(SOURCE, field.id, edit(field, patch));

    it('creates date and datetime range columns and keeps the flag through edits', async () => {
      const { field: stay } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', range: true })
      );
      const { field: slot } = await TableFields.createField(
        SOURCE,
        definition({ type: 'datetime', range: true, nullable: false })
      );
      expect(stay).toMatchObject({ type: 'date', range: true, defaultValue: null });
      expect(slot).toMatchObject({ type: 'datetime', range: true, nullable: false });
      expect(await physicalType(stay)).toBe('daterange');
      expect(await physicalType(slot)).toBe('tstzrange');
      // An exact replay matches, and other fields are not ranges.
      expect(
        await TableFields.createField(SOURCE, {
          ...definition({ type: 'date', range: true }),
          id: stay.id,
          name: stay.name,
        })
      ).toEqual({ field: stay, created: false });
      expect((await TableFields.listFields(SOURCE))[0]).toMatchObject({ range: false });
      // Left out, an edit keeps the end date; the drift check accepts the column.
      const described = await retype(stay, { description: 'When the stay runs.' });
      expect(described).toMatchObject({ range: true, revision: 2 });
      expect(await physicalType(described)).toBe('daterange');
    });

    it('refuses an end date on other types and a default on a range; a range may repeat', async () => {
      for (const patch of [
        { type: 'text' as const, range: true },
        { type: 'number' as const, range: true },
        { type: 'date' as const, range: true, defaultValue: '2026-10-12' },
        { type: 'datetime' as const, range: true, defaultValue: '2026-10-12T09:00' },
      ])
        await expect(TableFields.createField(SOURCE, definition(patch))).rejects.toMatchObject({
          statusCode: 400,
        });
      const { field: status } = await TableFields.createField(
        SOURCE,
        definition({ type: 'select', options: [{ label: 'todo' }, { label: 'done' }] })
      );
      const [todo, done] = status.options ?? [];
      const recurrence = {
        statusFieldId: status.id,
        doneOptionIds: [done?.id ?? ''],
        resetOptionId: todo?.id ?? null,
      };
      const { field: stay } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', range: true, recurrence })
      );
      expect(stay).toMatchObject({ range: true, recurrence });
      // End date on or off keeps the repeat (it is not a type change).
      const { field: due } = await TableFields.createField(
        SOURCE,
        definition({ type: 'datetime', recurrence })
      );
      const ranged = await retype(due, { range: true });
      expect(ranged).toMatchObject({ range: true, recurrence });
      expect(await retype(ranged, { range: false })).toMatchObject({ range: false, recurrence });
      // A date with a default must drop it to become a range.
      const { field: day } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', defaultValue: '2026-10-12' })
      );
      await expect(retype(day, { range: true })).rejects.toMatchObject({ statusCode: 400 });
      expect(await retype(day, { range: true, defaultValue: null })).toMatchObject({
        range: true,
        defaultValue: null,
      });
    });

    it('turns dates into one-day ranges and back to their starts, empty cells staying empty', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'date' }));
      await write(field, ['2026-10-12', null, '2024-02-29']);
      const range = await retype(field, { range: true });
      expect(range).toMatchObject({ type: 'date', range: true });
      expect(await physicalType(range)).toBe('daterange');
      expect(await read(range)).toEqual(['2026-10-12', null, '2024-02-29']);
      expect(await nulls(range)).toEqual([false, true, false]);
      // A span, with its end day included.
      const current = (await TableEntries.getEntry(SOURCE, ROWS[0] ?? '')).entry;
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      await TableEntries.updateEntry(SOURCE, current.id, {
        schemaVersion,
        expectedRevision: current.revision,
        values: { [range.id]: '2026-10-12/2026-10-15' },
      });
      expect(await read(range)).toEqual(['2026-10-12/2026-10-15', null, '2024-02-29']);
      const plain = await retype(range, { range: false });
      expect(await physicalType(plain)).toBe('date');
      expect(await read(plain)).toEqual(['2026-10-12', null, '2024-02-29']);
    });

    it('turns datetimes into single-instant ranges and back to their starts', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'datetime' }));
      await write(field, ['2026-10-12T09:00', null, '2026-10-01T22:30:00.123456Z']);
      const range = await retype(field, { range: true });
      expect(await physicalType(range)).toBe('tstzrange');
      expect(await read(range)).toEqual([
        '2026-10-11T20:00:00.000000Z',
        null,
        '2026-10-01T22:30:00.123456Z',
      ]);
      expect(await nulls(range)).toEqual([false, true, false]);
      const current = (await TableEntries.getEntry(SOURCE, ROWS[0] ?? '')).entry;
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      await TableEntries.updateEntry(SOURCE, current.id, {
        schemaVersion,
        expectedRevision: current.revision,
        values: { [range.id]: '2026-10-12T09:00/2026-10-12T10:30' },
      });
      const plain = await retype(range, { range: false });
      expect(await physicalType(plain)).toBe('timestamp with time zone');
      expect(await read(plain)).toEqual([
        '2026-10-11T20:00:00.000000Z',
        null,
        '2026-10-01T22:30:00.123456Z',
      ]);
    });

    it('moves ranges across Include time through local midnights, across a DST change', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', range: true })
      );
      // 27 September is a 23-hour day in Auckland (+12:00 → +13:00).
      await write(field, ['2026-09-27', '2026-10-01/2026-10-03', null]);
      const timed = await retype(field, { type: 'datetime' });
      expect(timed).toMatchObject({ type: 'datetime', range: true });
      expect(await physicalType(timed)).toBe('tstzrange');
      expect(await read(timed)).toEqual([
        '2026-09-26T12:00:00.000000Z/2026-09-27T11:00:00.000000Z',
        '2026-09-30T11:00:00.000000Z/2026-10-03T11:00:00.000000Z',
        null,
      ]);
      expect(await nulls(timed)).toEqual([false, false, true]);
      const days = await retype(timed, { type: 'date' });
      expect(await physicalType(days)).toBe('daterange');
      expect(await read(days)).toEqual(['2026-09-27', '2026-10-01/2026-10-03', null]);
      expect(await nulls(days)).toEqual([false, false, true]);
    });

    it('keeps the local days a datetime range touches when the time is dropped', async () => {
      const { field } = await TableFields.createField(
        SOURCE,
        definition({ type: 'datetime', range: true })
      );
      await write(field, [
        // A single instant at local midnight is that one day.
        '2026-10-06T00:00',
        // Ending at local midnight does not reach the next day.
        '2026-10-06T09:00/2026-10-07T00:00',
        // Past midnight it does.
        '2026-10-06T22:00/2026-10-07T01:00',
        null,
      ]);
      const days = await retype(field, { type: 'date' });
      expect(await read(days)).toEqual(['2026-10-06', '2026-10-06', '2026-10-06/2026-10-07', null]);
    });

    it('turns Include time and End date on or off together', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ type: 'date' }));
      await write(field, ['2026-10-12', null]);
      const timed = await retype(field, { type: 'datetime', range: true });
      expect(await read(timed)).toEqual(['2026-10-11T11:00:00.000000Z', null]);
      const back = await retype(timed, { type: 'date', range: false });
      expect(await physicalType(back)).toBe('date');
      expect(await read(back)).toEqual(['2026-10-12', null]);
    });

    it('writes ranges as text in their wire form (local instants) and reads that text back', async () => {
      const { field: stay } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', range: true })
      );
      const { field: slot } = await TableFields.createField(
        SOURCE,
        definition({ type: 'datetime', range: true })
      );
      for (const [index, [day, time]] of [
        ['2026-10-12/2026-10-15', '2026-10-12T09:00/2026-10-12T10:30'],
        ['2026-10-13', '2026-10-13T08:00:00.5Z'],
        [null, null],
      ].entries()) {
        const { schemaVersion } = await TableEntries.listEntries(SOURCE);
        await TableEntries.createEntry(SOURCE, {
          id: ROWS[index] ?? '',
          values: { [stay.id]: day ?? null, [slot.id]: time ?? null },
          schemaVersion,
        });
      }
      const stayText = await retype(stay, { type: 'text', range: false });
      const slotText = await retype(slot, { type: 'text', range: false });
      expect(await read(stayText)).toEqual(['2026-10-12/2026-10-15', '2026-10-13', null]);
      expect(await read(slotText)).toEqual([
        '2026-10-12T09:00:00+13:00/2026-10-12T10:30:00+13:00',
        '2026-10-13T21:00:00.5+13:00',
        null,
      ]);
      const stayBack = await retype(stayText, { type: 'date', range: true });
      const slotBack = await retype(slotText, { type: 'datetime', range: true });
      expect(await read(stayBack)).toEqual(['2026-10-12/2026-10-15', '2026-10-13', null]);
      expect(await read(slotBack)).toEqual([
        '2026-10-11T20:00:00.000000Z/2026-10-11T21:30:00.000000Z',
        '2026-10-13T08:00:00.500000Z',
        null,
      ]);
      expect(await nulls(slotBack)).toEqual([false, false, true]);
    });

    it('converts required text to a required range', async () => {
      const { field } = await TableFields.createField(SOURCE, definition({ nullable: false }));
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(field.columnName)}) VALUES ($1, '2026-10-12 / 2026-10-14'), ($2, '2026-10-20')`,
        [ROWS[0], ROWS[1]]
      );
      const range = await retype(field, { type: 'date', range: true });
      expect(range).toMatchObject({ nullable: false, range: true });
      expect(await read(range)).toEqual(['2026-10-12/2026-10-14', '2026-10-20']);
      const { rows } = await getDb().query<{ required: boolean }>(
        `SELECT attnotnull AS required FROM pg_attribute
          WHERE attrelid = '${SOURCE_SQL}'::regclass AND attname = $1`,
        [range.columnName]
      );
      expect(rows).toEqual([{ required: true }]);
    });

    it('refuses text that is not a range without changing the field', async () => {
      for (const contents of ['', 'next week', '2026-10-15/2026-10-12', '2026-10-12T09:00/17:00']) {
        const { field: text } = await TableFields.createField(SOURCE, definition());
        await getDb().query(`DELETE FROM ${SOURCE_SQL}`);
        await getDb().query(
          `INSERT INTO ${SOURCE_SQL} (id, ${quoteIdentifier(text.columnName)}) VALUES ($1, '2026-10-12'), ($2, $3)`,
          [ROWS[0], ROWS[1], contents]
        );
        await expect(retype(text, { type: 'date', range: true })).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining('2026-10-12/2026-10-15'),
        });
        expect(await physicalType(text)).toBe('text');
        expect((await TableFields.listFields(SOURCE)).find((f) => f.id === text.id)).toEqual(text);
      }
    });

    it('refuses other conversions into or out of a populated range, and allows them when empty', async () => {
      const { field: amount } = await TableFields.createField(
        SOURCE,
        definition({ type: 'number' })
      );
      const { field: stay } = await TableFields.createField(
        SOURCE,
        definition({ type: 'date', range: true })
      );
      const { field: done } = await TableFields.createField(
        SOURCE,
        definition({ type: 'checkbox', nullable: false, defaultValue: false })
      );
      // Empty columns change freely.
      const emptyRange = await retype(amount, { type: 'date', range: true });
      const emptyNumber = await retype(emptyRange, { type: 'number', range: false });
      expect(await physicalType(emptyNumber)).toBe('numeric');
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      await TableEntries.createEntry(SOURCE, {
        id: ROWS[0] ?? '',
        values: { [emptyNumber.id]: '12.5', [stay.id]: '2026-10-12/2026-10-13' },
        schemaVersion,
      });
      await expect(retype(emptyNumber, { type: 'date', range: true })).rejects.toMatchObject({
        statusCode: 409,
        message:
          'Only a date, a date and time, or text can get an end date. Convert this field to a date first.',
      });
      await expect(
        retype(done, { type: 'datetime', range: true, defaultValue: null })
      ).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(retype(stay, { type: 'number', range: false })).rejects.toMatchObject({
        statusCode: 409,
        message:
          'A field with end dates can only become a date, a date and time, or text. Clear its values or convert it to text first.',
      });
      await expect(
        retype(stay, { type: 'select', range: false, options: [{ label: 'a' }] })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await physicalType(stay)).toBe('daterange');
      expect(await read(stay)).toEqual(['2026-10-12/2026-10-13']);
    });
  });
});
