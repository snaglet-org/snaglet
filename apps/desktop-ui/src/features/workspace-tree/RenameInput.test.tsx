import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { formatTableName } from '@snaglet/shared/utils';
import { RenameInput } from './RenameInput';

describe('RenameInput', () => {
  it('commits once for Enter followed by blur when the caller returns nothing', () => {
    const onCommit = vi.fn();
    render(<RenameInput initialValue="Alpha" onCommit={onCommit} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'Beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Beta');
  });

  it('re-arms after the caller resolves false and keeps the typed text', async () => {
    const onCommit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onValueChange = vi.fn();
    render(
      <RenameInput
        initialValue="Alpha"
        onCommit={onCommit}
        onCancel={vi.fn()}
        onValueChange={onValueChange}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: 'Beta' } });
    expect(onValueChange).toHaveBeenLastCalledWith('Beta');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(input).toHaveValue('Beta');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('is read-only while busy and points at the caller error while one shows', () => {
    render(
      <RenameInput
        initialValue="Alpha"
        onCommit={vi.fn()}
        onCancel={vi.fn()}
        busy
        errorId="rename-error"
      />
    );
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('aria-busy', 'true');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'rename-error');
  });

  it('formats typed and pasted text in place, keeping the caret where the user is typing', async () => {
    const onValueChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <RenameInput
        initialValue="work_notes"
        onCommit={onCommit}
        onCancel={vi.fn()}
        onValueChange={onValueChange}
        format={formatTableName}
      />
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Rename' });
    const user = userEvent.setup();

    await user.type(input, 'X Y', { initialSelectionStart: 4, initialSelectionEnd: 4 });
    expect(input).toHaveValue('workx_y_notes');
    expect([input.selectionStart, input.selectionEnd]).toEqual([7, 7]);
    expect(onValueChange).toHaveBeenLastCalledWith('workx_y_notes');

    input.setSelectionRange(8, 13);
    await user.paste('Field \t Guide');
    expect(input).toHaveValue('workx_y_field_guide');
    expect([input.selectionStart, input.selectionEnd]).toEqual([19, 19]);

    await user.type(input, '-', { initialSelectionStart: 0, initialSelectionEnd: 0 });
    expect(input).toHaveValue('-workx_y_field_guide');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('-workx_y_field_guide');
  });

  it('leaves text as typed without a format', () => {
    render(<RenameInput initialValue="Alpha" onCommit={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: 'Project Notes' } });
    expect(input).toHaveValue('Project Notes');
  });
});
