import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { EditorView } from '@tiptap/pm/view';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer/MarkdownRenderer';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { NODE_CHIP_MIME, setActiveDragChip, nodeToChipMarkdown } from '@desktop/utils/nodeChip';
import { __resetEntryNameCacheForTests } from './entryNameCache';
import { EntryReferenceChip } from './EntryReferenceChip';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});
const api = vi.hoisted(() => ({ resolveEntries: vi.fn(), entries: vi.fn(), agents: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, resolveEntries: api.resolveEntries, entries: api.entries },
    agentsApi: { ...actual.agentsApi, list: api.agents },
  };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const id = `${tableId}/${entryId}`;
const href = `entry:${id}`;
const openTableEntry = vi.fn();
const writeText = vi.fn().mockResolvedValue(undefined);

function show(children: ReactNode) {
  return render(
    <DashboardNavigationProvider
      value={{
        openInPane: vi.fn(),
        openThreadAgent: vi.fn(),
        requestReveal: vi.fn(),
        openTableEntry,
      }}
    >
      {children}
    </DashboardNavigationProvider>
  );
}

beforeEach(() => {
  __resetEntryNameCacheForTests();
  openTableEntry.mockReset();
  writeText.mockClear();
  api.resolveEntries.mockReset().mockResolvedValue({
    entries: [{ tableId, entryId, name: 'Current name', tableName: 'Reading list' }],
  });
  api.entries.mockReset().mockResolvedValue({ page: 3 });
  api.agents.mockResolvedValue([]);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
    return { pos: this.state.selection.from, inside: -1 };
  });
});
afterEach(() => {
  cleanup();
  __resetEntryNameCacheForTests();
  setActiveDragChip(null);
  vi.restoreAllMocks();
});

describe('rendered entry references', () => {
  it('preserves the entry URL, resolves its current name and opens the containing table', async () => {
    show(<MarkdownRenderer content={`[Old name](${href})`} />);
    const chip = await screen.findByRole('link');
    await waitFor(() => expect(chip).toHaveTextContent('Current name'));
    expect(chip).toHaveAttribute('href', href);
    expect(chip).toHaveAttribute('data-node-id', id);
    fireEvent.click(chip);
    expect(openTableEntry).toHaveBeenCalledWith(tableId, entryId);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies canonical markdown using the live label and drags the full identity', async () => {
    show(<EntryReferenceChip tableId={tableId} entryId={entryId} />);
    const chip = await screen.findByRole('link');
    await waitFor(() => expect(chip).toHaveTextContent('Current name'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`[Current name](${href})`));
    const setData = vi.fn();
    fireEvent.dragStart(chip, { dataTransfer: { setData, setDragImage: vi.fn() } });
    expect(setData).toHaveBeenCalledWith(
      NODE_CHIP_MIME,
      JSON.stringify({ id, kind: 'entry', title: 'Current name' })
    );
    expect(openTableEntry).not.toHaveBeenCalled();
  });

  it('keeps unnamed markdown empty while displaying its positional Untitled label', async () => {
    api.resolveEntries.mockResolvedValue({
      entries: [{ tableId, entryId, name: '', tableName: 'Reading list' }],
    });
    show(<MarkdownRenderer content={`[](${href})`} />);
    await waitFor(() => expect(screen.getByRole('link')).toHaveTextContent('Untitled 3'));
    expect(api.entries).toHaveBeenCalledWith(tableId, { focusEntryId: entryId, pageSize: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`[](${href})`));
  });

  it('uses a known fallback on failure without calling the entry unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.resolveEntries.mockRejectedValue(new Error('Offline'));
    show(<EntryReferenceChip tableId={tableId} entryId={entryId} name="Known name" />);
    act(() => emitTableEvent({ type: 'tables.invalidated' }));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.getByRole('link')).toHaveTextContent('Known name');
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-disabled');
  });

  it('disables navigation and drag only after authoritative absence', async () => {
    api.resolveEntries.mockResolvedValue({ entries: [] });
    show(<EntryReferenceChip tableId={tableId} entryId={entryId} />);
    await waitFor(() => expect(screen.getByRole('link')).toHaveTextContent('Unavailable entry'));
    const chip = screen.getByRole('link');
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAttribute('draggable', 'false');
    fireEvent.click(chip);
    expect(openTableEntry).not.toHaveBeenCalled();
  });

  it('renders a noninteractive chip inside a cell button without nested controls', async () => {
    show(
      <button type="button">
        Edit <EntryReferenceChip tableId={tableId} entryId={entryId} interactive={false} />
      </button>
    );
    await screen.findByRole('button', { name: 'Edit Current name' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('.md-chip-entry [tabindex]')).toBeNull();
  });
});

describe('editor entry references', () => {
  it.each([
    [false, ''],
    [false, '[Draft] \\ path'],
    [true, ''],
    [true, '[Draft] \\ path'],
  ] as const)(
    'pastes canonical markdown in richBlocks=%s with label %j',
    async (richBlocks, title) => {
      const onChange = vi.fn();
      show(
        <ChipEditableInput value="" onChange={onChange} ariaLabel="Notes" richBlocks={richBlocks} />
      );
      const input = await screen.findByRole('textbox', { name: 'Notes' });
      const markdown = nodeToChipMarkdown({ kind: 'entry', id, title });
      fireEvent.paste(input, {
        clipboardData: {
          getData: (type: string) => (type === 'text/plain' ? markdown : ''),
          types: ['text/plain'],
        },
      });
      await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(markdown));
      expect(input.querySelectorAll('.md-chip-entry')).toHaveLength(1);
      expect(input.querySelectorAll('.md-chip-table')).toHaveLength(0);
    }
  );

  it('opens by full identity, copies canonical markdown, and leaves persisted text untouched', async () => {
    const onChange = vi.fn();
    show(<ChipEditableInput value={`[Old name](${href})`} onChange={onChange} ariaLabel="Notes" />);
    const chip = await screen.findByRole('link');
    await waitFor(() => expect(chip).toHaveTextContent('Current name'));
    expect(chip).toHaveAttribute('data-node-id', id);
    fireEvent.click(chip);
    expect(openTableEntry).toHaveBeenCalledWith(tableId, entryId);
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(openTableEntry).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`[Current name](${href})`));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops an unnamed entry without persisting the display fallback', async () => {
    api.resolveEntries.mockResolvedValue({
      entries: [{ tableId, entryId, name: '', tableName: 'Reading list' }],
    });
    const onChange = vi.fn();
    show(<ChipEditableInput value="" onChange={onChange} ariaLabel="Notes" />);
    const input = await screen.findByRole('textbox', { name: 'Notes' });
    fireEvent.drop(input, {
      dataTransfer: {
        types: [NODE_CHIP_MIME],
        getData: (type: string) =>
          type === NODE_CHIP_MIME ? JSON.stringify({ kind: 'entry', id, title: '' }) : '',
        dropEffect: 'copy',
        files: [],
      },
      clientX: 0,
      clientY: 0,
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(`[](${href})`));
    await waitFor(() => expect(screen.getByRole('link')).toHaveTextContent('Untitled 3'));
  });
});
