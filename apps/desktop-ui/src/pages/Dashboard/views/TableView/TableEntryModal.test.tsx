import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntryResponse, TableField } from '@snaglet/shared/types';
import type { TableEvent } from '@desktop/features/database';
import { FetchError } from '@desktop/utils/api';
import { TableEntryModal } from './TableEntryModal';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? 'cell'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const api = vi.hoisted(() => ({ entry: vi.fn(), updateEntry: vi.fn(), deleteEntries: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);
const events = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('./repeat/RepeatSection', () => ({
  RepeatSection: ({ field }: { field: TableField }) => (
    <section aria-label={`Repeat: ${field.name}`} />
  ),
}));

const repeatsApi = vi.hoisted(() => ({ get: vi.fn(), move: vi.fn() }));
vi.mock('@desktop/utils/api/tableRepeats', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api/tableRepeats')>(
    '@desktop/utils/api/tableRepeats'
  );
  return { ...actual, tableRepeatsApi: repeatsApi };
});

vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});
vi.mock('@desktop/features/database', async () => {
  const actual = await vi.importActual<typeof import('@desktop/features/database')>(
    '@desktop/features/database'
  );
  return { ...actual, emitTableEvent: events.emit };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = '00000000-0000-4000-8000-000000000001';

function field(
  partial: Partial<TableField> & Pick<TableField, 'id' | 'name' | 'type'>
): TableField {
  return {
    columnName: partial.name.toLowerCase(),
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    options: null,
    managed: false,
    isTitle: false,
    collapsed: false,
    recurrence: null,
    ...partial,
  } as TableField;
}

const name = field({ id: 'fld-name', name: 'Name', type: 'text', isTitle: true });
const notes = field({ id: 'fld-notes', name: 'Notes', type: 'text' });
const done = field({ id: 'fld-done', name: 'Done', type: 'checkbox' });
const created = field({ id: 'fld-created', name: 'Created', type: 'datetime', managed: true });
const fields = [name, notes, done, created];

function response(values: Record<string, unknown>, revision = 'rev-1'): TableEntryResponse {
  return {
    entry: {
      id: entryId,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision,
      values: values as never,
    },
    schemaVersion: 'schema-1',
    relatedEntries: {},
    relatedItems: {},
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('TableEntryModal', () => {
  it('shows the entry name as the title and every field as a property', async () => {
    api.entry.mockResolvedValue(
      response({
        [name.id]: 'Roast schedule',
        [notes.id]: 'Tuesdays',
        [done.id]: false,
        [created.id]: '2026-01-01T00:00:00.000Z',
      })
    );
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    expect(within(dialog).getByText('Notes')).toBeVisible();
    expect(within(dialog).getByText('Tuesdays')).toBeVisible();
    expect(within(dialog).getByText('Done')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Created (read-only)' })).toBeDisabled();
  });

  it('copies the entry ID from the header, next to Close, and stays open', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const onClose = vi.fn();
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule' }));
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={onClose} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    const header = within(dialog).getByRole('banner');
    const actions = within(header)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(actions.slice(-3)).toEqual(['Copy entry ID', 'Delete entry', 'Close entry']);
    await user.click(within(header).getByRole('button', { name: 'Copy entry ID' }));
    expect(copy).toHaveBeenCalledWith(entryId);
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Entry ID copied'));
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it('edits a property in place and saves it with the entry revision', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule', [notes.id]: 'Tuesdays' }));
    api.updateEntry.mockResolvedValue(
      response({ [name.id]: 'Roast schedule', [notes.id]: 'Thursdays' }, 'rev-2')
    );
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Notes' }));
    const input = within(dialog).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'Thursdays');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(tableId, entryId, {
        values: { [notes.id]: 'Thursdays' },
        schemaVersion: 'schema-1',
        expectedRevision: 'rev-1',
      })
    );
    expect(await within(dialog).findByText('Thursdays')).toBeVisible();
    expect(events.emit).toHaveBeenCalledWith({ type: 'table.entries.changed', tableId, entryId });
  });

  it('toggles a checkbox property straight away', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule', [done.id]: false }));
    api.updateEntry.mockResolvedValue(
      response({ [name.id]: 'Roast schedule', [done.id]: true }, 'rev-2')
    );
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Done in Roast schedule' }));
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        entryId,
        expect.objectContaining({ values: { [done.id]: true }, expectedRevision: 'rev-1' })
      )
    );
  });

  it('keeps its name while the name is edited', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Test entry' }));
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Test entry' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Name: Test entry' }));
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Test entry' })).toBe(dialog);
  });

  it('shows why a checkbox property did not save', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Test entry', [done.id]: false }));
    api.updateEntry.mockRejectedValue(new Error('The server is unavailable.'));
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Test entry' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Done in Test entry' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server is unavailable.'
    );
  });

  it('keeps the changed-elsewhere notice after a refused save closes its editor', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Test entry', [notes.id]: 'Before' }));
    api.updateEntry.mockRejectedValue(new FetchError('Entry changed', 409));
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Test entry' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Notes' }));
    await userEvent.type(within(dialog).getByRole('textbox'), ' and after');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This entry changed elsewhere. Reloaded the latest version; try again.'
    );
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('ignores a read that a newer save superseded', async () => {
    let finishStaleRead: (value: TableEntryResponse) => void = () => {};
    api.entry.mockResolvedValueOnce(response({ [name.id]: 'Test entry', [done.id]: false }));
    api.entry.mockImplementationOnce(
      () => new Promise<TableEntryResponse>((resolve) => (finishStaleRead = resolve))
    );
    api.updateEntry.mockResolvedValue(
      response({ [name.id]: 'Test entry', [done.id]: true }, 'rev-2')
    );
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Test entry' });
    // Another pane's save starts a read; this row's own save lands before it.
    const { emitTableEvent } = await vi.importActual<typeof import('@desktop/features/database')>(
      '@desktop/features/database'
    );
    emitTableEvent({ type: 'table.entries.changed', tableId, entryId });
    await waitFor(() => expect(api.entry).toHaveBeenCalledTimes(2));
    const checkbox = within(dialog).getByRole('checkbox', { name: 'Done in Test entry' });
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    finishStaleRead(response({ [name.id]: 'Test entry', [done.id]: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkbox).toBeChecked();
  });

  describe('another write to its table', () => {
    const other = '00000000-0000-4000-8000-00000000000a';
    /** An event on the real table bus (the module mock only stubs local emits). */
    async function hear(event: TableEvent) {
      const { emitTableEvent } = await vi.importActual<typeof import('@desktop/features/database')>(
        '@desktop/features/database'
      );
      act(() => emitTableEvent(event));
    }

    async function openRow(shown = fields) {
      render(
        <TableEntryModal tableId={tableId} entryId={entryId} fields={shown} onClose={vi.fn()} />
      );
      return screen.findByRole('dialog', { name: 'Test entry' });
    }

    it('refreshes when a batch names this row after another one', async () => {
      api.entry
        .mockResolvedValueOnce(response({ [name.id]: 'Test entry', [notes.id]: 'Before' }))
        .mockResolvedValueOnce(response({ [name.id]: 'Test entry', [notes.id]: 'After' }, 'rev-2'));
      const dialog = await openRow();
      // A batch that names only the other row leaves this one be.
      await hear({ type: 'table.entries.changed', tableId, entryId: other, entryIds: [other] });
      expect(api.entry).toHaveBeenCalledTimes(1);

      await hear({
        type: 'table.entries.changed',
        tableId,
        entryId: other,
        entryIds: [other, entryId],
      });
      expect(await within(dialog).findByText('After')).toBeVisible();
      expect(api.entry).toHaveBeenCalledTimes(2);
    });

    it('refreshes on a batch too big to list, and on a field change to its table', async () => {
      api.entry.mockResolvedValue(response({ [name.id]: 'Test entry' }));
      await openRow();
      await hear({ type: 'table.entries.changed', tableId, entryId: other, allEntries: true });
      await waitFor(() => expect(api.entry).toHaveBeenCalledTimes(2));
      await hear({ type: 'table.fields.changed', tableId: 'table-1111111111111-zzzzzzzzz' });
      await hear({ type: 'table.fields.changed', tableId });
      await waitFor(() => expect(api.entry).toHaveBeenCalledTimes(3));
    });

    it('shows the row as deleted, read-only, when a batch delete took it', async () => {
      const due = field({
        id: 'fld-due',
        name: 'Due',
        type: 'date',
        recurrence: {
          statusFieldId: 'fld-status',
          doneOptionIds: ['done'],
          resetOptionId: null,
        },
      });
      api.entry
        .mockResolvedValueOnce(response({ [name.id]: 'Test entry', [done.id]: false }))
        .mockRejectedValueOnce(new FetchError('Entry not found', 404));
      const dialog = await openRow([...fields, due]);
      expect(within(dialog).getByRole('region', { name: 'Repeat: Due' })).toBeInTheDocument();

      await hear({
        type: 'table.entries.changed',
        tableId,
        entryId: other,
        entryIds: [other, entryId],
      });

      expect(await within(dialog).findByRole('status')).toHaveTextContent('This row was deleted.');
      // Its name and last values stay on show; nothing edits or saves it.
      expect(within(dialog).getByRole('heading', { name: 'Test entry' })).toBeVisible();
      expect(within(dialog).queryByRole('button', { name: /^Edit / })).toBeNull();
      expect(within(dialog).queryByRole('checkbox', { name: 'Done in Test entry' })).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Done (read-only)' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Notes (read-only)' })).toBeDisabled();
      expect(within(dialog).queryByRole('region', { name: /^Repeat:/ })).toBeNull();
      expect(within(dialog).queryByRole('alert')).toBeNull();
      expect(api.updateEntry).not.toHaveBeenCalled();
    });

    it('comes back to life when an undo brings the row back', async () => {
      api.entry
        .mockResolvedValueOnce(response({ [name.id]: 'Test entry' }))
        .mockRejectedValueOnce(new FetchError('Entry not found', 404))
        .mockResolvedValueOnce(response({ [name.id]: 'Test entry' }, 'rev-2'));
      const dialog = await openRow();
      await hear({ type: 'table.entries.changed', tableId, entryId, entryIds: [entryId] });
      await within(dialog).findByRole('status');
      await hear({ type: 'table.entries.changed', tableId, entryId, entryIds: [entryId] });
      expect(
        await within(dialog).findByRole('button', { name: 'Edit Name: Test entry' })
      ).toBeEnabled();
      expect(within(dialog).queryByRole('status')).toBeNull();
    });

    it('shows the row as deleted when a save finds it gone', async () => {
      api.entry.mockResolvedValue(response({ [name.id]: 'Test entry', [done.id]: false }));
      api.updateEntry.mockRejectedValue(new FetchError('Entry not found', 404));
      const dialog = await openRow();
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Done in Test entry' }));
      expect(await within(dialog).findByRole('status')).toHaveTextContent('This row was deleted.');
      expect(within(dialog).queryByRole('checkbox', { name: 'Done in Test entry' })).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Done (read-only)' })).toBeDisabled();
      expect(within(dialog).queryByRole('alert')).toBeNull();
    });
  });

  it('closes on Escape and from the close button', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule' }));
    const onClose = vi.fn();
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={onClose} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    dialog.focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close entry' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a click elsewhere closes an open editor unsaved; on the scrim, the next click closes the row', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule', [notes.id]: 'Tuesdays' }));
    const onClose = vi.fn();
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={onClose} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Notes' }));
    await userEvent.type(within(dialog).getByRole('textbox'), ' too');
    // Elsewhere in the row window.
    await userEvent.click(within(dialog).getByRole('heading', { name: 'Roast schedule' }));
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).getByText('Tuesdays')).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Notes' }));
    const scrim = document.querySelector<HTMLElement>('[data-table-entry-modal] > [aria-hidden]')!;
    await userEvent.click(scrim);
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.updateEntry).not.toHaveBeenCalled();
  });

  it('shows a repeat section for each repeating date field, after the properties', async () => {
    const recurrence = {
      statusFieldId: 'fld-status',
      doneOptionIds: ['done'],
      resetOptionId: null,
    };
    const due = field({ id: 'fld-due', name: 'Due', type: 'date', recurrence });
    const plain = field({ id: 'fld-start', name: 'Start', type: 'date' });
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule', [due.id]: '2026-10-12' }));
    render(
      <TableEntryModal
        tableId={tableId}
        entryId={entryId}
        fields={[...fields, due, plain]}
        onClose={vi.fn()}
      />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    expect(within(dialog).getByRole('region', { name: 'Repeat: Due' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: 'Repeat: Start' })).toBeNull();
  });

  it('shows no repeat section without a repeating field', async () => {
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule' }));
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={vi.fn()} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    expect(within(dialog).queryByRole('region', { name: /^Repeat:/ })).toBeNull();
  });

  it('edits a date range with Start and End and refuses an end before the start', async () => {
    const trip = field({ id: 'fld-trip', name: 'Trip', type: 'date', range: true });
    api.entry.mockResolvedValue(
      response({ [name.id]: 'Test entry', [trip.id]: '2026-10-12/2026-10-15' })
    );
    api.updateEntry.mockResolvedValue(
      response({ [name.id]: 'Test entry', [trip.id]: '2026-10-12/2026-10-18' }, 'rev-2')
    );
    render(
      <TableEntryModal
        tableId={tableId}
        entryId={entryId}
        fields={[name, trip]}
        onClose={vi.fn()}
      />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Test entry' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Trip' }));
    const end = within(dialog).getByLabelText('End');
    expect(within(dialog).getByLabelText('Start')).toHaveAttribute('data-value', '2026-10-12');
    expect((within(dialog).getByLabelText('Start') as HTMLInputElement).value).toMatch(
      /^Mon, Oct 12\b/
    );
    fireEvent.change(end, { target: { value: '2026-10-10' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(within(dialog).getAllByRole('alert')[0]).toHaveTextContent(
      'The end is before the start.'
    );
    fireEvent.change(end, { target: { value: '2026-10-18' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(tableId, entryId, {
        values: { [trip.id]: '2026-10-12/2026-10-18' },
        schemaVersion: 'schema-1',
        expectedRevision: 'rev-1',
      })
    );
  });

  it('shows a repeat section for a repeating range field too', async () => {
    const recurrence = {
      statusFieldId: 'fld-status',
      doneOptionIds: ['opt-done'],
      resetOptionId: null,
    };
    const due = field({ id: 'fld-due', name: 'Due', type: 'date', recurrence });
    const trip = field({ id: 'fld-trip', name: 'Trip', type: 'date', range: true, recurrence });
    api.entry.mockResolvedValue(response({ [name.id]: 'Test entry' }));
    render(
      <TableEntryModal
        tableId={tableId}
        entryId={entryId}
        fields={[name, due, trip]}
        onClose={vi.fn()}
      />
    );
    await screen.findByRole('dialog', { name: 'Test entry' });
    expect(screen.getByRole('region', { name: 'Repeat: Due' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Repeat: Trip' })).toBeInTheDocument();
  });

  describe('a repeating date’s editor is the date + repeat popover', () => {
    const recurrence = {
      statusFieldId: null,
      doneOptionIds: [],
      resetOptionId: null,
    };
    const due = field({ id: 'fld-due', name: 'Due', type: 'date', recurrence });
    const weekly = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      dtstart: '2026-10-12',
      current: '2026-10-12',
      tz: 'UTC',
    };

    beforeEach(() => {
      api.entry.mockResolvedValue(response({ [name.id]: 'Test entry', [due.id]: '2026-10-12' }));
      repeatsApi.get.mockResolvedValue({
        entryId,
        revision: 'rev-1',
        repeats: { [due.id]: weekly },
        log: [],
      });
    });

    async function openDue() {
      render(
        <TableEntryModal
          tableId={tableId}
          entryId={entryId}
          fields={[name, due]}
          onClose={vi.fn()}
        />
      );
      const dialog = await screen.findByRole('dialog', { name: 'Test entry' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Edit Due' }));
      await userEvent.click(within(dialog).getByRole('combobox', { name: 'Due' }));
      const card = screen.getByRole('dialog', { name: 'Choose date' });
      await within(card).findByRole('button', { name: 'Repeat, Every week on Monday' });
      return { dialog, card };
    }

    it('one outside press closes the popover and the field’s editor together, unsaved', async () => {
      const { dialog } = await openDue();
      fireEvent.pointerDown(within(dialog).getByRole('banner'));
      expect(screen.queryByRole('dialog', { name: 'Choose date' })).toBeNull();
      await waitFor(() =>
        expect(within(dialog).queryByRole('combobox', { name: 'Due' })).toBeNull()
      );
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(repeatsApi.move).not.toHaveBeenCalled();
    });

    it('a move from the popover shows in the window, and Save then writes nothing stale', async () => {
      repeatsApi.move.mockResolvedValue({
        ...response({ [name.id]: 'Test entry', [due.id]: '2026-10-14' }, 'rev-2'),
        fieldId: due.id,
        repeat: weekly,
        logged: [],
        removed: [],
        changed: true,
      });
      const { dialog, card } = await openDue();
      fireEvent.click(within(card).getByRole('gridcell', { name: /October 14/ }));
      await userEvent.click(within(card).getByRole('button', { name: 'Just this one' }));
      await waitFor(() =>
        expect(repeatsApi.move).toHaveBeenCalledWith(tableId, entryId, due.id, {
          expectedRevision: 'rev-1',
          schemaVersion: 'schema-1',
          expectedCurrent: '2026-10-12',
          to: '2026-10-14',
        })
      );
      await waitFor(() =>
        expect(within(dialog).getByRole('combobox', { name: 'Due' })).toHaveAttribute(
          'data-value',
          '2026-10-14'
        )
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(api.updateEntry).not.toHaveBeenCalled();
      expect(await within(dialog).findByRole('button', { name: 'Edit Due' })).toHaveTextContent(
        /Oct 14/
      );
    });
  });

  it('deletes the entry at its shown revision without a confirm, then closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule' }, 'rev-7'));
    api.deleteEntries.mockResolvedValue({ deletedIds: [entryId], alreadyDeleted: [] });
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={onClose} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.deleteEntries).toHaveBeenCalledWith(tableId, {
      entryIds: [entryId],
      expectedRevisions: { [entryId]: 'rev-7' },
    });
    expect(screen.queryByRole('dialog', { name: /Delete/ })).not.toBeInTheDocument();
    expect(events.emit).toHaveBeenCalledWith({
      type: 'table.entries.changed',
      tableId,
      entryId,
      entryIds: [entryId],
    });
  });

  it('keeps the preview open with the review dialog when the entry changed since', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.entry.mockResolvedValue(response({ [name.id]: 'Roast schedule' }));
    api.deleteEntries.mockRejectedValue(new FetchError('Changed since loaded.', 409, {}));
    render(
      <TableEntryModal tableId={tableId} entryId={entryId} fields={fields} onClose={onClose} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Roast schedule' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete entry' }));
    expect(await screen.findByRole('dialog', { name: 'Review changed entries' })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });
});
