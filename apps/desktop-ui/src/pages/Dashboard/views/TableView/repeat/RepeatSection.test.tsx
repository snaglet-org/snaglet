import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableHistoryStep } from '@snaglet/shared/types';
import { showToast } from '@desktop/utils/toast';
import { newestTableStep, stepTableHistory } from '@desktop/features/database/tableHistory';
import { emitTableEvent, type TableEvent } from '@desktop/features/database/tableEvents';
import { RepeatSection, describeLogRow } from './RepeatSection';
import { useEntryRepeats } from './useEntryRepeats';

const api = vi.hoisted(() => ({
  entry: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  move: vi.fn(),
  shift: vi.fn(),
  undoOccurrence: vi.fn(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: { entry: api.entry } }));
vi.mock('@desktop/utils/api/tableRepeats', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api/tableRepeats')>(
    '@desktop/utils/api/tableRepeats'
  );
  const { entry: _entry, ...repeatsApi } = api;
  return { ...actual, tableRepeatsApi: repeatsApi };
});
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn() }));
// Local emits are stubbed; the bus itself is real, so a test can play another
// client's write (`hear`).
const bus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@desktop/features/database', async () => {
  const actual = await vi.importActual<typeof import('@desktop/features/database/tableEvents')>(
    '@desktop/features/database/tableEvents'
  );
  return { ...actual, emitTableEvent: bus.emit };
});
vi.mock('@desktop/features/database/tableHistory', () => ({
  stepTableHistory: vi.fn(),
  newestTableStep: vi.fn(),
}));

const TABLE = 'table-1111111111111-aaaaaaaaa';
const ENTRY = '11111111-2222-3333-4444-555555555555';
const REV = 'a'.repeat(64);
const SCHEMA = 'b'.repeat(64);
const field = {
  id: 'field-due',
  tableId: TABLE,
  name: 'Due',
  type: 'date',
  recurrence: { statusFieldId: 's', doneOptionIds: ['d'], resetOptionId: null },
} as unknown as TableField;
const entry = { id: ENTRY, revision: REV, values: { 'field-due': '2026-10-19' } };
const weekly = {
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  dtstart: '2026-10-05',
  current: '2026-10-19',
  tz: 'UTC',
};
function log(id: string, kind: 'done' | 'skipped' | 'moved', occurrence: string, extra = {}) {
  return {
    id,
    tableId: TABLE,
    fieldId: field.id,
    entryId: ENTRY,
    occurrence,
    kind,
    movedTo: null,
    actorKind: 'user',
    actorId: '1',
    createdAt: '2026-10-12T10:00:00.000Z',
    ...extra,
  };
}
const history = [
  log('tocc-3', 'moved', '2026-10-26', {
    movedTo: '2026-10-27',
    createdAt: '2026-10-13T09:00:00.000Z',
  }),
  log('tocc-2', 'skipped', '2026-10-12', { createdAt: '2026-10-12T11:00:00.000Z' }),
  log('tocc-1', 'done', '2026-10-05', { createdAt: '2026-10-06T08:00:00.000Z' }),
];
function result(repeat = weekly, extra = {}) {
  return {
    entry: { ...entry, revision: 'c'.repeat(64), values: { 'field-due': repeat.current } },
    schemaVersion: SCHEMA,
    relatedEntries: {},
    relatedItems: {},
    fieldId: field.id,
    repeat,
    logged: [],
    removed: [],
    changed: true,
    ...extra,
  };
}
const revision = { expectedRevision: REV, schemaVersion: SCHEMA, expectedCurrent: '2026-10-19' };

beforeEach(() => {
  vi.clearAllMocks();
  api.entry.mockResolvedValue({
    entry,
    schemaVersion: SCHEMA,
    relatedEntries: {},
    relatedItems: {},
  });
  api.get.mockResolvedValue({
    entryId: ENTRY,
    revision: REV,
    repeats: { [field.id]: weekly },
    log: history,
  });
});

function renderSection(rerenderKey = 0) {
  render(<RepeatSection key={rerenderKey} tableId={TABLE} entryId={ENTRY} field={field} />);
  return userEvent.setup();
}

describe('RepeatSection', () => {
  it('shows the summary, the current occurrence and the history (newest first)', async () => {
    renderSection();
    const section = await screen.findByRole('region', { name: 'Repeat: Due' });
    expect(within(section).getByTestId('repeat-section-summary')).toHaveTextContent(
      'Every week on Monday'
    );
    expect(within(section).getByText('Mon, Oct 19, 2026')).toBeInTheDocument();
    const rows = within(within(section).getByRole('list', { name: 'History' })).getAllByRole(
      'listitem'
    );
    expect(rows.map((r) => r.querySelector('[data-log-text]')?.textContent)).toEqual([
      'Oct 26 moved → Tue, Oct 27',
      'Oct 12 skipped',
      'Oct 5 ✓ done',
    ]);
  });

  it('Done and Skip send the revision pair and expectedCurrent', async () => {
    api.complete.mockResolvedValue(
      result(
        { ...weekly, current: '2026-10-26' },
        { logged: [log('tocc-4', 'done', '2026-10-19')] }
      )
    );
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(api.complete).toHaveBeenCalledWith(TABLE, ENTRY, field.id, revision)
    );
    expect(await screen.findByText('Mon, Oct 26, 2026')).toBeInTheDocument();
    expect(screen.getAllByText(/✓ done/)).toHaveLength(2);
  });

  it('offers Undo for exactly the step the write made', async () => {
    const step = { id: 'step-1', label: 'Skip Due' } as TableHistoryStep;
    vi.mocked(newestTableStep).mockResolvedValue(step);
    api.skip.mockResolvedValue(result({ ...weekly, current: '2026-10-26' }));
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Skipped',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
      )
    );
    const calls = vi.mocked(showToast).mock.calls;
    const options = calls[calls.length - 1]?.[1];
    options?.action?.run();
    expect(stepTableHistory).toHaveBeenCalledWith('undo', { expected: step, tableId: TABLE });
  });

  it("says where to undo when the write's step can't be read", async () => {
    vi.mocked(newestTableStep).mockResolvedValue(null);
    api.skip.mockResolvedValue(result({ ...weekly, current: '2026-10-26' }));
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Skipped. To undo it, use the table's history.", {
        durationMs: 6000,
      })
    );
  });

  it('Move asks Only this one / All upcoming, and moves one', async () => {
    api.move.mockResolvedValue(result());
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Move…' }));
    const date = screen.getByLabelText('Move to');
    await user.clear(date);
    await user.type(date, '2026-10-21');
    await user.click(screen.getByRole('button', { name: 'Only this one' }));
    await waitFor(() =>
      expect(api.move).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        to: '2026-10-21',
      })
    );
  });

  it('on a date range, shows the span and moves its start (the end follows)', async () => {
    const trip = { ...field, range: true } as TableField;
    api.entry.mockResolvedValue({
      entry: { ...entry, values: { 'field-due': '2026-10-19/2026-10-21' } },
      schemaVersion: SCHEMA,
      relatedEntries: {},
      relatedItems: {},
    });
    api.move.mockResolvedValue(result());
    render(<RepeatSection tableId={TABLE} entryId={ENTRY} field={trip} />);
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'Repeat: Due' });
    expect(within(section).getByText(/^Oct 19 – 21/)).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Move…' }));
    const date = screen.getByLabelText('Move start to');
    expect(date).toHaveAttribute('data-value', '2026-10-19');
    expect((date as HTMLInputElement).value).toMatch(/^Mon, Oct 19\b/);
    await user.clear(date);
    await user.type(date, '2026-10-20');
    await user.click(screen.getByRole('button', { name: 'Only this one' }));
    await waitFor(() =>
      expect(api.move).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        to: '2026-10-20',
      })
    );
  });

  it('All upcoming shifts the series', async () => {
    api.shift.mockResolvedValue(result());
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Move…' }));
    const date = screen.getByLabelText('Move to');
    await user.clear(date);
    await user.type(date, '2026-10-20');
    await user.click(screen.getByRole('button', { name: 'All upcoming' }));
    await waitFor(() =>
      expect(api.shift).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        to: '2026-10-20',
      })
    );
  });

  it('disables All upcoming with the reason for a fixed-day rule', async () => {
    api.get.mockResolvedValue({
      entryId: ENTRY,
      revision: REV,
      repeats: { [field.id]: { ...weekly, rrule: 'FREQ=MONTHLY;BYDAY=3MO' } },
      log: [],
    });
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Move…' }));
    const all = screen.getByRole('button', { name: 'All upcoming' });
    expect(all).toBeDisabled();
    expect(screen.getByText(/can’t move by days/)).toBeInTheDocument();
  });

  it('Undo on a history entry undoes that entry', async () => {
    api.undoOccurrence.mockResolvedValue(result(weekly, { removed: ['tocc-2'] }));
    const user = renderSection();
    const list = await screen.findByRole('list', { name: 'History' });
    const skipped = within(list).getAllByRole('listitem')[1]!;
    await user.click(within(skipped).getByRole('button', { name: /Undo/ }));
    await waitFor(() =>
      expect(api.undoOccurrence).toHaveBeenCalledWith(TABLE, ENTRY, 'tocc-2', {
        ...revision,
        fieldId: field.id,
      })
    );
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
  });

  it('offers to set a repeat when the field has none', async () => {
    api.get.mockResolvedValue({ entryId: ENTRY, revision: REV, repeats: {}, log: [] });
    renderSection();
    expect(await screen.findByText('Doesn’t repeat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set repeat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('a row whose date was cleared keeps its repeat here: Edit opens it, Doesn’t repeat stops it', async () => {
    api.entry.mockResolvedValue({
      entry: { ...entry, values: { 'field-due': null } },
      schemaVersion: SCHEMA,
      relatedEntries: {},
      relatedItems: {},
    });
    api.clear.mockResolvedValue(result(weekly, { repeat: null }));
    const user = renderSection();
    expect(await screen.findByTestId('repeat-section-summary')).toHaveTextContent(
      'Every week on Monday'
    );
    await user.click(screen.getByRole('button', { name: 'Edit repeat' }));
    const panel = await screen.findByRole('dialog', { name: 'Repeat Due' });
    const choices = within(panel).getByRole('radiogroup', { name: 'How it repeats' });
    // It reads from the row's current occurrence, the cell being empty.
    expect(within(choices).getByRole('radio', { name: 'Every week on Monday' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(within(choices).getByRole('radio', { name: 'Doesn’t repeat' }));
    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.clear).toHaveBeenCalledWith(TABLE, ENTRY, field.id, revision));
  });

  it('opens the same Repeat panel from Edit; untouched, Done writes nothing', async () => {
    const user = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Edit repeat' }));
    const panel = await screen.findByRole('dialog', { name: 'Repeat Due' });
    const choices = within(panel).getByRole('radiogroup', { name: 'How it repeats' });
    expect(within(choices).getByRole('radio', { name: 'Every week on Monday' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    // Standalone: no way back to a date view, Done closes.
    expect(within(panel).queryByRole('button', { name: 'Back to the date' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Repeat Due' })).toBeNull();
    expect(api.set).not.toHaveBeenCalled();
  });
});

describe('RepeatSection, repeats', () => {
  describe('Jump to now', () => {
    const timed = { ...field, type: 'datetime' } as TableField;
    const minutely = (current: string) => ({
      rrule: 'FREQ=MINUTELY',
      dtstart: '2026-01-01T09:00:00',
      current,
      tz: 'UTC',
    });
    function load(repeat: typeof weekly) {
      api.entry.mockResolvedValue({
        entry: { ...entry, values: { 'field-due': `${repeat.current}Z` } },
        schemaVersion: SCHEMA,
        relatedEntries: {},
        relatedItems: {},
      });
      api.get.mockResolvedValue({
        entryId: ENTRY,
        revision: REV,
        repeats: { [field.id]: repeat },
        log: [],
      });
    }

    it('is offered on an interval that is behind, and jumps in one write', async () => {
      const behind = minutely('2026-01-01T09:00:00');
      load(behind);
      vi.mocked(newestTableStep).mockResolvedValue({ id: 'step-1' } as TableHistoryStep);
      api.skip.mockResolvedValue(result(minutely('2099-01-01T09:00:00')));
      render(<RepeatSection tableId={TABLE} entryId={ENTRY} field={timed} />);
      const user = userEvent.setup();
      expect(await screen.findByText('Overdue')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Jump to now' }));
      expect(api.skip).toHaveBeenCalledWith(TABLE, ENTRY, field.id, {
        ...revision,
        expectedCurrent: '2026-01-01T09:00:00',
        jump: true,
      });
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          'Jumped to now',
          expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
        )
      );
      expect(screen.queryByRole('button', { name: 'Jump to now' })).toBeNull();
    });

    it('is not offered on an interval that isn’t behind, or on set days', async () => {
      load(minutely('2099-01-01T09:00:00'));
      const { unmount } = render(<RepeatSection tableId={TABLE} entryId={ENTRY} field={timed} />);
      expect(await screen.findByRole('button', { name: 'Skip' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Jump to now' })).toBeNull();
      unmount();
      load({ ...weekly, dtstart: '2026-01-05', current: '2026-01-05' });
      render(<RepeatSection tableId={TABLE} entryId={ENTRY} field={field} />);
      expect(await screen.findByText('Overdue')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Jump to now' })).toBeNull();
    });
  });
});

describe('describeLogRow', () => {
  it('words each kind', () => {
    expect(describeLogRow(log('a', 'done', '2026-10-05'), 2026)).toBe('Oct 5 ✓ done');
    expect(describeLogRow(log('a', 'skipped', '2027-01-04'), 2026)).toBe('Jan 4, 2027 skipped');
    expect(
      describeLogRow(
        log('a', 'moved', '2026-10-05T09:00:00', { movedTo: '2026-10-06T10:30:00' }),
        2026
      )
    ).toBe('Oct 5, 9:00 AM moved → Tue, Oct 6, 10:30 AM');
  });
});

describe('useEntryRepeats', () => {
  const OTHER = '99999999-2222-3333-4444-555555555555';
  const hear = (event: TableEvent) => act(() => emitTableEvent(event));

  it('shows the next occurrence after a batch Done on [another row, this one]', async () => {
    renderSection();
    const section = await screen.findByRole('region', { name: 'Repeat: Due' });
    expect(within(section).getByText('Mon, Oct 19, 2026')).toBeInTheDocument();
    // An agent sets Done on both rows; the server advanced this one a week.
    api.entry.mockResolvedValue({
      entry: { ...entry, revision: 'c'.repeat(64), values: { 'field-due': '2026-10-26' } },
      schemaVersion: SCHEMA,
      relatedEntries: {},
      relatedItems: {},
    });
    api.get.mockResolvedValue({
      entryId: ENTRY,
      revision: 'c'.repeat(64),
      repeats: { [field.id]: { ...weekly, current: '2026-10-26' } },
      log: [log('tocc-4', 'done', '2026-10-19'), ...history],
    });
    hear({ type: 'table.entries.changed', tableId: TABLE, entryId: OTHER, entryIds: [OTHER] });
    expect(api.get).toHaveBeenCalledTimes(1);

    hear({
      type: 'table.entries.changed',
      tableId: TABLE,
      entryId: OTHER,
      entryIds: [OTHER, ENTRY],
    });
    expect(await within(section).findByText('Mon, Oct 26, 2026')).toBeInTheDocument();
  });

  it('reloads on a batch too big to list and on a field change to its table', async () => {
    const { result: hook } = renderHook(() => useEntryRepeats(TABLE, ENTRY));
    await waitFor(() => expect(hook.current.state?.entry.revision).toBe(REV));
    hear({ type: 'table.entries.changed', tableId: TABLE, entryId: OTHER, allEntries: true });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    hear({ type: 'table.fields.changed', tableId: 'table-1111111111111-zzzzzzzzz' });
    hear({ type: 'table.fields.changed', tableId: TABLE });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  });

  it('ignores a read that a newer write superseded', async () => {
    const { result: hook } = renderHook(() => useEntryRepeats(TABLE, ENTRY));
    await waitFor(() => expect(hook.current.state?.entry.revision).toBe(REV));
    // A read starts (another pane's change), then this row's write lands first.
    let finishStaleRead: (value: unknown) => void = () => {};
    api.entry.mockImplementationOnce(() => new Promise((resolve) => (finishStaleRead = resolve)));
    void hook.current.reload();
    api.skip.mockResolvedValue(result({ ...weekly, current: '2026-10-26' }));
    await act(async () => {
      expect(await hook.current.run(field.id, { action: 'skip' })).toBe(true);
    });
    expect(hook.current.state?.entry.revision).toBe('c'.repeat(64));
    await act(async () => {
      finishStaleRead({ entry, schemaVersion: SCHEMA, relatedEntries: {}, relatedItems: {} });
      await Promise.resolve();
    });
    expect(hook.current.state?.entry.revision).toBe('c'.repeat(64));
  });
});
