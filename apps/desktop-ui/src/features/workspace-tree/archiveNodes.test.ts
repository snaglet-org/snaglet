/**
 * archiveNodesWithUndo — the tree's archive step: no confirmation, one toast
 * whose Undo restores every node it archived (each keeps its parent and slot,
 * so a reload puts it back in place).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { onLibraryEvent, type LibraryEvent } from '@desktop/utils/workspaceEvents';
import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { archiveNodesWithUndo, topmostNodes } from './archiveNodes';

const archive = vi.fn();
const restore = vi.fn();

vi.mock('@desktop/utils/api', () => ({
  archiveApi: {
    archive: (...args: unknown[]) => archive(...args),
    restore: (...args: unknown[]) => restore(...args),
  },
}));

const timestamp = '2026-01-01T00:00:00.000Z';
const doc = (id: string, title: string, containerId: string | null): LibraryTreeChild => ({
  kind: 'doc',
  id,
  containerId,
  title,
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const folder = (id: string, name: string, children: LibraryTreeChild[] = []): LibraryTreeChild => ({
  kind: 'container',
  id,
  parentId: null,
  name,
  sortOrder: 0,
  category: null,
  folderPath: null,
  githubUrl: null,
  createdBy: null,
  lastEditedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  children,
});

let events: LibraryEvent[] = [];
let toasts: ToastDetail[] = [];
let unsubscribe: (() => void) | null = null;
const onToast = (e: Event) => toasts.push((e as CustomEvent<ToastDetail>).detail);

beforeEach(() => {
  events = [];
  toasts = [];
  archive.mockReset().mockResolvedValue({ node: null, affected: 1 });
  restore.mockReset().mockResolvedValue({ node: null, affected: 1 });
  unsubscribe = onLibraryEvent((event) => events.push(event));
  window.addEventListener(TOAST_EVENT_NAME, onToast);
});

afterEach(() => {
  unsubscribe?.();
  window.removeEventListener(TOAST_EVENT_NAME, onToast);
});

describe('archiveNodesWithUndo', () => {
  it('archives without asking, prunes the row and offers an Undo that restores it in place', async () => {
    const note = doc('doc-1111111111111-aaaaaaaaa', 'Notes', null);

    await expect(archiveNodesWithUndo([note])).resolves.toEqual([note.id]);

    expect(archive).toHaveBeenCalledWith(note.id);
    expect(events).toEqual([{ type: 'archive-changed', ids: [note.id], reload: false }]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Archived “Notes”');
    expect(toasts[0].action?.label).toBe('Undo');

    events = [];
    toasts[0].action?.run();
    await vi.waitFor(() =>
      expect(events).toEqual([{ type: 'archive-changed', ids: [note.id], reload: true }])
    );
    expect(restore).toHaveBeenCalledWith(note.id);
  });

  it('asks for a reload when a container goes, since its archive cascades', async () => {
    const plans = folder('container-1111111111111-aaaaaaaaa', 'Plans');

    await archiveNodesWithUndo([plans]);

    expect(events).toEqual([{ type: 'archive-changed', ids: [plans.id], reload: true }]);
  });

  it('keeps a refused row, names it in an error toast, and undoes only what it archived', async () => {
    const kept = doc('doc-1111111111111-aaaaaaaaa', 'Kept', null);
    const gone = doc('doc-2222222222222-bbbbbbbbb', 'Gone', null);
    archive.mockImplementation(async (id: string) => {
      if (id === kept.id) throw new Error('locked');
      return { node: null, affected: 1 };
    });

    await expect(archiveNodesWithUndo([kept, gone])).resolves.toEqual([gone.id]);

    expect(events).toEqual([{ type: 'archive-changed', ids: [gone.id], reload: false }]);
    expect(toasts.map((t) => t.message)).toEqual([
      'Archived “Gone”',
      "Couldn't archive “Kept”: locked",
    ]);
    toasts[0].action?.run();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(restore).toHaveBeenCalledWith(gone.id);
  });

  it('does not restore a node someone else had archived already', async () => {
    const note = doc('doc-1111111111111-aaaaaaaaa', 'Notes', null);
    archive.mockResolvedValue({ node: null, affected: 0, alreadyArchived: true });

    await expect(archiveNodesWithUndo([note])).resolves.toEqual([note.id]);

    expect(events).toHaveLength(1);
    expect(toasts).toEqual([]);
  });
});

describe('topmostNodes', () => {
  it('drops a node whose folder is archived in the same step', () => {
    const inner = doc('doc-1111111111111-aaaaaaaaa', 'Inner', 'container-1111111111111-aaaaaaaaa');
    const plans = folder('container-1111111111111-aaaaaaaaa', 'Plans', [inner]);
    const loose = doc('doc-2222222222222-bbbbbbbbb', 'Loose', null);
    const index = new Map([plans, inner, loose].map((node) => [node.id, node]));

    expect(topmostNodes([inner, plans, loose], index)).toEqual([plans, loose]);
  });
});
