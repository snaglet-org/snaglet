/**
 * Where the Notify section appears: only on items with a start time (a timed
 * event, a row's date-and-time field, an automation), naming the right item.
 * The section itself is stubbed; ReminderSettingsControl.test covers it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutomationRecord,
  CalendarAutomationOccurrence,
  CalendarEvent,
  CalendarRowOccurrence,
  ReminderItemRef,
  TableField,
} from '@snaglet/shared/types';

vi.mock('@desktop/features/reminders/ReminderSettingsControl', () => ({
  ReminderSettingsControl: ({
    item,
    label = 'Notify',
  }: {
    item: ReminderItemRef;
    label?: string;
  }) => <section aria-label={label} data-item={JSON.stringify(item)} />,
}));

const calendar = vi.hoisted(() => ({ getEvent: vi.fn() }));
vi.mock('@desktop/features/calendar/calendarApi', () => ({ calendarApi: calendar }));
const automations = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: automations }));
const tables = vi.hoisted(() => ({ entry: vi.fn(), fields: vi.fn() }));
vi.mock('@desktop/utils/api', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, ...tables } };
});
vi.mock('@desktop/pages/Dashboard/views/TableView/repeat/RepeatSection', () => ({
  RepeatSection: () => null,
}));

import { EventPopover } from '@desktop/features/calendar/EventPopover';
import { AutomationOccurrencePopover } from '@desktop/features/calendar/AutomationOccurrencePopover';
import { RowPopover } from '@desktop/pages/Dashboard/views/CalendarView/RowPopover';
import { TableEntryModal } from '@desktop/pages/Dashboard/views/TableView/TableEntryModal';

const ZONE = 'UTC';
const EVENT_ID = 'event-1111111111111-aaaaaaaaa';
const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const AUTOMATION_ID = 'automation-1111111111111-aaaaaaaaa';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function anchor() {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

const notify = (name: string | RegExp = /^Notify/) => screen.queryByRole('region', { name });
const itemOf = (el: HTMLElement | null) => JSON.parse(el?.getAttribute('data-item') ?? 'null');

function event(time: CalendarEvent['time']): CalendarEvent {
  return {
    id: EVENT_ID,
    calendarId: 'cal-1',
    title: 'Standup',
    description: '',
    location: '',
    time,
    repeat: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
  };
}

function field(id: string, extra: Partial<TableField>): TableField {
  return {
    id,
    tableId: TABLE_ID,
    columnName: id,
    name: id,
    description: null,
    type: 'text',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    range: false,
    options: null,
    position: 0,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    ...extra,
  };
}

const NAME = field('field-name', { name: 'Name', isTitle: true });
const DUE = field('field-due', { name: 'Due', type: 'datetime', calendarId: 'cal-1' });
const DAY = field('field-day', { name: 'Day', type: 'date', calendarId: 'cal-1' });
const CREATED = field('field-created', {
  name: 'created_at',
  type: 'datetime',
  managed: true,
  calendarId: 'cal-1',
});

function loaded(values: Record<string, unknown>) {
  return {
    entry: { id: ENTRY_ID, createdAt: '', revision: 'r1', values },
    schemaVersion: 's1',
    relatedEntries: {},
    relatedItems: {},
  };
}

function rowOccurrence(f: TableField, time: CalendarRowOccurrence['time']): CalendarRowOccurrence {
  return {
    key: `row:${f.id}:${ENTRY_ID}:x`,
    source: 'row',
    calendarId: 'cal-1',
    title: 'Pay rent',
    time,
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: TABLE_ID,
    tableName: 'Tasks',
    projectId: null,
    entryId: ENTRY_ID,
    fieldId: f.id,
    range: false,
    hasEnd: false,
    entryRevision: 'r1',
    schemaVersion: 's1',
  };
}

const timedRowTime = {
  kind: 'timed',
  start: '2026-10-16T09:00:00.000Z',
  end: '2026-10-16T09:30:00.000Z',
} as CalendarRowOccurrence['time'];

function renderRow(f: TableField, time: CalendarRowOccurrence['time']) {
  render(
    <RowPopover
      anchor={anchor()}
      occurrence={rowOccurrence(f, time)}
      calendar={undefined}
      zone={ZONE}
      fields={[NAME, f]}
      actions={[]}
      onOpenFull={vi.fn()}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />
  );
}

describe('Notify placement', () => {
  beforeEach(() => {
    calendar.getEvent.mockReset();
    automations.get.mockReset();
    tables.entry.mockReset();
    tables.fields.mockReset();
  });

  describe('event popover', () => {
    const renderEvent = () =>
      render(
        <EventPopover
          anchor={anchor()}
          eventId={EVENT_ID}
          calendars={[]}
          viewerZone={ZONE}
          onClose={vi.fn()}
          onChanged={vi.fn()}
        />
      );

    it('a timed event has Notify for that event', async () => {
      calendar.getEvent.mockResolvedValue({
        event: event({
          kind: 'timed',
          startAt: '2026-10-16T09:00:00.000Z',
          endAt: '2026-10-16T09:30:00.000Z',
          timeZone: ZONE,
        }),
      });
      renderEvent();
      await flush();
      expect(itemOf(notify())).toEqual({ kind: 'event', eventId: EVENT_ID });
    });

    it('an all-day event has none', async () => {
      calendar.getEvent.mockResolvedValue({
        event: event({
          kind: 'all_day',
          startDate: '2026-10-16',
          endDate: '2026-10-17',
          timeZone: ZONE,
        }),
      });
      renderEvent();
      await flush();
      expect(screen.getByRole('textbox', { name: 'Event title' })).toBeInTheDocument();
      expect(notify()).toBeNull();
    });
  });

  describe('row popover', () => {
    it("a row's date-and-time field has Notify for that row and field", async () => {
      tables.entry.mockResolvedValue(loaded({ 'field-name': 'Pay rent' }));
      renderRow(DUE, timedRowTime);
      await flush();
      // A Notify button opens the settings in a popover of their own.
      expect(notify('Notify · Due')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Notify' }));
      expect(itemOf(notify('Notify · Due'))).toEqual({
        kind: 'table_entry',
        tableId: TABLE_ID,
        entryId: ENTRY_ID,
        fieldId: DUE.id,
      });
    });

    it('a date-only field and the managed created_at have none', async () => {
      tables.entry.mockResolvedValue(loaded({ 'field-name': 'Pay rent' }));
      renderRow(DAY, { kind: 'all_day', startDate: '2026-10-16', endDate: '2026-10-17' });
      await flush();
      expect(screen.queryByRole('button', { name: /Notify/ })).toBeNull();
      renderRow(CREATED, timedRowTime);
      await flush();
      expect(screen.queryByRole('button', { name: /Notify/ })).toBeNull();
    });
  });

  it('the automation popover has Notify for the automation', async () => {
    automations.get.mockResolvedValue({
      automation: {
        id: AUTOMATION_ID,
        name: 'Daily check',
        status: 'active',
        when: {
          kind: 'repeat',
          rrule: 'FREQ=DAILY',
          timeOfDay: '09:00',
          startsOn: '2026-10-16',
          tz: 'UTC',
        },
        whenText: 'every day at 09:00',
        nextRunAt: '2026-10-16T09:00:00.000Z',
        lastRun: null,
        threadId: 'thread-1',
        threadTitle: 'Test thread',
      } as AutomationRecord,
    });
    const occurrence = {
      key: `automation:${AUTOMATION_ID}:2026-10-16T09:00:00.000Z`,
      source: 'automation',
      calendarId: 'cal-1',
      title: 'Daily check',
      time: timedRowTime,
      status: 'upcoming',
      canMove: false,
      canResize: false,
      automationId: AUTOMATION_ID,
      agentId: 'test-agent-a',
      agentName: 'Test Agent A',
      threadId: 'thread-1',
      automationStatus: 'active',
    } as CalendarAutomationOccurrence;
    render(
      <AutomationOccurrencePopover
        anchor={anchor()}
        occurrence={occurrence}
        offerUndo={vi.fn()}
        onEdit={vi.fn()}
        onOpenThread={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await flush();
    expect(itemOf(notify())).toEqual({ kind: 'automation', automationId: AUTOMATION_ID });
  });

  describe('row window', () => {
    it('has Notify for each date-and-time field on a calendar that holds a time', async () => {
      const LATER = field('field-later', { name: 'Later', type: 'datetime', calendarId: 'cal-1' });
      const OFF_CAL = field('field-off', { name: 'Off', type: 'datetime' });
      tables.entry.mockResolvedValue(
        loaded({
          'field-name': 'Pay rent',
          'field-due': '2026-10-16T09:00:00.000Z',
          'field-later': null,
          'field-off': '2026-10-16T09:00:00.000Z',
          'field-created': '2026-10-01T09:00:00.000Z',
        })
      );
      render(
        <TableEntryModal
          tableId={TABLE_ID}
          entryId={ENTRY_ID}
          fields={[NAME, DUE, LATER, OFF_CAL, CREATED]}
          onClose={vi.fn()}
        />
      );
      await flush();
      const sections = screen.getAllByRole('region', { name: /^Notify/ });
      expect(sections).toHaveLength(1);
      expect(sections[0]).toHaveAccessibleName('Notify · Due');
      expect(itemOf(sections[0])).toEqual({
        kind: 'table_entry',
        tableId: TABLE_ID,
        entryId: ENTRY_ID,
        fieldId: DUE.id,
      });
    });
  });
});
