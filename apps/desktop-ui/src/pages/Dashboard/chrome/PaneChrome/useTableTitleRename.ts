import { useEffect } from 'react';
import { formatTableName } from '@snaglet/shared/utils';
import { useTableRename } from '@desktop/features/database';
import { getCachedTableEntry, useLiveTableName } from '@desktop/features/database/tableNameCache';
import type { DetailSelection } from '../../selection/types';
import type { PathHeaderRename } from '../PathHeader/PathHeader';

/**
 * The pane top bar's rename for a custom Database table: the same
 * `useTableRename` session the sidebar row runs, so names follow the shared
 * policy and a refused or conflicting name keeps the field open. Snaglet tables,
 * archived tables (the server refuses to rename them), and tables missing from
 * the loaded catalog get none. Switching the pane to another table
 * abandons an open edit.
 */
export function useTableTitleRename(selection: DetailSelection): PathHeaderRename | undefined {
  const tableId = selection?.kind === 'table' ? selection.table_id : null;
  const snapshot = selection?.kind === 'table' ? selection.table : undefined;
  const live = useLiveTableName(tableId);
  const rename = useTableRename();
  const { cancel } = rename;
  useEffect(() => cancel, [tableId, cancel]);

  if (!tableId || live.unavailable || live.archived) return undefined;
  // Origin never changes; the cache is only preferred for the latest name.
  const entry = getCachedTableEntry(tableId) ?? snapshot;
  if (entry?.origin !== 'custom') return undefined;
  return {
    editing: rename.tableId === tableId,
    begin: () => rename.begin(getCachedTableEntry(tableId) ?? entry),
    submit: rename.submit,
    cancel: rename.cancel,
    change: rename.change,
    format: formatTableName,
    busy: rename.saving,
    error: rename.error,
  };
}
