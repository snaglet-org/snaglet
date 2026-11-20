/**
 * The floor of public.table_fields, public.table_catalog and the rows that
 * hang off them, on a fresh database:
 *
 * - a new field is not collapsed, not a list, not a range, has an auto
 *   (NULL) width and no options, reference kind, recurrence or calendar;
 * - a width is NULL or 64–800;
 * - a list relation is never null and defaults to []; a relation links to
 *   exactly one target, a custom table or one built-in item kind;
 * - a select holds an options array; a multi-select is never null and has a
 *   list default;
 * - an unmanaged field may be a datetime with an ISO string default; the only
 *   managed datetime is created_at;
 * - only date and datetime fields are ranges, and a range has no default;
 * - recurrence sits only on a non-managed date/datetime field, as an object;
 *   a repeat value is an object, one per (field, entry); an occurrence is
 *   done or skipped once; only a move has a destination; deleting a field or
 *   a table takes its repeats and log along;
 * - name rules bind active tables and fields only: a retired one moves to its
 *   tombstone name and frees its name; deleted needs the holding step;
 *   built-in tables and managed fields stay active; purging a table clears
 *   only retired relations to it; a history step is unique per actor sequence.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { TABLE_REFERENCE_KINDS } from '@snaglet/shared/types';
import { createFreshDatabase } from '../../../support/freshDatabase';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const TARGET_ID = 'table-1111111111111-bbbbbbbbb';
const FIELD_ID = 'field-1111111111111-aaaaaaaaa';
const ENTRY = '11111111-1111-4111-8111-111111111111';
const OTHER_ENTRY = '22222222-2222-4222-8222-222222222222';

async function expectViolation(
  db: PostgresAdapter,
  text: string,
  params: unknown[] = [],
  code: string | RegExp = /^23/
) {
  // Only an integrity-constraint error (SQLSTATE class 23, or the exact code
  // given) counts, so a typo in the statement cannot pass.
  await expect(db.query(text, params)).rejects.toMatchObject({
    code: expect.stringMatching(code),
  });
}

/** Custom catalog rows, one per [id, name] pair. */
async function seedTables(db: PostgresAdapter, tables: Array<[string, string]>): Promise<void> {
  for (const [id, name] of tables)
    await db.query(
      "INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES ($1, $2, $2, 'custom')",
      [id, name]
    );
}

describe('table fields schema', () => {
  it('gives a new field its defaults', async () => {
    const { db, close } = await createFreshDatabase('table_fields_defaults');
    try {
      const { rows: columns } = await db.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'table_fields' AND column_name = ANY($1)
          ORDER BY column_name`,
        [['collapsed', 'is_range', 'multiple', 'options', 'reference_kind', 'width']]
      );
      expect(columns).toEqual([
        {
          column_name: 'collapsed',
          data_type: 'boolean',
          is_nullable: 'NO',
          column_default: 'false',
        },
        {
          column_name: 'is_range',
          data_type: 'boolean',
          is_nullable: 'NO',
          column_default: 'false',
        },
        {
          column_name: 'multiple',
          data_type: 'boolean',
          is_nullable: 'NO',
          column_default: 'false',
        },
        { column_name: 'options', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
        {
          column_name: 'reference_kind',
          data_type: 'text',
          is_nullable: 'YES',
          column_default: null,
        },
        { column_name: 'width', data_type: 'integer', is_nullable: 'YES', column_default: null },
      ]);

      await seedTables(db, [[TABLE_ID, 'test_table']]);
      const { rows: inserted } = await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position)
         VALUES ($1, $2, 'notes', 'notes', 'text', true, 0)
         RETURNING collapsed, multiple, is_range, width, options, reference_kind, recurrence,
                   calendar_id, state`,
        [FIELD_ID, TABLE_ID]
      );
      expect(inserted).toEqual([
        {
          collapsed: false,
          multiple: false,
          is_range: false,
          width: null,
          options: null,
          reference_kind: null,
          recurrence: null,
          calendar_id: null,
          state: 'active',
        },
      ]);
    } finally {
      await close();
    }
  }, 120_000);

  it('holds a width to NULL or 64–800', async () => {
    const { db, close } = await createFreshDatabase('table_fields_width');
    try {
      await seedTables(db, [[TABLE_ID, 'test_table']]);
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position)
         VALUES ($1, $2, 'title', 'title', 'text', true, 0)`,
        [FIELD_ID, TABLE_ID]
      );
      const set = (width: number | null) =>
        db.query('UPDATE public.table_fields SET width = $2 WHERE id = $1 RETURNING width', [
          FIELD_ID,
          width,
        ]);
      for (const width of [64, 800, 240, null])
        expect((await set(width)).rows).toEqual([{ width }]);
      for (const width of [63, 801, 0, -100])
        await expectViolation(db, 'UPDATE public.table_fields SET width = $2 WHERE id = $1', [
          FIELD_ID,
          width,
        ]);
    } finally {
      await close();
    }
  }, 120_000);

  it('keeps a list relation non-null with a [] default', async () => {
    const { db, close } = await createFreshDatabase('table_fields_lists');
    try {
      await seedTables(db, [
        [TABLE_ID, 'test_table'],
        [TARGET_ID, 'target_table'],
      ]);
      const insert = (id: string, values: string) =>
        db.query(
          `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_value, reference_table_id, position, multiple)
           VALUES ${values}`,
          [id, TABLE_ID, TARGET_ID]
        );
      await insert(
        'field-1111111111111-links',
        "($1, $2, 'links', 'links', 'relation', false, '[]', $3, 5, true)"
      );
      for (const [suffix, values] of [
        ['nullable', "($1, $2, 'bad_a', 'bad_a', 'relation', true, '[]', $3, 6, true)"],
        ['nodefault', "($1, $2, 'bad_b', 'bad_b', 'relation', false, 'null', $3, 6, true)"],
        ['text', "($1, $2, 'bad_c', 'bad_c', 'text', true, 'null', NULLIF($3, $3), 6, true)"],
        ['single', "($1, $2, 'bad_d', 'bad_d', 'relation', true, '[]', $3, 6, false)"],
      ])
        await expect(insert(`field-1111111111111-${suffix}`, values)).rejects.toMatchObject({
          code: '23514',
        });
    } finally {
      await close();
    }
  }, 120_000);

  it('links a relation to exactly one target: a custom table or a built-in item kind', async () => {
    const { db, close } = await createFreshDatabase('table_fields_refs');
    try {
      await seedTables(db, [
        [TABLE_ID, 'test_table'],
        [TARGET_ID, 'target_table'],
      ]);
      let position = 0;
      const insert = (
        column: string,
        kind: string | null,
        options: {
          type?: string;
          table?: string | null;
          multiple?: boolean;
          state?: string;
        } = {}
      ) => {
        const multiple = options.multiple ?? false;
        const state = options.state ?? 'active';
        return db.query(
          `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_value, reference_table_id, reference_kind, position, multiple, state, state_changed_at)
           VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, CASE WHEN $11 = 'active' THEN NULL ELSE now() END)`,
          [
            `field-1111111111111-${column.replace(/_/g, '')}`,
            TABLE_ID,
            state === 'active' ? column : `_snaglet_field_1111111111111_${column}`,
            options.type ?? 'relation',
            !multiple,
            multiple ? '[]' : 'null',
            options.table ?? null,
            kind,
            position++,
            multiple,
            state,
          ]
        );
      };
      // A custom table target, single and multiple.
      await insert('one_table', null, { table: TARGET_ID });
      await insert('many_table', null, { table: TARGET_ID, multiple: true });
      // Every built-in item kind, single and multiple.
      for (const kind of TABLE_REFERENCE_KINDS) {
        await insert(`one_${kind}`, kind);
        await insert(`many_${kind}`, kind, { multiple: true });
      }
      const refused: Array<Parameters<typeof insert>> = [
        ['secret', 'credential'],
        ['event', 'calendar_event'],
        ['both', 'doc', { table: TARGET_ID }],
        ['neither', null],
        ['text_kind', 'doc', { type: 'text' }],
      ];
      for (const args of refused)
        await expect(insert(...args)).rejects.toMatchObject({ code: '23514' });
      // A retired relation may still have lost its target, never gained two.
      await insert('retired_none', null, { state: 'archived' });
      await expect(
        insert('retired_both', 'doc', { table: TARGET_ID, state: 'archived' })
      ).rejects.toMatchObject({ code: '23514' });

      const { rows: index } = await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'table_fields_reference_kind_idx'"
      );
      expect(index[0]?.indexdef).toContain('WHERE (reference_kind IS NOT NULL)');
    } finally {
      await close();
    }
  }, 120_000);

  it('holds select options and list-shaped multi-select defaults', async () => {
    const { db, close } = await createFreshDatabase('table_fields_selects');
    try {
      await seedTables(db, [[TABLE_ID, 'test_table']]);
      const options = JSON.stringify([
        { id: 'opt-1', label: 'todo', color: 'blue' },
        { id: 'opt-2', label: 'done', color: 'green' },
      ]);
      let position = 0;
      const insert = (
        column: string,
        type: string,
        nullable: boolean,
        defaultValue: string,
        multiple: boolean,
        fieldOptions: string | null
      ) =>
        db.query(
          `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_value, position, multiple, options)
           VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)`,
          [
            `field-1111111111111-${column.replace(/_/g, '')}`,
            TABLE_ID,
            column,
            type,
            nullable,
            defaultValue,
            position++,
            multiple,
            fieldOptions,
          ]
        );
      // A select holds a label or null; a multi-select is never null with a list default.
      await insert('status', 'select', true, '"todo"', false, options);
      await insert('tags', 'select', false, '["todo"]', true, options);
      await insert('empty', 'select', false, '[]', true, '[]');
      const refused: Array<Parameters<typeof insert>> = [
        ['no_options', 'select', true, 'null', false, null],
        ['object_options', 'select', true, 'null', false, '{}'],
        ['text_options', 'text', true, 'null', false, options],
        ['nullable_list', 'select', true, '[]', true, options],
        ['null_list', 'select', false, 'null', true, options],
        ['list_default', 'select', true, '["todo"]', false, options],
        ['scalar_list', 'select', false, '"todo"', true, options],
        ['multiple_text', 'text', false, '[]', true, null],
        ['id', 'select', true, 'null', false, options],
      ];
      for (const args of refused)
        await expect(insert(...args)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await close();
    }
  }, 120_000);

  it('lets unmanaged fields be datetimes with ISO string defaults', async () => {
    const { db, close } = await createFreshDatabase('table_fields_datetimes');
    try {
      await seedTables(db, [[TABLE_ID, 'test_table']]);
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position, managed)
         VALUES ($2, $1, 'created_at', 'created_at', 'datetime', false, 0, true)`,
        [TABLE_ID, `field-managed-${TABLE_ID}-created_at`]
      );
      let position = 0;
      const addDue = (id: string, column: string, defaultValue: string) =>
        db.query(
          `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_value, position)
           VALUES ($1, $2, $3, $3, 'datetime', true, $4::jsonb, $5)`,
          [id, TABLE_ID, column, defaultValue, (position += 1)]
        );
      await addDue('field-1111111111111-dueat', 'due_at', '"2026-10-01T22:30:00.000000Z"');
      await addDue('field-1111111111111-remind', 'remind_at', 'null');
      // A datetime default is a string, and a managed datetime is still only created_at.
      await expect(addDue('field-1111111111111-bad', 'bad_at', 'true')).rejects.toMatchObject({
        code: '23514',
      });
      await expectViolation(
        db,
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position, managed)
         VALUES ('field-1111111111111-other', $1, 'other_at', 'other_at', 'datetime', true, 99, true)`,
        [TABLE_ID],
        '23514'
      );
    } finally {
      await close();
    }
  }, 120_000);

  it('keeps ranges to date and datetime fields with no default', async () => {
    const { db, close } = await createFreshDatabase('table_fields_ranges');
    try {
      const day = 'field-1111111111111-rangeday01';
      const at = 'field-1111111111111-rangeat001';
      const note = 'field-1111111111111-rangenote1';
      await seedTables(db, [[TABLE_ID, 'trips']]);
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position) VALUES
           ($1, $4, 'day', 'day', 'date', true, 0),
           ($2, $4, 'at', 'at', 'datetime', true, 1),
           ($3, $4, 'note', 'note', 'text', true, 2)`,
        [day, at, note, TABLE_ID]
      );

      // Date and datetime fields may become ranges with no default.
      await db.query(`UPDATE public.table_fields SET is_range = true WHERE id = ANY($1)`, [
        [day, at],
      ]);
      // Other types cannot, and a range field cannot have a default.
      await expectViolation(
        db,
        `UPDATE public.table_fields SET is_range = true WHERE id = $1`,
        [note],
        '23514'
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET default_value = '"2026-10-12"' WHERE id = $1`,
        [day],
        '23514'
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET type = 'text' WHERE id = $1`,
        [at],
        '23514'
      );
      // A plain date keeps its string default.
      await db.query(`UPDATE public.table_fields SET is_range = false WHERE id = $1`, [day]);
      await db.query(
        `UPDATE public.table_fields SET default_value = '"2026-10-12"' WHERE id = $1`,
        [day]
      );
    } finally {
      await close();
    }
  }, 120_000);

  it('enforces the recurrence rules at the database floor', async () => {
    const { db, close } = await createFreshDatabase('table_fields_recurrence');
    try {
      const otherTable = 'table-1111111111111-recurtab2';
      const due = 'field-1111111111111-recurdue1';
      const at = 'field-1111111111111-recurat01';
      const note = 'field-1111111111111-recurnote';
      const status = 'field-1111111111111-recurstat';
      const otherDue = 'field-1111111111111-recurdue2';
      await seedTables(db, [
        [TABLE_ID, 'chores'],
        [otherTable, 'other'],
      ]);
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position) VALUES
           ($1, $5, 'due', 'due', 'date', true, 0),
           ($2, $5, 'at', 'at', 'datetime', true, 1),
           ($3, $5, 'note', 'note', 'text', true, 2),
           ($4, $6, 'due', 'due', 'date', true, 0)`,
        [due, at, note, otherDue, TABLE_ID, otherTable]
      );
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position, options)
         VALUES ($1, $2, 'status', 'status', 'select', true, 3,
                 '[{"id":"opt-todo","label":"To do"},{"id":"opt-done","label":"Done"}]'::jsonb)`,
        [status, TABLE_ID]
      );
      const config = JSON.stringify({
        statusFieldId: status,
        doneOptionIds: ['opt-done'],
        resetOptionId: 'opt-todo',
        weekStart: 'MO',
      });
      const repeat = JSON.stringify({
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        dtstart: '2026-10-05',
        current: '2026-10-12',
        tz: 'America/Los_Angeles',
        within: 'week',
      });

      // --- table_fields.recurrence: date/datetime, not managed, an object.
      await db.query(`UPDATE public.table_fields SET recurrence = $2::jsonb WHERE id = $1`, [
        due,
        config,
      ]);
      await db.query(`UPDATE public.table_fields SET recurrence = '{}'::jsonb WHERE id = $1`, [at]);
      await expectViolation(
        db,
        `UPDATE public.table_fields SET recurrence = '{}'::jsonb WHERE id = $1`,
        [note]
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET recurrence = '{}'::jsonb WHERE id = $1`,
        [status]
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET recurrence = '[]'::jsonb WHERE id = $1`,
        [otherDue]
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET recurrence = 'true'::jsonb WHERE id = $1`,
        [otherDue]
      );
      // A managed created_at is a datetime but never repeats.
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position, managed)
         VALUES ('field-managed-recur-created', $1, 'created_at', 'created_at', 'datetime', false, 9, true)`,
        [TABLE_ID]
      );
      await expectViolation(
        db,
        `UPDATE public.table_fields SET recurrence = '{}'::jsonb WHERE id = 'field-managed-recur-created'`
      );
      // Changing a repeating field to a non-date type is refused until it is turned off.
      await expectViolation(db, `UPDATE public.table_fields SET type = 'text' WHERE id = $1`, [at]);

      // --- table_entry_repeats: an object, one per (field, entry), FKs hold.
      const insertRepeat = `INSERT INTO public.table_entry_repeats (table_id, field_id, entry_id, value)
                            VALUES ($1, $2, $3, $4::jsonb)`;
      await db.query(insertRepeat, [TABLE_ID, due, ENTRY, repeat]);
      await expectViolation(db, insertRepeat, [TABLE_ID, due, ENTRY, repeat], '23505');
      await expectViolation(db, insertRepeat, [TABLE_ID, at, ENTRY, '"FREQ=DAILY"'], '23514');
      await expectViolation(
        db,
        insertRepeat,
        [TABLE_ID, 'field-1111111111111-nosuchfld', ENTRY, '{}'],
        '23503'
      );
      await expectViolation(
        db,
        insertRepeat,
        ['table-1111111111111-nosuchtab', due, OTHER_ENTRY, '{}'],
        '23503'
      );

      // --- table_entry_occurrences: shapes, kinds, once per occurrence.
      const occ = (occurrence: string, kind: string, movedTo: string | null = null) =>
        db.query(
          `INSERT INTO public.table_entry_occurrences
             (table_id, field_id, entry_id, occurrence, kind, moved_to, actor_kind, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'agent', 'test-agent-a') RETURNING id`,
          [TABLE_ID, due, ENTRY, occurrence, kind, movedTo]
        );
      const done = await occ('2026-10-05', 'done');
      expect(done.rows[0]?.id).toMatch(/^tocc-/);
      await occ('2026-10-12', 'skipped');
      await occ('2026-10-19', 'moved', '2026-10-21');
      // A move can repeat (moved twice), and a moved occurrence can still be done.
      await occ('2026-10-19', 'moved', '2026-10-22');
      await occ('2026-10-19', 'done');
      await occ('2026-10-26T09:00:00', 'done');
      const insertOcc = `INSERT INTO public.table_entry_occurrences
                           (table_id, field_id, entry_id, occurrence, kind, moved_to)
                         VALUES ($1, $2, $3, $4, $5, $6)`;
      // Completed or skipped at most once.
      await expectViolation(db, insertOcc, [TABLE_ID, due, ENTRY, '2026-10-05', 'done', null]);
      await expectViolation(db, insertOcc, [TABLE_ID, due, ENTRY, '2026-10-05', 'skipped', null]);
      await expectViolation(db, insertOcc, [TABLE_ID, due, ENTRY, '2026-10-12', 'done', null]);
      // The same occurrence on another entry is its own.
      await db.query(insertOcc, [TABLE_ID, due, OTHER_ENTRY, '2026-10-05', 'done', null]);
      // Kinds, destinations, shapes.
      for (const [occurrence, kind, movedTo] of [
        ['2026-11-02', 'completed', null],
        ['2026-11-02', 'moved', null],
        ['2026-11-02', 'done', '2026-11-03'],
        ['2026-11-2', 'done', null],
        ['2026-11-02 09:00', 'done', null],
        ['2026-11-02T09:00:00Z', 'done', null],
        ['2026-11-09', 'moved', 'next week'],
      ])
        await expectViolation(db, insertOcc, [TABLE_ID, due, ENTRY, occurrence, kind, movedTo]);

      // --- cascades: a field purge clears its repeats and log, a table purge clears the rest.
      await db.query(insertRepeat, [TABLE_ID, at, ENTRY, repeat]);
      await db.query(insertOcc, [TABLE_ID, at, ENTRY, '2026-10-05T09:00:00', 'done', null]);
      await db.query(`DELETE FROM public.table_fields WHERE id = $1`, [at]);
      const counts = async () =>
        (
          await db.query<{ repeats: number; occurrences: number }>(
            `SELECT (SELECT count(*)::int FROM public.table_entry_repeats) AS repeats,
                    (SELECT count(*)::int FROM public.table_entry_occurrences) AS occurrences`
          )
        ).rows[0];
      expect(await counts()).toEqual({ repeats: 1, occurrences: 7 });
      await db.query(`DELETE FROM public.table_catalog WHERE id = $1`, [TABLE_ID]);
      expect(await counts()).toEqual({ repeats: 0, occurrences: 0 });
    } finally {
      await close();
    }
  }, 120_000);

  it('binds name rules to active tables and fields, freeing a retired one’s name', async () => {
    const { db, close } = await createFreshDatabase('table_fields_retire');
    try {
      await seedTables(db, [
        [TABLE_ID, 'test_table'],
        [TARGET_ID, 'target_table'],
      ]);
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, default_value, reference_table_id, position, multiple)
         VALUES ('field-1111111111111-note', $1, 'note', 'note', 'text', true, 'null', NULL, 0, false),
                ('field-1111111111111-link', $1, 'link', 'link', 'relation', true, 'null', $2, 1, false)`,
        [TABLE_ID, TARGET_ID]
      );
      // Every built-in table is active.
      const { rows: builtins } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.table_catalog WHERE origin = 'builtin' AND state <> 'active'"
      );
      expect(builtins[0]?.n).toBe(0);

      // A retired table gives its name up and must use its tombstone name.
      await expectViolation(
        db,
        "UPDATE public.table_catalog SET state = 'archived' WHERE id = $1",
        [TARGET_ID],
        '23514'
      );
      await db.query(
        "UPDATE public.table_catalog SET state = 'archived', table_name = $2 WHERE id = $1",
        [TARGET_ID, '_snaglet_table_1111111111111_ccccccccc']
      );
      await seedTables(db, [['table-1111111111111-ddddddddd', 'target_table']]);
      await expectViolation(
        db,
        "INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES ('table-1111111111111-eeeeeeeee', 'target_table', 'target_table', 'custom')",
        [],
        '23505'
      );
      // Deleted needs the holding step; built-ins stay active.
      await expectViolation(
        db,
        "UPDATE public.table_catalog SET state = 'deleted' WHERE id = $1",
        [TARGET_ID],
        '23514'
      );
      await db.query(
        "UPDATE public.table_catalog SET state = 'deleted', held_by = 'tstep-1' WHERE id = $1",
        [TARGET_ID]
      );
      await expectViolation(
        db,
        "UPDATE public.table_catalog SET state = 'archived' WHERE id = 'table-builtin-docs'",
        [],
        '23514'
      );

      // A retired field frees its name and slot; its column is its tombstone.
      await expectViolation(
        db,
        "UPDATE public.table_fields SET state = 'archived' WHERE id = 'field-1111111111111-note'",
        [],
        '23514'
      );
      await db.query(
        "UPDATE public.table_fields SET state = 'archived', column_name = '_snaglet_field_1111111111111_note' WHERE id = 'field-1111111111111-note'"
      );
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position)
         VALUES ('field-1111111111111-note2', $1, 'note', 'note', 'text', true, 0)`,
        [TABLE_ID]
      );

      // A purged target clears only retired relations; an active one keeps it.
      await expectViolation(
        db,
        'DELETE FROM public.table_catalog WHERE id = $1',
        [TARGET_ID],
        '23514'
      );
      await db.query(
        "UPDATE public.table_fields SET state = 'deleted', held_by = 'tstep-1', column_name = '_snaglet_field_1111111111111_link' WHERE id = 'field-1111111111111-link'"
      );
      await db.query('DELETE FROM public.table_catalog WHERE id = $1', [TARGET_ID]);
      const { rows: link } = await db.query<{ reference_table_id: string | null }>(
        "SELECT reference_table_id FROM public.table_fields WHERE id = 'field-1111111111111-link'"
      );
      expect(link).toEqual([{ reference_table_id: null }]);

      // Managed fields cannot retire.
      await db.query(
        `INSERT INTO public.table_fields (id, table_id, column_name, name, type, nullable, position, managed)
         VALUES ('field-managed-x-id', $1, 'id', 'id', 'uuid', false, 5, true)`,
        [TABLE_ID]
      );
      await expectViolation(
        db,
        "UPDATE public.table_fields SET state = 'archived', column_name = '_snaglet_x' WHERE id = 'field-managed-x-id'",
        [],
        '23514'
      );
    } finally {
      await close();
    }
  }, 120_000);

  it('records a table history step once per actor sequence, from a known actor kind', async () => {
    const { db, close } = await createFreshDatabase('table_fields_history');
    try {
      const insert = (id: string, actorKind: string, seq: number) =>
        db.query(
          `INSERT INTO public.table_history (id, actor_kind, actor_id, seq, state, kind, label, ops)
           VALUES ($1, $2, 'test-user', $3, 'done', 'entry.update', 'Edit', '[]')`,
          [id, actorKind, seq]
        );
      await insert('tstep-2', 'user', 1);
      await expect(insert('tstep-3', 'user', 1)).rejects.toMatchObject({ code: '23505' });
      await expect(insert('tstep-4', 'robot', 2)).rejects.toMatchObject({ code: '23514' });
    } finally {
      await close();
    }
  }, 120_000);
});
