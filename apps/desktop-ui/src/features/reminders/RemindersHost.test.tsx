import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderDue, WsMessage } from '@snaglet/shared/types';
import { WebSocketContext, type WsContextValue } from '@desktop/ws/WebSocketContext';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';

const native = vi.hoisted(() => ({
  click: null as ((click: { key: string; item: unknown }) => void) | null,
  willSound: vi.fn(() => false),
  takeLaunchClick: vi.fn(),
}));
vi.mock('./nativeNotifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nativeNotifications')>()),
  nativeNotifications: {
    onClicked: (handler: typeof native.click) => {
      native.click = handler;
      return () => {
        native.click = null;
      };
    },
    takeLaunchClick: native.takeLaunchClick,
  },
  nativeWillSound: native.willSound,
}));
const sync = vi.hoisted(() => ({ useNativeReminderSync: vi.fn() }));
vi.mock('./useNativeReminderSync', () => sync);
const sounds = vi.hoisted(() => ({ playReminderSound: vi.fn() }));
vi.mock('./reminderSounds', () => sounds);
const reveal = vi.hoisted(() => ({ revealCalendarEvent: vi.fn() }));
vi.mock('./revealCalendarItem', () => reveal);
const tables = vi.hoisted(() => ({ fields: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, fields: tables.fields } };
});
vi.mock('@desktop/pages/Dashboard/views/TableView/TableEntryModal', () => ({
  TableEntryModal: (props: { tableId: string; entryId: string; onClose: () => void }) => (
    <div role="dialog" aria-label={`Row ${props.entryId}`}>
      <button type="button" onClick={props.onClose}>
        Close row
      </button>
    </div>
  ),
}));

import { REMINDER_BANNER_MS, RemindersHost, __resetRemindersHostForTests } from './RemindersHost';

const EVENT_ID = 'event-1111111111111-aaaaaaaaa';
const AUTOMATION_ID = 'automation-1111111111111-aaaaaaaaa';
const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

function due(over: Partial<ReminderDue> = {}): ReminderDue {
  const now = Date.now();
  return {
    key: 'event:1:15m',
    item: { kind: 'event', eventId: EVENT_ID },
    title: 'Standup',
    calendarName: 'Work',
    startsAt: new Date(now + 15 * 60_000).toISOString(),
    fireAt: new Date(now).toISOString(),
    offset: { amount: 15, unit: 'minutes' },
    sound: 'bell',
    ...over,
  };
}

function setup() {
  const listeners = new Set<(msg: WsMessage) => void>();
  const ws: WsContextValue = {
    connectionState: 'open',
    serverRestarting: false,
    send: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addMessageListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const nav: DashboardNavigationValue = {
    openInPane: vi.fn(),
    openThreadAgent: vi.fn(),
    requestReveal: vi.fn(),
    openCalendar: vi.fn(),
    openAutomation: vi.fn(),
    openTableEntry: vi.fn(),
  };
  render(
    <WebSocketContext.Provider value={ws}>
      <DashboardNavigationProvider value={nav}>
        <RemindersHost />
      </DashboardNavigationProvider>
    </WebSocketContext.Provider>
  );
  const fire = (payload: unknown, type = 'reminder:due') =>
    act(() => {
      for (const l of listeners) l({ type, channel: 'workspace', payload });
    });
  return { nav, fire, ws };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const banner = () => screen.queryByRole('group', { name: /^Reminder: / });

describe('RemindersHost', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    __resetRemindersHostForTests();
    native.willSound.mockReset().mockReturnValue(false);
    native.takeLaunchClick.mockReset().mockResolvedValue(null);
    sounds.playReminderSound.mockReset();
    reveal.revealCalendarEvent.mockReset().mockResolvedValue(undefined);
    tables.fields.mockReset();
    sync.useNativeReminderSync.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('shows a banner in a polite live region and keeps the native schedule in sync', () => {
    const { fire, ws } = setup();
    expect(sync.useNativeReminderSync).toHaveBeenCalledWith(ws.addMessageListener);
    const region = screen.getByRole('region', { name: 'Reminders' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    fire(due());
    expect(banner()).toHaveTextContent('Standup');
    expect(banner()).toHaveTextContent('Starts in 15 minutes · Work');
  });

  it('says "Starting now" for the at-start reminder', () => {
    const { fire } = setup();
    const now = new Date().toISOString();
    fire(due({ key: 'k-start', offset: null, startsAt: now, fireAt: now, calendarName: null }));
    expect(banner()).toHaveTextContent('Starting now');
    expect(banner()).not.toHaveTextContent('·');
  });

  it('accepts the dotted frame name and a wrapped payload; ignores junk and repeats', () => {
    const { fire } = setup();
    fire({ nope: true });
    fire(due(), 'something:else');
    expect(banner()).toBeNull();
    fire({ reminder: due() }, 'reminder.due');
    fire(due());
    expect(screen.getAllByRole('group', { name: /^Reminder: / })).toHaveLength(1);
  });

  it('plays the sound only when the native notification will not', () => {
    const { fire } = setup();
    native.willSound.mockReturnValue(false);
    fire(due({ key: 'a', sound: 'bell' }));
    expect(sounds.playReminderSound).toHaveBeenCalledWith('bell');

    native.willSound.mockReturnValue(true);
    fire(due({ key: 'b' }));
    expect(native.willSound).toHaveBeenLastCalledWith('b');
    expect(sounds.playReminderSound).toHaveBeenCalledTimes(1);
  });

  it('hides after 15 s, paused while hovered', () => {
    const { fire } = setup();
    fire(due());
    const el = banner()!;
    act(() => vi.advanceTimersByTime(REMINDER_BANNER_MS - 1000));
    fireEvent.pointerEnter(el);
    act(() => vi.advanceTimersByTime(REMINDER_BANNER_MS * 2));
    expect(banner()).not.toBeNull();
    fireEvent.pointerLeave(el);
    act(() => vi.advanceTimersByTime(REMINDER_BANNER_MS - 1));
    expect(banner()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(banner()).toBeNull();
  });

  it('Dismiss and Escape remove it', () => {
    const { fire } = setup();
    fire(due({ key: 'a', title: 'First' }));
    fire(due({ key: 'b', title: 'Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss reminder First' }));
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: 'Open' });
    open.focus();
    fireEvent.keyDown(open, { key: 'Escape' });
    expect(banner()).toBeNull();
  });

  it('Open on an event goes to the Calendar and opens the event', () => {
    const { fire, nav } = setup();
    const d = due();
    fire(d);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(nav.openCalendar).toHaveBeenCalled();
    expect(reveal.revealCalendarEvent).toHaveBeenCalledWith(EVENT_ID, d.startsAt);
    expect(banner()).toBeNull();
  });

  it('Open on an automation opens it in the Automations pane', () => {
    const { fire, nav } = setup();
    fire(due({ item: { kind: 'automation', automationId: AUTOMATION_ID }, title: 'Daily' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(nav.openAutomation).toHaveBeenCalledWith(AUTOMATION_ID, 'Daily');
  });

  it('Open on a row opens its row window', async () => {
    tables.fields.mockResolvedValue({ fields: [] });
    const { fire, nav } = setup();
    fire(
      due({ item: { kind: 'table_entry', tableId: TABLE_ID, entryId: ENTRY_ID, fieldId: 'f1' } })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await flush();
    expect(tables.fields).toHaveBeenCalledWith(TABLE_ID);
    expect(screen.getByRole('dialog', { name: `Row ${ENTRY_ID}` })).toBeInTheDocument();
    expect(nav.openTableEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close row' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falls back to the table at the row when its fields cannot load', async () => {
    tables.fields.mockRejectedValue(new Error('gone'));
    const { fire, nav } = setup();
    fire(
      due({ item: { kind: 'table_entry', tableId: TABLE_ID, entryId: ENTRY_ID, fieldId: 'f1' } })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await flush();
    expect(nav.openTableEntry).toHaveBeenCalledWith(TABLE_ID, ENTRY_ID);
  });

  it('opens the item whose notification launched Snaglet, once', async () => {
    native.takeLaunchClick.mockResolvedValue({
      key: 'k1',
      item: { kind: 'automation', automationId: AUTOMATION_ID },
    });
    const first = setup();
    await flush();
    expect(native.takeLaunchClick).toHaveBeenCalledTimes(1);
    expect(first.nav.openAutomation).toHaveBeenCalledTimes(1);
    expect(first.nav.openAutomation).toHaveBeenCalledWith(AUTOMATION_ID, undefined);
    // A later remount (or StrictMode's second run) doesn't open it again.
    const second = setup();
    await flush();
    expect(native.takeLaunchClick).toHaveBeenCalledTimes(1);
    expect(second.nav.openAutomation).not.toHaveBeenCalled();
  });

  it('a click on the native notification opens the item too', () => {
    const { fire, nav } = setup();
    fire(due({ key: 'k1', item: { kind: 'automation', automationId: AUTOMATION_ID } }));
    act(() =>
      native.click?.({ key: 'k1', item: { kind: 'automation', automationId: AUTOMATION_ID } })
    );
    expect(nav.openAutomation).toHaveBeenCalledWith(AUTOMATION_ID, undefined);
    // Its banner goes too.
    expect(banner()).toBeNull();
  });
});
