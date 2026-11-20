import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { ChipEditableInput } from './ChipEditableInput';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChipEditableInput interaction transitions', () => {
  it('does not emit a user edit when disabling or enabling while loading a newer value', async () => {
    const onChange = vi.fn();
    const props = { onChange, ariaLabel: 'Field name', enableNodeMentions: false };
    const view = render(<ChipEditableInput {...props} value="Local draft" />);
    await act(async () => Promise.resolve());
    expect(screen.getByRole('textbox')).toHaveTextContent('Local draft');

    view.rerender(<ChipEditableInput {...props} value="Local draft" disabled />);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');

    view.rerender(<ChipEditableInput {...props} value="Server name" disabled={false} />);
    await act(async () => Promise.resolve());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveTextContent('Server name');
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
  });

  it('focuses hydrated text before timers or animation frames so immediate typing is retained', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    function Cell() {
      const [editing, setEditing] = useState(false);
      const [value, setValue] = useState('Note');
      return editing ? (
        <ChipEditableInput
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          autoFocus
          ariaLabel="Notes"
          enableNodeMentions={false}
        />
      ) : (
        <button onClick={() => setEditing(true)}>Open notes</button>
      );
    }
    render(<Cell />);
    const trigger = screen.getByRole('button');
    trigger.focus();
    fireEvent.click(trigger);
    // No advancing TipTap's zero-delay create timer or requestAnimationFrame.
    await act(async () => Promise.resolve());
    const input = screen.getByRole('textbox', { name: 'Notes' });
    expect(input).toHaveFocus();
    expect(input).toHaveTextContent('Note');

    vi.useRealTimers();
    await userEvent.setup({ delay: null }).keyboard('!');
    expect(input).toHaveTextContent('Note!');
    expect(onChange).toHaveBeenLastCalledWith('Note!');
  });

  it('does not reclaim focus after the user moves to another control', async () => {
    vi.useFakeTimers();
    render(
      <>
        <ChipEditableInput
          value="Loaded text"
          onChange={vi.fn()}
          autoFocus
          ariaLabel="Notes"
          enableNodeMentions={false}
        />
        <button>Other control</button>
      </>
    );
    await act(async () => Promise.resolve());
    expect(screen.getByRole('textbox')).toHaveFocus();
    const other = screen.getByRole('button');
    other.focus();
    await act(async () => vi.advanceTimersByTime(100));
    expect(other).toHaveFocus();
  });

  it('does not override a focus choice made before its hydration microtask finishes', async () => {
    render(
      <>
        <ChipEditableInput
          value="Loaded text"
          onChange={vi.fn()}
          autoFocus
          ariaLabel="Notes"
          enableNodeMentions={false}
        />
        <button>Other control</button>
      </>
    );
    const other = screen.getByRole('button');
    other.focus();
    await act(async () => Promise.resolve());
    expect(screen.getByRole('textbox')).toHaveTextContent('Loaded text');
    expect(other).toHaveFocus();
  });

  it('submits a one-line field on an Enter the open search has no hit for, without a line break', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    function Field() {
      const [value, setValue] = useState('');
      return (
        <ChipEditableInput
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          onSubmit={onSubmit}
          ariaLabel="Agent"
          // Agents only, and the roster is empty: the search has no hits.
          mentionKinds={['agent']}
          mentionOnType
        />
      );
    }
    render(<Field />);
    const user = userEvent.setup({ delay: null });
    const input = screen.getByRole('textbox', { name: 'Agent' });
    await user.click(input);
    await user.keyboard('nobody');
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith('nobody');
    expect(input.querySelectorAll('p')).toHaveLength(1);
  });

  it('keeps a disabled preview read-only: inert checkboxes and no chip drop', async () => {
    const onChange = vi.fn();
    const onCheckboxAutoSave = vi.fn();
    render(
      <ChipEditableInput
        value={'- [ ] First task'}
        onChange={onChange}
        onCheckboxAutoSave={onCheckboxAutoSave}
        disabled
        multiline
        allowMarkdownPreview
        defaultMode="preview"
        ariaLabel="Snapshot"
        enableNodeMentions={false}
      />
    );
    const checkbox = await screen.findByRole('checkbox');
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(onCheckboxAutoSave).not.toHaveBeenCalled();

    const preview = checkbox.closest('[data-pane-drop-target="node-chip"]') as HTMLElement;
    const chip = JSON.stringify({ id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc' });
    const dataTransfer = {
      types: [NODE_CHIP_MIME],
      getData: (type: string) => (type === NODE_CHIP_MIME ? chip : ''),
      dropEffect: 'none',
      files: [],
    };
    expect(fireEvent.dragOver(preview, { dataTransfer })).toBe(true);
    expect(preview).not.toHaveAttribute('data-chip-drag-over');
    fireEvent.drop(preview, { dataTransfer });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a chip drag on a disabled editor', async () => {
    render(
      <ChipEditableInput
        value="Locked"
        onChange={vi.fn()}
        disabled
        ariaLabel="Locked field"
        enableNodeMentions={false}
      />
    );
    const box = await screen.findByRole('textbox', { name: 'Locked field' });
    const dataTransfer = {
      types: [NODE_CHIP_MIME],
      getData: () => '',
      dropEffect: 'none',
      files: [],
    };
    expect(fireEvent.dragEnter(box, { dataTransfer })).toBe(true);
    expect(fireEvent.dragOver(box, { dataTransfer })).toBe(true);
    expect(box).not.toHaveAttribute('data-chip-drag-over');
  });
});
