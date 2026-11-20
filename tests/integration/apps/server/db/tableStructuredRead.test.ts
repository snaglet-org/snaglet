import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  getDb,
  transaction,
  TableCatalog,
  TableFields,
  TableEntries,
  quoteIdentifier,
} from '@snaglet/db';
import { listAgentEntries } from '@server/domains/tables/tableAgent';
import type { CreateTableFieldRequest, TableEntryValues, TableField } from '@snaglet/shared/types';

const SOURCE = 'table-1111111111111-structuredread';
const SOURCE_NAME = 'structured_read';
const SOURCE_SQL = `user_tables.${quoteIdentifier(SOURCE_NAME)}`;
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
let serial = 0;

async function field(patch: Partial<CreateTableFieldRequest> = {}): Promise<TableField> {
  serial += 1;
  return (
    await TableFields.createField(SOURCE, {
      id: `field-1111111111111-${serial}`,
      name: `structured_${serial}`,
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
      ...patch,
    })
  ).field;
}

async function clean(): Promise<void> {
  await getDb().query('DELETE FROM public.table_fields WHERE table_id=$1', [SOURCE]);
  await getDb().query(`DROP TABLE IF EXISTS ${SOURCE_SQL} CASCADE`);
  await getDb().query('DELETE FROM public.table_catalog WHERE id=$1', [SOURCE]);
}

async function create(values: TableEntryValues, id: string) {
  const { schemaVersion } = await TableEntries.listEntries(SOURCE);
  return TableEntries.createEntry(SOURCE, { id, values, schemaVersion });
}

describe('structured table entry reads (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await transaction(async (tx) => {
      await TableCatalog.createCustomPhysicalTable(SOURCE_NAME, SOURCE, tx);
      await TableCatalog.registerCustom(
        { id: SOURCE, tableName: SOURCE_NAME, name: SOURCE_NAME },
        tx
      );
      await TableFields.registerInitialFields(SOURCE, tx);
    });
  });
  afterAll(clean);

  it('applies typed where conditions, ordered sorts, and pages the result', async () => {
    const name = await field();
    const amount = await field({ type: 'number' });
    const due = await field({ type: 'date' });
    const status = await field({
      type: 'select',
      options: [
        { label: 'todo', color: 'blue' },
        { label: 'done', color: 'green' },
      ],
    });
    await create(
      { [name.id]: 'Alpha', [amount.id]: '2', [due.id]: '2026-01-03', [status.id]: 'todo' },
      IDS[0]
    );
    await create(
      { [name.id]: 'Beta', [amount.id]: '10', [due.id]: '2026-01-01', [status.id]: 'done' },
      IDS[1]
    );
    await create(
      { [name.id]: 'Gamma', [amount.id]: null, [due.id]: null, [status.id]: null },
      IDS[2]
    );

    const filtered = await TableEntries.listEntries(SOURCE, {
      where: [
        { fieldId: amount.id, operator: 'gt', value: '1' },
        { fieldId: name.id, operator: 'is_not_empty' },
      ],
      sort: [{ fieldId: amount.id, direction: 'desc' }],
      page: 1,
      pageSize: 1,
    });
    expect(filtered.entries.map((entry) => entry.id)).toEqual([IDS[1]]);
    expect(filtered.totalCount).toBe(2);
    expect(filtered.page).toBe(1);
    expect(filtered.pageSize).toBe(1);
    expect(filtered.rowNumbers).toEqual({ [IDS[1]]: 2 });

    const selectOrder = await TableEntries.listEntries(SOURCE, {
      sort: [{ fieldId: status.id, direction: 'asc' }],
      pageSize: 10,
    });
    expect(selectOrder.entries.map((entry) => entry.id)).toEqual([IDS[0], IDS[1], IDS[2]]);

    const dates = await TableEntries.listEntries(SOURCE, {
      where: [{ fieldId: due.id, operator: 'on_or_after', value: '2026-01-02' }],
    });
    expect(dates.entries.map((entry) => entry.id)).toEqual([IDS[0]]);
  });

  it('resolves a focused entry page and returns revisions usable for guarded writes', async () => {
    const name = await field();
    await create({ [name.id]: 'one' }, IDS[0]);
    await create({ [name.id]: 'two' }, IDS[1]);
    await create({ [name.id]: 'three' }, IDS[2]);

    const listed = await TableEntries.listEntries(SOURCE, {
      sort: [{ fieldId: name.id, direction: 'desc' }],
      page: 1,
      pageSize: 2,
    });
    expect(listed.entries.map((entry) => entry.id)).toEqual([IDS[1], IDS[2]]);
    const focused = await TableEntries.listEntries(SOURCE, {
      focusEntryId: IDS[0],
      pageSize: 2,
      sort: [{ fieldId: name.id, direction: 'desc' }],
    });
    expect(focused.page).toBe(2);
    expect(focused.entries.map((entry) => entry.id)).toEqual([IDS[0]]);

    const current = listed.entries.find((entry) => entry.id === IDS[1])!;
    const updated = await TableEntries.updateEntry(SOURCE, IDS[1], {
      schemaVersion: listed.schemaVersion,
      expectedRevision: current.revision,
      values: { [name.id]: 'changed' },
    });
    expect(updated.entry.values[name.id]).toBe('changed');
    await expect(
      TableEntries.updateEntry(SOURCE, IDS[1], {
        schemaVersion: updated.schemaVersion,
        expectedRevision: current.revision,
        values: { [name.id]: 'stale' },
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reads agent entries by field names, columns, paging, sort, and where', async () => {
    const name = await field({ name: 'agent_name' });
    const amount = await field({ name: 'agent_amount', type: 'number' });
    await create({ [name.id]: 'Alpha', [amount.id]: '2' }, IDS[0]);
    await create({ [name.id]: 'Beta', [amount.id]: '10' }, IDS[1]);
    await create({ [name.id]: 'Gamma', [amount.id]: '20' }, IDS[2]);

    const result = await listAgentEntries(SOURCE_NAME, {
      where: [{ field: 'agent_amount', operator: 'gte', value: '10' }],
      sort: [{ field: 'agent_amount', direction: 'desc' }],
      page: 1,
      limit: 1,
      columns: ['agent_name'],
    });
    expect(result).toMatchObject({
      table: SOURCE_NAME,
      page: 1,
      pageSize: 1,
      total: 2,
      hasMore: true,
    });
    expect(result.entries).toEqual([
      { id: IDS[2], rev: expect.stringMatching(/^[a-f0-9]{8}$/), values: { agent_name: 'Gamma' } },
    ]);

    const full = await listAgentEntries(SOURCE_NAME, {
      sort: [{ field: 'agent_name', direction: 'asc' }],
    });
    expect(full.entries.map((entry) => entry.id)).toEqual(IDS);
    expect(full.entries.every((entry) => entry.rev.length === 8)).toBe(true);
  });

  it('rejects invalid agent columns and malformed name-addressed options', async () => {
    await field({ name: 'agent_name' });
    await expect(listAgentEntries(SOURCE_NAME, { columns: ['NoSuchField'] })).rejects.toMatchObject(
      { statusCode: 400 }
    );
    await expect(
      listAgentEntries(SOURCE_NAME, { sort: [{ field: 'agent_name', direction: 'sideways' }] })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      listAgentEntries(SOURCE_NAME, { where: [{ field: 'NoSuchField', operator: 'is_empty' }] })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      listAgentEntries(SOURCE_NAME, {
        where: [{ field: 'agent_name', operator: 'not-a-real-operator' }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects duplicate projections and field-incompatible operators', async () => {
    await field({ name: 'guard_text' });
    await expect(
      listAgentEntries(SOURCE_NAME, { columns: ['guard_text', 'guard_text'] })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      listAgentEntries(SOURCE_NAME, { where: [{ field: 'guard_text', operator: 'gt', value: 3 }] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects unknown field names in structured sort and where input', async () => {
    await field();
    await expect(
      TableEntries.listEntries(SOURCE, {
        sort: [{ fieldId: 'field-1111111111111-nope', direction: 'asc' }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      TableEntries.listEntries(SOURCE, {
        where: [{ fieldId: 'field-1111111111111-nope', operator: 'is_empty' }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
