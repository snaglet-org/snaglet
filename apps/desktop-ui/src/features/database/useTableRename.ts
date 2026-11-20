import { useCallback, useRef, useState } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage, tableNameProblem } from '@snaglet/shared/utils';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { emitTableEvent } from './tableEvents';
import { isTableCatalogEntry } from './tableLifecycle';

interface RenameSession {
  tableId: string;
  /** The name the edit started from; the list keeps its place by it. */
  originalName: string;
  /** Sent as `expectedName`; advances when a stale 409 reports the current name. */
  expectedName: string;
  value: string;
  attempted: boolean;
}

export interface TableRename {
  /** Catalog id being renamed, or null while idle. */
  tableId: string | null;
  originalName: string | null;
  /** The typed name (for controlled inputs). */
  value: string;
  saving: boolean;
  /** Server message, else the live name-policy problem. */
  error: string | null;
  /** Start editing a custom table; ignored for built-ins or mid-save. */
  begin: (table: TableCatalogEntry) => void;
  /** Mirror a keystroke; clears a previous server error. */
  change: (value: string) => void;
  /**
   * Submit once. Resolves true when editing is over (renamed, or nothing
   * changed) and false when the field should stay open with the typed text
   * (invalid name, failed save, or a save already in flight).
   */
  submit: (value: string) => Promise<boolean>;
  /** Abandon the edit; ignored while a save is in flight. */
  cancel: () => void;
}

/** The current entry a stale-rename 409 carries in `details.table`. */
function currentEntryFromConflict(err: unknown): TableCatalogEntry | null {
  if (!(err instanceof FetchError) || err.status !== 409) return null;
  const { details } = err;
  if (typeof details !== 'object' || details === null || !('table' in details)) return null;
  return isTableCatalogEntry(details.table) ? details.table : null;
}

/**
 * A 409 message plus the way back: Escape keeps the name the table has now,
 * so a taken or stale name never leaves the user guessing what it is.
 */
function conflictMessage(message: string, currentName: string): string {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `${sentence} Escape keeps "${currentName}".`;
}

/**
 * One in-place rename of a custom Database table, shared by the sidebar row,
 * the pane top bar and the table pane title. Names follow the shared
 * `tableNameProblem` policy, and each of those inputs passes `formatTableName`
 * as its `format` so typed capitals and spaces are fixed rather than flagged;
 * submitting the unchanged name is a no-op with no request. A ref guard keeps
 * a burst of Enter presses (or Enter then blur) to one PATCH.
 *
 * Success and stale conflicts both announce the entry on the table bus, so
 * every sidebar and open pane patches its label in place. After a stale 409
 * the field keeps the typed text and the server's "renamed to X" message;
 * submitting again deliberately renames from the name now shown. Every 409
 * (stale or taken) also names the current name that Escape keeps.
 */
export function useTableRename(): TableRename {
  const [session, setSession] = useState<RenameSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const begin = useCallback((table: TableCatalogEntry) => {
    if (table.origin !== 'custom' || inFlightRef.current) return;
    setServerError(null);
    setSession({
      tableId: table.id,
      originalName: table.name,
      expectedName: table.name,
      value: table.name,
      attempted: false,
    });
  }, []);

  const change = useCallback((value: string) => {
    setServerError(null);
    setSession((current) => (current ? { ...current, value } : current));
  }, []);

  const cancel = useCallback(() => {
    if (inFlightRef.current) return;
    setServerError(null);
    setSession(null);
  }, []);

  const submit = useCallback(async (value: string): Promise<boolean> => {
    const current = sessionRef.current;
    if (!current || inFlightRef.current) return false;
    const name = value.trim();
    if (name === current.expectedName) {
      setServerError(null);
      setSession(null);
      return true;
    }
    setSession({ ...current, value, attempted: true });
    if (tableNameProblem(name)) return false;

    inFlightRef.current = true;
    setSaving(true);
    setServerError(null);
    try {
      const { table } = await tablesApi.rename(current.tableId, {
        name,
        expectedName: current.expectedName,
      });
      emitTableEvent({ type: 'table.updated', table });
      setSession((latest) => (latest?.tableId === current.tableId ? null : latest));
      return true;
    } catch (err) {
      const message = getErrorMessage(err, 'Could not rename the table');
      const latest = currentEntryFromConflict(err);
      const stale = latest !== null && latest.id === current.tableId;
      if (stale) {
        emitTableEvent({ type: 'table.updated', table: latest });
        setSession((open) =>
          open?.tableId === latest.id ? { ...open, expectedName: latest.name } : open
        );
      }
      const conflict = err instanceof FetchError && err.status === 409;
      setServerError(
        conflict ? conflictMessage(message, stale ? latest.name : current.expectedName) : message
      );
      return false;
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }, []);

  let error = serverError;
  if (!error && session) {
    const trimmed = session.value.trim();
    // An empty name only complains after a submit; other problems show as
    // soon as the user types. The untouched current name is never flagged,
    // even when it predates the policy.
    const problem = trimmed === session.expectedName ? null : tableNameProblem(session.value);
    if (problem && (session.attempted || trimmed.length > 0)) error = problem;
  }

  return {
    tableId: session?.tableId ?? null,
    originalName: session?.originalName ?? null,
    value: session?.value ?? '',
    saving,
    error,
    begin,
    change,
    submit,
    cancel,
  };
}
