import { useCallback, useRef, useState } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { FetchError, tablesApi } from '@desktop/utils/api';
import { emitTableEvent } from './tableEvents';
import { isTableCatalogEntry } from './tableLifecycle';

export interface TableProjectLinkOptions {
  /**
   * Hears every refusal as it happens, with the same message `error`
   * holds — for a surface that reports through a toast rather than inline.
   */
  onError?: (message: string) => void;
}

export interface TableProjectLink {
  /** Catalog id of the table whose link is being saved, or null while idle. */
  savingTableId: string | null;
  /** The server's message for the last failed link, until the next attempt. */
  error: string | null;
  clearError: () => void;
  /**
   * Link a custom table to a project, or unlink it (`null` = workspace-wide).
   * Resolves true when the table is now where asked (including when it
   * already was, with no request) and false when the server refused or a
   * save is already in flight; built-in tables never send a request.
   */
  setProject: (table: TableCatalogEntry, projectId: string | null) => Promise<boolean>;
}

/** The current entry a refusal carries in `details.table`, when it does. */
export function currentEntryFromError(err: unknown): TableCatalogEntry | null {
  if (!(err instanceof FetchError)) return null;
  const { details } = err;
  if (typeof details !== 'object' || details === null || !('table' in details)) return null;
  return isTableCatalogEntry(details.table) ? details.table : null;
}

/**
 * One table's project link, shared by the workspace tree's project rows and
 * Tables headers (a dropped `table` chip) and the table pane's project
 * picker. Dragged sidebar rows move through `placeTable` instead. A successful change announces the returned entry
 * on the table bus, so every sidebar regroups the table and every open pane
 * relabels it; a refusal that carries the table's current entry announces
 * that instead, so a stale row catches up. The link is placement, not
 * content: it is not a step in the undo history.
 */
export function useTableProjectLink({ onError }: TableProjectLinkOptions = {}): TableProjectLink {
  const [savingTableId, setSavingTableId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const clearError = useCallback(() => setError(null), []);

  const setProject = useCallback(
    async (table: TableCatalogEntry, projectId: string | null): Promise<boolean> => {
      if (table.origin !== 'custom' || inFlightRef.current) return false;
      setError(null);
      if (table.projectId === projectId) return true;
      inFlightRef.current = true;
      setSavingTableId(table.id);
      try {
        const response = await tablesApi.setProject(table.id, projectId);
        emitTableEvent({ type: 'table.updated', table: response.table });
        return true;
      } catch (err) {
        const current = currentEntryFromError(err);
        if (current?.id === table.id) emitTableEvent({ type: 'table.updated', table: current });
        const message = getErrorMessage(err, 'Failed to move table');
        setError(message);
        onErrorRef.current?.(message);
        return false;
      } finally {
        inFlightRef.current = false;
        setSavingTableId(null);
      }
    },
    []
  );

  return { savingTableId, error, clearError, setProject };
}
