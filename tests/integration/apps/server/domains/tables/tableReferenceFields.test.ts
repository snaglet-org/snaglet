/**
 * Relation fields that link to Snaglet items (docs, agents, …), against real
 * PostgreSQL: text/text[] storage without foreign keys, write-time checks on
 * added ids only (missing, wrong kind, malformed and archived ids refused,
 * nothing written), titles in `relatedItems`, archived and purged targets
 * kept, a purged agent cleared everywhere, text ↔ item conversions, and undo.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import type { TableEntryValues, TableField } from '@snaglet/shared/types';
import {
  AGENT_A,
  AGENT_ARCHIVED,
  AGENT_B,
  DOC_A,
  DOC_ARCHIVED,
  DOC_B,
  FOLDER,
  MISSING_DOC,
  PROJECT,
  THREAD,
  TITLES,
  cleanReferenceFixtures,
  seedReferenceFixtures,
  setAgentArchived,
  setNodeArchived,
} from '../../../../../support/tableReferenceFixtures';

const emitted: Array<{ type: string; args: unknown[] }> = [];
const record =
  (type: string) =>
  (...args: unknown[]) =>
    emitted.push({ type, args });
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: (...args: unknown[]) => record('table.created')(...args),
  emitTableUpdated: (...args: unknown[]) => record('table.updated')(...args),
  emitTableFieldsChanged: (...args: unknown[]) => record('table.fields.changed')(...args),
  emitTableEntriesChanged: (...args: unknown[]) => record('table.entries.changed')(...args),
  emitTableRemoved: (...args: unknown[]) => record('table.removed')(...args),
  emitTableRestored: (...args: unknown[]) => record('table.restored')(...args),
  emitTableHistoryChanged: (...args: unknown[]) => record('table.history.changed')(...args),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  deleteTableEntries,
  getTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { stepTableHistory } from '@server/domains/tables/tableHistory';
import { archiveTableField } from '@server/domains/tables/tableLifecycle';
import { agentService } from '@server/services/AgentService';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const TABLE = 'table-1111111111111-refsaaaaa';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const E3 = '33333333-3333-4333-8333-333333333333';
const E4 = '44444444-4444-4444-8444-444444444444';

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

function def(id: string, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id: `field-1111111111111-${id}`,
    name,
    description: null,
    type,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...extra,
  };
}

function items(id: string, name: string, referenceKind: string, multiple = false) {
  return def(id, name, 'relation', {
    referenceKind,
    multiple,
    nullable: !multiple,
    defaultValue: multiple ? [] : null,
  });
}

async function field(name: string): Promise<TableField> {
  const found = (await listTableFields(TABLE)).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing field ${name}`);
  return found;
}

/** Values keyed by field name, re-keyed by id. */
async function byName(values: Record<string, unknown>): Promise<TableEntryValues> {
  const fields = await listTableFields(TABLE);
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const found = fields.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`missing field ${name}`);
      return [found.id, value];
    })
  ) as TableEntryValues;
}

async function insert(id: string, values: Record<string, unknown>) {
  const { schemaVersion } = await listTableEntries(TABLE);
  const keyed = await byName(values);
  return as(() => createTableEntry(TABLE, { id, values: keyed, schemaVersion }));
}

async function patch(id: string, values: Record<string, unknown>) {
  const current = await getTableEntry(TABLE, id);
  return as(async () =>
    updateTableEntry(TABLE, id, {
      values: await byName(values),
      schemaVersion: current.schemaVersion,
      expectedRevision: current.entry.revision,
    })
  );
}

async function valueOf(id: string, name: string): Promise<unknown> {
  return (await getTableEntry(TABLE, id)).entry.values[(await field(name)).id];
}

async function update(name: string, changes: Record<string, unknown>) {
  const current = await field(name);
  return as(() =>
    updateTableField(TABLE, current.id, {
      name: current.name,
      description: current.description,
      type: current.type,
      nullable: current.nullable,
      defaultValue: current.defaultValue,
      referenceTableId: current.referenceTableId,
      multiple: current.multiple,
      ...changes,
      expectedRevision: current.revision,
    })
  );
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

async function entryCount(): Promise<number> {
  return (await listTableEntries(TABLE)).totalCount;
}

const undo = () => as(() => stepTableHistory('undo', {}));
const redo = () => as(() => stepTableHistory('redo', {}));

/** A table with a Doc field, a multiple Agent field and a Project field. */
async function itemTable(): Promise<void> {
  await as(() => createTable({ id: TABLE, name: 'reading_log' }));
  for (const definition of [
    def('note', 'note', 'text'),
    items('brief', 'brief', 'doc'),
    items('owners', 'owners', 'agent', true),
    items('project', 'project', 'project'),
  ])
    await as(() => createTableField(TABLE, definition));
}

describe('Snaglet item relation fields', () => {
  beforeEach(async () => {
    emitted.length = 0;
    await cleanReferenceFixtures();
    await seedReferenceFixtures();
  });
  afterAll(cleanReferenceFixtures);

  it('stores item links as text and text[] with a list index and no foreign key', async () => {
    await itemTable();
    const brief = await field('brief');
    const owners = await field('owners');
    expect(brief).toMatchObject({ type: 'relation', referenceKind: 'doc', referenceTableId: null });
    expect(owners).toMatchObject({ referenceKind: 'agent', multiple: true, defaultValue: [] });
    expect((await field('note')).referenceKind).toBeNull();

    const { rows: columns } = await getDb().query<{ column_name: string; udt_name: string }>(
      `SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'user_tables' AND table_name = 'reading_log' AND column_name IN ('brief', 'owners')
        ORDER BY column_name`
    );
    expect(columns).toEqual([
      { column_name: 'brief', udt_name: 'text' },
      { column_name: 'owners', udt_name: '_text' },
    ]);
    const { rows: keys } = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'user_tables.reading_log'::regclass AND contype = 'f'`
    );
    expect(keys[0]?.n).toBe(0);
    const { rows: indexes } = await getDb().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'user_tables' AND indexname = $1`,
      ['field_1111111111111_owners_links_idx']
    );
    expect(indexes[0]?.indexdef).toContain('USING gin (owners)');

    const bad = [
      [items('two', 'two_targets', 'doc'), { referenceTableId: TABLE }, 'not both'],
      [def('neither', 'neither', 'relation'), {}, 'a table or a Snaglet item type'],
      [items('secret', 'secret', 'credential'), {}, 'Snaglet item types are'],
      [def('kind_text', 'kind_text', 'text', { referenceKind: 'doc' }), {}, 'Only relation'],
    ] as const;
    for (const [definition, extra, message] of bad) {
      const error = await caught(() =>
        as(() => createTableField(TABLE, { ...definition, ...extra }))
      );
      expect(error).toMatchObject({ statusCode: 400 });
      expect(error.message).toContain(message);
    }
  });

  it('links and names live items, refusing bad ids without writing anything', async () => {
    await itemTable();
    const created = await insert(E1, {
      note: 'first',
      brief: DOC_A,
      owners: [AGENT_B, AGENT_A],
      project: PROJECT,
    });
    expect(created.created).toBe(true);
    expect(created.relatedItems).toEqual({
      doc: { [DOC_A]: { title: TITLES[DOC_A], archived: false } },
      agent: {
        [AGENT_A]: { title: TITLES[AGENT_A], archived: false },
        [AGENT_B]: { title: TITLES[AGENT_B], archived: false },
      },
      project: { [PROJECT]: { title: TITLES[PROJECT], archived: false } },
    });
    expect(await valueOf(E1, 'owners')).toEqual([AGENT_B, AGENT_A]);
    const page = await listTableEntries(TABLE);
    expect(page.relatedItems?.doc?.[DOC_A]?.title).toBe(TITLES[DOC_A]);

    const refused: Array<[Record<string, unknown>, string]> = [
      [{ brief: THREAD }, `${THREAD} is a thread, not a doc`],
      [{ brief: 'not an id!' }, 'Choose a doc to link'],
      [{ brief: MISSING_DOC }, `there is no doc ${MISSING_DOC}`],
      [{ brief: DOC_ARCHIVED }, `${DOC_ARCHIVED} is archived. Restore it before linking.`],
      [{ owners: ['ghost'] }, 'there is no agent ghost'],
      [{ owners: [AGENT_ARCHIVED] }, 'is archived'],
      [{ owners: [AGENT_A, AGENT_A] }, 'Link each item only once'],
      [{ owners: Array.from({ length: 101 }, (_, n) => `test-agent-${n}`) }, 'at most 100'],
      [{ project: FOLDER }, 'is a container, not a project'],
    ];
    for (const [values, message] of refused) {
      const error = await caught(() => insert(E2, values));
      expect(error).toMatchObject({ statusCode: 400 });
      expect(error.message).toContain(message);
    }
    expect(await entryCount()).toBe(1);
  });

  it('keeps archived and purged links through edits, shown as archived or left out', async () => {
    await itemTable();
    await insert(E1, { brief: DOC_A, owners: [AGENT_A, AGENT_B] });

    await setNodeArchived(DOC_A, true);
    await setAgentArchived(AGENT_A, true);
    expect((await getTableEntry(TABLE, E1)).relatedItems).toMatchObject({
      doc: { [DOC_A]: { archived: true } },
      agent: { [AGENT_A]: { archived: true }, [AGENT_B]: { archived: false } },
    });
    // Other edits and reorders keep archived links without re-checking them.
    await patch(E1, { note: 'edited' });
    await patch(E1, { owners: [AGENT_B, AGENT_A] });
    expect(await valueOf(E1, 'owners')).toEqual([AGENT_B, AGENT_A]);
    // Linking an archived item anew is refused.
    await patch(E1, { brief: DOC_B });
    const error = await caught(() => patch(E1, { brief: DOC_A }));
    expect(error.message).toContain('is archived');
    expect(await valueOf(E1, 'brief')).toBe(DOC_B);

    await setNodeArchived(DOC_A, false);
    await patch(E1, { brief: DOC_A });
    expect((await getTableEntry(TABLE, E1)).relatedItems?.doc?.[DOC_A]).toEqual({
      title: TITLES[DOC_A],
      archived: false,
    });

    // A hard-deleted doc stays as its id and reads as unavailable (absent).
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [DOC_A]);
    const gone = await getTableEntry(TABLE, E1);
    expect(gone.entry.values[(await field('brief')).id]).toBe(DOC_A);
    expect(gone.relatedItems?.doc).toBeUndefined();
    await patch(E1, { note: 'still editable' });
    await patch(E1, { brief: null });
    expect(await valueOf(E1, 'brief')).toBeNull();
  });

  it('clears a purged agent from every agent relation, hidden columns included', async () => {
    await itemTable();
    await as(() => createTableField(TABLE, items('lead', 'lead', 'agent')));
    await as(() => createTableField(TABLE, items('backup', 'backup', 'agent')));
    await insert(E1, { owners: [AGENT_A, AGENT_B], lead: AGENT_A, backup: AGENT_A });
    await insert(E2, { owners: [AGENT_B], lead: AGENT_B });
    const backup = await field('backup');
    await as(() => archiveTableField(TABLE, backup.id));
    emitted.length = 0;

    expect(await agentService.purge(AGENT_A)).toMatchObject({
      clearedTableLinks: [{ tableId: TABLE, entryIds: [E1] }],
    });
    expect(await valueOf(E1, 'owners')).toEqual([AGENT_B]);
    expect(await valueOf(E1, 'lead')).toBeNull();
    expect(await valueOf(E2, 'owners')).toEqual([AGENT_B]);
    const { rows } = await getDb().query<{ value: string | null }>(
      `SELECT ${quoteIdentifier('_snaglet_field_1111111111111_backup')} AS value FROM user_tables.reading_log WHERE id = $1`,
      [E1]
    );
    expect(rows[0]?.value).toBeNull();
    expect(emitted).toContainEqual({ type: 'table.entries.changed', args: [TABLE, [E1]] });
  });

  it('converts text to doc links and back, and undo restores the text exactly', async () => {
    await itemTable();
    await as(() => createTableField(TABLE, def('refs', 'refs', 'text')));
    await insert(E1, { refs: `[Launch brief](${DOC_A})` });
    await insert(E2, { refs: ` ${DOC_ARCHIVED} ` });
    await insert(E3, { refs: null });
    await insert(E4, { refs: '' });

    await update('refs', { type: 'relation', referenceKind: 'doc', nullable: true });
    expect(await field('refs')).toMatchObject({ type: 'relation', referenceKind: 'doc' });
    expect(await valueOf(E1, 'refs')).toBe(DOC_A);
    expect(await valueOf(E2, 'refs')).toBe(DOC_ARCHIVED);
    expect(await valueOf(E3, 'refs')).toBeNull();
    expect(await valueOf(E4, 'refs')).toBeNull();

    await undo();
    expect(await field('refs')).toMatchObject({ type: 'text', referenceKind: null });
    expect(await valueOf(E1, 'refs')).toBe(`[Launch brief](${DOC_A})`);
    expect(await valueOf(E2, 'refs')).toBe(` ${DOC_ARCHIVED} `);
    expect(await valueOf(E4, 'refs')).toBe('');
    await redo();
    expect(await valueOf(E1, 'refs')).toBe(DOC_A);
    await undo();

    // Several ids need a multiple relation; anything but chips and ids is refused.
    await patch(E3, { refs: `${DOC_A}, [Budget notes](${DOC_B})` });
    const single = await caught(() => update('refs', { type: 'relation', referenceKind: 'doc' }));
    expect(single).toMatchObject({ statusCode: 409 });
    expect(single.message).toContain('more than one doc');
    await update('refs', {
      type: 'relation',
      referenceKind: 'doc',
      multiple: true,
      nullable: false,
      defaultValue: [],
    });
    expect(await valueOf(E3, 'refs')).toEqual([DOC_A, DOC_B]);
    expect(await valueOf(E4, 'refs')).toEqual([]);
    await undo();
    await patch(E4, { refs: 'see [the brief' });
    const prose = await caught(() => update('refs', { type: 'relation', referenceKind: 'doc' }));
    expect(prose).toMatchObject({ statusCode: 409 });
    expect(prose.message).toContain('chip or id');
    // Plain words read as ids, and are no docs.
    await patch(E4, { refs: 'see the brief' });
    const words = await caught(() =>
      update('refs', { type: 'relation', referenceKind: 'doc', multiple: true })
    );
    expect(words.message).toContain('not a doc in Snaglet (see, the, brief)');
    await patch(E4, { refs: THREAD });
    const wrongKind = await caught(() =>
      update('refs', { type: 'relation', referenceKind: 'doc', multiple: true })
    );
    expect(wrongKind.message).toContain('not a doc in Snaglet');
    expect(await field('refs')).toMatchObject({ type: 'text' });
  });

  it('converts doc links to chip text, keeping a purged id bare', async () => {
    await itemTable();
    await insert(E1, { brief: DOC_A, owners: [AGENT_A, AGENT_B] });
    await insert(E2, { brief: DOC_B });
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [DOC_B]);
    await update('brief', { type: 'text', referenceKind: null });
    expect(await valueOf(E1, 'brief')).toBe(`[Launch brief](${DOC_A})`);
    expect(await valueOf(E2, 'brief')).toBe(DOC_B);
    await update('owners', {
      type: 'text',
      referenceKind: null,
      multiple: false,
      nullable: true,
      defaultValue: null,
    });
    expect(await valueOf(E1, 'owners')).toBe(
      `[Test Agent A](${AGENT_A}), [Test Agent B](${AGENT_B})`
    );
    expect(await valueOf(E2, 'owners')).toBeNull();
  });

  it('changes shape within a kind, widens projects to containers, and refuses other kinds', async () => {
    await itemTable();
    await insert(E1, { brief: DOC_A, project: PROJECT });
    await update('brief', { multiple: true, nullable: false, defaultValue: [] });
    expect(await valueOf(E1, 'brief')).toEqual([DOC_A]);
    await update('brief', { multiple: false, nullable: true, defaultValue: null });
    expect(await valueOf(E1, 'brief')).toBe(DOC_A);
    // An update that leaves the kind out keeps it.
    const renamed = await as(async () => {
      const current = await field('brief');
      return updateTableField(TABLE, current.id, {
        name: 'brief_doc',
        description: null,
        type: 'relation',
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
        expectedRevision: current.revision,
      });
    });
    expect(renamed.referenceKind).toBe('doc');

    await update('project', { referenceKind: 'container' });
    expect(await field('project')).toMatchObject({ referenceKind: 'container' });
    expect(await valueOf(E1, 'project')).toBe(PROJECT);
    const other = await caught(() => update('brief_doc', { referenceKind: 'thread' }));
    expect(other).toMatchObject({ statusCode: 409 });
    // An empty field converts freely.
    await patch(E1, { brief_doc: null });
    await update('brief_doc', { referenceKind: 'thread' });
    expect(await field('brief_doc')).toMatchObject({ referenceKind: 'thread' });
  });

  it('undoes and redoes item writes exactly, without re-checking liveness', async () => {
    await itemTable();
    await insert(E1, { brief: DOC_A, owners: [AGENT_A, AGENT_B] });
    await patch(E1, { owners: [AGENT_B] });
    await undo();
    expect(await valueOf(E1, 'owners')).toEqual([AGENT_A, AGENT_B]);
    await redo();
    expect(await valueOf(E1, 'owners')).toEqual([AGENT_B]);

    await as(() => deleteTableEntries(TABLE, { entryIds: [E1] }));
    await setNodeArchived(DOC_A, true);
    await undo();
    const restored = await getTableEntry(TABLE, E1);
    expect(restored.entry.values[(await field('brief')).id]).toBe(DOC_A);
    expect(restored.relatedItems?.doc?.[DOC_A]?.archived).toBe(true);
  });

  it('filters by linked item titles and names items on filtered pages', async () => {
    await itemTable();
    await insert(E1, { note: 'first', brief: DOC_A, owners: [AGENT_A] });
    await insert(E2, { note: 'second', brief: DOC_B, owners: [AGENT_B, AGENT_A] });
    await insert(E3, { note: 'third' });
    const ids = async (q: string) =>
      (await listTableEntries(TABLE, { q })).entries.map((entry) => entry.id);

    expect(await ids('launch')).toEqual([E1]);
    expect(await ids('"Test Agent A"')).toEqual([E1, E2]);
    expect(await ids('budget "agent b"')).toEqual([E2]);
    const filtered = await listTableEntries(TABLE, { q: 'launch' });
    expect(filtered.relatedItems).toEqual({
      doc: { [DOC_A]: { title: TITLES[DOC_A], archived: false } },
      agent: { [AGENT_A]: { title: TITLES[AGENT_A], archived: false } },
    });
    expect(filtered.rowNumbers).toEqual({ [E1]: 1 });

    // Archived items still match by the title their chip shows; purged ones do not.
    await setNodeArchived(DOC_A, true);
    expect(await ids('launch')).toEqual([E1]);
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [DOC_B]);
    expect(await ids('budget')).toEqual([]);
  });

  it('includes item titles in a stale write conflict', async () => {
    await itemTable();
    await insert(E1, { brief: DOC_A });
    const current = await getTableEntry(TABLE, E1);
    await patch(E1, { note: 'changed' });
    const error = await caught(() =>
      as(() =>
        updateTableEntry(TABLE, E1, {
          values: {},
          schemaVersion: current.schemaVersion,
          expectedRevision: current.entry.revision,
        })
      )
    );
    expect(error.statusCode).toBe(409);
    expect(error.details?.relatedItems).toEqual({
      doc: { [DOC_A]: { title: TITLES[DOC_A], archived: false } },
    });
  });
});
