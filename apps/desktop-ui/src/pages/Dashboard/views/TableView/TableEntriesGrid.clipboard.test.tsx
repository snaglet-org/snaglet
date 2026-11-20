import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableEntriesRequest,
  CreateTableEntriesResponse,
  TableEntriesResponse,
  TableEntry,
  TableField,
  TableHistoryResponse,
  TableHistoryStep,
} from '@snaglet/shared/types';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import type { ShowToastOptions } from '@desktop/utils/toast';
import { TableEntriesGrid } from './TableEntriesGrid';
import { __clearCopiedRowsForTests, copyRows } from './rowClipboard';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({ value, onChange, ariaLabel, autoFocus }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn<(message: string, options?: ShowToastOptions) => void>(),
}));
vi.mock('@desktop/utils/toast', () => toast);

const api = vi.hoisted(() => ({
  entries: vi.fn<() => Promise<TableEntriesResponse>>(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn(),
  createEntries:
    vi.fn<
      (tableId: string, input: CreateTableEntriesRequest) => Promise<CreateTableEntriesResponse>
    >(),
  updateEntry: vi.fn(),
  reorderFields: vi.fn(),
  setFieldView: vi.fn(),
  deleteEntries: vi.fn(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
  history: vi.fn<(limit?: number) => Promise<TableHistoryResponse>>(),
  stepHistory: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);

function field(
  partial: Partial<TableField> & Pick<TableField, 'id' | 'name' | 'type'>
): TableField {
  return {
    tableId,
    columnName: partial.name,
    description: null,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    revision: 1,
    managed: false,
    position: 0,
    collapsed: false,
    isTitle: false,
    multiple: false,
    range: false,
    options: null,
    ...partial,
  } as TableField;
}

const idField = field({ id: 'field-id', name: 'id', type: 'uuid', managed: true });
const name = field({
  id: 'field-1111111111111-aaaaaaaaa',
  name: 'name',
  type: 'text',
  isTitle: true,
});
const qty = field({ id: 'field-1111111111111-bbbbbbbbb', name: 'qty', type: 'number' });
const notes = field({
  id: 'field-1111111111111-ccccccccc',
  name: 'notes',
  type: 'text',
  collapsed: true,
});
const fields = [idField, name, qty, notes];

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
function row(n: number, label: string, amount: string): TableEntry {
  return {
    id: id(n),
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: String(n).repeat(64),
    values: {
      [idField.id]: id(n),
      [name.id]: label,
      [qty.id]: amount,
      [notes.id]: `${label} notes`,
    },
  };
}
const alpha = row(1, 'Alpha', '1');
const beta = row(2, 'Beta', '2');
const gamma = row(3, 'Gamma', '3');

const actor = { kind: 'user' as const, id: 'user-test', name: 'Test User' };
const pasteStep: TableHistoryStep = {
  id: 'step-paste',
  actor,
  kind: 'entry.write',
  label: 'Add 2 entries in test_items',
  tableIds: [tableId],
  state: 'done',
  seq: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };

function page(entries: TableEntry[]): TableEntriesResponse {
  return {
    entries,
    fields,
    totalCount: entries.length,
    page: 1,
    pageSize: 25,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  };
}

function grid(props: Partial<Parameters<typeof TableEntriesGrid>[0]> = {}) {
  return render(
    <PaneFindProvider isActive>
      <TableEntriesGrid tableId={tableId} columns={[]} fields={fields} {...props} />
    </PaneFindProvider>
  );
}

/** Rows' names in the order the grid shows them. */
function shownNames(): string[] {
  return screen
    .getAllByRole('checkbox', { name: /^Select entry / })
    .map((box) => (box.getAttribute('aria-label') ?? '').replace('Select entry ', ''));
}

const press = (key: string, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, metaKey: true });

/** Let a copy's clipboard write settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function check(...labels: string[]) {
  for (const label of labels)
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select entry ${label}` }));
}

beforeEach(() => {
  vi.resetAllMocks();
  __clearCopiedRowsForTests();
  __resetEntryNameCacheForTests();
  __resetTableHistoryForTests();
  localStorage.clear();
  let stored = '';
  clipboard = {
    writeText: vi.fn(async (text: string) => {
      stored = text;
    }),
    readText: vi.fn(async () => stored),
  };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  // The server's rows: a paste lands in them, so the reload after it agrees.
  let rows = [alpha, beta, gamma];
  api.entries.mockImplementation(async () => page(rows));
  api.fields.mockResolvedValue({ fields });
  api.history.mockResolvedValue({
    actor,
    steps: [pasteStep],
    undo: pasteStep,
    redo: null,
    depth: 100,
  });
  api.stepHistory.mockResolvedValue({ step: pasteStep, undo: null, redo: pasteStep });
  api.createEntries.mockImplementation(async (_tableId, input) => {
    const added = input.entries.map((entry, index) => ({
      id: entry.id,
      createdAt: '2026-01-02T00:00:00.000000Z',
      revision: String(index).repeat(64),
      values: { ...entry.values, [idField.id]: entry.id },
    }));
    const at = input.afterEntryId
      ? rows.findIndex((entry) => entry.id === input.afterEntryId) + 1
      : rows.length;
    rows = [...rows.slice(0, at), ...added, ...rows.slice(at)];
    return { entries: added, schemaVersion, relatedEntries: {}, relatedItems: {} };
  });
});
afterEach(() => {
  __clearCopiedRowsForTests();
  __resetTableHistoryForTests();
  window.getSelection()?.removeAllRanges();
});

describe('TableEntriesGrid row copy and paste', () => {
  it('copies checked rows as text and pastes them after the last one, checked, with Undo', async () => {
    grid();
    await check('Gamma', 'Alpha');
    expect(press('c')).toBe(false);
    // The shown columns (the collapsed one left out), rows in the order shown.
    expect(clipboard.writeText).toHaveBeenCalledWith(
      `${alpha.id}\tAlpha\t1\n${gamma.id}\tGamma\t3`
    );
    expect(toast.showToast).toHaveBeenCalledWith('Copied 2 rows');

    expect(press('v')).toBe(false);
    await waitFor(() => expect(api.createEntries).toHaveBeenCalledOnce());
    const [, input] = api.createEntries.mock.calls[0]!;
    expect(input.afterEntryId).toBe(gamma.id);
    expect(input.schemaVersion).toBe(schemaVersion);
    // Editable values only, the collapsed column's included; fresh ids.
    expect(input.entries.map((entry) => entry.values)).toEqual([
      { [name.id]: 'Alpha', [qty.id]: '1', [notes.id]: 'Alpha notes' },
      { [name.id]: 'Gamma', [qty.id]: '3', [notes.id]: 'Gamma notes' },
    ]);
    const newIds = input.entries.map((entry) => entry.id);
    expect(newIds.some((newId) => [alpha.id, beta.id, gamma.id].includes(newId))).toBe(false);

    await waitFor(() => expect(shownNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Alpha', 'Gamma']));
    const boxes = screen.getAllByRole('checkbox', { name: /^Select entry / });
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Pasted 2 rows', {
        action: { label: 'Undo', run: expect.any(Function) },
      })
    );
    const undo = toast.showToast.mock.calls.find(([message]) => message === 'Pasted 2 rows')?.[1];
    undo?.action?.run();
    await waitFor(() =>
      expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: pasteStep.id })
    );
  });

  it('appends the copies when the grid is sorted', async () => {
    grid({ sort: [{ fieldId: qty.id, direction: 'desc' }] });
    await check('Beta');
    press('c');
    press('v');
    await waitFor(() => expect(api.createEntries).toHaveBeenCalledOnce());
    expect(api.createEntries.mock.calls[0]![1]).not.toHaveProperty('afterEntryId');
  });

  it('leaves the keys alone with nothing checked, nothing copied, or a cell open', async () => {
    grid();
    await screen.findByRole('checkbox', { name: 'Select entry Alpha' });
    expect(press('c')).toBe(true);
    expect(press('v')).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();

    await check('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Edit name in entry Beta' }));
    const editor = await screen.findByRole('textbox', { name: 'name' });
    expect(press('c', editor)).toBe(true);
    expect(press('c')).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('leaves Cmd/Ctrl+C to a text selection', async () => {
    grid();
    await check('Alpha');
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('Beta'));
    window.getSelection()?.addRange(range);
    expect(press('c')).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('pastes nothing once something else was copied, and says where other rows go', async () => {
    grid();
    await check('Alpha');
    press('c');
    await settle();
    clipboard.readText.mockResolvedValue('copied in another app');
    expect(press('v')).toBe(false);
    await waitFor(() => expect(clipboard.readText).toHaveBeenCalled());
    expect(api.createEntries).not.toHaveBeenCalled();

    clipboard.writeText.mockRejectedValue(new Error('denied'));
    await copyRows({
      tableId: 'table-1111111111111-bbbbbbbbb',
      entries: [alpha],
      fields,
      visibleFields: [name],
    });
    press('v');
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Paste rows into the table they came from.')
    );
    expect(api.createEntries).not.toHaveBeenCalled();
  });

  it('asks for a fresh copy when the clipboard can’t be read after leaving the window', async () => {
    grid();
    await check('Alpha');
    press('c');
    await settle();
    clipboard.readText.mockRejectedValue(new Error('not allowed'));
    window.dispatchEvent(new Event('blur'));
    expect(press('v')).toBe(false);
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Copy the rows again to paste them here.')
    );
    expect(api.createEntries).not.toHaveBeenCalled();
  });

  it('pastes from memory when the system clipboard refused the copy', async () => {
    clipboard.writeText.mockRejectedValue(new Error('denied'));
    clipboard.readText.mockRejectedValue(new Error('denied'));
    grid();
    await check('Beta');
    press('c');
    // Nothing checked now: the copies follow the last copied row shown.
    await check('Beta');
    press('v');
    await waitFor(() => expect(api.createEntries).toHaveBeenCalledOnce());
    expect(api.createEntries.mock.calls[0]![1].afterEntryId).toBe(beta.id);
    await waitFor(() => expect(shownNames()).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma']));
  });

  it('says why a refused paste made nothing', async () => {
    api.createEntries.mockRejectedValue(new Error('qty: enter a number.'));
    grid();
    await check('Alpha');
    press('c');
    press('v');
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('qty: enter a number.', { durationMs: 4000 })
    );
    expect(within(document.body).getAllByRole('checkbox', { name: /^Select entry / })).toHaveLength(
      3
    );
  });
});
