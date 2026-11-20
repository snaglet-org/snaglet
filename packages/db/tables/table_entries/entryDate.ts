import type { TableEntryWhereOperator, TableField } from '@snaglet/shared/types';
import { isRange } from '../table_fields/fieldSchema';
import { entryWhereCondition } from './entryWhere';
import { stem, STOP_WORDS } from './tableMatch';

/**
 * A range of calendar days in the user's zone: `from` inclusive, `to` exclusive
 * (`YYYY-MM-DD`). An end that is null is open ("before June" has no `from`).
 */
export interface DateRange {
  from: string | null;
  to: string | null;
  /** Which way it lies from today: past ranges list newest first, the rest soonest first. */
  direction: 'past' | 'current' | 'future';
}

const MIN_WORD = 3;

/** A word that says nothing about what to find ("what", "is", "my", a one- or two-letter word). */
export function isFillerWord(text: string): boolean {
  const word = text.trim().toLowerCase();
  return word.length < MIN_WORD || STOP_WORDS.has(word) || STOP_WORDS.has(stem(word));
}

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const CREATED_WORDS = new Set(['created', 'added', 'made', 'entered']);

/**
 * The date fields a month phrase applies to in one table, and the query words
 * that said so (so they are not also required to appear in a row):
 * - "created" or "added" in the query: the row's creation time;
 * - a word of a date field's name ("due" for `due`, "start" for `starts`): that field;
 * - otherwise every date field the table has (a row counts when any falls in the
 *   range), or, with none, the creation time.
 */
export function pickDateFields(
  fields: readonly TableField[],
  termTexts: readonly string[]
): { fields: TableField[]; consumed: Set<string> } {
  const created = fields.find((field) => field.managed && field.columnName === 'created_at');
  const dated = fields.filter(
    (field) => !field.managed && (field.type === 'date' || field.type === 'datetime')
  );
  const consumed = new Set<string>();
  const stems = new Map(termTexts.map((text) => [stem(text.toLowerCase()), text.toLowerCase()]));

  const createdHint = termTexts.filter((text) => CREATED_WORDS.has(text.toLowerCase()));
  if (created && createdHint.length) {
    for (const text of createdHint) consumed.add(text.toLowerCase());
    return { fields: [created], consumed };
  }
  const hinted = dated.filter((field) => nameWords(field.name).some((w) => stems.has(stem(w))));
  if (hinted.length) {
    for (const field of hinted)
      for (const word of nameWords(field.name)) {
        const original = stems.get(stem(word));
        if (original) consumed.add(original);
      }
    return { fields: hinted, consumed };
  }
  if (dated.length) return { fields: dated, consumed };
  return { fields: created ? [created] : [], consumed };
}

/** SQL for "any of these fields falls in the range", or `false` when there is no field. */
export function dateRangeCondition(
  fields: readonly TableField[],
  range: DateRange,
  param: (value: unknown) => string
): string {
  if (!fields.length) return 'false';
  const parts = fields.map((field) => {
    const bounds = [
      ...(range.from
        ? [
            {
              fieldId: field.id,
              operator: 'on_or_after' as TableEntryWhereOperator,
              value: range.from,
            },
          ]
        : []),
      ...(range.to
        ? [{ fieldId: field.id, operator: 'before' as TableEntryWhereOperator, value: range.to }]
        : []),
    ];
    return `(${entryWhereCondition(bounds, fields, param) ?? 'true'})`;
  });
  return `(${parts.join(' OR ')})`;
}

/**
 * The `timestamp` a row sorts by for a date field: the column itself, or a
 * range column's start (a range cannot be cast to a timestamp).
 */
export function dateSortSql(field: TableField, column: string): string {
  return isRange(field) ? `lower(${column})::timestamp` : `${column}::timestamp`;
}
