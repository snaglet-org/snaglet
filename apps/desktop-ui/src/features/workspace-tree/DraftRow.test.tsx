/**
 * DraftRow — the tree's inline name prompt. Enter or blur commits, Escape
 * cancels, and the row is one-shot: the blur that follows Enter or Escape
 * (the row unmounts with focus inside) never creates the item again. A table
 * draft formats its name as typed; other kinds keep the text as typed.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DraftRow } from './DraftRow';

function renderDraft() {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <DraftRow
      depth={0}
      kind="doc"
      inputRef={{ current: null }}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
  const input = screen.getByRole('textbox', { name: 'doc name' });
  fireEvent.change(input, { target: { value: 'Notes' } });
  return { input, onCommit, onCancel };
}

describe('DraftRow', () => {
  it('commits once when Enter is followed by the blur of the closing row', () => {
    const { input, onCommit, onCancel } = renderDraft();

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Notes');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not create the item when Escape is followed by a blur', () => {
    const { input, onCommit, onCancel } = renderDraft();

    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits on blur alone', () => {
    const { input, onCommit } = renderDraft();

    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith('Notes');
  });

  it('formats a table name as typed and pasted, keeping the caret where the user is typing', async () => {
    const onCommit = vi.fn();
    render(
      <DraftRow
        depth={0}
        kind="table"
        inputRef={{ current: null }}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'table name' });
    const user = userEvent.setup();

    await user.type(input, 'Work Experience');
    expect(input).toHaveValue('work_experience');
    expect([input.selectionStart, input.selectionEnd]).toEqual([15, 15]);

    await user.type(input, 'Past ', { initialSelectionStart: 0, initialSelectionEnd: 0 });
    expect(input).toHaveValue('past_work_experience');
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);

    input.setSelectionRange(20, 20);
    await user.paste(' Log \t Book');
    expect(input).toHaveValue('past_work_experience_log_book');

    // Anything else stays for the create to reject, never silently dropped.
    await user.type(input, '-', { initialSelectionStart: 0, initialSelectionEnd: 0 });
    expect(input).toHaveValue('-past_work_experience_log_book');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('-past_work_experience_log_book');
  });

  it.each(['thread', 'doc'] as const)('keeps a %s name as typed', async (kind) => {
    const onCommit = vi.fn();
    render(
      <DraftRow
        depth={0}
        kind={kind}
        inputRef={{ current: null }}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />
    );
    const input = screen.getByRole('textbox', { name: `${kind} name` });

    await userEvent.setup().type(input, 'Work Experience');
    expect(input).toHaveValue('Work Experience');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Work Experience');
  });
});
