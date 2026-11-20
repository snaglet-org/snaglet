import type { TableEntryValue } from '@snaglet/shared/types';
import { userTimeZone } from '@snaglet/shared/utils';
import type {
  AgentEntriesResult,
  AgentListEntriesResult,
  AgentQueryResult,
  AgentTableField,
  AgentTableProject,
  AgentTableSummary,
  AgentWriteResult,
} from '@server/domains/tables/tableAgent';
import { SQL_LIMIT } from './schemas';

const REV_PREFIX = 8;
const SYSTEM_LINE = 'system: id uuid, created_at, position (row order)';
const LIST_HINT =
  '* title, ? nullable, →t relation (→snaglet:doc etc. links Snaglet items), [] multiple, .. range (start/end), @p project home (none: workspace-wide). table {op: "read", table} for field details and a write example; {op: "read", sql} to query.';
const REV_HINT = 'to edit with a rev guard, read these with table {op: "read", table, ids}';
/** Longest title a query's item-title line prints before `…`. */
const ITEM_TITLE_MAX = 60;
const NO_TABLES = 'No tables yet. Create one with table {op: "schema", table, fields}.';
/** Options a table list shows per select field before `…+N`; `{table}` shows them all. */
const LISTED_OPTIONS = 8;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function rowCount(table: AgentTableSummary): string {
  return `${table.rows}${table.rowsCapped ? '+' : ''}`;
}

/**
 * ` @Launch`: the table's project home, or nothing for a workspace-wide
 * table. `@` is its own sign — `[]` already marks a multiple field.
 */
function projectTag(table: AgentTableSummary): string {
  return table.project ? ` @${table.project.name}` : '';
}

/** One line saying how a project thread's list is ordered. */
function scopeLine(tables: readonly AgentTableSummary[], project: AgentTableProject): string {
  const own = tables.filter((table) => table.project?.id === project.id).length;
  return `in project ${project.name}: ${plural(own, 'table', 'tables')} first, then workspace-wide, then other projects`;
}

function editable(table: AgentTableSummary): AgentTableField[] {
  return table.fields.filter((field) => !field.managed);
}

/** `(todo|doing|done)`: labels quoted only when they hold a delimiter. */
function optionList(field: AgentTableField, cap?: number): string {
  const labels = (field.options ?? []).map((option) =>
    /[|()"]/.test(option.label) ? JSON.stringify(option.label) : option.label
  );
  const shown =
    cap !== undefined && labels.length > cap
      ? [...labels.slice(0, cap), `…+${labels.length - cap}`]
      : labels;
  return `(${shown.join('|')})`;
}

/**
 * `name* text?`, `company →companies?`, `emails →emails[]`,
 * `owner →snaglet:agent?`, `briefs →snaglet:doc[]`,
 * `status select(todo|done)?`, `tags select[](a|b)`, `stay date..?`.
 */
function fieldToken(field: AgentTableField, optionCap?: number): string {
  const title = field.isTitle ? '*' : '';
  if (field.type === 'select') {
    const shape = field.multiple ? '[]' : '';
    const optional = !field.multiple && field.nullable ? '?' : '';
    return `${field.name}${title} select${shape}${optionList(field, optionCap)}${optional}`;
  }
  if (field.type === 'relation') {
    const target =
      field.refName ??
      (field.referenceKind ? `snaglet:${field.referenceKind}` : (field.referenceTableId ?? '?'));
    const shape = field.multiple ? '[]' : field.nullable ? '?' : '';
    return `${field.name}${title} →${target}${shape}`;
  }
  const range = field.range ? '..' : '';
  const repeats = field.recurrence ? ' ↻' : '';
  return `${field.name}${title} ${field.type}${range}${field.nullable ? '?' : ''}${repeats}`;
}

/** One quiet line naming archived items, or nothing. */
function archivedLine(names: readonly string[], restore: string): string[] {
  return names.length ? [`archived (${restore}): ${names.join(', ')}`] : [];
}

/**
 * One line per table. `project` is the calling thread's project: the domain
 * lists its tables first, and a leading line says so.
 */
export function renderTableList(
  tables: AgentTableSummary[],
  archivedTables: readonly string[] = [],
  project: AgentTableProject | null = null
): string {
  const archived = archivedLine(archivedTables, 'restore_table');
  if (!tables.length) return [NO_TABLES, ...archived].join('\n');
  const lines = tables.map(
    (table) =>
      `${table.name} (${rowCount(table)})${projectTag(table)}: ${editable(table)
        .map((field) => fieldToken(field, LISTED_OPTIONS))
        .join(', ')}`
  );
  return [...(project ? [scopeLine(tables, project)] : []), ...lines, ...archived, LIST_HINT].join(
    '\n'
  );
}

function hasDefault(field: AgentTableField): boolean {
  const value = field.defaultValue;
  return value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
}

/** ` calendar "Work"`: the calendar a date shows on. */
function dateSettings(field: AgentTableField): string {
  return field.calendarId
    ? ` calendar ${JSON.stringify(field.calendarName ?? field.calendarId)}`
    : '';
}

function fieldLine(field: AgentTableField): string {
  const fallback = hasDefault(field) ? ` = ${JSON.stringify(field.defaultValue)}` : '';
  const description = field.description?.replace(/\s+/g, ' ').trim();
  return `${fieldToken(field)}${dateSettings(field)}${fallback}${description ? ` — ${description}` : ''}`;
}

const PLACEHOLDERS: Readonly<Record<string, TableEntryValue>> = {
  text: 'text',
  number: '12.5',
  date: '2026-01-31',
  // No offset: read in the user's time zone. `…Z` or `±HH:MM` pins one.
  datetime: '2026-01-31T15:30',
  checkbox: true,
};

/** A range field's value: start/end (a date range's end day included). */
const RANGE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  date: '2026-01-31/2026-02-02',
  datetime: '2026-01-31T15:30/2026-01-31T17:00',
};

function placeholder(field: AgentTableField): TableEntryValue {
  if (field.type === 'relation') {
    const id = field.referenceKind ? `<${field.referenceKind} id>` : '<entry id>';
    return field.multiple ? [id] : id;
  }
  if (field.type === 'select') {
    const label = field.options?.[0]?.label ?? '<option>';
    return field.multiple ? [label] : label;
  }
  if (field.range) return RANGE_PLACEHOLDERS[field.type] ?? 'text';
  return PLACEHOLDERS[field.type] ?? 'text';
}

/** The title, then the first field of each other value shape, so every format shows once. */
function exampleLine(table: AgentTableSummary): string {
  const fields = editable(table);
  const shapes = new Set<string>();
  const picked: AgentTableField[] = [];
  for (const field of [...fields.filter((f) => f.isTitle), ...fields.filter((f) => !f.isTitle)]) {
    const shape = `${field.type}${field.referenceKind ? ':snaglet' : ''}${field.multiple ? '[]' : ''}${field.range ? '..' : ''}`;
    if (shapes.has(shape)) continue;
    shapes.add(shape);
    picked.push(field);
  }
  const values: Record<string, TableEntryValue> = {};
  for (const field of picked) {
    Object.defineProperty(values, field.name, {
      value: placeholder(field),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return `example: table ${JSON.stringify({ op: 'write', table: table.name, insert: [{ values }] })}`;
}

/** Only tables with a datetime field name the zone offset-less values and SQL output use. */
function zoneLine(table: AgentTableSummary): string[] {
  return editable(table).some((field) => field.type === 'datetime')
    ? [`datetimes: ISO 8601; no offset and sql output use ${userTimeZone()}`]
    : [];
}

/** Only tables with a range field say how a range's end counts and how sql shows it. */
function rangeLine(table: AgentTableSummary): string[] {
  return editable(table).some((field) => field.range)
    ? [
        'ranges (..): start/end or one value; 2026-01-31/2026-02-02 is three days (date ranges include their end); a datetime range ends at its end instant; sql shows PostgreSQL ranges, end excluded: [2026-01-31,2026-02-03)',
      ]
    : [];
}

/**
 * How to link one of the table's entries from a message, doc or field: the
 * canonical entry chip, keyed by catalog id so a table rename never breaks it.
 */
function entryLinkLine(table: AgentTableSummary): string {
  return `link an entry: [title](entry:${table.id}/<entry id>)`;
}

/**
 * The same chip form after rows an agent just read or wrote: their ids are bare uuids, and a
 * chip needs the table id in front (`entry:<tableId>/<entryId>`), which is not otherwise in sight.
 */
function rowLinkLine(tableId: string): string {
  return `link a row: [title](entry:${tableId}/<entry id>)`;
}

/** Only tables with a repeating date field say how to set and mark a repeat (docs/architecture.md). */
function repeatLine(table: AgentTableSummary): string[] {
  return editable(table).some((field) => field.recurrence)
    ? [
        'repeats (↻): write repeat [{id, field, set: {rrule} (on set days) or {rrule: "FREQ=MINUTELY;INTERVAL=90"} (datetime: every 90 min from its date; HOURLY/MINUTELY/SECONDLY, at least 1 s; under a minute the calendar does not draw it), null stops; or done: true; or skip: true, or "now" to jump an interval that is behind to its next time without logging the missed ones}]; one undo step each; read ids shows where each stands',
      ]
    : [];
}

/** Field block for `{table}` reads and schema results; `heading` overrides the default header. */
export function renderTableDetail(table: AgentTableSummary, heading?: string): string {
  const unit = table.rows === 1 && !table.rowsCapped ? 'row' : 'rows';
  const header = heading ?? `${table.name} (${rowCount(table)} ${unit})${projectTag(table)}`;
  return [
    header,
    ...editable(table).map(fieldLine),
    ...archivedLine(table.archivedFields ?? [], 'restore_field'),
    SYSTEM_LINE,
    ...(table.state ? [] : [entryLinkLine(table)]),
    ...zoneLine(table),
    ...rangeLine(table),
    ...repeatLine(table),
    ...(table.state ? [] : [exampleLine(table)]),
  ].join('\n');
}

function tsvCell(value: string | null): string {
  if (value === null) return '';
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export function renderQuery(result: AgentQueryResult, limit: number): string {
  const lines: string[] = [];
  if (result.columns.length) lines.push(result.columns.map(tsvCell).join('\t'));
  for (const row of result.rows) lines.push(row.map(tsvCell).join('\t'));
  const count = result.rows.length;
  const advice =
    limit < SQL_LIMIT.max ? 'add WHERE or raise limit' : 'add WHERE or page with OFFSET';
  lines.push(
    result.capped ? `${count} of ${count}+ rows (capped; ${advice})` : plural(count, 'row', 'rows')
  );
  if (result.itemTitles?.length) lines.push(`snaglet titles: ${itemTitleList(result.itemTitles)}`);
  // SQL cannot select a rev (the entry model computes it), so point at the read that can.
  if (count && result.columns.includes('id')) lines.push(REV_HINT);
  return lines.join('\n');
}

/** `{table, ids}` read: one line per entry with its rev prefix and full values. */
export function renderEntries(result: AgentEntriesResult): string {
  const lines = result.entries.map(
    (entry) =>
      `${entry.id} (rev ${entry.rev.slice(0, REV_PREFIX)}) ${JSON.stringify(entry.values)}${
        entry.repeats ? ` ↻ ${JSON.stringify(entry.repeats)}` : ''
      }`
  );
  if (result.missing.length) lines.push(`not found: ${result.missing.join(', ')}`);
  lines.push(`${plural(result.entries.length, 'entry', 'entries')} of ${result.table}`);
  if (result.entries.length) lines.push(rowLinkLine(result.tableId));
  return lines.join('\n');
}

/** One page of a structured read: the rows, then where the page sits and the next step. */
export function renderEntryPage(result: AgentListEntriesResult): string {
  const lines = result.entries.map(
    (entry) => `${entry.id} (rev ${entry.rev.slice(0, REV_PREFIX)}) ${JSON.stringify(entry.values)}`
  );
  const first = (result.page - 1) * result.pageSize + 1;
  lines.push(
    result.entries.length
      ? `rows ${first}-${first + result.entries.length - 1} of ${result.total} in ${result.table}${
          result.hasMore ? `; more: page ${result.page + 1}` : ''
        }`
      : `no rows on page ${result.page} of ${result.table} (${result.total} in all)`
  );
  if (result.entries.length) lines.push(rowLinkLine(result.tableId));
  return lines.join('\n');
}

/** `doc-… "Launch brief", clio "Clio" (archived)`: ids with their items' titles. */
function itemTitleList(items: NonNullable<AgentQueryResult['itemTitles']>): string {
  return items
    .map(({ id, title, archived }) => {
      const shown =
        title.length > ITEM_TITLE_MAX ? `${title.slice(0, ITEM_TITLE_MAX - 1)}…` : title;
      return `${id} ${JSON.stringify(shown)}${archived ? ' (archived)' : ''}`;
    })
    .join(', ');
}

function revised(items: { id: string; rev: string }[]): string {
  return items.map(({ id, rev }) => `${id} (rev ${rev.slice(0, REV_PREFIX)})`).join(', ');
}

export function renderWrite(result: AgentWriteResult): string {
  const lines: string[] = [];
  const group = (label: string, count: number, listed: string): void => {
    if (count) lines.push(`${label} ${count}: ${listed}`);
  };
  group('inserted', result.inserted.length, revised(result.inserted));
  group('existing', result.existing.length, revised(result.existing));
  group('updated', result.updated.length, revised(result.updated));
  group('unchanged', result.unchanged.length, result.unchanged.join(', '));
  for (const item of result.repeats ?? [])
    lines.push(
      `repeat ${item.id} (rev ${item.rev.slice(0, REV_PREFIX)}) ${item.field}: ${item.repeat}`
    );
  if (result.inserted.length || result.existing.length || result.updated.length)
    lines.push(rowLinkLine(result.tableId));
  return lines.length ? lines.join('\n') : 'no changes';
}

/** Names render when the domain supplies them; ids are the fallback. */
export interface ClearedLinks {
  tableId: string;
  fieldId: string;
  count: number;
  tableName?: string;
  fieldName?: string;
}

export function renderDelete(result: {
  deletedIds: string[];
  alreadyDeleted: string[];
  clearedReferences: ClearedLinks[];
}): string {
  const parts = [`deleted ${result.deletedIds.length}`];
  if (result.alreadyDeleted.length) parts.push(`already gone ${result.alreadyDeleted.length}`);
  if (result.clearedReferences.length) {
    const links = result.clearedReferences.map(
      (ref) => `${ref.tableName ?? ref.tableId}.${ref.fieldName ?? ref.fieldId} ${ref.count}`
    );
    parts.push(`links cleared: ${links.join(', ')}`);
  }
  return parts.join(', ');
}
