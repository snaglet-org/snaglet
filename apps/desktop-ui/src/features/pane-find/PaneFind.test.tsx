import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneFindProvider } from './PaneFindContext';
import { WorkspaceEditor } from '@desktop/features/rich-markdown/workspace-editor/WorkspaceEditor';

// The source-mode tests exercise the real shared autosave and find integration.
vi.mock('@desktop/features/rich-markdown/editor', () => ({ ChipEditableInput: () => null }));

function Pane({ active, name }: { active: boolean; name: string }) {
  return (
    <section aria-label={name}>
      <PaneFindProvider isActive={active}>
        <WorkspaceEditor
          kind="doc-body"
          savedValue="target TARGET target"
          sourceMode
          onSave={vi.fn()}
        />
      </PaneFindProvider>
    </section>
  );
}

describe('active pane find', () => {
  it('intercepts native Cmd/Ctrl+F only for the active pane, selects the query, wraps and restores focus', () => {
    const { rerender } = render(
      <>
        <Pane active name="First" />
        <Pane active={false} name="Second" />
      </>
    );
    const first = within(screen.getByRole('region', { name: 'First' }));
    const second = within(screen.getByRole('region', { name: 'Second' }));
    const editor = first.getByRole('textbox');
    editor.focus();
    expect(fireEvent.keyDown(window, { key: 'f', metaKey: true })).toBe(false);
    const input = first.getByRole('textbox', { name: 'Find in document' });
    expect(input).toHaveFocus();
    expect(second.queryByRole('search')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'target' } });
    expect(first.getByRole('status')).toHaveTextContent('1 of 3');
    fireEvent.click(first.getByRole('button', { name: 'Previous match' }));
    expect(first.getByRole('status')).toHaveTextContent('3 of 3');
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionEnd).toBe(6);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(first.getByRole('status')).toHaveTextContent('1 of 3');
    fireEvent.click(first.getByRole('button', { name: 'Match case' }));
    expect(first.getByRole('status')).toHaveTextContent('1 of 2');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first.queryByRole('search')).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
    rerender(
      <>
        <Pane active={false} name="First" />
        <Pane active name="Second" />
      </>
    );
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(second.getByRole('search')).toBeInTheDocument();
    expect(first.queryByRole('search')).not.toBeInTheDocument();
  });
  it('leaves Escape to other surfaces while focus is outside the open find bar', () => {
    render(
      <>
        <Pane active name="First" />
        <input aria-label="Elsewhere" />
      </>
    );
    const editor = within(screen.getByRole('region', { name: 'First' })).getByRole('textbox');
    editor.focus();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(screen.getByRole('search')).toBeInTheDocument();

    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' });
    elsewhere.focus();
    expect(fireEvent.keyDown(elsewhere, { key: 'Escape' })).toBe(true);
    expect(screen.getByRole('search')).toBeInTheDocument();

    const input = screen.getByRole('textbox', { name: 'Find in document' });
    input.focus();
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
  });

  it('leaves the caret where the user types in the source while the find bar stays open', () => {
    render(<Pane active name="First" />);
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox');
    editor.focus();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), {
      target: { value: 'target' },
    });
    // Navigating from the bar selects the current match.
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, 6]);

    editor.focus();
    editor.setSelectionRange(20, 20);
    fireEvent.change(editor, { target: { value: 'target TARGET target!' } });
    expect(editor).toHaveValue('target TARGET target!');
    // The edit re-finds, but must not pull the caret back onto a match, where
    // the next keystroke would overwrite it.
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([21, 21]);
  });

  it('requires replace-all confirmation, cancellation leaves draft untouched, and one undo restores it', async () => {
    render(<Pane active name="First" />);
    const editor = screen.getByRole('textbox');
    editor.focus();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), {
      target: { value: 'target' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), {
      target: { value: '$&' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all…' }));
    expect(editor).toHaveValue('target TARGET target');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(editor).toHaveValue('target TARGET target');
    fireEvent.click(screen.getByRole('button', { name: 'Replace all…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace 3 matches' }));
    await waitFor(() => expect(editor).toHaveValue('$& $& $&'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(editor, { key: 'z', metaKey: true });
    expect(editor).toHaveValue('target TARGET target');
  });
});

describe('find inside a preview dialog', () => {
  it('gives Cmd/Ctrl+F to the dialog, not the pane behind it, and Escape closes the bar first', () => {
    render(
      <>
        <Pane active name="Behind" />
        <div role="dialog" aria-label="Preview">
          <PaneFindProvider isActive inDialog>
            <WorkspaceEditor
              kind="doc-body"
              savedValue="needle in the previewed doc"
              sourceMode
              onSave={vi.fn()}
            />
          </PaneFindProvider>
        </div>
      </>
    );
    const behind = within(screen.getByRole('region', { name: 'Behind' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Preview' }));

    expect(fireEvent.keyDown(window, { key: 'f', metaKey: true })).toBe(false);
    const input = dialog.getByRole('textbox', { name: 'Find in document' });
    expect(input).toHaveFocus();
    expect(behind.queryByRole('search')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'needle' } });
    expect(dialog.getByRole('status')).toHaveTextContent('1 of 1');

    // Escape closes the find bar and is marked handled, so the dialog stays.
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(dialog.queryByRole('search')).not.toBeInTheDocument();
  });
});
