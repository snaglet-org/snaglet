import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { CreateTableFieldRequest, TableField } from '@snaglet/shared/types';

const emitTableFieldsChanged = jest.fn();
const emitTableEntriesChanged = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: (...args: unknown[]) => emitTableFieldsChanged(...args),
  emitTableEntriesChanged: (...args: unknown[]) => emitTableEntriesChanged(...args),
}));
import { applyAgentSchema } from '@server/domains/tables/tableAgent';
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField, listTableFields } from '@server/domains/tables/tableFields';
import { listTableEntries } from '@server/domains/tables/tableEntries';
import { listTableHistory } from '@server/domains/tables/tableHistory';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const TARGET_ID = 'table-1111111111111-bbbbbbbbb';
const FIELD_ID = 'field-1111111111111-aaaaaaaaa';
const definition: CreateTableFieldRequest = {
  id: FIELD_ID,
  name: 'test_field',
  description: 'A label for agents to understand — 名前.',
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
};

function app(): express.Application {
  const value = express();
  value.use(express.json());
  value.use('/api/tables', tablesRouter);
  value.use(errorHandler);
  return value;
}

async function cleanup(): Promise<void> {
  const tables = await TableCatalog.listTables({ origin: 'custom' });
  for (const table of tables) {
    await getDb().query(`DROP TABLE IF EXISTS user_tables."${table.tableName}" CASCADE`);
  }
  await getDb().query('DELETE FROM public.table_fields');
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
}

describe('editable table fields API and service (real DB)', () => {
  beforeEach(async () => {
    await cleanup();
    await createTable({ id: TABLE_ID, name: 'test_table' });
    emitTableFieldsChanged.mockClear();
    emitTableEntriesChanged.mockClear();
  });
  afterAll(cleanup);

  it('registers the Name and both managed fields atomically with each new table', async () => {
    const response = await request(app()).get(`/api/tables/${TABLE_ID}/fields`);
    expect(response.status).toBe(200);
    const initial = [
      expect.objectContaining({
        id: `field-title-${TABLE_ID}`,
        name: 'name',
        type: 'text',
        nullable: false,
        defaultValue: '',
        managed: false,
        isTitle: true,
        position: 0,
      }),
      expect.objectContaining({ name: 'id', type: 'uuid', managed: true, position: 1 }),
      expect.objectContaining({ name: 'created_at', type: 'datetime', managed: true, position: 2 }),
    ];
    expect(response.body.data.fields).toEqual(initial);
    // A replayed create returns the table without seeding a second Name field.
    expect(await createTable({ id: TABLE_ID, name: 'test_table' })).toMatchObject({
      created: false,
    });
    expect(await listTableFields(TABLE_ID)).toEqual(initial);
    const builtin = await request(app()).get('/api/tables/table-builtin-docs/fields');
    expect(builtin.body.data.fields).toEqual([]);
    const missing = await request(app()).get('/api/tables/table-1111111111111-missing/fields');
    expect(missing.status).toBe(404);
  });

  it('creates and replays one normalized field, emitting only after the real write', async () => {
    const input = { ...definition, name: '  test_field ', description: ' Meaning for agents. ' };
    const created = await request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(input);
    expect(created.status).toBe(201);
    expect(created.body.data.field).toMatchObject({
      id: FIELD_ID,
      name: 'test_field',
      // The field's name is its real column name.
      columnName: 'test_field',
      description: 'Meaning for agents.',
      revision: 1,
      managed: false,
    });
    const replay = await request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(input);
    expect(replay.status).toBe(200);
    expect(replay.body.data.field).toEqual(created.body.data.field);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
    expect(emitTableFieldsChanged).toHaveBeenCalledWith(TABLE_ID);
  });

  it('edits fields and rejects a stale edit without broadcasting or overwriting it', async () => {
    const { field } = await createTableField(TABLE_ID, definition);
    emitTableFieldsChanged.mockClear();
    const input = {
      ...definition,
      type: 'number',
      description: 'Amount owed.',
      defaultValue: '12.25',
      expectedRevision: field.revision,
    };
    const edited = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send(input);
    expect(edited.status).toBe(200);
    expect(edited.body.data.field).toMatchObject({
      type: 'number',
      defaultValue: '12.25',
      description: 'Amount owed.',
      revision: 2,
    });
    const stale = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({ ...input, name: 'stale_name' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.field).toEqual(edited.body.data.field);
    const noop = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({ ...input, expectedRevision: 2 });
    expect(noop.status).toBe(200);
    expect(noop.body.data.field.revision).toBe(2);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed definitions, IDs and revisions before metadata or DDL changes', async () => {
    for (const input of [
      [],
      { ...definition, id: 'bad' },
      { ...definition, name: 'Bad & Field' },
      { ...definition, type: 'sql' },
      { ...definition, nullable: 'true' },
      { ...definition, description: 'x'.repeat(2001) },
      { ...definition, defaultValue: 42 },
      { ...definition, type: 'date', defaultValue: '2026-02-30' },
      { ...definition, type: 'relation', referenceTableId: 'table-builtin-docs' },
      { ...definition, referenceTableId: undefined },
    ]) {
      const result = await request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(input);
      expect({ input, status: result.status }).toEqual({ input, status: 400 });
    }
    const invalidRevision = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({ ...definition, expectedRevision: 0 });
    expect(invalidRevision.status).toBe(400);
    expect(await listTableFields(TABLE_ID)).toHaveLength(3);
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
  });

  it('refuses built-in schema changes and managed-column edits', async () => {
    const builtin = await request(app())
      .post('/api/tables/table-builtin-docs/fields')
      .send(definition);
    expect(builtin.status).toBe(403);
    const managed = (await listTableFields(TABLE_ID)).find((field) => field.managed);
    if (!managed) throw new Error('Expected a managed field');
    const result = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${managed.id}`)
      .send({ ...definition, expectedRevision: managed.revision });
    expect(result.status).toBe(403);
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
  });

  it('keeps the Name field text over PATCH while allowing a rename', async () => {
    const [title] = await listTableFields(TABLE_ID);
    const path = `/api/tables/${TABLE_ID}/fields/${title.id}`;
    const body = { ...definition, name: 'name', description: null, expectedRevision: 1 };
    const retyped = await request(app())
      .patch(path)
      .send({ ...body, type: 'number' });
    expect(retyped.status).toBe(400);
    expect(retyped.body.error.message).toBe('The Name field must stay a text field.');
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
    const renamed = await request(app())
      .patch(path)
      .send({ ...body, name: 'label', isTitle: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.field).toMatchObject({
      id: title.id,
      name: 'label',
      columnName: 'label',
      type: 'text',
      isTitle: true,
      revision: 2,
    });
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
  });

  it('reorders fields over PUT /fields/order, emitting once, and rejects malformed bodies', async () => {
    await createTableField(TABLE_ID, definition);
    emitTableFieldsChanged.mockClear();
    const ids = (await listTableFields(TABLE_ID)).map((field) => field.id);
    const next = [FIELD_ID, ...ids.filter((id) => id !== FIELD_ID)];
    const response = await request(app())
      .put(`/api/tables/${TABLE_ID}/fields/order`)
      .send({ fieldIds: next });
    expect(response.status).toBe(200);
    expect(
      (response.body.data.fields as TableField[]).map((field) => [field.id, field.position])
    ).toEqual(next.map((id, index) => [id, index]));
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
    expect(emitTableFieldsChanged).toHaveBeenCalledWith(TABLE_ID);
    emitTableFieldsChanged.mockClear();
    for (const body of [{}, { fieldIds: 'id' }, { fieldIds: [1] }, { fieldIds: next.slice(1) }]) {
      const rejected = await request(app()).put(`/api/tables/${TABLE_ID}/fields/order`).send(body);
      expect([400, 409]).toContain(rejected.status);
    }
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
    expect((await listTableFields(TABLE_ID)).map((field) => field.id)).toEqual(next);
  });

  it('inserts fields before a chosen field over POST, emitting once per create', async () => {
    await createTableField(TABLE_ID, definition);
    emitTableFieldsChanged.mockClear();
    const [titleId, managedId, managedCreatedAt] = (await listTableFields(TABLE_ID)).map(
      (field) => field.id
    );
    const read = async () =>
      (await listTableFields(TABLE_ID)).map((field) => [field.id, field.position]);
    const post = (body: CreateTableFieldRequest) =>
      request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(body);
    const placed = {
      ...definition,
      id: 'field-1111111111111-bbbbbbbbb',
      name: 'placed_field',
      beforeFieldId: FIELD_ID,
    };
    const created = await post(placed);
    expect(created.status).toBe(201);
    expect(created.body.data).toEqual({
      field: expect.objectContaining({ id: placed.id, position: 3, revision: 1 }),
    });
    expect(created.body.data.field).not.toHaveProperty('beforeFieldId');
    const order = [titleId, managedId, managedCreatedAt, placed.id, FIELD_ID].map((id, index) => [
      id,
      index,
    ]);
    expect(await read()).toEqual(order);
    const replay = await post({ ...placed, beforeFieldId: managedId });
    expect(replay.status).toBe(200);
    expect(replay.body.data.field).toEqual(created.body.data.field);
    expect(await read()).toEqual(order);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
    expect(emitTableFieldsChanged).toHaveBeenCalledWith(TABLE_ID);

    const leading = { ...definition, id: 'field-1111111111111-ccccccccc', name: 'leading_field' };
    const first = await post({ ...leading, beforeFieldId: titleId });
    expect(first.body.data.field).toMatchObject({ id: leading.id, position: 0 });
    const trailing = { ...definition, id: 'field-1111111111111-ddddddddd', name: 'trailing_field' };
    const appended = await post(trailing);
    expect(appended.body.data.field).toMatchObject({ id: trailing.id, position: 6 });
    expect(await read()).toEqual(
      [leading.id, titleId, managedId, managedCreatedAt, placed.id, FIELD_ID, trailing.id].map(
        (id, index) => [id, index]
      )
    );
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed, missing or other-table beforeFieldId with 400 and no change', async () => {
    await createTable({ id: TARGET_ID, name: 'related_table' });
    const { field: foreign } = await createTableField(TARGET_ID, {
      ...definition,
      id: 'field-1111111111111-bbbbbbbbb',
    });
    emitTableFieldsChanged.mockClear();
    const fields = await listTableFields(TABLE_ID);
    for (const [beforeFieldId, message] of [
      [42, 'beforeFieldId must be a field id.'],
      [null, 'beforeFieldId must be a field id.'],
      [[FIELD_ID], 'beforeFieldId must be a field id.'],
      ['', 'The field to insert before no longer exists.'],
      ['field-1111111111111-missing', 'The field to insert before no longer exists.'],
      [foreign.id, 'The field to insert before no longer exists.'],
      [FIELD_ID, 'The field to insert before no longer exists.'],
    ] as const) {
      const result = await request(app())
        .post(`/api/tables/${TABLE_ID}/fields`)
        .send({ ...definition, beforeFieldId });
      expect({ beforeFieldId, status: result.status, message: result.body.error.message }).toEqual({
        beforeFieldId,
        status: 400,
        message,
      });
    }
    expect(await listTableFields(TABLE_ID)).toEqual(fields);
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
  });

  it('collapses and expands fields over PATCH /view, emitting only on a change', async () => {
    const { field } = await createTableField(TABLE_ID, definition);
    emitTableFieldsChanged.mockClear();
    const [title, managed] = await listTableFields(TABLE_ID);
    expect(field.collapsed).toBe(false);
    expect(managed).toMatchObject({ managed: true, collapsed: false });
    const view = (fieldId: string, collapsed: boolean) =>
      request(app()).patch(`/api/tables/${TABLE_ID}/fields/${fieldId}/view`).send({ collapsed });

    const on = await view(FIELD_ID, true);
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ field: { ...field, collapsed: true } });
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
    expect(emitTableFieldsChanged).toHaveBeenCalledWith(TABLE_ID);
    const repeat = await view(FIELD_ID, true);
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.field).toEqual(on.body.data.field);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);

    const managedOn = await view(managed.id, true);
    expect(managedOn.body.data.field).toEqual({ ...managed, collapsed: true });
    const off = await view(FIELD_ID, false);
    expect(off.body.data.field).toEqual(field);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(3);
    const listed = await request(app()).get(`/api/tables/${TABLE_ID}/fields`);
    expect(
      (listed.body.data.fields as TableField[]).map((item) => [item.id, item.collapsed])
    ).toEqual([
      [title.id, false],
      [managed.id, true],
      [expect.stringContaining('created_at'), false],
      [FIELD_ID, false],
    ]);
  });

  it('rejects malformed view bodies, unknown fields and builtins without broadcasting', async () => {
    await createTable({ id: TARGET_ID, name: 'related_table' });
    const { field: foreign } = await createTableField(TARGET_ID, {
      ...definition,
      id: 'field-1111111111111-bbbbbbbbb',
    });
    await createTableField(TABLE_ID, definition);
    emitTableFieldsChanged.mockClear();
    const fields = await listTableFields(TABLE_ID);
    for (const body of [[], {}, { collapsed: 'true' }, { collapsed: null }, { collapsed: 1 }]) {
      const result = await request(app())
        .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/view`)
        .send(body);
      expect({ body, status: result.status }).toEqual({ body, status: 400 });
    }
    for (const [tableId, fieldId, status] of [
      [TABLE_ID, 'field-1111111111111-missing', 404],
      [TABLE_ID, foreign.id, 404],
      ['table-1111111111111-missing', FIELD_ID, 404],
      ['table-builtin-docs', FIELD_ID, 403],
    ] as const) {
      const result = await request(app())
        .patch(`/api/tables/${tableId}/fields/${fieldId}/view`)
        .send({ collapsed: true });
      expect({ tableId, fieldId, status: result.status }).toEqual({ tableId, fieldId, status });
    }
    expect(await listTableFields(TABLE_ID)).toEqual(fields);
    expect((await listTableFields(TARGET_ID)).every((item) => !item.collapsed)).toBe(true);
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
  });

  it('sets, reads back and clears a column width over PATCH /view without schema or history churn', async () => {
    const { field } = await createTableField(TABLE_ID, definition);
    emitTableFieldsChanged.mockClear();
    const managed = (await listTableFields(TABLE_ID)).find((item) => item.managed);
    if (!managed) throw new Error('Missing managed field');
    // A field starts at auto: no width on the wire.
    expect(field).not.toHaveProperty('width');
    expect(managed).not.toHaveProperty('width');
    const { schemaVersion } = await listTableEntries(TABLE_ID);
    const steps = (await listTableHistory({ actor: 'all', tableId: TABLE_ID })).steps.length;
    const view = (fieldId: string, body: unknown) =>
      request(app()).patch(`/api/tables/${TABLE_ID}/fields/${fieldId}/view`).send(body);

    const set = await view(FIELD_ID, { width: 240 });
    expect(set.status).toBe(200);
    expect(set.body.data).toEqual({ field: { ...field, width: 240 } });
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
    expect(emitTableFieldsChanged).toHaveBeenCalledWith(TABLE_ID);
    const repeat = await view(FIELD_ID, { width: 240 });
    expect(repeat.body.data.field).toEqual(set.body.data.field);
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
    const listed = await request(app()).get(`/api/tables/${TABLE_ID}/fields`);
    expect((listed.body.data.fields as TableField[]).find((item) => item.id === FIELD_ID)).toEqual({
      ...field,
      width: 240,
    });

    // Both keys at once; then collapsing alone keeps the width for when it expands.
    const both = await view(FIELD_ID, { collapsed: true, width: 300 });
    expect(both.body.data.field).toEqual({ ...field, collapsed: true, width: 300 });
    const expanded = await view(FIELD_ID, { collapsed: false });
    expect(expanded.body.data.field).toEqual({ ...field, width: 300 });
    // Managed columns take a width too.
    const managedSet = await view(managed.id, { width: 64 });
    expect(managedSet.body.data.field).toEqual({ ...managed, width: 64 });

    // The width is presentation: same revision, same entry schema version, no undo step.
    expect((await listTableEntries(TABLE_ID)).schemaVersion).toBe(schemaVersion);
    expect((await listTableHistory({ actor: 'all', tableId: TABLE_ID })).steps).toHaveLength(steps);

    const cleared = await view(FIELD_ID, { width: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.field).toEqual(field);
    expect(cleared.body.data.field).not.toHaveProperty('width');
    expect(emitTableFieldsChanged).toHaveBeenCalledTimes(5);
  });

  it('refuses widths outside 64–800 px and non-integer widths without changing anything', async () => {
    const { field } = await createTableField(TABLE_ID, definition);
    await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/view`)
      .send({ width: 200 });
    emitTableFieldsChanged.mockClear();
    for (const body of [
      { width: 63 },
      { width: 801 },
      { width: 0 },
      { width: -120 },
      { width: 120.5 },
      { width: '240' },
      { width: true },
      { width: [240] },
      { collapsed: true, width: 1000 },
      { collapsed: 'true', width: 240 },
    ]) {
      const result = await request(app())
        .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/view`)
        .send(body);
      expect({ body, status: result.status }).toEqual({ body, status: 400 });
    }
    const tooWide = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/view`)
      .send({ width: 801 });
    expect(tooWide.body.error.message).toBe(
      'width must be a whole number of pixels from 64 to 800, or null for auto.'
    );
    expect((await listTableFields(TABLE_ID)).find((item) => item.id === FIELD_ID)).toEqual({
      ...field,
      width: 200,
    });
    expect(emitTableFieldsChanged).not.toHaveBeenCalled();
  });

  it('keeps a column width through a rename and an archive and restore', async () => {
    const { field } = await createTableField(TABLE_ID, definition);
    await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/view`)
      .send({ width: 280 });
    const renamed = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({ ...definition, name: 'renamed_field', expectedRevision: field.revision });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.field).toMatchObject({
      name: 'renamed_field',
      revision: field.revision + 1,
      width: 280,
    });

    const archived = await request(app())
      .post(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/archive`)
      .send({});
    expect(archived.status).toBe(200);
    expect((await listTableFields(TABLE_ID)).map((item) => item.id)).not.toContain(FIELD_ID);
    const restored = await request(app())
      .post(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}/restore`)
      .send({});
    expect(restored.status).toBe(200);
    expect(restored.body.data.field).toMatchObject({ id: FIELD_ID, width: 280 });
    expect((await listTableFields(TABLE_ID)).find((item) => item.id === FIELD_ID)).toMatchObject({
      name: 'renamed_field',
      width: 280,
    });
  });

  it('creates a multiple relation over POST and keeps it when a PATCH leaves multiple out', async () => {
    await createTable({ id: TARGET_ID, name: 'related_table' });
    const input = { ...definition, type: 'relation', referenceTableId: TARGET_ID, multiple: true };
    const created = await request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(input);
    expect(created.status).toBe(201);
    expect(created.body.data.field).toMatchObject({
      multiple: true,
      nullable: false,
      defaultValue: [],
    });
    const { multiple: _multiple, ...withoutMultiple } = input;
    const edited = await request(app())
      .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
      .send({ ...withoutMultiple, description: 'Linked rows.', expectedRevision: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.field).toMatchObject({ multiple: true, revision: 2 });
    for (const body of [
      { ...input, id: 'field-1111111111111-bbbbbbbbb', name: 'bad_flag', multiple: 'yes' },
      { ...definition, id: 'field-1111111111111-ccccccccc', name: 'bad_type', multiple: true },
    ]) {
      const result = await request(app()).post(`/api/tables/${TABLE_ID}/fields`).send(body);
      expect({ body, status: result.status }).toEqual({ body, status: 400 });
    }
  });

  describe('making a field required with a default', () => {
    const EMPTY_ROW = '11111111-1111-4111-8111-111111111111';
    const FILLED_ROW = '22222222-2222-4222-8222-222222222222';
    async function columnValues(column: string): Promise<unknown[]> {
      const { rows } = await getDb().query<{ value: unknown }>(
        `SELECT ${quoteIdentifier(column)} AS value FROM user_tables.test_table ORDER BY id`
      );
      return rows.map((row) => row.value);
    }

    it('turns a text field with empty rows into a required checkbox over PATCH', async () => {
      const { field } = await createTableField(TABLE_ID, definition);
      await getDb().query(
        `INSERT INTO user_tables.test_table (id, test_field) VALUES ($1, NULL), ($2, 'true')`,
        [EMPTY_ROW, FILLED_ROW]
      );
      emitTableFieldsChanged.mockClear();
      const edited = await request(app())
        .patch(`/api/tables/${TABLE_ID}/fields/${FIELD_ID}`)
        .send({
          ...definition,
          type: 'checkbox',
          nullable: false,
          defaultValue: false,
          expectedRevision: field.revision,
        });
      expect(edited.status).toBe(200);
      expect(edited.body.data.field).toMatchObject({
        type: 'checkbox',
        nullable: false,
        defaultValue: false,
        revision: 2,
      });
      expect(await columnValues('test_field')).toEqual([false, true]);
      // The fields event already reloads entries; no separate entries event.
      expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
      expect(emitTableFieldsChanged).toHaveBeenCalledWith(TABLE_ID);
      expect(emitTableEntriesChanged).not.toHaveBeenCalled();
    });

    it('fills empty values through an agent update_field, and still refuses one without a default', async () => {
      await applyAgentSchema('test_table', {
        ops: [
          { op: 'add_field', field: { name: 'status', type: 'text' } },
          { op: 'add_field', field: { name: 'score', type: 'number' } },
        ],
      });
      await getDb().query(
        `INSERT INTO user_tables.test_table (id, status) VALUES ($1, NULL), ($2, 'done')`,
        [EMPTY_ROW, FILLED_ROW]
      );
      emitTableFieldsChanged.mockClear();
      const { table } = await applyAgentSchema('test_table', {
        ops: [{ op: 'update_field', name: 'status', set: { nullable: false, default: 'open' } }],
      });
      expect(table.fields.find((item) => item.name === 'status')).toMatchObject({
        nullable: false,
        defaultValue: 'open',
        revision: 2,
      });
      expect(await columnValues('status')).toEqual(['open', 'done']);
      await expect(
        applyAgentSchema('test_table', {
          ops: [{ op: 'update_field', name: 'score', set: { nullable: false } }],
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          'ops[0] update_field: Existing rows have empty values. Keep this field optional or fill those values first.',
      });
      expect(await columnValues('score')).toEqual([null, null]);
      expect(emitTableFieldsChanged).toHaveBeenCalledTimes(1);
      expect(emitTableEntriesChanged).not.toHaveBeenCalled();
    });
  });
});
