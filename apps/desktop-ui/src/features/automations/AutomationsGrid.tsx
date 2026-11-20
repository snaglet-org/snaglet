/**
 * The Automations view (the built-in Automations table): every automation
 * with its status, timing in words, next run, agent, thread, calendar and last result.
 * Cells are read-only; changes go through the row actions (Pause / Resume,
 * Run now, Edit, Archive) and the Edit form, all via /api/automations, each
 * with Undo instead of a confirmation. Archived (canceled) ones are hidden
 * unless "Show archived" is on; Restore brings one back. Refreshes on
 * `automations:changed` through the shared list ({@link useAutomations}).
 */
import { useEffect, useRef, useState } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Checkbox, EmptyState } from '@desktop/components';
import { showToast } from '@desktop/utils/toast';
import { cn } from '@desktop/utils/classNames';
import {
  automationStatusText,
  deleteAutomation,
  formatAutomationNextRun,
  lastResultText,
  pauseAutomation,
  restoreAutomation,
  resumeAutomation,
  runAutomationNow,
  toastUndoAndReload,
  type OfferUndo,
} from './automationActions';
import { AutomationEditForm } from './AutomationEditForm';
import { loadAutomations, upsertAutomation, useAutomations } from './automationsStore';
import { useActionFocusReturn } from './useActionFocusReturn';
import styles from './AutomationsGrid.module.scss';

const COLUMNS = [
  'Name',
  'Status',
  'When',
  'Next run',
  'Agent',
  'Thread',
  'Calendar',
  'Last result',
];

export function AutomationsGrid() {
  const { automations: rows, error } = useAutomations();
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<AutomationRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The shared list stays live on its own; opening the grid reads it fresh.
  useEffect(() => {
    void loadAutomations();
  }, []);

  // Pause and Resume, Archive and Restore swap the pressed button; when it is
  // gone, focus goes to the row's first action.
  const tableRef = useRef<HTMLTableElement>(null);
  const focusRowId = useRef<string | null>(null);
  const captureFocus = useActionFocusReturn(busyId !== null, rows, () =>
    Array.from(tableRef.current?.rows ?? [])
      .find((tr) => tr.dataset.automationId === focusRowId.current)
      ?.querySelector<HTMLElement>(`.${styles.actions} button:not(:disabled)`)
  );

  const act = async (
    a: AutomationRecord,
    action: (a: AutomationRecord, offer: OfferUndo) => Promise<AutomationRecord>,
    failure: string
  ) => {
    focusRowId.current = a.id;
    captureFocus(tableRef.current);
    setBusyId(a.id);
    try {
      upsertAutomation(await action(a, toastUndoAndReload));
    } catch (err) {
      showToast(getErrorMessage(err, failure));
    } finally {
      setBusyId(null);
    }
  };

  if (error && !rows) {
    return <EmptyState title="Couldn't load automations" body={error} />;
  }
  if (!rows) return <p className={styles.loading}>Loading…</p>;

  const visible = rows.filter((a) => showDeleted || a.status !== 'cancelled');
  const deletedCount = rows.filter((a) => a.status === 'cancelled').length;

  return (
    <div className={styles.shell}>
      <div className={styles.toolbar}>
        <span className={styles.count}>
          {visible.length === 1 ? '1 automation' : `${visible.length} automations`}
        </span>
        {deletedCount > 0 && (
          <Checkbox checked={showDeleted} onChange={setShowDeleted} size="sm">
            Show archived ({deletedCount})
          </Checkbox>
        )}
      </div>
      {visible.length === 0 ? (
        <EmptyState
          title="No automations yet"
          body="Ask an agent to check back later or every morning, and it shows up here."
        />
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table} aria-label="Automations" ref={tableRef}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => {
                const busy = busyId === a.id;
                return (
                  <tr
                    key={a.id}
                    data-automation-id={a.id}
                    className={cn(a.status !== 'active' && styles.inactive)}
                  >
                    <td className={styles.name} title={a.prompt}>
                      {a.name}
                    </td>
                    <td>{automationStatusText(a)}</td>
                    <td>{a.whenText}</td>
                    <td>{formatAutomationNextRun(a)}</td>
                    <td>{a.agentName ?? a.agentId}</td>
                    <td>{a.threadTitle ?? 'Untitled thread'}</td>
                    <td>{a.calendarTitle ? a.calendarTitle : '—'}</td>
                    <td className={styles.result} title={a.lastRun?.error ?? undefined}>
                      {lastResultText(a)}
                    </td>
                    <td className={styles.actions}>
                      {a.status === 'active' && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void act(a, pauseAutomation, "Couldn't pause")}
                        >
                          Pause
                        </Button>
                      )}
                      {a.status === 'paused' && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void act(a, resumeAutomation, "Couldn't resume")}
                        >
                          Resume
                        </Button>
                      )}
                      {a.status === 'cancelled' ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void act(a, restoreAutomation, "Couldn't restore")}
                        >
                          Restore
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void act(a, runAutomationNow, "Couldn't run")}
                          >
                            Run now
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setEditing(a)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void act(a, deleteAutomation, "Couldn't archive")}
                          >
                            Archive
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <AutomationEditForm
          automation={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            upsertAutomation(saved);
            showToast(`Saved ${saved.name}`);
          }}
        />
      )}
    </div>
  );
}
