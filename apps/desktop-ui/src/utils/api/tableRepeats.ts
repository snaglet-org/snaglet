/**
 * Per-row repeats on a table's repeating date field:
 * `/api/tables/:id/entries/:entryId/repeats…` and the per-log-entry undo at
 * `/api/tables/:id/entries/:entryId/occurrences/:occurrenceId/undo`.
 *
 * Every write sends the entry's `expectedRevision` and the table's
 * `schemaVersion`; a 409 means the row changed since it was loaded (refetch
 * and tell the user, see {@link isStaleRepeatError}). Wall times throughout:
 * `YYYY-MM-DD` for date fields, `YYYY-MM-DDTHH:MM[:SS]` for datetime fields,
 * never through UTC midnight.
 */

import type { TableEntryResponse } from '@snaglet/shared/types';
import type { TableRepeat } from '@snaglet/shared/utils';
import { FetchError, fetchData, getApiUrl } from './core';

// Local copies of the server shapes. Source of truth: `@snaglet/db`
// `packages/db/tables/table_entries/repeats.ts` (OccurrenceLogRow) and
// `TableEntriesModel.ts` (EntryRepeatsView, RepeatActionResult). These are
// not in `@snaglet/shared/types` yet; keep them in sync by hand.

type OccurrenceKind = 'done' | 'skipped' | 'moved';

export interface OccurrenceLogRow {
  /** `tocc-…` */
  id: string;
  tableId: string;
  fieldId: string;
  entryId: string;
  /** The planned occurrence (wall time). */
  occurrence: string;
  kind: OccurrenceKind;
  /** Where a moved occurrence went (wall time); null for done / skipped. */
  movedTo: string | null;
  actorKind: string | null;
  actorId: string | null;
  /** ISO instant. */
  createdAt: string;
}

export interface EntryRepeatsView {
  entryId: string;
  revision: string;
  /** By field id. */
  repeats: Record<string, TableRepeat>;
  /** Newest first. */
  log: OccurrenceLogRow[];
}

/** Every repeating row of a table (GET /tables/:id/repeats). */
export interface TableRepeatsView {
  tableId: string;
  rows: Array<{
    fieldId: string;
    entryId: string;
    repeat: TableRepeat;
    /** The current occurrence's log rows (done / skipped / moved), oldest first. */
    log: OccurrenceLogRow[];
  }>;
}

export interface RepeatActionResult extends TableEntryResponse {
  fieldId: string;
  repeat: TableRepeat | null;
  /** Log rows this action added. */
  logged: OccurrenceLogRow[];
  /** Log row ids this action removed. */
  removed: string[];
  /** False when nothing changed (no history step). */
  changed: boolean;
}

export interface RepeatRevision {
  expectedRevision: string;
  schemaVersion: string;
  /** Optional guard: the repeat's `current` the client saw (null = none). */
  expectedCurrent?: string | null;
}

export interface SetRepeatInput extends RepeatRevision {
  rrule: string;
  /** Re-anchor the series here; omitted keeps dtstart/current (rule-only change). */
  date?: string;
}

export type CompleteRepeatInput = RepeatRevision;

export interface SkipRepeatInput extends RepeatRevision {
  /** Skip every past occurrence up to the next one on/after `now`. */
  toUpcoming?: boolean;
  /**
   * Jump to now (a repeat at an interval): move straight to the first
   * upcoming time without logging the missed ones, however many.
   */
  jump?: boolean;
  now?: string;
}

export interface MoveRepeatInput extends RepeatRevision {
  /** Defaults to the current occurrence. */
  occurrence?: string;
  to: string;
}

function entryPath(tableId: string, entryId: string): string {
  return `/tables/${encodeURIComponent(tableId)}/entries/${encodeURIComponent(entryId)}`;
}

function repeatPath(tableId: string, entryId: string, fieldId: string): string {
  return `${entryPath(tableId, entryId)}/repeats/${encodeURIComponent(fieldId)}`;
}

function post<T>(path: string, body: object): Promise<T> {
  return fetchData<T>(getApiUrl(path), { method: 'POST', body: JSON.stringify(body) });
}

export const tableRepeatsApi = {
  /** Every repeating row of the table with its current occurrence's log, for the grid and Board. */
  list: (tableId: string) =>
    fetchData<TableRepeatsView>(getApiUrl(`/tables/${encodeURIComponent(tableId)}/repeats`)),

  /** The entry's repeats by field and its occurrence log (newest first). */
  get: (tableId: string, entryId: string) =>
    fetchData<EntryRepeatsView>(getApiUrl(`${entryPath(tableId, entryId)}/repeats`)),

  /** Sets or replaces the repeat: on set days. */
  set: (tableId: string, entryId: string, fieldId: string, input: SetRepeatInput) =>
    fetchData<RepeatActionResult>(getApiUrl(repeatPath(tableId, entryId, fieldId)), {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  /** Stops repeating. The occurrence log is kept. */
  clear: (tableId: string, entryId: string, fieldId: string, input: RepeatRevision) => {
    const params = new URLSearchParams({
      expectedRevision: input.expectedRevision,
      schemaVersion: input.schemaVersion,
    });
    if (input.expectedCurrent !== undefined && input.expectedCurrent !== null)
      params.set('expectedCurrent', input.expectedCurrent);
    return fetchData<RepeatActionResult>(
      getApiUrl(`${repeatPath(tableId, entryId, fieldId)}?${params}`),
      { method: 'DELETE' }
    );
  },

  /** Logs the current occurrence done and advances the row. */
  complete: (tableId: string, entryId: string, fieldId: string, input: CompleteRepeatInput) =>
    post<RepeatActionResult>(`${repeatPath(tableId, entryId, fieldId)}/complete`, input),

  skip: (tableId: string, entryId: string, fieldId: string, input: SkipRepeatInput) =>
    post<RepeatActionResult>(`${repeatPath(tableId, entryId, fieldId)}/skip`, input),

  /** Moves one occurrence (only this one). */
  move: (tableId: string, entryId: string, fieldId: string, input: MoveRepeatInput) =>
    post<RepeatActionResult>(`${repeatPath(tableId, entryId, fieldId)}/move`, input),

  /** Moves this and all upcoming occurrences by the same offset. 400 for fixed-day rules. */
  shift: (tableId: string, entryId: string, fieldId: string, input: MoveRepeatInput) =>
    post<RepeatActionResult>(`${repeatPath(tableId, entryId, fieldId)}/shift`, input),

  /** Undoes one history entry (done / skipped / moved) as its own undoable step. */
  undoOccurrence: (
    tableId: string,
    entryId: string,
    occurrenceId: string,
    input: RepeatRevision & { fieldId: string }
  ) =>
    post<RepeatActionResult>(
      `${entryPath(tableId, entryId)}/occurrences/${encodeURIComponent(occurrenceId)}/undo`,
      input
    ),
};

/** A 409: the row (or schema) changed since it was loaded. */
export function isStaleRepeatError(error: unknown): boolean {
  return error instanceof FetchError && error.status === 409;
}
