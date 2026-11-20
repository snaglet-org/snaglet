import { createRef, useEffect, useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableSelectOptionUsageResponse } from '@snaglet/shared/types';
import { SelectOptionsEditor, type SelectOptionsEditorProps } from './SelectOptionsEditor';
import type { SelectOptionsValue } from './selectFieldDefinition';

const api = vi.hoisted(() => ({
  selectOptionUsage:
    vi.fn<(tableId: string, fieldId: string) => Promise<TableSelectOptionUsageResponse>>(),
}));
vi.mock('@desktop/utils/api', () => ({ tablesApi: api }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const fieldId = 'field-1111111111111-aaaaaaaaa';
const initial: SelectOptionsValue = {
  options: [
    { id: 'opt-first', label: 'Todo', color: 'blue' },
    { id: 'opt-second', label: 'Done', color: 'green' },
  ],
  defaultValue: 'Todo',
};
interface HarnessProps extends Omit<
  SelectOptionsEditorProps,
  'tableId' | 'options' | 'defaultValue' | 'onChange'
> {
  value?: SelectOptionsValue;
  onChange?: (value: SelectOptionsValue) => void;
}
function Harness({ value = initial, onChange, ...props }: HarnessProps) {
  const [current, setCurrent] = useState(value);
  return (
    <>
      <button>Outside</button>
      <SelectOptionsEditor
        {...props}
        tableId={tableId}
        {...current}
        onChange={(next) => {
          setCurrent(next);
          onChange?.(next);
        }}
      />
    </>
  );
}
function editLabel(label = 'Todo') {
  fireEvent.click(screen.getByRole('button', { name: `Rename option ${label}` }));
  return screen.getByRole('textbox', { name: 'Option label' });
}
function deferred<T>() {
  let complete: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (value: T) => complete(value) };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.selectOptionUsage.mockResolvedValue({ usage: { 'opt-first': 0, 'opt-second': 0 } });
});

describe('SelectOptionsEditor', () => {
  it('adds one trimmed option with a stable id and automatic color only on commit', () => {
    const change = vi.fn();
    render(<Harness onChange={change} />);
    const input = screen.getByRole('textbox', { name: 'New option' });
    fireEvent.change(input, { target: { value: '  Review  ' } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [
        ...initial.options,
        { id: expect.stringMatching(/^opt-/), label: 'Review', color: 'yellow' },
      ],
      defaultValue: 'Todo',
    });
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Rename option Review' })).toBeInTheDocument();
  });

  it('renames on Enter, atomically updates defaults, and restores focus without changing the id', () => {
    const change = vi.fn();
    render(<Harness onChange={change} value={{ ...initial, defaultValue: ['Done', 'Todo'] }} />);
    const input = editLabel();
    fireEvent.change(input, { target: { value: 'Ready' } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [{ ...initial.options[0], label: 'Ready' }, initial.options[1]],
      defaultValue: ['Done', 'Ready'],
    });
    expect(screen.getByRole('button', { name: 'Rename option Ready' })).toHaveFocus();
  });

  it('leaves presses elsewhere in the app alone while a rename is pending', () => {
    const change = vi.fn();
    render(<Harness onChange={change} />);
    const input = editLabel();
    fireEvent.change(input, { target: { value: 'done' } });
    const outside = vi.fn();
    document.addEventListener('pointerdown', outside, true);
    try {
      // The parent flushes on its own dismissal; this editor never intercepts.
      expect(fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))).toBe(true);
    } finally {
      document.removeEventListener('pointerdown', outside, true);
    }
    expect(outside).toHaveBeenCalledOnce();
    expect(change).not.toHaveBeenCalled();
    expect(input).toHaveValue('done');
  });

  it('retains invalid local text on blur, then Escape cancels only the rename', () => {
    const change = vi.fn();
    const outerEscape = vi.fn();
    render(
      <div onKeyDown={outerEscape}>
        <Harness onChange={change} />
      </div>
    );
    const input = editLabel();
    fireEvent.change(input, { target: { value: 'done' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('done');
    expect(screen.getByRole('alert')).toHaveTextContent('listed twice');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(change).not.toHaveBeenCalled();
    expect(outerEscape).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename option Todo' })).toHaveFocus();
  });

  it('exposes a synchronous validated flush before parent persistence', () => {
    const flush = createRef<(() => boolean) | null>();
    const change = vi.fn();
    render(<Harness flushPendingRef={flush} onChange={change} />);
    const input = editLabel();
    fireEvent.change(input, { target: { value: '' } });
    act(() => expect(flush.current?.()).toBe(false));
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Ready' } });
    act(() => expect(flush.current?.()).toBe(true));
    expect(change).toHaveBeenCalledOnce();
    expect(change.mock.calls[0][0].defaultValue).toBe('Ready');
  });

  it('keeps the flush available to the parent passive unmount cleanup', () => {
    const change = vi.fn();
    const flushed = vi.fn();
    function Parent() {
      const flush = useRef<(() => boolean) | null>(null);
      useEffect(
        () => () => {
          flushed(flush.current?.());
        },
        []
      );
      return (
        <SelectOptionsEditor
          tableId={tableId}
          {...initial}
          flushPendingRef={flush}
          onChange={change}
        />
      );
    }
    const view = render(<Parent />);
    const input = editLabel();
    fireEvent.change(input, { target: { value: 'Ready' } });
    view.unmount();
    expect(flushed).toHaveBeenCalledExactlyOnceWith(true);
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [{ ...initial.options[0], label: 'Ready' }, initial.options[1]],
      defaultValue: 'Ready',
    });
  });

  it('uses all palette colors and preserves defaults on recolor', () => {
    const change = vi.fn();
    render(<Harness onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change color for Todo' }));
    expect(screen.getAllByRole('button', { name: /^Set Todo color to / })).toHaveLength(9);
    expect(screen.getByRole('button', { name: 'Set Todo color to blue' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set Todo color to pink' }));
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [{ ...initial.options[0], color: 'pink' }, initial.options[1]],
      defaultValue: 'Todo',
    });
    expect(screen.getByRole('button', { name: 'Change color for Todo' })).toHaveFocus();
  });

  it('reorders by keyboard while retaining focus and ordered defaults', () => {
    const change = vi.fn();
    render(<Harness onChange={change} value={{ ...initial, defaultValue: ['Todo', 'Done'] }} />);
    const handle = screen.getByRole('button', { name: 'Reorder Todo, position 1 of 2' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [initial.options[1], initial.options[0]],
      defaultValue: ['Todo', 'Done'],
    });
    expect(screen.getByRole('button', { name: 'Reorder Todo, position 2 of 2' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Todo moved to position 2 of 2');
  });

  it('supports local drag reorder even when custom data is unavailable, without pane splitting', () => {
    const change = vi.fn();
    const split = vi.fn();
    render(
      <div onDrop={split}>
        <Harness onChange={change} />
      </div>
    );
    const source = screen.getByRole('button', { name: 'Reorder Todo, position 1 of 2' });
    const target = screen.getByRole('button', { name: 'Rename option Done' });
    const dataTransfer = {
      setData: vi.fn(),
      getData: () => '',
      types: [],
      effectAllowed: 'all',
      dropEffect: 'none',
    };
    fireEvent.dragStart(source, { dataTransfer });
    expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(target, { dataTransfer })).toBe(false);
    expect(change.mock.calls[0][0].options).toEqual([initial.options[1], initial.options[0]]);
    expect(split).not.toHaveBeenCalled();
    fireEvent.dragEnd(source, { dataTransfer });
  });

  it('checks persisted usage and requires an explicit confirmation that reports affected rows', async () => {
    api.selectOptionUsage.mockResolvedValue({ usage: { 'opt-first': 3 } });
    const change = vi.fn();
    render(<Harness fieldId={fieldId} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Todo' }));
    expect(await screen.findByText('Remove “Todo” from 3 rows?')).toBeInTheDocument();
    expect(api.selectOptionUsage).toHaveBeenCalledExactlyOnceWith(tableId, fieldId);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove option' }));
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [initial.options[1]],
      defaultValue: null,
    });
  });

  it('tells a required single choice which default replaces the removed option', async () => {
    api.selectOptionUsage.mockResolvedValue({ usage: { 'opt-second': 2 } });
    const change = vi.fn();
    render(<Harness fieldId={fieldId} required onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Done' }));
    expect(
      await screen.findByText('Remove “Done”? The 2 rows using it change to “Todo”.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove option' }));
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [initial.options[0]],
      defaultValue: 'Todo',
    });
  });

  it('keeps an in-use option of a required single choice until another default exists', async () => {
    api.selectOptionUsage.mockResolvedValue({ usage: { 'opt-first': 1 } });
    const change = vi.fn();
    render(<Harness fieldId={fieldId} required onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Todo' }));
    expect(
      await screen.findByText(
        '1 row uses “Todo”. Choose another default choice first, or make the field optional.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove option' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep option' }));
    expect(change).not.toHaveBeenCalled();
  });

  it('removes a verified unused option without prompting and keeps unrelated defaults', async () => {
    const change = vi.fn();
    render(<Harness fieldId={fieldId} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Done' }));
    await waitFor(() =>
      expect(change).toHaveBeenCalledExactlyOnceWith({
        options: [initial.options[0]],
        defaultValue: 'Todo',
      })
    );
    expect(screen.queryByRole('button', { name: 'Keep option' })).not.toBeInTheDocument();
  });

  it('can remove a known unsaved addition without a usage request', () => {
    const change = vi.fn();
    render(<Harness fieldId={fieldId} persistedOptionIds={['opt-first']} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Done' }));
    expect(change).toHaveBeenCalledExactlyOnceWith({
      options: [initial.options[0]],
      defaultValue: 'Todo',
    });
    expect(api.selectOptionUsage).not.toHaveBeenCalled();
  });

  it('keeps options on a failed usage check, offers retry, and never interprets failure as unused', async () => {
    api.selectOptionUsage
      .mockRejectedValueOnce(new Error('Usage unavailable'))
      .mockResolvedValueOnce({ usage: { 'opt-first': 1 } });
    const change = vi.fn();
    render(<Harness fieldId={fieldId} onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove option Todo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usage unavailable');
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry usage check' }));
    expect(await screen.findByText('Remove “Todo” from 1 row?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep option' }));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename option Todo' })).toBeEnabled();
  });

  it.each(['cancel', 'unmount'] as const)(
    'ignores an obsolete usage response after %s',
    async (action) => {
      const pending = deferred<TableSelectOptionUsageResponse>();
      api.selectOptionUsage.mockReturnValue(pending.promise);
      const change = vi.fn();
      const view = render(<Harness fieldId={fieldId} onChange={change} />);
      fireEvent.click(screen.getByRole('button', { name: 'Remove option Todo' }));
      if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Keep option' }));
      else view.unmount();
      await act(async () => pending.resolve({ usage: { 'opt-first': 0 } }));
      expect(change).not.toHaveBeenCalled();
    }
  );
});
