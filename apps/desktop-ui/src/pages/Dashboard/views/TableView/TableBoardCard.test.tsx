import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import { TableBoardCard } from './TableBoardCard';
import { cellRepeatKey } from './repeat/useTableRepeats';

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

const tableId = 'table-1111111111111-aaaaaaaaa';
const due = {
  id: 'field-due',
  tableId,
  columnName: 'due',
  name: 'Due',
  type: 'date',
  range: false,
  managed: false,
  recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
} as unknown as TableField;
const entry: TableEntry = {
  id: '11111111-2222-4333-8444-555555555555',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'r1',
  values: { [due.id]: '2020-11-01' },
};

function card(
  repeats?: Parameters<typeof TableBoardCard>[0]['repeats'],
  handlers = { onOpen: vi.fn(), onDragStart: vi.fn() }
) {
  render(
    <TableBoardCard
      entry={entry}
      label="Pay rent"
      nameField={undefined}
      fields={[due]}
      groups={[]}
      currentKey="todo"
      repeats={repeats}
      pending={false}
      disabled={false}
      onOpen={handlers.onOpen}
      onMove={vi.fn()}
      onDragStart={handlers.onDragStart}
    />
  );
  return handlers;
}

describe('TableBoardCard', () => {
  it('reads a repeating date as its repeat', () => {
    card(
      new Map([
        [
          cellRepeatKey(due.id, entry.id),
          {
            repeat: {
              rrule: 'FREQ=MONTHLY',
              dtstart: '2020-11-01',
              current: '2020-11-01',
              tz: 'UTC',
            },
            log: [],
          },
        ],
      ])
    );
    expect(screen.getByText('Sun Nov 1')).toBeInTheDocument();
  });

  it('shows the plain date without the table’s repeats', () => {
    card();
    expect(screen.queryByText(/· by/)).toBeNull();
  });

  it('copies the entry ID from its icon without opening or dragging the card', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { onOpen, onDragStart } = card();
    const button = screen.getByRole('button', { name: 'Copy entry ID' });
    expect(button).toHaveAttribute('title', 'Copy entry ID');
    fireEvent.pointerDown(button, { button: 0 });
    await user.click(button);
    expect(copy).toHaveBeenCalledWith(entry.id);
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Entry ID copied'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('reaches the copy icon from the keyboard, after the title', async () => {
    const user = userEvent.setup();
    card();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Open Pay rent' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy entry ID' })).toHaveFocus();
  });
});
