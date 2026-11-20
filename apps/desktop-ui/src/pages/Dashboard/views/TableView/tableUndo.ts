import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
} from 'react';
import type { TableHistoryStep } from '@snaglet/shared/types';
import {
  stepTableHistory,
  useTableHistory,
  type TableHistoryDirection,
  type TableHistoryPrepared,
  type TableHistorySnapshot,
} from '@desktop/features/database/tableHistory';
import { usePaneIsActive } from '@desktop/features/pane-find/PaneFindContext';

export interface TableUndoController extends TableHistorySnapshot {
  tableId: string;
  /**
   * Undo or redo the user's next table step. `shown` is the step a control
   * named; the server refuses if that is not the next one.
   */
  run: (direction: TableHistoryDirection, shown?: TableHistoryStep | null) => Promise<void>;
  /** Set by the entries grid: saves (and closes) its open row before a step. */
  prepareRef: MutableRefObject<(() => Promise<TableHistoryPrepared>) | null>;
}

const TableUndoContext = createContext<TableUndoController | null>(null);
export const TableUndoProvider = TableUndoContext.Provider;

/** The table pane's undo controls; null outside a table pane. */
export function useTableUndo(): TableUndoController | null {
  return useContext(TableUndoContext);
}

/** "Undo edit title in reading_list" from the step label "Edit title in reading_list". */
export function stepActionLabel(verb: 'Undo' | 'Redo', step: TableHistoryStep): string {
  return `${verb} ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}`;
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/**
 * Focus in a text field, textarea, select or rich editor (a cell editor
 * included) keeps Cmd/Ctrl+Z for its own text undo.
 */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target.isContentEditable) return true;
  // jsdom lacks isContentEditable; rich-editor children sit inside the host.
  return (
    target.closest(
      '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]'
    ) !== null
  );
}

/**
 * Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z for the active table pane. It stands
 * down for text editing, an open dialog, focus in the Dashboard sidebar
 * (whose workspace tree has its own undo), and when there is no step to
 * take, so those keys fall through as before. Handled keys stop there, so
 * the workspace tree's window listener does not replay them too.
 */
function useTableUndoShortcuts(
  enabled: boolean,
  snapshot: TableHistorySnapshot,
  run: (direction: TableHistoryDirection) => void
): void {
  const latest = useRef({ snapshot, run });
  latest.current = { snapshot, run };
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z')
        return;
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      const focused = document.activeElement;
      if (isTextEditingTarget(event.target) || isTextEditingTarget(focused)) return;
      if (focused instanceof Element && focused.closest('#dashboard-sidebar')) return;
      const direction = event.shiftKey ? 'redo' : 'undo';
      const { snapshot: current, run: step } = latest.current;
      if (!current.busy && !current[direction]) return;
      event.preventDefault();
      event.stopPropagation();
      step(direction);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}

/**
 * The table pane's undo controller: the user's next steps, running them
 * (after the grid saves its open row), and the pane's shortcuts while the
 * pane is active. Built-in tables pass `enabled: false`.
 */
export function useTableUndoController(tableId: string, enabled: boolean): TableUndoController {
  const snapshot = useTableHistory(enabled);
  const prepareRef = useRef<(() => Promise<TableHistoryPrepared>) | null>(null);
  const active = usePaneIsActive();
  const run = useCallback(
    (direction: TableHistoryDirection, shown?: TableHistoryStep | null) =>
      stepTableHistory(direction, {
        expected: shown,
        tableId,
        prepare: () => prepareRef.current?.() ?? Promise.resolve('ready'),
      }),
    [tableId]
  );
  useTableUndoShortcuts(enabled && active, snapshot, (direction) => void run(direction));
  return useMemo(() => ({ ...snapshot, tableId, run, prepareRef }), [snapshot, tableId, run]);
}
