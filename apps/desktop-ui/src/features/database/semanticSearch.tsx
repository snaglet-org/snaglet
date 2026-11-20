import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import type { SemanticStatus, SemanticTableRow } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { tablesApi } from '@desktop/utils/api';
import styles from './semanticSearch.module.scss';

/** Most rows a table indexes without asking; matches the server's SEMANTIC_ROW_CAP. */
const SEMANTIC_AUTO_ROW_CAP = 10_000;

/** The rule, as the Embeddings pane states it. */
export const SEMANTIC_DEFAULT_RULE =
  'Tables up to 10,000 rows are indexed automatically; bigger ones are off until you turn them on.';

/** What a switch reads from either the table's status or its overview row. */
export type SemanticSwitchState = Pick<
  SemanticStatus & SemanticTableRow,
  | 'tableId'
  | 'enabled'
  | 'rows'
  | 'rowsCapped'
  | 'needsConfirmation'
  | 'indexed'
  | 'state'
  | 'awaitingConfirm'
  | 'paused'
  | 'estimate'
>;

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function rowsLabel(state: Pick<SemanticSwitchState, 'rows' | 'rowsCapped'>): string {
  return `${count(state.rows)}${state.rowsCapped ? '+' : ''} ${state.rows === 1 ? 'row' : 'rows'}`;
}

/**
 * One line under the switch: "N of M rows indexed · ~X MB", "Indexing… N of
 * M rows · ~X MB" while building, or what turning it on would take.
 */
export function semanticStatusLine(state: SemanticSwitchState): string {
  if (!state.enabled) {
    return state.needsConfirmation
      ? `Off · ${rowsLabel(state)}, more than the ${count(SEMANTIC_AUTO_ROW_CAP)} indexed automatically (${state.estimate.label})`
      : `Off · ${rowsLabel(state)}`;
  }
  const progress = `${count(state.indexed)} of ${rowsLabel(state)}`;
  if (state.state === 'indexing' && !state.paused)
    return `Indexing… ${progress} · ${state.estimate.label}`;
  return `${progress} indexed · ${state.estimate.label}`;
}

/** True while the server is building: worth polling for progress. */
export function isSemanticBuilding(state: SemanticSwitchState): boolean {
  return state.enabled && state.state === 'indexing' && !state.paused;
}

export interface SemanticSwitch {
  /** The Switch's onChange: on above the cap asks first instead of saving. */
  toggle: (next: boolean) => void;
  /** "Turn on anyway": on with `confirm`. */
  confirm: () => void;
  cancel: () => void;
  /** Turning on above the cap is waiting for the second click. */
  confirming: boolean;
  saving: boolean;
  error: string | null;
}

/**
 * The per-table "Search by meaning" switch: on, off, and the in-line second
 * click a table over the row cap needs. `onStatus` gets the server's answer.
 */
export function useSemanticSwitch(
  state: Pick<SemanticSwitchState, 'tableId' | 'needsConfirmation'>,
  onStatus: (status: SemanticStatus) => void
): SemanticSwitch {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { tableId, needsConfirmation } = state;

  const save = useCallback(
    async (enabled: boolean, confirm: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const status = await tablesApi.setSemanticSearch(
          tableId,
          confirm ? { enabled, confirm } : { enabled }
        );
        if (!mounted.current) return;
        setConfirming(false);
        onStatus(status);
      } catch (err) {
        if (mounted.current) setError(getErrorMessage(err, 'Could not change search by meaning'));
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [tableId, onStatus]
  );

  return {
    toggle: (next) => {
      setError(null);
      if (next && needsConfirmation) {
        setConfirming(true);
        return;
      }
      setConfirming(false);
      void save(next, false);
    },
    confirm: () => void save(true, true),
    cancel: () => setConfirming(false),
    confirming,
    saving,
    error,
  };
}

/**
 * The in-line second step for a table over the cap, under its status line
 * (which already says it is over the cap): the size, then "Turn on anyway".
 * `held`: the table is on but grew past the cap, and its paused reason above
 * already names the size, so only the button shows (nothing to cancel).
 */
export const SemanticConfirm: FC<{
  state: Pick<SemanticSwitchState, 'rows' | 'rowsCapped' | 'estimate'>;
  control: SemanticSwitch;
  held?: boolean;
}> = ({ state, control, held = false }) => (
  <div className={styles.confirm}>
    {!held && (
      <p className={styles.confirmText}>
        Indexing all {rowsLabel(state)} takes {state.estimate.label}
        {state.rowsCapped ? ' or more' : ''} on disk.
      </p>
    )}
    <div className={styles.confirmActions}>
      <Button
        size="sm"
        variant="primary"
        loading={control.saving}
        loadingText="Turning on…"
        onClick={control.confirm}
      >
        Turn on anyway ({state.estimate.label})
      </Button>
      {!held && (
        <Button size="sm" variant="ghost" disabled={control.saving} onClick={control.cancel}>
          Cancel
        </Button>
      )}
    </div>
  </div>
);
