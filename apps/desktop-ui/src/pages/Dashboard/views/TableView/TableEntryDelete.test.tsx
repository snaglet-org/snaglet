import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchError } from '@desktop/utils/api';
import { TableEntryDelete } from './TableEntryDelete';

const api = vi.hoisted(() => ({ deleteEntries: vi.fn() }));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const entries = [{ id: '00000000-0000-4000-8000-000000000001', revision: 'a'.repeat(64) }];
const references = [
  {
    tableId: 'table-1111111111111-bbbbbbbbb',
    tableName: 'Related items',
    fieldId: 'field-1111111111111-bbbbbbbbb',
    fieldName: 'Source',
    count: 3,
  },
];
const request = {
  entryIds: [entries[0].id],
  expectedRevisions: { [entries[0].id]: entries[0].revision },
};
function setup() {
  const props = { tableId, entries, onDeleted: vi.fn(), onReload: vi.fn(), onCancel: vi.fn() };
  render(<TableEntryDelete {...props} />);
  return props;
}

beforeEach(() => {
  vi.resetAllMocks();
  api.deleteEntries.mockResolvedValue({
    deletedIds: [entries[0].id],
    alreadyDeleted: [],
    clearedReferences: [],
  });
});

describe('TableEntryDelete', () => {
  it('does not act on opening or canceling and freezes revisions for the confirmed request', async () => {
    const props = setup();
    expect(api.deleteEntries).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(api.deleteEntries).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete entries' }));
    expect(api.deleteEntries).toHaveBeenCalledWith(tableId, request);
    expect(props.onDeleted).toHaveBeenCalledWith([entries[0].id]);
  });

  it('keeps retryable errors inline and never removes rows before success', async () => {
    api.deleteEntries.mockRejectedValueOnce(new Error('Network unavailable'));
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete entries' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
    expect(props.onDeleted).not.toHaveBeenCalled();
    api.deleteEntries.mockResolvedValueOnce({
      deletedIds: [],
      alreadyDeleted: [entries[0].id],
      clearedReferences: [],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete entries' }));
    expect(api.deleteEntries).toHaveBeenLastCalledWith(tableId, request);
    expect(props.onDeleted).toHaveBeenCalledWith([entries[0].id]);
  });

  it('requires explicit fresh confirmation before clearing incoming links', async () => {
    api.deleteEntries.mockRejectedValueOnce(
      new FetchError('3 other entries link to this selection.', 409, { references })
    );
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete entries' }));
    expect(
      await screen.findByRole('dialog', { name: 'Delete linked entries?' })
    ).toBeInTheDocument();
    expect(screen.getByText('Related items · Source: 3 links')).toBeInTheDocument();
    expect(props.onDeleted).not.toHaveBeenCalled();
    expect(api.deleteEntries).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Clear links and delete' }));
    expect(api.deleteEntries).toHaveBeenLastCalledWith(tableId, {
      ...request,
      clearReferences: true,
    });
    expect(props.onDeleted).toHaveBeenCalledWith([entries[0].id]);
  });

  it('never silently retries stale entries with current server revisions', async () => {
    api.deleteEntries.mockRejectedValueOnce(
      new FetchError('Entry changed elsewhere', 409, {
        entries: [{ ...entries[0], revision: 'b'.repeat(64) }],
      })
    );
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete entries' }));
    expect(
      await screen.findByRole('dialog', { name: 'Review changed entries' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete entries' })).not.toBeInTheDocument();
    expect(props.onDeleted).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reload entries' }));
    expect(props.onReload).toHaveBeenCalledOnce();
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(api.deleteEntries).toHaveBeenCalledOnce();
  });

  it('does not offer reference clearing for malformed conflict details', async () => {
    api.deleteEntries.mockRejectedValueOnce(
      new FetchError('Review current entries', 409, { references: [{ count: 3 }] })
    );
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete entries' }));
    expect(
      await screen.findByRole('dialog', { name: 'Review changed entries' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Clear links and delete' })
    ).not.toBeInTheDocument();
  });

  it('locks duplicate submissions and dismissal while deletion is pending', async () => {
    let complete: (value: unknown) => void = () => undefined;
    api.deleteEntries.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const props = setup();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Delete entries' }));
    expect(api.deleteEntries).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(props.onDeleted).not.toHaveBeenCalled();
    await act(async () =>
      complete({ deletedIds: [entries[0].id], alreadyDeleted: [], clearedReferences: [] })
    );
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledOnce());
  });
});
