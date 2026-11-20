import type { ReactElement, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocTreeNode } from '@desktop/utils/api';
import { docsApi } from '@desktop/utils/api';
import type { DocRecord, DocSnapshotMeta } from '@desktop/utils/api/docs';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import {
  outlineEntries,
  type DocOutlineStore,
} from '@desktop/features/rich-markdown/outline/docOutline';
import { DocView } from './DocView';

const workspaceEditorFlush = vi.hoisted(() => vi.fn<() => Promise<string>>());
type SaveState = 'pristine' | 'dirty' | 'saving' | 'saved' | 'error';
/** The mounted editor's `onSaveStateChange`, so a test can report an edit. */
const workspaceEditorSaveState = vi.hoisted(() => ({
  emit: null as ((state: SaveState, error: string | null) => void) | null,
}));
/** The mounted editor's outline store and its latest line-link focus. */
const workspaceEditorProps = vi.hoisted(() => ({
  outline: null as DocOutlineStore | null,
  focus: null as { anchor: unknown; nonce: number; jump?: boolean } | null,
}));

vi.mock('@desktop/utils/api', () => ({
  docsApi: {
    update: vi.fn(),
    listSnapshots: vi.fn(),
    getSnapshot: vi.fn(),
    restoreSnapshot: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    clearSnapshots: vi.fn(),
  },
}));

vi.mock('@desktop/utils/workspaceEvents.js', () => ({ emitLibraryEvent: vi.fn() }));
vi.mock('../../chrome/PaneChrome/PaneChrome.js', () => ({
  usePaneChromeActions: vi.fn(),
  useHasPaneChrome: () => false,
}));

vi.mock('@desktop/components', async () => {
  const controls = await vi.importActual<typeof import('@desktop/components/controls')>(
    '@desktop/components/controls'
  );
  return { Button: controls.Button, TextInput: controls.TextInput };
});

vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: ({ value, disabled }: { value: string; disabled?: boolean }) => (
    <div data-testid="snapshot-preview-editor" data-disabled={String(!!disabled)}>
      {value}
    </div>
  ),
}));

vi.mock('@desktop/features/rich-markdown/workspace-editor/index.js', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    WorkspaceEditor: React.forwardRef<
      { focus: () => void; flush: () => Promise<string> },
      {
        sourceMode?: boolean;
        onSaveStateChange?: (state: SaveState, error: string | null) => void;
        outline?: DocOutlineStore;
        lineLinks?: { focus?: { anchor: unknown; nonce: number; jump?: boolean } | null };
      }
    >(({ sourceMode = false, onSaveStateChange, outline, lineLinks }, ref) => {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
        flush: workspaceEditorFlush,
      }));
      workspaceEditorProps.outline = outline ?? null;
      workspaceEditorProps.focus = lineLinks?.focus ?? null;
      React.useEffect(() => {
        workspaceEditorSaveState.emit = onSaveStateChange ?? null;
        onSaveStateChange?.('dirty', null);
      }, [onSaveStateChange]);
      return <div data-testid="workspace-editor" data-source-mode={String(sourceMode)} />;
    }),
  };
});

vi.mock('./DocProperties.js', () => ({
  DocProperties: ({
    editorSaveState,
    children,
  }: {
    editorSaveState?: string;
    children?: ReactNode;
  }) => (
    <div data-testid="doc-properties-content" data-editor-save-state={editorSaveState}>
      {children}
    </div>
  ),
}));

const node: DocTreeNode = {
  kind: 'doc',
  id: 'doc-1',
  containerId: null,
  title: 'Test doc',
  content: '# Test',
  sortOrder: 0,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
};

const listSnapshots = vi.mocked(docsApi.listSnapshots);
const createSnapshot = vi.mocked(docsApi.createSnapshot);
const getSnapshot = vi.mocked(docsApi.getSnapshot);
const restoreSnapshot = vi.mocked(docsApi.restoreSnapshot);
const deleteSnapshot = vi.mocked(docsApi.deleteSnapshot);
const clearSnapshots = vi.mocked(docsApi.clearSnapshots);

const snapshotMeta: DocSnapshotMeta = {
  id: 'snapshot-1',
  reason: 'manual',
  label: 'before edit',
  created_by: null,
  created_at: '2026-07-01T12:00:00.000Z',
  content_bytes: node.content.length,
};

/** `n` distinct metadata rows, newest first. */
function metas(n: number): DocSnapshotMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    ...snapshotMeta,
    id: `snapshot-${i + 1}`,
    label: `edit ${i + 1}`,
    created_at: new Date(Date.UTC(2026, 6, 1, 12, 0, n - i)).toISOString(),
  }));
}

function listResult(count: number, snapshots: DocSnapshotMeta[] = metas(Math.min(count, 200))) {
  return { doc_id: node.id, count, snapshots };
}

const restoredDoc: DocRecord = {
  id: node.id,
  containerId: null,
  title: node.title,
  content: '# Old version',
  dueAt: null,
  assignedTo: null,
  priority: null,
  createdBy: null,
  lastEditedBy: null,
  sortOrder: 0,
  createdAt: node.createdAt,
  updatedAt: '2026-07-01T12:05:00.000Z',
};

/** The Versions trigger, whatever count it currently shows. */
const versionsButton = () => screen.getByRole('button', { name: /^Versions( \d+)? ▾$/ });

beforeEach(() => {
  window.sessionStorage.clear();
  listSnapshots.mockReset();
  createSnapshot.mockReset();
  getSnapshot.mockReset();
  restoreSnapshot.mockReset();
  deleteSnapshot.mockReset();
  clearSnapshots.mockReset();
  workspaceEditorFlush.mockReset();
  workspaceEditorFlush.mockResolvedValue(node.content);
  listSnapshots.mockResolvedValue(listResult(0, []));
  createSnapshot.mockResolvedValue({
    id: 'snapshot-1',
    reason: 'manual',
    label: null,
    created_by: null,
    created_at: '2026-07-01T12:00:00.000Z',
    content_bytes: node.content.length,
  });
  getSnapshot.mockResolvedValue({ ...snapshotMeta, doc_id: node.id, content: '# Old version' });
  restoreSnapshot.mockResolvedValue(restoredDoc);
  deleteSnapshot.mockResolvedValue({ deleted: true, id: 'snapshot-1', doc_id: node.id });
  clearSnapshots.mockResolvedValue({ deleted: true, doc_id: node.id, deleted_count: 1 });
});

/** Render with the Properties panel open: Snapshot and Versions live in it. */
function renderDocView(ui: ReactElement) {
  const result = render(ui);
  fireEvent.click(screen.getByTestId('properties-toggle'));
  return result;
}

/** Open the Versions dropdown and click into the snapshot preview. */
async function openSnapshotPreview(user: ReturnType<typeof userEvent.setup>) {
  listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
  await user.click(versionsButton());
  await user.click(await screen.findByRole('option'));
  await screen.findByRole('button', { name: 'Restore this version' });
}

describe('DocView Properties header controls', () => {
  it('has no Properties bar: md/txt sits in the strip, Snapshot and Versions in the panel', async () => {
    const user = userEvent.setup();
    render(<DocView node={node} />);

    // Outside a pane the topbar controls render in the panel's own strip.
    const strip = screen.getByTestId('properties-strip');
    expect(within(strip).getByTestId('doc-source-toggle')).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: /^Versions/ })).not.toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: 'Snapshot' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('doc-properties-content')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('properties-toggle'));
    const panel = screen.getByRole('region', { name: 'Document properties' });
    expect(within(panel).getByTestId('doc-properties-content')).toBeInTheDocument();
    const versions = within(panel).getByRole('group', { name: 'Versions' });
    expect(within(versions).getByRole('button', { name: 'Snapshot' })).toBeInTheDocument();
    expect(within(versions).getByRole('button', { name: /^Versions/ })).toBeInTheDocument();
    await user.click(screen.getByTestId('properties-toggle'));
    expect(screen.queryByTestId('doc-properties-content')).not.toBeInTheDocument();
  });

  it('renders the Versions list on <body>, outside the panel and every scroll container', async () => {
    // WebKit (the packaged app's WKWebView) does not paint a position:fixed
    // menu nested in an overflow:auto scroller, though it hit-tests it; the
    // list must live in the body-level fixed layer like every other popover.
    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    await user.click(versionsButton());

    const listbox = await screen.findByRole('listbox', { name: 'Doc versions' });
    const surface = listbox.closest('[data-floating-layer]');
    expect(surface?.parentElement).toBe(document.body);
    expect(screen.getByRole('region', { name: 'Document properties' })).not.toContainElement(
      listbox
    );
    expect(versionsButton()).toHaveAttribute('aria-controls', surface?.id);
  });

  it('opens from the keyboard onto the first version and walks the list with arrows', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });

    versionsButton().focus();
    await user.keyboard('{Enter}');

    const options = await screen.findAllByRole('option');
    await waitFor(() => expect(options[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(versionsButton()).toHaveFocus();
  });

  it('closes the Versions list with the panel and does not reopen it with the panel', async () => {
    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    await user.click(versionsButton());
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    // A click with no pointer press (Enter on the toggle) never reaches the
    // list's outside-press dismissal: only the panel unmounting closes it.
    fireEvent.click(screen.getByTestId('properties-toggle'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('properties-toggle'));
    expect(versionsButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('reopens the list when a version fails to load, unless the panel has closed meanwhile', async () => {
    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    getSnapshot.mockRejectedValueOnce(new Error('version gone'));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    await user.click(versionsButton());
    await user.click(await screen.findByRole('option'));
    expect(await screen.findByRole('alert')).toHaveTextContent('version gone');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    let rejectLoad: ((reason: Error) => void) | undefined;
    getSnapshot.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        })
    );
    await user.click(screen.getByRole('option'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('properties-toggle'));
    await act(async () => rejectLoad?.(new Error('version gone')));

    fireEvent.click(screen.getByTestId('properties-toggle'));
    expect(versionsButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('returns focus to the Versions button after choosing a version with Enter', async () => {
    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    versionsButton().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('option')).toHaveFocus());
    await user.keyboard('{Enter}');

    await screen.findByRole('button', { name: 'Restore this version' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(versionsButton()).toHaveFocus();
  });

  it('shows a failed save in the toolbar while Properties is closed', async () => {
    render(<DocView node={node} />);
    act(() => workspaceEditorSaveState.emit?.('error', 'Network down'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('save failed');
    expect(alert).toHaveAttribute('title', 'Network down');
  });

  it('keeps the source toggle and editor on one controlled state', async () => {
    const user = userEvent.setup();
    render(<DocView node={node} />);

    const toggle = screen.getByTestId('doc-source-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-source-mode', 'false');
    await user.click(screen.getByTestId('properties-toggle'));
    expect(screen.getByTestId('doc-properties-content')).toHaveAttribute(
      'data-editor-save-state',
      'dirty'
    );

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('workspace-editor')).toHaveAttribute('data-source-mode', 'true');
    expect(window.sessionStorage.getItem('snaglet:workspace-editor:source-mode')).toBe('1');
  });

  it('uses Button loading and disabled semantics while creating a snapshot', async () => {
    let resolveSnapshot: (() => void) | undefined;
    createSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = () =>
            resolve({
              id: 'snapshot-1',
              reason: 'manual',
              label: null,
              created_by: null,
              created_at: '2026-07-01T12:00:00.000Z',
              content_bytes: node.content.length,
            });
        })
    );
    renderDocView(<DocView node={node} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Snapshot' }));

    const loadingButton = screen.getByRole('button', { name: 'Snapshotting…' });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute('aria-busy', 'true');

    resolveSnapshot?.();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Snapshotted ✓' })).toBeDisabled()
    );
  });

  it('exposes Versions as a pressed popup button and loads the list', async () => {
    renderDocView(<DocView node={node} />);

    const versions = versionsButton();
    expect(versions).toHaveAttribute('aria-expanded', 'false');
    expect(versions).toHaveAttribute('aria-pressed', 'false');

    await userEvent.setup().click(versions);

    expect(versions).toHaveAttribute('aria-expanded', 'true');
    expect(versions).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(listSnapshots).toHaveBeenCalledWith(node.id);
  });

  it('closes the Versions menu on Escape from the trigger and on a press outside it', async () => {
    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    const user = userEvent.setup();
    renderDocView(
      <>
        <DocView node={node} />
        <button type="button">Elsewhere</button>
      </>
    );

    await user.click(versionsButton());
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    // Focus is still on the trigger: Escape must reach the menu anyway.
    expect(versionsButton()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(versionsButton()).toHaveAttribute('aria-expanded', 'false');

    await user.click(versionsButton());
    await user.click(await screen.findByRole('option'));
    await screen.findByRole('button', { name: 'Restore this version' });
    await user.click(versionsButton());
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('returns focus to the trigger when Escape closes the menu from inside it', async () => {
    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    await user.click(versionsButton());
    const option = await screen.findByRole('option');
    option.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(versionsButton()).toHaveFocus();
  });

  it('keeps the menu open while its Clear all confirmation is in use', async () => {
    listSnapshots.mockResolvedValue(listResult(2));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 2 ▾' });

    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows Delete this version beside Restore and deletes after the in-app confirmation', async () => {
    // Regression guard: the confirmation is an in-app dialog — window.confirm
    // is suppressed by the Tauri webview and must never be involved.
    const nativeConfirm = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await openSnapshotPreview(user);

    const deleteButton = screen.getByRole('button', { name: 'Delete this version' });
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeInTheDocument();

    await user.click(deleteButton);

    // Nothing deleted yet — the dialog is the gate, and it identifies the
    // exact version being deleted.
    expect(deleteSnapshot).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Delete this version?' });
    expect(dialog).toHaveTextContent('before edit');

    await user.click(within(dialog).getByRole('button', { name: 'Delete this version' }));

    expect(nativeConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(deleteSnapshot).toHaveBeenCalledWith(node.id, 'snapshot-1'));
    // Preview exits back to the live doc and the list refreshes.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete this version' })).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('workspace-editor')).toBeInTheDocument();
    // Mount, dropdown open, post-delete refresh.
    expect(listSnapshots).toHaveBeenCalledTimes(3);
  });

  it('opens find on Cmd/Ctrl+F in the snapshot preview and searches its read-only content', async () => {
    getSnapshot.mockResolvedValue({
      ...snapshotMeta,
      doc_id: node.id,
      content: 'Alpha beta alpha',
    });
    const user = userEvent.setup();
    renderDocView(
      <PaneFindProvider isActive>
        <DocView node={node} />
      </PaneFindProvider>
    );
    await openSnapshotPreview(user);
    expect(screen.queryByRole('search')).not.toBeInTheDocument();

    // The pane owns Cmd/Ctrl+F; the preview must answer it, not drop it.
    expect(fireEvent.keyDown(window, { key: 'f', metaKey: true })).toBe(false);
    const input = await screen.findByRole('textbox', { name: 'Find in version' });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'alpha' } });
    const bar = screen.getByRole('search', { name: 'Find in version' });
    expect(within(bar).getByText('1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    expect(within(bar).getByText('1 of 1')).toBeInTheDocument();

    // Searching never turns the read-only preview editable, and offers no Replace.
    expect(screen.getByTestId('snapshot-preview-editor')).toHaveAttribute('data-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
  });

  it('performs no deletion when the confirmation is canceled', async () => {
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await openSnapshotPreview(user);

    await user.click(screen.getByRole('button', { name: 'Delete this version' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this version?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(deleteSnapshot).not.toHaveBeenCalled();
    // Still in preview — nothing changed, and the dialog is gone.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete this version' })).toBeInTheDocument();
  });

  it('surfaces a delete failure without claiming success', async () => {
    deleteSnapshot.mockRejectedValue(new Error('snapshot not found'));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await openSnapshotPreview(user);

    await user.click(screen.getByRole('button', { name: 'Delete this version' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this version?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete this version' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('snapshot not found');
    // Still in preview — the delete did not happen.
    expect(screen.getByRole('button', { name: 'Delete this version' })).toBeInTheDocument();
  });

  it('stays snapshotted through keys that change nothing and re-arms on a real edit', async () => {
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    await user.click(screen.getByRole('button', { name: 'Snapshot' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Snapshotted ✓' })).toBeDisabled()
    );
    await user.click(screen.getByTestId('workspace-editor'));
    await user.keyboard('{ArrowRight}{Tab}');
    expect(screen.getByRole('button', { name: 'Snapshotted ✓' })).toBeDisabled();

    act(() => workspaceEditorSaveState.emit?.('dirty', null));
    expect(screen.getByRole('button', { name: 'Snapshot' })).toBeEnabled();
  });

  it('waits for the latest flushed content before snapshotting and stays snapshotted after refresh', async () => {
    const latestContent = '# Test\n\nlatest queued edit';
    let resolveFlush: ((value: string) => void) | undefined;
    workspaceEditorFlush.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFlush = resolve;
        })
    );
    const { rerender } = renderDocView(<DocView node={node} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Snapshot' }));
    expect(createSnapshot).not.toHaveBeenCalled();

    resolveFlush?.(latestContent);
    await waitFor(() => expect(createSnapshot).toHaveBeenCalledWith(node.id));

    rerender(
      <DocView node={{ ...node, content: latestContent, updatedAt: '2026-07-01T12:01:00.000Z' }} />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Snapshotted ✓' })).toBeDisabled()
    );
  });
});

describe('DocView version count', () => {
  it('shows the resolved total for 0, 1 and many versions', async () => {
    listSnapshots.mockResolvedValue(listResult(0, []));
    const { unmount } = renderDocView(<DocView node={node} />);
    expect(await screen.findByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();
    unmount();

    listSnapshots.mockResolvedValue(listResult(1));
    const one = renderDocView(<DocView node={node} />);
    expect(await screen.findByRole('button', { name: 'Versions 1 ▾' })).toBeInTheDocument();
    one.unmount();

    listSnapshots.mockResolvedValue(listResult(12));
    renderDocView(<DocView node={node} />);
    expect(await screen.findByRole('button', { name: 'Versions 12 ▾' })).toBeInTheDocument();
  });

  it('loads the count from the list route on doc load, before the dropdown opens', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    renderDocView(<DocView node={node} />);

    expect(await screen.findByRole('button', { name: 'Versions 3 ▾' })).toBeInTheDocument();
    expect(listSnapshots).toHaveBeenCalledTimes(1);
    expect(listSnapshots).toHaveBeenCalledWith(node.id);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows the server total, not the page length, when history exceeds one page', async () => {
    listSnapshots.mockResolvedValue(listResult(250, metas(200)));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);

    expect(await screen.findByRole('button', { name: 'Versions 250 ▾' })).toBeInTheDocument();
    await user.click(versionsButton());
    expect(await screen.findAllByRole('option')).toHaveLength(200);
    expect(screen.getByText('Showing the latest 200 of 250 versions.')).toBeInTheDocument();
  });

  it('shows no number at all while the count is unresolved — never a 0', async () => {
    let resolveList: ((value: ReturnType<typeof listResult>) => void) | undefined;
    listSnapshots.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );
    renderDocView(<DocView node={node} />);

    expect(screen.getByRole('button', { name: 'Versions ▾' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Versions 0 ▾' })).not.toBeInTheDocument();

    resolveList?.(listResult(3));
    expect(await screen.findByRole('button', { name: 'Versions 3 ▾' })).toBeInTheDocument();
  });

  it('resets to unresolved and refetches when navigating to another doc', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    const { rerender } = renderDocView(<DocView node={node} />);
    expect(await screen.findByRole('button', { name: 'Versions 3 ▾' })).toBeInTheDocument();

    let resolveList: ((value: ReturnType<typeof listResult>) => void) | undefined;
    listSnapshots.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );
    rerender(<DocView node={{ ...node, id: 'doc-2', title: 'Other doc' }} />);

    // The previous doc's count of 3 must not carry over while doc-2's is pending.
    expect(screen.getByRole('button', { name: 'Versions ▾' })).toBeInTheDocument();
    expect(listSnapshots).toHaveBeenLastCalledWith('doc-2');

    resolveList?.({ doc_id: 'doc-2', count: 7, snapshots: metas(7) });
    expect(await screen.findByRole('button', { name: 'Versions 7 ▾' })).toBeInTheDocument();
  });

  it('increments after a manual snapshot', async () => {
    listSnapshots.mockResolvedValue(listResult(0, []));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    expect(await screen.findByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();

    listSnapshots.mockResolvedValue(listResult(1));
    await user.click(screen.getByRole('button', { name: 'Snapshot' }));

    expect(await screen.findByRole('button', { name: 'Versions 1 ▾' })).toBeInTheDocument();
    await waitFor(() => expect(listSnapshots).toHaveBeenCalledTimes(2));
  });

  it('re-fetches after a restore so the pre-restore snapshot is counted', async () => {
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await openSnapshotPreview(user);
    expect(await screen.findByRole('button', { name: 'Versions 1 ▾' })).toBeInTheDocument();

    // The server adds a pre-restore safety snapshot: 1 -> 2.
    listSnapshots.mockResolvedValue(listResult(2));
    await user.click(screen.getByRole('button', { name: 'Restore this version' }));

    await waitFor(() => expect(restoreSnapshot).toHaveBeenCalledWith(node.id, 'snapshot-1'));
    expect(await screen.findByRole('button', { name: 'Versions 2 ▾' })).toBeInTheDocument();
    expect(screen.getByTestId('workspace-editor')).toBeInTheDocument();
  });

  it('decrements after deleting a single version', async () => {
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await openSnapshotPreview(user);
    expect(await screen.findByRole('button', { name: 'Versions 1 ▾' })).toBeInTheDocument();

    listSnapshots.mockResolvedValue(listResult(0, []));
    await user.click(screen.getByRole('button', { name: 'Delete this version' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this version?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete this version' }));

    expect(await screen.findByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();
  });
});

describe('DocView clear all versions', () => {
  it('offers no Clear all action when there are no versions', async () => {
    listSnapshots.mockResolvedValue(listResult(0, []));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 0 ▾' });

    await user.click(versionsButton());

    expect(await screen.findByRole('listbox')).toHaveTextContent('No prior versions.');
    expect(screen.queryByRole('button', { name: 'Clear all versions…' })).not.toBeInTheDocument();
  });

  it('keeps the destructive action out of the listbox and reachable by keyboard', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });

    expect(versionsButton()).toHaveAttribute('aria-haspopup', 'listbox');
    await user.click(versionsButton());

    const listbox = await screen.findByRole('listbox', { name: 'Doc versions' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    // The button is an action, not a selectable version: it is not an
    // option and it does not live inside the listbox.
    expect(within(listbox).queryByRole('button')).not.toBeInTheDocument();
    const clearAll = screen.getByRole('button', { name: 'Clear all versions…' });
    expect(clearAll).toBeEnabled();

    clearAll.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Clear all versions?' })).toBeInTheDocument();
  });

  it('confirms with the count and the live-doc safety statement before deleting anything', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });
    await user.click(versionsButton());

    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));

    expect(clearSnapshots).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    expect(dialog).toHaveTextContent('Permanently delete all 3 saved versions of “Test doc”?');
    expect(dialog).toHaveTextContent('The current doc content will not change');
    expect(dialog).toHaveTextContent('This cannot be undone.');
  });

  it('deletes nothing when the confirmation is canceled', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });
    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));

    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(clearSnapshots).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Versions 3 ▾' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('shows Clearing… while in flight, then resets to zero, closes the dropdown and exits preview', async () => {
    let resolveClear: (() => void) | undefined;
    clearSnapshots.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClear = () => resolve({ deleted: true, doc_id: node.id, deleted_count: 1 });
        })
    );
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await openSnapshotPreview(user);
    expect(screen.getByTestId('snapshot-preview-editor')).toBeInTheDocument();

    listSnapshots.mockResolvedValue(listResult(1, [snapshotMeta]));
    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear all versions' }));

    // In flight: the dialog's confirm reads Clearing… and conflicting
    // snapshot actions are locked.
    const clearing = await within(dialog).findByRole('button', { name: 'Clearing…' });
    expect(clearing).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore this version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete this version' })).toBeDisabled();
    expect(versionsButton()).toBeDisabled();
    expect(clearSnapshots).toHaveBeenCalledWith(node.id);

    resolveClear?.();

    expect(await screen.findByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // Preview is gone; the live editor is back and untouched.
    expect(screen.queryByTestId('snapshot-preview-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-editor')).toBeInTheDocument();
    expect(restoreSnapshot).not.toHaveBeenCalled();
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });

  it('returns focus to the Versions button after Clear all succeeds', async () => {
    listSnapshots.mockResolvedValue(listResult(2));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 2 ▾' });

    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear all versions' }));

    expect(await screen.findByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(versionsButton()).toHaveFocus());
  });

  it('ignores a list response issued before the clear that lands after it', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });

    // Opening the dropdown issues a refetch that we hold open across the clear.
    let resolveLateList: ((value: ReturnType<typeof listResult>) => void) | undefined;
    listSnapshots.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLateList = resolve;
        })
    );
    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear all versions' }));
    expect(await screen.findByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();

    // The stale response arrives now — it must not bring back the earlier count.
    resolveLateList?.(listResult(3));
    await waitFor(() => expect(listSnapshots).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Versions 3 ▾' })).not.toBeInTheDocument();
    // Reopening refetches (the server now has nothing) — the stale 3-row
    // payload never became the cached list.
    listSnapshots.mockResolvedValue(listResult(0, []));
    await user.click(versionsButton());
    expect(await screen.findByRole('listbox')).toHaveTextContent('No prior versions.');
    expect(screen.getByRole('button', { name: 'Versions 0 ▾' })).toBeInTheDocument();
  });

  it('does not let a clear still in flight for one doc touch the next doc', async () => {
    let resolveClear: (() => void) | undefined;
    clearSnapshots.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClear = () => resolve({ deleted: true, doc_id: node.id, deleted_count: 3 });
        })
    );
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    const { rerender } = renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });
    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear all versions' }));
    await within(dialog).findByRole('button', { name: 'Clearing…' });

    // Navigate away while doc-1's clear is pending.
    listSnapshots.mockResolvedValue({ doc_id: 'doc-2', count: 5, snapshots: metas(5) });
    rerender(<DocView node={{ ...node, id: 'doc-2', title: 'Other doc' }} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Versions 5 ▾' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Snapshot' })).toBeEnabled();

    resolveClear?.();
    await waitFor(() => expect(clearSnapshots).toHaveBeenCalledTimes(1));

    // doc-2 keeps its own history: count, list and no dialog.
    expect(screen.getByRole('button', { name: 'Versions 5 ▾' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Versions 0 ▾' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(versionsButton());
    expect(await screen.findAllByRole('option')).toHaveLength(5);
    expect(clearSnapshots).toHaveBeenCalledWith(node.id);
  });

  it('does not carry an open confirmation across docs', async () => {
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    const { rerender } = renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });
    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    expect(screen.getByRole('dialog', { name: 'Clear all versions?' })).toBeInTheDocument();

    rerender(<DocView node={{ ...node, id: 'doc-2', title: 'Other doc' }} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Versions 3 ▾' })).toBeInTheDocument();
    expect(clearSnapshots).not.toHaveBeenCalled();
  });

  it('lets the unchanged current doc be snapshotted again after its history is cleared', async () => {
    listSnapshots.mockResolvedValue(listResult(0, []));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 0 ▾' });

    listSnapshots.mockResolvedValue(listResult(1));
    await user.click(screen.getByRole('button', { name: 'Snapshot' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Snapshotted ✓' })).toBeDisabled()
    );
    await screen.findByRole('button', { name: 'Versions 1 ▾' });

    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear all versions' }));
    await screen.findByRole('button', { name: 'Versions 0 ▾' });

    // Same content, but no history left — Snapshot is re-armed and works.
    const snapshot = await screen.findByRole('button', { name: 'Snapshot' });
    expect(snapshot).toBeEnabled();
    listSnapshots.mockResolvedValue(listResult(1));
    await user.click(snapshot);
    await waitFor(() => expect(createSnapshot).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Versions 1 ▾' })).toBeInTheDocument();
  });

  it('surfaces a failure in the dialog, keeps the real count and reloads the history', async () => {
    clearSnapshots.mockRejectedValue(new Error('network down'));
    listSnapshots.mockResolvedValue(listResult(3));
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    await screen.findByRole('button', { name: 'Versions 3 ▾' });
    await user.click(versionsButton());
    await user.click(await screen.findByRole('button', { name: 'Clear all versions…' }));
    const callsBefore = listSnapshots.mock.calls.length;

    const dialog = screen.getByRole('dialog', { name: 'Clear all versions?' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear all versions' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not clear versions: network down');
    // Retry stays available, nothing claims success.
    expect(within(dialog).getByRole('button', { name: 'Clear all versions' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Versions 3 ▾' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Versions 0 ▾' })).not.toBeInTheDocument();
    await waitFor(() => expect(listSnapshots.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});

describe('DocView outline', () => {
  /** The editor publishes these headings to the outline, as the real one does. */
  function publish(markdown: string) {
    act(() => {
      workspaceEditorProps.outline?.setEntries(outlineEntries(markdown));
    });
  }

  it('lists the headings the editor publishes in the Properties panel', () => {
    renderDocView(<DocView node={node} />);
    const panel = screen.getByRole('region', { name: 'Document properties' });
    expect(within(panel).getByText('No headings yet')).toBeInTheDocument();
    publish('# Intro\n\n## Goals');
    const outline = within(panel).getByRole('navigation', { name: 'Outline' });
    expect(
      within(outline)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Intro', 'Goals']);
  });

  it('turns a click into a heading jump for the editor', async () => {
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    publish('# Intro\n\n## Goals\n\n## Goals');

    await user.click(screen.getAllByRole('button', { name: 'Goals' })[1]!);
    expect(workspaceEditorProps.focus).toMatchObject({
      anchor: { heading: { slug: 'goals-1' } },
      jump: true,
    });
    const first = workspaceEditorProps.focus!.nonce;

    // Clicking the same entry again is a new request.
    await user.click(screen.getAllByRole('button', { name: 'Goals' })[1]!);
    expect(workspaceEditorProps.focus?.nonce).not.toBe(first);
  });

  it('lists but does not jump while a version preview replaces the editor', async () => {
    const user = userEvent.setup();
    renderDocView(<DocView node={node} />);
    publish('# Intro');
    await openSnapshotPreview(user);
    expect(screen.getByRole('button', { name: 'Intro' })).toBeDisabled();
  });
});
