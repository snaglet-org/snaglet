/**
 * Reminders at the app shell (mounted once in the Dashboard):
 *
 * - On `reminder:due` it shows a banner at the top right of the Snaglet window
 *   (title, "Starts in 15 minutes" / "Starting now" and the calendar, Open,
 *   Dismiss). A banner hides after {@link REMINDER_BANNER_MS}, paused while
 *   the pointer is over it or focus is in it; Escape dismisses the focused
 *   one. The stack is a polite live region.
 * - It plays the reminder's sound only when the native notification won't
 *   ({@link nativeWillSound}), so the user hears exactly one.
 * - Open (and a click on the native notification, including the one that
 *   launched a quit Snaglet) goes to the item: an event
 *   on the Calendar with its popover, a row in its row window, an
 *   automation in the Automations pane.
 * - It keeps the OS schedule in sync ({@link useNativeReminderSync}).
 *
 * The stack sits above panes and popovers' panes, below modals; it is fixed
 * to the window, which the app zoom scales like the status bar's popovers.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReminderDue, ReminderItemRef, TableField } from '@snaglet/shared/types';
import { tablesApi } from '@desktop/utils/api';
import { WebSocketContext } from '@desktop/ws/WebSocketContext';
import {
  useDashboardNavigation,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { TableEntryModal } from '@desktop/pages/Dashboard/views/TableView/TableEntryModal';
import {
  nativeNotifications,
  nativeWillSound,
  type NativeNotificationClick,
} from './nativeNotifications';
import { playReminderSound } from './reminderSounds';
import { isReminderDueFrame, parseReminderDue, reminderLead } from './reminderText';
import { revealCalendarEvent } from './revealCalendarItem';
import { useNativeReminderSync } from './useNativeReminderSync';
import styles from './RemindersHost.module.scss';

export const REMINDER_BANNER_MS = 15_000;
const MAX_BANNERS = 4;
const SEEN_LIMIT = 200;

/**
 * The click that launched Snaglet, read once per page load and shared by a
 * remount (StrictMode runs effects twice); null once it has been opened.
 */
let launchClick: Promise<NativeNotificationClick | null> | null = null;

export function __resetRemindersHostForTests(): void {
  launchClick = null;
}

interface EntryWindow {
  tableId: string;
  entryId: string;
  fields: TableField[];
}

export function RemindersHost() {
  const ws = useContext(WebSocketContext);
  const addMessageListener = ws?.addMessageListener;
  const nav = useDashboardNavigation();
  const navRef = useRef<DashboardNavigationValue | null>(nav);
  navRef.current = nav;
  const [banners, setBanners] = useState<ReminderDue[]>([]);
  const [entry, setEntry] = useState<EntryWindow | null>(null);
  const seen = useRef<string[]>([]);

  useNativeReminderSync(addMessageListener);

  const show = useCallback((due: ReminderDue) => {
    // Delivery is deduplicated by key; a reconnect replay shows nothing twice.
    if (seen.current.includes(due.key)) return;
    seen.current = [...seen.current, due.key].slice(-SEEN_LIMIT);
    setBanners((prev) => [...prev, due].slice(-MAX_BANNERS));
    if (!nativeWillSound(due.key)) playReminderSound(due.sound);
  }, []);

  useEffect(() => {
    if (!addMessageListener) return;
    return addMessageListener((msg) => {
      if (!isReminderDueFrame(msg.type)) return;
      const due = parseReminderDue(msg.payload);
      if (due) show(due);
    });
  }, [addMessageListener, show]);

  const dismiss = useCallback(
    (key: string) => setBanners((prev) => prev.filter((b) => b.key !== key)),
    []
  );

  const open = useCallback((item: ReminderItemRef, due?: ReminderDue) => {
    const navigation = navRef.current;
    switch (item.kind) {
      case 'event':
        navigation?.openCalendar?.();
        void revealCalendarEvent(item.eventId, due?.startsAt ?? null);
        return;
      case 'automation':
        navigation?.openAutomation?.(item.automationId, due?.title);
        return;
      case 'table_entry':
        tablesApi
          .fields(item.tableId)
          .then(({ fields }) => setEntry({ tableId: item.tableId, entryId: item.entryId, fields }))
          .catch(() => navigation?.openTableEntry?.(item.tableId, item.entryId));
        return;
    }
  }, []);

  useEffect(
    () =>
      nativeNotifications.onClicked(({ key, item }) => {
        dismiss(key);
        open(item);
      }),
    [dismiss, open]
  );

  // A notification clicked while Snaglet was quit launched it: open that item once.
  useEffect(() => {
    let live = true;
    launchClick ??= nativeNotifications.takeLaunchClick();
    void launchClick.then((click) => {
      if (!live || !click) return;
      launchClick = Promise.resolve(null);
      open(click.item);
    });
    return () => {
      live = false;
    };
  }, [open]);

  if (typeof document === 'undefined') return null;
  return (
    <>
      {createPortal(
        <section className={styles.host} aria-label="Reminders" aria-live="polite">
          {banners.map((due) => (
            <ReminderBanner
              key={due.key}
              due={due}
              onOpen={() => {
                dismiss(due.key);
                open(due.item, due);
              }}
              onDismiss={() => dismiss(due.key)}
            />
          ))}
        </section>,
        document.body
      )}
      {entry &&
        createPortal(
          <div className={styles.entryWindow}>
            <TableEntryModal
              tableId={entry.tableId}
              entryId={entry.entryId}
              fields={entry.fields}
              onClose={() => setEntry(null)}
            />
          </div>,
          document.body
        )}
    </>
  );
}

interface ReminderBannerProps {
  due: ReminderDue;
  onOpen: () => void;
  onDismiss: () => void;
}

function ReminderBanner({ due, onOpen, onDismiss }: ReminderBannerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [lead] = useState(() => reminderLead(due));

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    stop();
    timer.current = setTimeout(() => dismissRef.current(), REMINDER_BANNER_MS);
  };
  const settle = () => (hovered.current || focused.current ? stop() : start());

  useEffect(() => {
    start();
    return stop;
    // Started once; hover and focus pause and restart it.
  }, []);

  const meta = due.calendarName ? `${lead} · ${due.calendarName}` : lead;
  return (
    <div
      ref={ref}
      className={styles.banner}
      role="group"
      aria-label={`Reminder: ${due.title}. ${meta}`}
      data-reminder-banner=""
      onPointerEnter={() => {
        hovered.current = true;
        settle();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        settle();
      }}
      onFocus={() => {
        focused.current = true;
        settle();
      }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && ref.current?.contains(event.relatedTarget)) {
          return;
        }
        focused.current = false;
        settle();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
    >
      <span className={styles.icon} aria-hidden>
        ◷
      </span>
      <div className={styles.text}>
        <strong className={styles.title}>{due.title}</strong>
        <span className={styles.meta}>{meta}</span>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.open} onClick={onOpen}>
          Open
        </button>
        <button
          type="button"
          className={styles.dismiss}
          aria-label={`Dismiss reminder ${due.title}`}
          title="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}
