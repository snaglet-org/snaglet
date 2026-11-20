/**
 * The starter tables a fresh install gets: blank `ideas`, `tasks` and
 * `events` tables, `reminders` with one example row on the Calendar, and the
 * sample project's own `sample_project_tasks` with example tasks.
 *
 * Everything goes through the table layer the agent `table` tool and the
 * field editor use (catalog, fields and entries), so the tables behave like
 * any a person makes: views, search, undo history, calendar bindings and
 * realtime events all apply. Example dates are relative to the moment of
 * seeding, in the user's time zone.
 *
 * A table whose name is already taken by an active custom table is kept as
 * it is: its id is returned and nothing is written to it, so a seed that
 * stopped partway can simply run again.
 */
import { transaction } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import type { TableEntryValue, TableSelectOptionColor } from '@snaglet/shared/types';
import { ConflictError, tableDateTimeLocalDate, userTimeZone } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  ensureDefaultCalendar,
  PendingCalendarChanges,
} from '@server/domains/calendar/calendarService';
import {
  applyAgentSchema,
  writeAgentEntries,
  type AgentFieldInput,
  type AgentSchemaInput,
  type AgentTableField,
  type AgentTableSummary,
} from '@server/domains/tables/tableAgent';
import { updateTableField } from '@server/domains/tables/tableFields';

type StarterTableKey = 'ideas' | 'tasks' | 'events' | 'reminders';

export type StarterTableIds = Record<StarterTableKey, string>;

const SAMPLE_PROJECT_TABLE = 'sample_project_tasks';
const EXAMPLE_NOTE = 'Example row: delete it when you are ready.';
const SAMPLE_NOTE = 'Example row: edit or delete it.';

// --- dates -------------------------------------------------------------------

const DAY_MS = 86_400_000;

function dateMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10))
  );
}

function addDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Today in the user's time zone, `YYYY-MM-DD`. */
function localToday(): string {
  const today = tableDateTimeLocalDate(new Date().toISOString(), userTimeZone());
  if (!today) throw new Error('Could not read the current date in the user time zone');
  return today;
}

/** A wall-clock time on `date`; a datetime write reads it in the user's time zone. */
function at(date: string, time: string): string {
  return `${date}T${time}:00`;
}

// --- shared pieces -------------------------------------------------------------

function options(
  ...items: Array<[label: string, color: TableSelectOptionColor]>
): AgentFieldInput['options'] {
  return items.map(([label, color]) => ({ label, color }));
}

const PRIORITY = options(['Low', 'blue'], ['Medium', 'yellow'], ['High', 'red']);

/**
 * The Default calendar's id, the one the field editor's "Show on calendar"
 * picks first: the `is_default` calendar, created when no calendar exists.
 */
async function defaultCalendarId(): Promise<string> {
  const changes = new PendingCalendarChanges();
  const calendar = await transaction((tx) => ensureDefaultCalendar(tx, changes));
  changes.emit();
  return calendar.id;
}

/**
 * The id of an active custom table already named `name`, which the seed keeps
 * untouched; null when the name is free. A built-in table of that name is a
 * 409, since nothing could be seeded under it.
 */
async function keptTableId(name: string): Promise<string | null> {
  const existing = await TableCatalog.findByName(name);
  if (!existing) return null;
  if (existing.origin !== 'custom')
    throw new ConflictError(`A Snaglet table named "${name}" already exists`);
  logger.info(`[onboarding] Kept the existing ${name} table; no starter fields or rows added`);
  return existing.id;
}

async function createTable(name: string, input: AgentSchemaInput): Promise<AgentTableSummary> {
  return (await applyAgentSchema(name, input)).table;
}

function fieldOf(table: AgentTableSummary, name: string): AgentTableField {
  const field = table.fields.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Starter table ${table.name} has no ${name} field`);
  return field;
}

function optionId(field: AgentTableField, label: string): string {
  const option = field.options?.find((candidate) => candidate.label === label);
  if (!option) throw new Error(`Field ${field.name} has no option ${label}`);
  return option.id;
}

/**
 * The field editor's "Status can complete it too": setting `statusName` to
 * `done` completes a repeating row's occurrence of `dateName` and resets the
 * status to `reset`.
 */
async function completeByStatus(
  table: AgentTableSummary,
  dateName: string,
  statusName: string,
  done: string,
  reset: string
): Promise<void> {
  const date = fieldOf(table, dateName);
  const status = fieldOf(table, statusName);
  await updateTableField(table.id, date.id, {
    name: date.name,
    description: date.description,
    type: date.type,
    nullable: date.nullable,
    defaultValue: date.defaultValue,
    referenceTableId: null,
    recurrence: {
      statusFieldId: status.id,
      doneOptionIds: [optionId(status, done)],
      resetOptionId: optionId(status, reset),
    },
    expectedRevision: date.revision,
  });
}

type Row = Record<string, TableEntryValue>;

async function insertRows(tableId: string, rows: Row[]): Promise<void> {
  await writeAgentEntries(tableId, { insert: rows.map((values) => ({ values })) });
}

// --- the starter tables ------------------------------------------------------

async function seedIdeas(): Promise<string> {
  const kept = await keptTableId('ideas');
  if (kept) return kept;
  const table = await createTable('ideas', {
    fields: [
      { name: 'idea', type: 'text' },
      {
        name: 'category',
        type: 'select',
        options: options(
          ['Product', 'blue'],
          ['Content', 'pink'],
          ['Process', 'orange'],
          ['Research', 'purple'],
          ['Personal', 'green'],
          ['Other', 'gray']
        ),
      },
      {
        name: 'status',
        type: 'select',
        options: options(
          ['New', 'blue'],
          ['Exploring', 'purple'],
          ['In progress', 'yellow'],
          ['On hold', 'orange'],
          ['Completed', 'green'],
          ['Archived', 'gray']
        ),
        default: 'New',
      },
      { name: 'priority', type: 'select', options: PRIORITY },
      { name: 'date_added', type: 'date' },
      { name: 'notes', type: 'text' },
      { name: 'related_docs', type: 'relation', ref: 'snaglet:doc', multiple: true },
    ],
  });
  return table.id;
}

async function seedTasks(): Promise<string> {
  const kept = await keptTableId('tasks');
  if (kept) return kept;
  const table = await createTable('tasks', {
    fields: [
      { name: 'due', type: 'date', calendar: await defaultCalendarId() },
      {
        name: 'status',
        type: 'select',
        options: options(['To do', 'blue'], ['In progress', 'yellow'], ['Done', 'green']),
        default: 'To do',
      },
      { name: 'priority', type: 'select', options: PRIORITY },
      { name: 'notes', type: 'text' },
    ],
    ops: [
      {
        op: 'update_field',
        name: 'name',
        set: {
          description:
            'Your general to-do list. A project can keep its own task table, like the sample project does.',
        },
      },
    ],
  });
  await completeByStatus(table, 'due', 'status', 'Done', 'To do');
  return table.id;
}

async function seedEvents(): Promise<string> {
  const kept = await keptTableId('events');
  if (kept) return kept;
  const table = await createTable('events', {
    fields: [
      { name: 'time', type: 'datetime', range: true, calendar: await defaultCalendarId() },
      { name: 'location', type: 'text' },
      { name: 'attendees', type: 'text' },
      { name: 'notes', type: 'text' },
    ],
  });
  return table.id;
}

async function seedReminders(today: string): Promise<string> {
  const kept = await keptTableId('reminders');
  if (kept) return kept;
  const table = await createTable('reminders', {
    fields: [
      { name: 'time', type: 'datetime', calendar: await defaultCalendarId() },
      { name: 'done', type: 'checkbox' },
      { name: 'notes', type: 'text' },
    ],
  });
  await insertRows(table.id, [
    {
      name: 'Water the plants',
      time: at(addDays(today, 2), '18:00'),
      done: false,
      notes: EXAMPLE_NOTE,
    },
  ]);
  return table.id;
}

/**
 * Create the workspace-level starter tables: `ideas`, `tasks` and `events`
 * blank, `reminders` with one example row. Returns their catalog ids; a name
 * already taken keeps that table (see the module comment).
 */
export async function seedStarterTables(): Promise<StarterTableIds> {
  return {
    ideas: await seedIdeas(),
    tasks: await seedTasks(),
    events: await seedEvents(),
    reminders: await seedReminders(localToday()),
  };
}

/**
 * Create the sample project's own task table, `sample_project_tasks`, inside
 * project container `projectId`, with four example rows due over the next
 * three weeks. Returns its catalog id; a name already taken keeps that table.
 */
export async function seedSampleProjectTable(projectId: string): Promise<string> {
  const kept = await keptTableId(SAMPLE_PROJECT_TABLE);
  if (kept) return kept;
  const table = await createTable(SAMPLE_PROJECT_TABLE, {
    fields: [
      { name: 'task', type: 'text' },
      {
        name: 'status',
        type: 'select',
        options: options(
          ['To do', 'blue'],
          ['In progress', 'green'],
          ['Done', 'yellow'],
          ['Blocked', 'orange']
        ),
      },
      {
        name: 'priority',
        type: 'select',
        options: options(['Low', 'blue'], ['Medium', 'green'], ['High', 'yellow']),
      },
      { name: 'due_date', type: 'date', calendar: await defaultCalendarId() },
      { name: 'notes', type: 'text' },
    ],
    ops: [
      {
        op: 'update_field',
        name: 'name',
        set: {
          description:
            "This sample project's own task list, a template for project work. Your general to-do list is the workspace tasks table.",
        },
      },
      { op: 'set_project', project_id: projectId },
    ],
  });
  await completeByStatus(table, 'due_date', 'status', 'Done', 'To do');
  const today = localToday();
  await insertRows(table.id, [
    {
      name: 'Explore the sample project',
      task: 'Look through its docs to see how it is organized',
      status: 'To do',
      priority: 'High',
      due_date: addDays(today, 2),
      notes: SAMPLE_NOTE,
    },
    {
      name: 'Customize the project overview',
      task: 'Replace the sample text with your own project details',
      status: 'To do',
      priority: 'Medium',
      due_date: addDays(today, 6),
      notes: SAMPLE_NOTE,
    },
    {
      name: 'Add your first real task',
      task: 'Add a row for something you are working on',
      status: 'To do',
      priority: 'Medium',
      due_date: addDays(today, 12),
      notes: SAMPLE_NOTE,
    },
    {
      name: 'Learn about table features',
      task: 'Try filtering, sorting and linking docs to rows',
      status: 'In progress',
      priority: 'Low',
      due_date: addDays(today, 19),
      notes: SAMPLE_NOTE,
    },
  ]);
  return table.id;
}
