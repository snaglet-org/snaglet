import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportNode: vi.fn(),
  reset: vi.fn(),
  showToast: vi.fn(),
  state: { status: 'idle' } as Record<string, unknown>,
}));

vi.mock('@desktop/hooks/useNodeExport.js', () => ({
  useNodeExport: () => ({
    state: mocks.state,
    exportNode: mocks.exportNode,
    reset: mocks.reset,
  }),
}));
vi.mock('@desktop/utils/toast.js', () => ({ showToast: mocks.showToast }));

import { ExportTreeNodeAction } from './ExportTreeNodeAction';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { status: 'idle' };
});

describe('invocation and row isolation', () => {
  it('exports a doc without selecting, expanding, dragging, or opening the row menu', async () => {
    const user = userEvent.setup();
    const rowClick = vi.fn();
    const rowDoubleClick = vi.fn();
    const rowContextMenu = vi.fn();
    const rowDragStart = vi.fn();
    const rowPointerDown = vi.fn();
    render(
      <div
        onClick={rowClick}
        onDoubleClick={rowDoubleClick}
        onContextMenu={rowContextMenu}
        onDragStart={rowDragStart}
        onPointerDown={rowPointerDown}
      >
        <ExportTreeNodeAction kind="doc" id="doc-1" label="Alpha doc" />
      </div>
    );
    const button = screen.getByRole('button', { name: 'Export Alpha doc' });

    await user.click(button);
    fireEvent.doubleClick(button);
    fireEvent.contextMenu(button);
    fireEvent.dragStart(button);

    expect(mocks.exportNode).toHaveBeenCalledTimes(1);
    expect(mocks.exportNode).toHaveBeenCalledWith({
      kind: 'doc',
      id: 'doc-1',
      suggestedName: 'Alpha doc',
    });
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowDoubleClick).not.toHaveBeenCalled();
    expect(rowContextMenu).not.toHaveBeenCalled();
    expect(rowDragStart).not.toHaveBeenCalled();
    expect(rowPointerDown).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('draggable', 'false');
  });

  it('uses the same action for one batched container export and blocks double submit while busy', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ExportTreeNodeAction kind="container" id="container-1" label="Planning" />
    );

    await user.click(screen.getByRole('button', { name: 'Export Planning' }));
    expect(mocks.exportNode).toHaveBeenCalledWith({
      kind: 'container',
      id: 'container-1',
      suggestedName: 'Planning',
    });

    mocks.state = { status: 'working' };
    rerender(<ExportTreeNodeAction kind="container" id="container-1" label="Planning" />);
    expect(screen.getByRole('button', { name: 'Export Planning' })).toBeDisabled();
  });
});

describe('completion feedback', () => {
  it('reports partial container success with skipped, failed, and manifest details', () => {
    mocks.state = {
      status: 'container-written',
      path: '/home/user/Desktop/Planning',
      directoryName: 'Planning',
      manifestPath: '/home/user/Desktop/Planning/export-manifest.json',
      report: {
        summary: { containers: 2, docs: 3, skipped: 2, failed: 1 },
      },
    };

    render(<ExportTreeNodeAction kind="container" id="container-1" label="Planning" />);

    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringMatching(
        /Exported 3 docs.*2 skipped nodes.*1 failed node.*export-manifest\.json/
      ),
      { durationMs: 6000 }
    );
  });

  it('surfaces failures but stays silent when the picker was canceled', () => {
    mocks.state = { status: 'error', message: 'Destination is not a folder' };
    const { rerender } = render(
      <ExportTreeNodeAction kind="container" id="container-1" label="Planning" />
    );
    expect(mocks.showToast).toHaveBeenCalledWith('Export failed: Destination is not a folder', {
      durationMs: 6000,
    });

    mocks.showToast.mockClear();
    mocks.state = { status: 'canceled' };
    rerender(<ExportTreeNodeAction kind="container" id="container-1" label="Planning" />);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
