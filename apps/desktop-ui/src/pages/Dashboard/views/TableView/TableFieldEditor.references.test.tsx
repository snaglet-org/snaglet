import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry, TableField } from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { FetchError } from '@desktop/utils/api';
import { TableFieldEditor } from './TableFieldEditor';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({ value, onChange, ariaLabel, disabled }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const api = vi.hoisted(() => ({
  createField: vi.fn(),
  updateField: vi.fn(),
  fields: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const targetId = 'table-2222222222222-bbbbbbbbb';
const catalog: TableCatalogEntry[] = [
  {
    id: tableId,
    name: 'Notes',
    origin: 'custom',
    projectId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: targetId,
    name: 'Reading list',
    origin: 'custom',
    projectId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];
const briefs: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  columnName: 'brief',
  name: 'brief',
  description: null,
  type: 'relation',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: 'doc',
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  api.createField.mockResolvedValue({ field: briefs });
  api.updateField.mockResolvedValue({ field: { ...briefs, revision: 2 } });
  api.fields.mockResolvedValue({ fields: [briefs] });
  api.list.mockResolvedValue({ tables: catalog });
});
afterEach(async () => {
  await act(async () => cleanup());
});

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function submit() {
  const form = screen.getByRole('region').querySelector('form');
  if (!form) throw new Error('Missing field form');
  fireEvent.submit(form);
}
const kinds = () => within(screen.getByLabelText('Snaglet item types'));
const tables = () => within(screen.getByLabelText('Custom tables'));

describe('TableFieldEditor links to Snaglet items', () => {
  it('offers every Snaglet item kind beside the tables and creates a Docs relation', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'brief');
    change('Field type', 'relation');
    expect(screen.getByRole('group', { name: 'Links to' })).toBeInTheDocument();
    await tables().findByRole('button', { name: 'Reading list' });
    expect(
      kinds()
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Docs', 'Projects', 'Containers', 'Threads', 'Images', 'Agents', 'Members']);
    fireEvent.click(kinds().getByRole('button', { name: 'Docs' }));
    expect(kinds().getByRole('button', { name: 'Docs' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Allow multiple docs' })).not.toBePressed();
    submit();
    await waitFor(() => expect(api.createField).toHaveBeenCalledOnce());
    expect(api.createField).toHaveBeenCalledWith(tableId, {
      id: expect.stringMatching(/^field-\d{13}-[a-z0-9]{1,12}$/),
      name: 'brief',
      description: null,
      type: 'relation',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
      referenceKind: 'doc',
      multiple: false,
    });
  });

  it('makes a multiple Agents relation, and picking a table clears the kind', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'owners');
    change('Field type', 'relation');
    fireEvent.click(kinds().getByRole('button', { name: 'Agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow multiple agents' }));
    fireEvent.click(await tables().findByRole('button', { name: 'Reading list' }));
    expect(kinds().getByRole('button', { name: 'Agents' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(tables().getByRole('button', { name: 'Reading list' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Allow multiple entries' })).toBePressed();
    fireEvent.click(kinds().getByRole('button', { name: 'Agents' }));
    expect(screen.getByLabelText('Related table')).toHaveValue('');
    submit();
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({
          type: 'relation',
          referenceTableId: null,
          referenceKind: 'agent',
          multiple: true,
          nullable: false,
          defaultValue: [],
        })
      )
    );
  });

  it('refuses a relation with no target before saving', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    change('Field name', 'links');
    change('Field type', 'relation');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose what this relation links to: a table or a Snaglet item type.'
    );
    expect(api.createField).not.toHaveBeenCalled();
  });

  it('shows an existing kind, and a conversion 409 inline without going stale', async () => {
    api.updateField.mockRejectedValueOnce(
      new FetchError(
        'Some values are not a thread in Snaglet (doc-1111111111111-aaaaaaaaa). Edit those values first.',
        409
      )
    );
    render(<TableFieldEditor tableId={tableId} field={briefs} onClose={vi.fn()} />);
    expect(kinds().getByRole('button', { name: 'Docs' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(kinds().getByRole('button', { name: 'Threads' }));
    submit();
    expect(await screen.findByText(/not a thread in Snaglet/)).toHaveAttribute('role', 'alert');
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      briefs.id,
      expect.objectContaining({ referenceKind: 'thread', referenceTableId: null })
    );
    expect(screen.queryByRole('button', { name: 'Load latest field' })).not.toBeInTheDocument();
  });

  it('turns a Docs relation into Text without sending a kind', async () => {
    render(<TableFieldEditor tableId={tableId} field={briefs} onClose={vi.fn()} />);
    change('Field type', 'text');
    submit();
    await waitFor(() => expect(api.updateField).toHaveBeenCalledOnce());
    const [, , request] = api.updateField.mock.calls[0] as [string, string, object];
    expect(request).toMatchObject({ type: 'text', referenceTableId: null });
    expect(request).not.toHaveProperty('referenceKind');
    expect(
      screen.getByText(/Existing values will be converted to the new type/)
    ).toBeInTheDocument();
  });
});
