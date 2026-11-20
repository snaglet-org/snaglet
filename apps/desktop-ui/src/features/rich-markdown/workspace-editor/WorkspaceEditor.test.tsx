import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceEditor } from './WorkspaceEditor';
import type { WorkspaceEditorAutosaveState } from './types';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({
    value,
    topRightSlot,
    allowMarkdownPreview,
    keepSelectionOnExternalChange,
  }: {
    value: string;
    topRightSlot?: React.ReactNode;
    allowMarkdownPreview?: boolean;
    keepSelectionOnExternalChange?: boolean;
  }) => (
    <div
      data-testid="mock-rich-editor"
      data-preview-enabled={allowMarkdownPreview ? 'true' : 'false'}
      data-keeps-selection={keepSelectionOnExternalChange ? 'true' : 'false'}
    >
      {topRightSlot}
      <div data-testid="mock-rich-value">{value}</div>
    </div>
  ),
}));

const MARKDOWN = '# Hello\n\nBody with [chip](doc-1111111111111-9gqbtkgh1).';

describe('WorkspaceEditor source mode', () => {
  it('renders no in-editor save status strip (status is surfaced at the section title now)', () => {
    render(<WorkspaceEditor kind="project-description" savedValue={MARKDOWN} onSave={vi.fn()} />);

    expect(screen.getByTestId('mock-rich-editor')).toBeInTheDocument();
    // A save from another client must not move the caret.
    expect(screen.getByTestId('mock-rich-editor')).toHaveAttribute('data-keeps-selection', 'true');
    expect(screen.queryByTestId('workspace-editor-source-textarea')).not.toBeInTheDocument();
    // No status inside the editor: consumers pipe it to their section title
    // via onSaveStateChange + EditorSaveHint.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses the controlled sourceMode prop as the single mode authority', () => {
    const { rerender } = render(
      <WorkspaceEditor kind="doc-body" savedValue={MARKDOWN} onSave={vi.fn()} sourceMode />
    );

    const textarea = screen.getByTestId('workspace-editor-source-textarea');
    expect(textarea).toHaveValue(MARKDOWN);
    expect(screen.queryByTestId('mock-rich-editor')).not.toBeInTheDocument();

    rerender(
      <WorkspaceEditor kind="doc-body" savedValue={MARKDOWN} onSave={vi.fn()} sourceMode={false} />
    );

    expect(screen.getByTestId('mock-rich-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-editor-source-textarea')).not.toBeInTheDocument();
  });

  it('hides host and preview chrome without overriding controlled source mode', () => {
    const chrome = <button type="button">Host chrome</button>;
    const { rerender } = render(
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MARKDOWN}
        onSave={vi.fn()}
        topRightSlot={chrome}
        hideChrome
      />
    );

    expect(screen.queryByRole('button', { name: 'Host chrome' })).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-rich-editor')).toHaveAttribute('data-preview-enabled', 'false');

    rerender(
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MARKDOWN}
        onSave={vi.fn()}
        topRightSlot={chrome}
        hideChrome
        sourceMode
      />
    );

    expect(screen.getByTestId('workspace-editor-source-textarea')).toHaveValue(MARKDOWN);
    expect(screen.queryByRole('button', { name: 'Host chrome' })).not.toBeInTheDocument();
  });

  it('preserves the current draft when the owner switches back to rich mode', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MARKDOWN}
        onSave={onSave}
        autosaveDelayMs={10_000}
        sourceMode
      />
    );

    await user.type(screen.getByTestId('workspace-editor-source-textarea'), ' more');
    rerender(
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MARKDOWN}
        onSave={onSave}
        autosaveDelayMs={10_000}
        sourceMode={false}
      />
    );

    expect(screen.getByTestId('mock-rich-value').textContent).toBe(`${MARKDOWN} more`);
  });

  it('autosaves edits made in source mode and reports typed save states', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onSaveStateChange = vi.fn();
    render(
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MARKDOWN}
        onSave={onSave}
        onSaveStateChange={onSaveStateChange}
        autosaveDelayMs={0}
        sourceMode
      />
    );

    await user.type(screen.getByTestId('workspace-editor-source-textarea'), ' more');

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(`${MARKDOWN} more`));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onSaveStateChange).toHaveBeenCalledWith('pristine', null);
    expect(onSaveStateChange).toHaveBeenCalledWith('dirty', null);
    expect(onSaveStateChange).toHaveBeenCalledWith('saved', null);
  });

  it("reports saving → saved with no blank step when the client's own save echo lands first", async () => {
    let resolveSave!: (value: string) => void;
    const onSave = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSave = resolve;
        })
    );
    const onSaveStateChange =
      vi.fn<(state: WorkspaceEditorAutosaveState, error: string | null) => void>();
    const editor = (savedValue: string) => (
      <WorkspaceEditor
        kind="doc-body"
        savedValue={savedValue}
        onSave={onSave}
        onSaveStateChange={onSaveStateChange}
        autosaveDelayMs={0}
        sourceMode
      />
    );
    const { rerender } = render(editor(MARKDOWN));

    fireEvent.change(screen.getByTestId('workspace-editor-source-textarea'), {
      target: { value: `${MARKDOWN} more` },
    });
    await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith('saving', null));

    // `doc.saved` for this very save reaches the pane before the PATCH response.
    rerender(editor(`${MARKDOWN} more`));
    await act(async () => {
      resolveSave(`${MARKDOWN} more`);
    });
    await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith('saved', null));

    const states = onSaveStateChange.mock.calls.map(([state]) => state);
    expect(states.filter((state, i) => state !== states[i - 1])).toEqual([
      'pristine',
      'dirty',
      'saving',
      'saved',
    ]);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('reports save failures through onSaveStateChange rather than an in-editor strip', async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSaveStateChange = vi.fn();
    const { unmount } = render(
      <WorkspaceEditor
        kind="project-description"
        savedValue={MARKDOWN}
        onSave={vi.fn().mockRejectedValue(new Error('disk full'))}
        onSaveStateChange={onSaveStateChange}
        autosaveDelayMs={10_000}
        sourceMode
      />
    );

    await user.type(screen.getByTestId('workspace-editor-source-textarea'), ' more');
    await user.keyboard('{Control>}s{/Control}');

    // The failure surfaces to the owning surface (which renders it at the
    // section title), not as an in-editor status role.
    await waitFor(() => expect(onSaveStateChange).toHaveBeenCalledWith('error', 'disk full'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    unmount();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    errorSpy.mockRestore();
  });
});

describe('WorkspaceEditor saveMode="manual"', () => {
  const renderManual = (onSave: (next: string) => Promise<string | void>, savedValue = 'Saved') =>
    render(
      <WorkspaceEditor
        kind="thread-system-prompt"
        saveMode="manual"
        sourceMode
        savedValue={savedValue}
        onSave={onSave}
      />
    );

  it('enables Save only when the draft differs, and sends only on Save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (next: string) => next.trimEnd());
    renderManual(onSave);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const textarea = screen.getByTestId('workspace-editor-source-textarea');
    await user.type(textarea, ' and more  {enter}');
    expect(onSave).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');

    await user.click(save);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Saved and more  \n');
    // The server trimmed; the text the user typed stays verbatim.
    expect(textarea).toHaveValue('Saved and more  \n');
    expect(save).toBeDisabled();
  });

  it('Cmd+S saves the draft', async () => {
    const onSave = vi.fn(async (next: string) => next);
    renderManual(onSave);
    const textarea = screen.getByTestId('workspace-editor-source-textarea');
    fireEvent.change(textarea, { target: { value: 'Edited' } });
    fireEvent.keyDown(textarea, { key: 's', metaKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Edited'));
  });

  it('a failed save keeps the draft and says so', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderManual(onSave);
    const textarea = screen.getByTestId('workspace-editor-source-textarea');
    fireEvent.change(textarea, { target: { value: 'Keep me ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Save failed: offline')
    );
    expect(textarea).toHaveValue('Keep me ');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a savedValue update while dirty leaves the draft alone', () => {
    const onSave = vi.fn(async (next: string) => next);
    const { rerender } = renderManual(onSave, 'v1');
    const textarea = screen.getByTestId('workspace-editor-source-textarea');
    fireEvent.change(textarea, { target: { value: 'v1 typing ' } });
    rerender(
      <WorkspaceEditor
        kind="thread-system-prompt"
        saveMode="manual"
        sourceMode
        savedValue="v2 echoed"
        onSave={onSave}
      />
    );
    expect(textarea).toHaveValue('v1 typing ');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Discard restores the saved value', () => {
    renderManual(vi.fn(), 'Original');
    const textarea = screen.getByTestId('workspace-editor-source-textarea');
    fireEvent.change(textarea, { target: { value: 'Scratch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(textarea).toHaveValue('Original');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('WorkspaceEditor source mode live styling', () => {
  it('styles a heading by level as soon as "## " is typed, and the text stays plain markdown', async () => {
    const user = userEvent.setup({ delay: null });
    const onSave = vi.fn();
    render(<WorkspaceEditor kind="doc-body" savedValue="" onSave={onSave} sourceMode />);
    const area = screen.getByTestId('workspace-editor-source-textarea');
    const highlight = screen.getByTestId('workspace-editor-source-highlight');

    await user.type(area, '## ');
    const heading = highlight.querySelector('[data-line-kind="heading"]');
    expect(heading).toHaveAttribute('data-level', '2');

    await user.type(area, 'Title{Enter}- item with **bold**');
    expect(area).toHaveValue('## Title\n- item with **bold**');
    // The styled copy holds exactly the same text, so it lines up.
    expect(highlight.textContent).toBe('## Title\n- item with **bold**');
    expect(highlight.querySelector('[data-line-kind="list"]')).toBeInTheDocument();
    expect(highlight).toHaveAttribute('aria-hidden', 'true');
  });
});
