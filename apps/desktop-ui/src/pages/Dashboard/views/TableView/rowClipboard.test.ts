import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import {
  __clearCopiedRowsForTests,
  cellText,
  copyRows,
  copyableValues,
  hasCopiedRows,
  pasteValues,
  readCopiedRows,
  rowShortcut,
  rowsAsText,
} from './rowClipboard';

const tableId = 'table-1111111111111-aaaaaaaaa';
const otherTableId = 'table-1111111111111-bbbbbbbbb';
const linkedId = '00000000-0000-4000-8000-0000000000aa';

function field(partial: Partial<TableField> & Pick<TableField, 'id' | 'type'>): TableField {
  return {
    tableId,
    name: partial.id,
    columnName: partial.id,
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

const title = field({ id: 'field-name', type: 'text', isTitle: true });
const amount = field({ id: 'field-amount', type: 'number' });
const done = field({ id: 'field-done', type: 'checkbox' });
const tags = field({ id: 'field-tags', type: 'select', multiple: true });
const due = field({ id: 'field-due', type: 'date', range: true });
const at = field({ id: 'field-at', type: 'datetime' });
const parent = field({ id: 'field-parent', type: 'relation', referenceTableId: tableId });
const brief = field({ id: 'field-brief', type: 'relation', referenceKind: 'doc' });
const idField = field({ id: 'field-id', type: 'uuid', managed: true, columnName: 'id' });
const created = field({ id: 'field-created', type: 'datetime', managed: true });

const entry: TableEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-01T00:00:00.000000Z',
  revision: 'r'.repeat(64),
  values: {
    [idField.id]: '00000000-0000-4000-8000-000000000001',
    [created.id]: '2026-01-01T00:00:00.000000Z',
    [title.id]: 'Say "hi"\tthere',
    [amount.id]: '1.50',
    [done.id]: true,
    [tags.id]: ['a', 'b'],
    [due.id]: '2026-10-12/2026-10-15',
    [at.id]: '2026-10-01T22:30:00.000000Z',
    [parent.id]: linkedId,
    [brief.id]: 'doc-1111111111111-aaaaaaaaa',
  },
};
const relations = {
  relatedEntries: { [tableId]: { [linkedId]: { name: 'Parent row' } } },
  relatedItems: { doc: { 'doc-1111111111111-aaaaaaaaa': { title: 'Brief', archived: false } } },
};

let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };

beforeEach(() => {
  __clearCopiedRowsForTests();
  let stored = '';
  clipboard = {
    writeText: vi.fn(async (text: string) => {
      stored = text;
    }),
    readText: vi.fn(async () => stored),
  };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => {
  __clearCopiedRowsForTests();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('row clipboard text', () => {
  it('reads each cell the way a spreadsheet takes it', () => {
    const zone = 'America/Los_Angeles';
    expect(cellText(done, true)).toBe('TRUE');
    expect(cellText(done, null)).toBe('FALSE');
    expect(cellText(amount, '1.50')).toBe('1.50');
    expect(cellText(tags, ['a', 'b'])).toBe('a, b');
    expect(cellText(due, '2026-10-12/2026-10-15')).toBe('2026-10-12 – 2026-10-15');
    expect(cellText(at, '2026-10-01T22:30:00.000000Z', {}, zone)).toBe('2026-10-01 15:30');
    expect(cellText(parent, linkedId, relations)).toBe('Parent row');
    expect(cellText(parent, linkedId)).toBe(linkedId);
    expect(cellText(brief, ['doc-1111111111111-aaaaaaaaa'], relations)).toBe('Brief');
    expect(cellText(title, null)).toBe('');
  });

  it('writes one tab-separated line per row, quoting cells with tabs, breaks or quotes', () => {
    const second = { ...entry, values: { [title.id]: 'plain', [amount.id]: null } };
    expect(rowsAsText([entry, second], [title, amount], relations)).toBe(
      '"Say ""hi""\tthere"\t1.50\nplain\t'
    );
  });
});

describe('row clipboard values', () => {
  const fields = [idField, created, title, amount, done, tags, due, at, parent, brief];

  it('carries every editable value and leaves managed fields to the server', () => {
    const values = copyableValues(entry, fields);
    expect(Object.keys(values)).toEqual([
      title.id,
      amount.id,
      done.id,
      tags.id,
      due.id,
      at.id,
      parent.id,
      brief.id,
    ]);
    expect(values[brief.id]).toBe('doc-1111111111111-aaaaaaaaa');
  });

  it('drops values whose field is gone, managed now, or of another type or shape', async () => {
    await copyRows({ tableId, entries: [entry], fields, visibleFields: [title] });
    const found = await readCopiedRows(tableId);
    if (found?.kind !== 'rows') throw new Error('expected copied rows');
    const now = [
      title,
      { ...amount, type: 'text' as const },
      { ...tags, multiple: false },
      { ...due, range: false },
      { ...at, managed: true },
      parent,
    ];
    expect(pasteValues(found.copy, now)).toEqual([
      { [title.id]: entry.values[title.id], [parent.id]: linkedId },
    ]);
  });
});

describe('copied rows', () => {
  it('pastes into the table they came from, and reports another table', async () => {
    expect(await readCopiedRows(tableId)).toBeNull();
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    expect(clipboard.writeText).toHaveBeenCalledWith('"Say ""hi""\tthere"');
    expect(hasCopiedRows()).toBe(true);
    const found = await readCopiedRows(tableId);
    expect(found).toMatchObject({ kind: 'rows', copy: { sourceIds: [entry.id] } });
    expect(await readCopiedRows(otherTableId)).toEqual({ kind: 'otherTable' });
  });

  it('is dropped once something else is on the system clipboard', async () => {
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    clipboard.readText.mockResolvedValue('copied elsewhere');
    expect(await readCopiedRows(tableId)).toBeNull();
    expect(hasCopiedRows()).toBe(false);
  });

  it('matches the clipboard text across line-ending conversions', async () => {
    const second = { ...entry, values: { [title.id]: 'b' } };
    const first = { ...entry, values: { [title.id]: 'a' } };
    await copyRows({ tableId, entries: [first, second], fields: [title], visibleFields: [title] });
    clipboard.readText.mockResolvedValue('a\r\nb');
    expect(await readCopiedRows(tableId)).toMatchObject({ kind: 'rows' });
  });

  it('still pastes from memory when the system clipboard refuses or can’t be read', async () => {
    clipboard.writeText.mockRejectedValue(new Error('denied'));
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    clipboard.readText.mockResolvedValue('something else');
    expect(await readCopiedRows(tableId)).toMatchObject({ kind: 'rows' });

    clipboard.writeText.mockResolvedValue(undefined);
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    clipboard.readText.mockRejectedValue(new Error('not allowed'));
    expect(await readCopiedRows(tableId)).toMatchObject({ kind: 'rows' });
  });

  it('asks for a fresh copy when the clipboard can’t be read after leaving the window', async () => {
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    clipboard.readText.mockRejectedValue(new Error('not allowed'));
    window.dispatchEvent(new Event('blur'));
    expect(await readCopiedRows(tableId)).toEqual({ kind: 'unverified' });
    clipboard.readText.mockImplementation(async () => '"Say ""hi""\tthere"');
    expect(await readCopiedRows(tableId)).toMatchObject({ kind: 'rows' });
  });

  it('is dropped by any other copy or cut in the app', async () => {
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    document.dispatchEvent(new Event('copy'));
    expect(hasCopiedRows()).toBe(false);
    await copyRows({ tableId, entries: [entry], fields: [title], visibleFields: [title] });
    document.dispatchEvent(new Event('cut'));
    expect(hasCopiedRows()).toBe(false);
  });
});

describe('rowShortcut', () => {
  const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, 'target', { value: target });
    return rowShortcut(event);
  };

  it('takes Cmd or Ctrl with C or V and nothing else', () => {
    expect(press({ key: 'c', metaKey: true })).toBe('copy');
    expect(press({ key: 'V', ctrlKey: true })).toBe('paste');
    expect(press({ key: 'c' })).toBeNull();
    expect(press({ key: 'v', metaKey: true, shiftKey: true })).toBeNull();
    expect(press({ key: 'c', metaKey: true, altKey: true })).toBeNull();
    expect(press({ key: 'x', metaKey: true })).toBeNull();
  });

  it('leaves text fields, rich editors, dialogs, the sidebar and a text selection alone', () => {
    const input = document.createElement('input');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.append(input, editor);
    expect(press({ key: 'c', metaKey: true }, input)).toBeNull();
    expect(press({ key: 'v', metaKey: true }, editor)).toBeNull();

    const sidebar = document.createElement('div');
    sidebar.id = 'dashboard-sidebar';
    const row = document.createElement('button');
    sidebar.append(row);
    document.body.append(sidebar);
    row.focus();
    expect(press({ key: 'c', metaKey: true })).toBeNull();
    row.blur();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    expect(press({ key: 'c', metaKey: true })).toBeNull();
    dialog.remove();

    const text = document.createElement('p');
    text.textContent = 'Some words';
    document.body.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.addRange(range);
    expect(press({ key: 'c', metaKey: true })).toBeNull();
    window.getSelection()?.removeAllRanges();
    expect(press({ key: 'c', metaKey: true })).toBe('copy');
  });
});
