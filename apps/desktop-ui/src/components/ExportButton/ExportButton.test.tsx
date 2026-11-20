/**
 * ExportButton — what the user is told afterward.
 *
 * Each outcome is a different claim about the world, and three of them are
 * easy to report wrongly: a renamed file, a canceled dialog, and a browser
 * download that has no path at all.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const exportNode = vi.fn();
let state: unknown = { status: 'idle' };
const reset = vi.fn();

vi.mock('@desktop/hooks/useNodeExport.js', () => ({
  useNodeExport: () => ({ state, exportNode, reset }),
}));

import { ExportButton } from './ExportButton';

beforeEach(() => {
  vi.clearAllMocks();
  state = { status: 'idle' };
});

describe('invocation', () => {
  it('passes the node identity through to the hook', async () => {
    const user = userEvent.setup();
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);

    await user.click(screen.getByRole('button', { name: /export/i }));

    expect(exportNode).toHaveBeenCalledWith({
      kind: 'doc',
      id: 'doc-1',
      suggestedName: 'Notes.md',
    });
  });

  it('forwards a thread message limit', async () => {
    const user = userEvent.setup();
    render(<ExportButton kind="thread" id="t-1" suggestedName="T.md" messageLimit={500} />);

    await user.click(screen.getByRole('button', { name: /export/i }));

    expect(exportNode).toHaveBeenCalledWith(expect.objectContaining({ messageLimit: 500 }));
  });

  it('is disabled while working, so a second click cannot stack a dialog', () => {
    state = { status: 'working' };
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('honors an explicit disabled', () => {
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('outcome reporting', () => {
  it('names the path when a file was written', () => {
    state = {
      status: 'written',
      path: '/home/user/Desktop/Notes.md',
      fileName: 'Notes.md',
      renamed: false,
    };
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);

    expect(screen.getByRole('status')).toHaveTextContent('/home/user/Desktop/Notes.md');
  });

  it('says the file was renamed rather than reporting the name the user chose', () => {
    // The user typed "Notes.md"; a collision produced "Notes (2).md". Showing
    // the requested name would send them looking for a file that is not there.
    state = {
      status: 'written',
      path: '/home/user/Desktop/Notes (2).md',
      fileName: 'Notes (2).md',
      renamed: true,
    };
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Notes (2).md');
    expect(status).toHaveTextContent(/not replaced/i);
  });

  it('shows the export icon (no text) in the pane topbar, keeping the accessible name', () => {
    render(<ExportButton variant="topbar" kind="doc" id="doc-1" suggestedName="Notes.md" />);
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button).not.toHaveTextContent('Export');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('reports a download without claiming a path', () => {
    state = { status: 'downloaded', fileName: 'Notes.md' };
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Downloaded');
    expect(status).toHaveTextContent('Notes.md');
    // Nothing was written, so no path may appear.
    expect(status.textContent).not.toMatch(/\/Users|Saved to/);
  });

  it('treats cancellation as neutral, not as an error', () => {
    state = { status: 'canceled' };
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);

    expect(screen.getByRole('status')).toHaveTextContent(/canceled/i);
    // A red alert for "I closed the dialog" would be wrong.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces a real failure as an alert', () => {
    state = { status: 'error', message: "Refusing to export into Snaglet's own storage" };
    render(<ExportButton kind="doc" id="doc-1" suggestedName="Notes.md" />);

    expect(screen.getByRole('alert')).toHaveTextContent(/own storage/i);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('stale results', () => {
  it('resets when the target node changes', () => {
    const { rerender } = render(<ExportButton kind="doc" id="doc-1" suggestedName="A.md" />);
    reset.mockClear();

    // Otherwise "Saved to …/A.md" would sit under a pane now showing doc-2.
    rerender(<ExportButton kind="doc" id="doc-2" suggestedName="B.md" />);

    expect(reset).toHaveBeenCalled();
  });

  it('resets when the kind changes', () => {
    const { rerender } = render(<ExportButton kind="doc" id="x" suggestedName="A.md" />);
    reset.mockClear();
    rerender(<ExportButton kind="thread" id="x" suggestedName="A.md" />);
    expect(reset).toHaveBeenCalled();
  });
});

describe('labels', () => {
  it('uses a custom label where the context needs one', async () => {
    render(
      <ExportButton
        kind="agent_memories"
        id="agent-1"
        suggestedName="clio memories.md"
        label="Export all memories"
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export all memories' })).toBeInTheDocument()
    );
  });
});
