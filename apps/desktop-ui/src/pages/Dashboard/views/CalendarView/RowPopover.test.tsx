/**
 * A repeating row has one status for the whole row (it resets after each
 * Done), so the popover shows a logged occurrence's own state in its place.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarRowOccurrence, TableField } from '@snaglet/shared/types';

vi.mock('@desktop/features/reminders/ReminderSettingsControl', () => ({
  ReminderSettingsControl: () => null,
}));
const tables = vi.hoisted(() => ({ entry: vi.fn(), fields: vi.fn() }));
vi.mock('@desktop/utils/api', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, ...tables } };
});

import { RowPopover } from './RowPopover';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

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
const STATUS = field('field-status', {
  name: 'status',
  type: 'select',
  options: [
    { id: 'opt-todo', label: 'todo', color: 'gray' },
    { id: 'opt-done', label: 'done', color: 'green' },
    { id: 'opt-applied', label: 'applied', color: 'blue' },
    { id: 'opt-rejected', label: 'rejected', color: 'red' },
  ],
});
const withStatus = (statusFieldId: string | null, doneOptionIds = ['opt-done']) =>
  field('field-due', {
    name: 'Due',
    type: 'date',
    calendarId: 'cal-1',
    recurrence: {
      statusFieldId,
      doneOptionIds,
      resetOptionId: 'opt-todo',
    },
  });

function occurrence(
  due: TableField,
  status: CalendarRowOccurrence['status'],
  repeating = true
): CalendarRowOccurrence {
  return {
    key: `row:${due.id}:${ENTRY_ID}:x`,
    source: 'row',
    calendarId: 'cal-1',
    title: 'Pay rent',
    time: { kind: 'all_day', startDate: '2026-10-21', endDate: '2026-10-21' },
    status,
    canMove: true,
    canResize: false,
    tableId: TABLE_ID,
    tableName: 'Tasks',
    projectId: null,
    entryId: ENTRY_ID,
    fieldId: due.id,
    range: false,
    hasEnd: false,
    entryRevision: 'r1',
    schemaVersion: 's1',
    ...(repeating
      ? {
          repeat: {
            occurrence: '2026-10-21',
            isCurrent: status === 'upcoming',
            summary: 'Every day',
          },
        }
      : {}),
  };
}

async function open(
  due: TableField,
  o: CalendarRowOccurrence,
  extra: Partial<React.ComponentProps<typeof RowPopover>> = {}
) {
  tables.entry.mockResolvedValue({
    entry: {
      id: ENTRY_ID,
      createdAt: '',
      revision: 'r1',
      values: { 'field-name': 'Pay rent', 'field-status': 'todo' },
    },
    schemaVersion: 's1',
    relatedEntries: {},
    relatedItems: {},
  });
  render(
    <RowPopover
      anchor={document.body.appendChild(document.createElement('button'))}
      occurrence={o}
      calendar={undefined}
      zone="UTC"
      fields={[NAME, STATUS, due]}
      actions={[
        { label: 'Mark done', onSelect: vi.fn() },
        { label: 'Skip', onSelect: vi.fn() },
      ]}
      {...extra}
      onOpenFull={vi.fn()}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />
  );
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('RowPopover done buttons', () => {
  beforeEach(() => {
    tables.entry.mockReset();
  });

  it('has one Mark button per done option of the status field, named after it', async () => {
    const onMarkStatus = vi.fn();
    const due = withStatus(STATUS.id, ['opt-applied', 'opt-rejected']);
    await open(due, occurrence(due, 'upcoming'), { onMarkStatus });
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark rejected' }));
    expect(onMarkStatus).toHaveBeenCalledWith(STATUS.id, 'rejected', {
      expectedRevision: 'r1',
      schemaVersion: 's1',
    });
    expect(screen.getByRole('button', { name: 'Mark applied' })).toBeInTheDocument();
  });

  it('keeps the plain Mark done when the repeat has no status field', async () => {
    const due = withStatus(null);
    await open(due, occurrence(due, 'upcoming'), { onMarkStatus: vi.fn() });
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
  });
});

describe('RowPopover undo of a mark', () => {
  beforeEach(() => {
    tables.entry.mockReset();
  });

  it('turns Mark and Skip on a done occurrence into one Undo done', async () => {
    const onUndoMark = vi.fn().mockResolvedValue(undefined);
    const due = withStatus(STATUS.id, ['opt-applied']);
    await open(due, occurrence(due, 'done'), { onMarkStatus: vi.fn(), onUndoMark });
    expect(screen.queryByRole('button', { name: /^Mark/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Undo done/ }));
    expect(onUndoMark).toHaveBeenCalledTimes(1);
  });

  it('offers Undo skip on a skipped occurrence', async () => {
    const due = withStatus(null);
    await open(due, occurrence(due, 'skipped'), { onUndoMark: vi.fn() });
    expect(screen.getByRole('button', { name: /Undo skip/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
  });

  it('keeps Mark and Skip on an upcoming occurrence', async () => {
    const due = withStatus(null);
    await open(due, occurrence(due, 'upcoming'), { onUndoMark: vi.fn() });
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});

describe('RowPopover Notify', () => {
  beforeEach(() => {
    tables.entry.mockReset();
  });

  const timed = (due: TableField, status: CalendarRowOccurrence['status']) => ({
    ...occurrence(due, status),
    time: {
      kind: 'timed' as const,
      start: '2026-10-21T14:00:00.000Z',
      end: '2026-10-21T15:00:00.000Z',
    },
  });
  const datetimeDue = () => ({ ...withStatus(null), type: 'datetime' as const });

  it('shows Notify as a plain button on an upcoming occurrence', async () => {
    const due = datetimeDue();
    await open(due, timed(due, 'upcoming'));
    const button = screen.getByRole('button', { name: 'Notify' });
    expect(button.textContent).toBe('Notify');
    expect(button).not.toHaveAttribute('aria-expanded');
  });

  it.each(['done', 'skipped'] as const)(
    'hides Notify once the occurrence is %s',
    async (status) => {
      const due = datetimeDue();
      await open(due, timed(due, status));
      expect(screen.queryByRole('button', { name: /^Notify/ })).toBeNull();
    }
  );
});

describe('RowPopover occurrence state', () => {
  beforeEach(() => {
    tables.entry.mockReset();
  });

  it('shows a done occurrence as Done in place of the row status', async () => {
    const due = withStatus(STATUS.id);
    await open(due, occurrence(due, 'done'));
    expect(screen.getByText('✓ Done')).toBeInTheDocument();
    expect(screen.queryByText('todo')).toBeNull();
  });

  it('shows a skipped occurrence’s state when completion is by the Done button alone', async () => {
    const due = withStatus(null);
    await open(due, occurrence(due, 'skipped'));
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('keeps the row status for an upcoming occurrence', async () => {
    const due = withStatus(STATUS.id);
    await open(due, occurrence(due, 'upcoming'));
    expect(screen.getByText('todo')).toBeInTheDocument();
    expect(screen.queryByText('✓ Done')).toBeNull();
  });

  it('shows no occurrence state on a row that does not repeat', async () => {
    const due = field('field-due', { name: 'Due', type: 'date', calendarId: 'cal-1' });
    await open(due, occurrence(due, 'done', false));
    expect(screen.queryByText('✓ Done')).toBeNull();
  });
});
