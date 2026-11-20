import { useEffect, useRef, useState, type FC } from 'react';
import type { AutomationRecord } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, EmptyState } from '@desktop/components';
import {
  automationStatusText,
  deleteAutomation,
  formatAutomationNextRun,
  formatAutomationTime,
  lastResultText,
  moveAutomationToCalendar,
  pauseAutomation,
  restoreAutomation,
  resumeAutomation,
  runAutomationNow,
  toastUndoAndReload,
  type OfferUndo,
} from '@desktop/features/automations/automationActions';
import {
  AutomationCalendarPicker,
  useAutomationCalendars,
} from '@desktop/features/automations/AutomationCalendarPicker';
import { AutomationCreateForm } from '@desktop/features/automations/AutomationCreateForm';
import { AutomationEditForm } from '@desktop/features/automations/AutomationEditForm';
import { upsertAutomation, useAutomations } from '@desktop/features/automations/automationsStore';
import { RunningBadge } from '@desktop/features/automations/RunningSwirl';
import { useActionFocusReturn } from '@desktop/features/automations/useActionFocusReturn';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer';
import { showToast } from '@desktop/utils/toast';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { markdownForChatMessageRender } from '@desktop/pages/Dashboard/views/ChatView/chatMarkdown';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';
import { AutomationRunLog } from './AutomationRunLog';
import { NextRunCountdown } from './NextRunCountdown';
import styles from './AutomationPane.module.scss';

type AutomationPaneProps =
  | { create: true; onReplaceSelection?: (selection: DetailSelection) => void }
  | { create?: false; automationId: string };

/**
 * The Automations pane: one automation's details, run log, actions and Edit
 * form, or (`create`) the New automation form. Reads the shared automations
 * store, so a wake starting, an agent's change or an action elsewhere shows
 * here at once. Actions offer Undo instead of a confirmation.
 */
export const AutomationPane: FC<AutomationPaneProps> = (props) => {
  if (props.create) return <NewAutomation onReplaceSelection={props.onReplaceSelection} />;
  return <AutomationDetail automationId={props.automationId} />;
};

const NewAutomation: FC<{ onReplaceSelection?: (selection: DetailSelection) => void }> = ({
  onReplaceSelection,
}) => (
  <div className={styles.shell}>
    <header className={styles.header}>
      <h1 className={styles.title}>New automation</h1>
      <p className={styles.subtitle}>
        Wake an agent in a thread at a set time, on a repeat, or every few minutes.
      </p>
    </header>
    <div className={styles.body}>
      <AutomationCreateForm
        onCreated={(automation) => {
          upsertAutomation(automation);
          showToast(`Created ${automation.name}`);
          onReplaceSelection?.({
            kind: 'automation-detail',
            automation_id: automation.id,
            name: automation.name,
          });
        }}
      />
    </div>
  </div>
);

const AutomationDetail: FC<{ automationId: string }> = ({ automationId }) => {
  const nav = useDashboardNavigation();
  const { automations, error } = useAutomations();
  const { calendars, loaded } = useAutomationCalendars();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = automations?.find((x) => x.id === automationId);

  // Closing the inline Edit form puts focus back on Edit instead of the page.
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const refocusEdit = useRef(false);
  const closeEdit = () => {
    refocusEdit.current = true;
    setEditing(false);
  };
  useEffect(() => {
    if (editing || !refocusEdit.current) return;
    refocusEdit.current = false;
    editButtonRef.current?.focus();
  }, [editing]);

  // Pause and Resume, Archive and Restore swap the pressed button.
  const actionsRef = useRef<HTMLDivElement>(null);
  const captureFocus = useActionFocusReturn(busy, a?.status, () =>
    actionsRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
  );

  if (!a) {
    if (automations === null) {
      return error ? (
        <EmptyState title="Couldn't load automations" body={error} />
      ) : (
        <p className={styles.loading}>Loading…</p>
      );
    }
    return (
      <EmptyState
        title="Automation not found"
        body="It may have been removed. Pick another one from the Automations sidebar."
      />
    );
  }

  const act = async (
    action: (a: AutomationRecord, offer: OfferUndo) => Promise<AutomationRecord>,
    failure: string
  ) => {
    captureFocus(actionsRef.current);
    setBusy(true);
    try {
      upsertAutomation(await action(a, toastUndoAndReload));
    } catch (err) {
      showToast(getErrorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  };

  const canceled = a.status === 'cancelled';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.identity}>
            <h1 className={styles.title}>{a.name}</h1>
            <p className={styles.subtitle}>
              <span>{`Wakes ${a.agentName ?? 'an agent'} · ${automationStatusText(a)}`}</span>
              {a.running && <RunningBadge />}
            </p>
          </div>
          {!editing && (
            <div className={styles.actions} ref={actionsRef}>
              {canceled ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void act(restoreAutomation, "Couldn't restore")}
                >
                  Restore
                </Button>
              ) : (
                <>
                  {a.status === 'active' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(pauseAutomation, "Couldn't pause")}
                    >
                      Pause
                    </Button>
                  )}
                  {a.status === 'paused' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(resumeAutomation, "Couldn't resume")}
                    >
                      Resume
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || a.running}
                    title={a.running ? 'A wake is going right now' : undefined}
                    onClick={() => void act(runAutomationNow, "Couldn't run")}
                  >
                    Run now
                  </Button>
                  <Button
                    ref={editButtonRef}
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    className={styles.deleteBtn}
                    onClick={() => void act(deleteAutomation, "Couldn't archive")}
                  >
                    Archive
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </header>
      <div className={styles.body}>
        {canceled && (
          <p className={styles.notice} role="status">
            Archived. It won&apos;t run again unless you restore it (here or from the Archive
            drawer).
          </p>
        )}
        {editing ? (
          <AutomationEditForm
            inline
            automation={a}
            onClose={closeEdit}
            onSaved={(saved) => {
              closeEdit();
              upsertAutomation(saved);
              showToast(`Saved ${saved.name}`);
            }}
          />
        ) : (
          <>
            <section className={styles.section} aria-label="Prompt">
              <h2 className={styles.sectionHeading}>Prompt</h2>
              {/* Rendered as the wake posts it, so its chips read as chips. */}
              <MarkdownRenderer
                content={markdownForChatMessageRender(a.prompt)}
                className={styles.prompt}
                showIncludeToggle={false}
              />
            </section>
            <section className={styles.section} aria-label="Details">
              <h2 className={styles.sectionHeading}>Details</h2>
              <dl className={styles.detailGrid}>
                <dt>When</dt>
                <dd>{a.whenText}</dd>
                <dt>Next run</dt>
                <dd className={styles.nextRun}>
                  <span>{formatAutomationNextRun(a)}</span>
                  <NextRunCountdown automation={a} className={styles.countdown} />
                </dd>
                <dt>Last result</dt>
                <dd className={styles.result} data-status={a.lastRun?.status}>
                  {a.lastRun ? (
                    <>
                      {lastResultText(a)}
                      <span className={styles.muted}>
                        {` · ${formatAutomationTime(a.lastRun.scheduledFor)}`}
                      </span>
                    </>
                  ) : (
                    'Not run yet'
                  )}
                </dd>
                {a.consecutiveFailures > 0 && (
                  <>
                    <dt>Failures in a row</dt>
                    <dd>{a.consecutiveFailures}</dd>
                  </>
                )}
                <dt>Thread</dt>
                <dd>
                  {nav?.openThread ? (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => nav.openThread?.(a.threadId, a.threadTitle)}
                    >
                      In {a.threadTitle ?? 'an untitled thread'} →
                    </button>
                  ) : (
                    (a.threadTitle ?? 'Untitled thread')
                  )}
                </dd>
                <dt>Calendar</dt>
                <dd className={styles.calendar}>
                  <AutomationCalendarPicker
                    value={a.calendarId}
                    calendars={calendars}
                    loaded={loaded}
                    current={
                      a.calendarId
                        ? {
                            id: a.calendarId,
                            title: a.calendarTitle,
                          }
                        : null
                    }
                    disabled={busy || canceled}
                    onChange={(calendarId) =>
                      void act(
                        (x, offer) => moveAutomationToCalendar(x, calendarId, offer),
                        calendarId === null ? "Couldn't remove it" : "Couldn't move it"
                      )
                    }
                  />
                </dd>
                <dt>Made by</dt>
                <dd>{a.createdByAgentId ? (a.agentName ?? 'an agent') : 'You'}</dd>
              </dl>
            </section>
            <section className={styles.section} aria-label="Runs">
              <h2 className={styles.sectionHeading}>Runs</h2>
              <AutomationRunLog key={a.id} automation={a} />
            </section>
          </>
        )}
      </div>
    </div>
  );
};
