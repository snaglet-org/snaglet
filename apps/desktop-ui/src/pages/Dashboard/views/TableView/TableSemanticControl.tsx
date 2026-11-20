import { useCallback, useEffect, useId, useState, type FC } from 'react';
import type { SemanticStatus, TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Popover, Switch, usePopover } from '@desktop/components';
import { LeafToggle, SearchIcon } from '@desktop/components/Icons';
import {
  isSemanticBuilding,
  SemanticConfirm,
  semanticStatusLine,
  useSemanticSwitch,
} from '@desktop/features/database/semanticSearch';
import { useGuardedInterval } from '@desktop/hooks/useGuardedInterval';
import { tablesApi } from '@desktop/utils/api';
import styles from './TableView.module.scss';

/** How often an open panel re-reads a table whose index is building. */
const BUILDING_POLL_MS = 2000;
/** A failed first read is tried once more after this long before the control stays hidden. */
const FIRST_READ_RETRY_MS = 2000;

/**
 * The custom table's "Search by meaning" switch, on the heading line after
 * the project control: the trigger says On or Off and opens a small panel
 * with the switch and one status line (rows indexed and size, "Indexing…"
 * while building, or why building is paused). A table over the row cap asks
 * in-line before it turns on; one that grew past the cap after it was turned
 * on shows why building waits and the same "Turn on anyway" button. The panel
 * re-reads the status while it is open and building. Custom tables only (Snaglet
 * tables have no rows to index); hidden until the status loads, and when it
 * cannot after one retry.
 */
export const TableSemanticControl: FC<{ table: TableCatalogEntry }> = ({ table }) => {
  const tableId = table.id;
  const custom = table.origin === 'custom';
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const panel = usePopover();
  const statusId = useId();

  // A failed read leaves the control as it was (hidden before the first
  // load), so it never takes the table pane down with it. True when it loaded.
  const refresh = useCallback(
    async (signal?: { canceled: boolean }): Promise<boolean> => {
      try {
        const next = await tablesApi.semanticStatus(tableId);
        if (!signal?.canceled) setStatus(next);
        return true;
      } catch (err) {
        console.warn('[tables] search by meaning status did not load:', getErrorMessage(err));
        return false;
      }
    },
    [tableId]
  );

  useEffect(() => {
    setStatus(null);
    if (!custom) return;
    const signal = { canceled: false };
    let retry: number | undefined;
    void refresh(signal).then((loaded) => {
      // A transient failure (the server restarting) gets one more try.
      if (!loaded && !signal.canceled)
        retry = window.setTimeout(() => void refresh(signal), FIRST_READ_RETRY_MS);
    });
    return () => {
      signal.canceled = true;
      window.clearTimeout(retry);
    };
  }, [custom, refresh]);

  // Fresh numbers each time the panel opens.
  useEffect(() => {
    if (panel.open) void refresh();
  }, [panel.open, refresh]);

  const poll = useCallback(
    async (signal: { canceled: boolean }) => {
      await refresh(signal);
    },
    [refresh]
  );
  useGuardedInterval(poll, {
    intervalMs: BUILDING_POLL_MS,
    enabled: panel.open && status !== null && isSemanticBuilding(status),
  });

  const control = useSemanticSwitch(
    { tableId, needsConfirmation: status?.needsConfirmation ?? false },
    setStatus
  );

  if (!custom || !status) return null;
  const stateWord = status.enabled ? 'On' : 'Off';

  return (
    <div className={styles.semanticControl}>
      <div className={styles.semanticAnchor}>
        <Button
          variant="ghost"
          size="sm"
          className={styles.semanticTrigger}
          leftIcon={<SearchIcon />}
          rightIcon={<LeafToggle open={panel.open} className={styles.semanticCaret} />}
          aria-haspopup="dialog"
          {...panel.triggerProps}
        >
          Search by meaning: {stateWord}
        </Button>
        <Popover
          open={panel.open}
          label="Search by meaning"
          role="dialog"
          placement="floating"
          className={styles.semanticPanel}
          {...panel.surfaceProps}
        >
          <div className={styles.semanticRow}>
            <span className={styles.semanticLabel}>Search by meaning</span>
            <Switch
              size="md"
              checked={status.enabled}
              onChange={control.toggle}
              disabled={control.saving}
              onLabel="On"
              offLabel="Off"
              aria-label="Search by meaning"
              aria-describedby={statusId}
            />
          </div>
          <p id={statusId} className={styles.semanticStatus} aria-live="polite">
            {semanticStatusLine(status)}
          </p>
          {status.enabled && status.paused && (
            <p className={styles.semanticNote}>{status.paused}</p>
          )}
          {status.enabled && status.awaitingConfirm && (
            <SemanticConfirm state={status} control={control} held />
          )}
          {control.confirming && <SemanticConfirm state={status} control={control} />}
          {control.error && (
            <p className={styles.semanticError} role="alert">
              {control.error}
            </p>
          )}
        </Popover>
      </div>
    </div>
  );
};
