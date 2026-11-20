import type { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateTableFieldRequest, TableField } from '@snaglet/shared/types';
import { TableDraftView } from './TableDraftView';
import { TableFieldEditor } from './TableFieldEditor';

const api = vi.hoisted(() => ({
  create: vi.fn(),
  createField: vi.fn(),
  updateField: vi.fn(),
  fields: vi.fn(),
  list: vi.fn(),
  agents: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, agentsApi: { list: api.agents }, FetchError: core.FetchError };
});

const DRAFT_ID = 'table-1111111111111-aaaaaaaaa';
const tableId = 'table-2222222222222-bbbbbbbbb';
const FORMAT_ERROR = 'Use only lowercase letters, numbers, and underscores, like work_experience.';

// jsdom has no layout. Stub geometry only; typing runs through real ProseMirror.
beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => {
  vi.resetAllMocks();
  api.agents.mockResolvedValue([]);
  api.list.mockResolvedValue({ tables: [] });
  api.fields.mockResolvedValue({ fields: [] });
  api.create.mockImplementation((input: { id: string; name: string }) =>
    Promise.resolve({
      table: { ...input, origin: 'custom', projectId: null, sortOrder: 0, createdAt: '' },
    })
  );
  api.createField.mockImplementation((_tableId: string, input: CreateTableFieldRequest) =>
    Promise.resolve({ field: savedField(input) })
  );
});
afterEach(async () => {
  await act(async () => cleanup());
  vi.restoreAllMocks();
});

function savedField(input: CreateTableFieldRequest): TableField {
  return {
    range: false,
    ...input,
    referenceKind: input.referenceKind ?? null,
    tableId,
    columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
    position: 2,
    managed: false,
    collapsed: false,
    isTitle: false,
    multiple: false,
    options: null,
    revision: 1,
  };
}

/** TipTap keeps its editor on the contenteditable element. */
function editorOf(textbox: HTMLElement): Editor {
  const { editor } = textbox as HTMLElement & { editor?: Editor };
  if (!editor) throw new Error('Not a TipTap editor');
  return editor;
}

/** The collapsed caret's offset into the single paragraph's text. */
function caretOf(textbox: HTMLElement): number {
  const { from, to } = editorOf(textbox).state.selection;
  expect(to).toBe(from);
  return from - 1;
}

/**
 * Where a click would put the caret. jsdom has no layout, and user-event's
 * arrow keys cannot step out of the paragraph-level DOM selection the editor
 * leaves after typing, so the test places it through the editor.
 */
function placeCaret(textbox: HTMLElement, offset: number) {
  act(() => {
    editorOf(textbox).commands.setTextSelection(offset + 1);
  });
}

/**
 * Types, moves the caret into the middle, types again and pastes, checking
 * the text and the caret after each step. The text after the caret proves it
 * stayed put: a caret parked at the end would put `X Y` after `experience`.
 */
async function typeNameEdits(textbox: HTMLElement) {
  const user = userEvent.setup();
  await waitFor(() => expect(textbox).toHaveFocus());
  await user.keyboard('Work Experience');
  expect(textbox).toHaveTextContent('work_experience');
  expect(caretOf(textbox)).toBe('work_experience'.length);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  placeCaret(textbox, 'work'.length);
  await user.keyboard('X Y');
  expect(textbox).toHaveTextContent('workx_y_experience');
  expect(caretOf(textbox)).toBe('workx_y'.length);

  await user.paste('Notes \n\t Log');
  expect(textbox).toHaveTextContent('workx_ynotes_log_experience');
  expect(caretOf(textbox)).toBe('workx_ynotes_log'.length);

  await user.keyboard('-');
  expect(textbox).toHaveTextContent('workx_ynotes_log-_experience');
  expect(caretOf(textbox)).toBe('workx_ynotes_log-'.length);
  expect(screen.getByRole('alert')).toHaveTextContent(FORMAT_ERROR);

  await user.keyboard('{Backspace}');
  expect(textbox).toHaveTextContent('workx_ynotes_log_experience');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  return user;
}

describe('table and field names format as you type', () => {
  it('creates a table from capitals, spaces and a paste without moving the caret', async () => {
    render(<TableDraftView draftId={DRAFT_ID} />);
    const textbox = await screen.findByRole('textbox', { name: 'Table name' });
    const user = await typeNameEdits(textbox);
    expect(screen.getByRole('button', { name: 'Create table' })).toBeEnabled();

    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ id: DRAFT_ID, name: 'workx_ynotes_log_experience' })
    );
  });

  it('creates a field from capitals, spaces and a paste without moving the caret', async () => {
    render(<TableFieldEditor tableId={tableId} onClose={vi.fn()} />);
    const textbox = await screen.findByRole('textbox', { name: 'Field name' });
    await typeNameEdits(textbox);

    const form = screen.getByRole('region').querySelector('form');
    if (!form) throw new Error('Missing field form');
    fireEvent.submit(form);
    await waitFor(() =>
      expect(api.createField).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({ name: 'workx_ynotes_log_experience' })
      )
    );
  });

  it('formats a field rename, leaving the loaded name alone until it is edited', async () => {
    const field = savedField({
      id: 'field-1111111111111-aaaaaaaaa',
      name: 'Legacy Name',
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
    });
    render(<TableFieldEditor tableId={tableId} field={field} onClose={vi.fn()} />);
    const textbox = await screen.findByRole('textbox', { name: 'Field name' });
    await waitFor(() => expect(textbox).toHaveFocus());
    expect(textbox).toHaveTextContent('Legacy Name');

    placeCaret(textbox, 'Legacy N'.length);
    await userEvent.setup().keyboard('S');
    expect(textbox).toHaveTextContent('legacy_nsame');
    expect(caretOf(textbox)).toBe('legacy_ns'.length);
  });
});
