/**
 * Double-clicking the pane title renames an open image (and its stored file)
 * or an image file in a linked project folder; other files, and images
 * outside every linked folder, keep a read-only title. A refused rename shows
 * a toast.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';
import type { FileTreeNode, ImageTreeNode } from '@desktop/utils/api';
import type { DetailSelection } from '../../selection/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('../../views/DetailRouter.js', () => ({
  DetailRouter: () => <div>pane body</div>,
}));
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({ PaneHistoryNav: () => null }));

const api = vi.hoisted(() => ({
  listTree: vi.fn(),
  renameImage: vi.fn(),
  renameFile: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree },
    imagesApi: { ...actual.imagesApi, rename: api.renameImage },
    filesApi: { ...actual.filesApi, rename: api.renameFile },
  };
});

import { onLibraryEvent, type LibraryEvent } from '@desktop/utils/workspaceEvents';
import { __resetProjectListForTests } from '@desktop/features/database/projectList';
import { PaneChrome } from './PaneChrome';

const IMAGE: ImageTreeNode = {
  kind: 'image',
  id: 'image-1111111111111-aaaaaaaaa',
  containerId: null,
  name: 'Capture',
  description: null,
  tags: [],
  mimeType: 'image/png',
  url: '/api/images/image-1111111111111-aaaaaaaaa/content',
  sizeBytes: 4,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A file opened by path, as from a `file:` chip. */
function fileNode(name: string, folder = '/tmp/test-project/img'): FileTreeNode {
  return {
    kind: 'file',
    id: `${folder}/${name}`,
    containerId: null,
    projectId: '',
    relativePath: `${folder}/${name}`,
    name,
    absolutePath: `${folder}/${name}`,
    sizeBytes: 0,
    updatedAt: '',
  };
}

const LINKED_PROJECT = {
  kind: 'container',
  id: 'container-1111111111111-aaaaaaaaa',
  parentId: null,
  name: 'Test project',
  sortOrder: 0,
  category: 'project',
  folderPath: '/tmp/test-project',
  githubUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  children: [],
};

function renderPane(selection: DetailSelection) {
  const leaf: LayoutLeaf = {
    kind: 'leaf',
    id: 'leaf-1',
    selection,
    history: { entries: [], index: -1 },
  };
  return render(
    <PaneChrome
      leaf={leaf}
      isActive
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
    />
  );
}

function renameTitle(current: string, next: string) {
  fireEvent.doubleClick(screen.getByText(current));
  const input = screen.getByRole('textbox', { name: 'Rename' });
  fireEvent.change(input, { target: { value: next } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

let events: LibraryEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  vi.resetAllMocks();
  __resetProjectListForTests();
  api.listTree.mockResolvedValue([LINKED_PROJECT]);
  events = [];
  stop = onLibraryEvent((event) => events.push(event));
});

afterEach(() => {
  stop();
  cleanup();
});

describe('PaneChrome title rename for images', () => {
  it('renames an open image with the shown name as the expected one', async () => {
    api.renameImage.mockResolvedValue({ ...IMAGE, name: 'Sunset' });
    renderPane({ kind: 'image', image_id: IMAGE.id, node: IMAGE });

    renameTitle('Capture', 'Sunset');

    await waitFor(() =>
      expect(api.renameImage).toHaveBeenCalledWith(IMAGE.id, 'Sunset', 'Capture')
    );
    await waitFor(() =>
      expect(events).toContainEqual({
        type: 'renamed',
        kind: 'image',
        id: IMAGE.id,
        name: 'Sunset',
      })
    );
  });

  it('renames an image file in a linked folder on disk', async () => {
    api.renameFile.mockResolvedValue({
      path: '/tmp/test-project/img/Sunset.png',
      name: 'Sunset.png',
    });
    renderPane({ kind: 'file', node: fileNode('photo.png') });

    await waitFor(() => expect(screen.getByTitle('Double-click to rename')).toBeTruthy());
    renameTitle('photo.png', 'Sunset');

    await waitFor(() =>
      expect(api.renameFile).toHaveBeenCalledWith('/tmp/test-project/img/photo.png', 'Sunset')
    );
    await waitFor(() =>
      expect(events).toContainEqual({
        type: 'file-renamed',
        fromPath: '/tmp/test-project/img/photo.png',
        toPath: '/tmp/test-project/img/Sunset.png',
        name: 'Sunset.png',
      })
    );
  });

  it('offers no rename for an image outside every linked folder', async () => {
    renderPane({ kind: 'file', node: fileNode('photo.png', '/tmp/elsewhere') });
    await waitFor(() => expect(api.listTree).toHaveBeenCalled());
    // Let the loaded project list render.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByTitle('Double-click to rename')).toBeNull();
    fireEvent.doubleClick(screen.getByText('photo.png'));
    expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull();
  });

  it('shows a toast when the rename is refused', async () => {
    api.renameImage.mockRejectedValue(new Error('This image was renamed to "Elsewhere"'));
    renderPane({ kind: 'image', image_id: IMAGE.id, node: IMAGE });

    renameTitle('Capture', 'Sunset');

    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith(
        'Rename failed: This image was renamed to "Elsewhere"'
      )
    );
    expect(events.some((event) => event.type === 'renamed')).toBe(false);
  });

  it('keeps a read-only title for other files', () => {
    renderPane({ kind: 'file', node: fileNode('notes.md') });
    fireEvent.doubleClick(screen.getByText('notes.md'));
    expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull();
  });
});
