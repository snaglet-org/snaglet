import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TableField, TableSelectOption } from '@snaglet/shared/types';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { EntryCell } from './cells/EntryCell';
import { SelectEntryPicker } from './SelectEntryPicker';

const options: TableSelectOption[] = [
  { id: 'opt-todo', label: 'To do', color: 'gray' },
  { id: 'opt-progress', label: 'In progress', color: 'blue' },
  { id: 'opt-done', label: 'Done', color: 'green' },
];
const field: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: 'table-1111111111111-aaaaaaaaa',
  columnName: 'status',
  name: 'Status',
  type: 'select',
  description: null,
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  options,
  multiple: false,
  position: 0,
  managed: false,
  collapsed: false,
  isTitle: false,
  revision: 1,
};

function setup(overrides: Partial<Parameters<typeof SelectEntryPicker>[0]> = {}) {
  const props = {
    field,
    value: null,
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    busy: false,
    autoFocus: true,
    ...overrides,
  };
  return { props, ...render(<SelectEntryPicker {...props} />) };
}

describe('SelectEntryPicker', () => {
  it('filters existing options case-insensitively and commits their exact stored label', async () => {
    const { props } = setup();
    const input = screen.getByRole('combobox', { name: 'Find Status' });
    expect(input).toHaveFocus();
    await userEvent.type(input, 'pRoG');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(props.onChange).toHaveBeenCalledWith('In progress');
    expect(props.onCommit).toHaveBeenCalledWith('In progress');
  });

  it('navigates choices with arrows, retaining focus in the input', async () => {
    const { props } = setup();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('In progress');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('keeps multiple selections in click order, excludes chosen options and clears to []', async () => {
    const { props } = setup({ field: { ...field, multiple: true }, value: [] });
    await userEvent.click(screen.getByRole('option', { name: 'Done' }));
    await userEvent.click(screen.getByRole('option', { name: 'To do' }));
    expect(props.onChange).toHaveBeenLastCalledWith(['Done', 'To do']);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'Done' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Done' }));
    expect(props.onChange).toHaveBeenLastCalledWith(['To do']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove To do' }));
    expect(props.onChange).toHaveBeenLastCalledWith([]);
    await userEvent.tab();
    expect(props.onCommit).toHaveBeenLastCalledWith([]);
  });

  it('preserves latest values when change and Tab happen in the same event batch', () => {
    const { props } = setup({ field: { ...field, multiple: true }, value: ['Done'] });
    act(() => {
      fireEvent.click(screen.getByRole('option', { name: 'To do' }));
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
    });
    expect(props.onCommit).toHaveBeenLastCalledWith(['Done', 'To do']);
  });

  it.each([null, 'Done'])(
    'commits an unchanged %s without choosing the first option when opened',
    async (value) => {
      const { props } = setup({ value });
      expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
      expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();
      fireEvent.pointerMove(screen.getByRole('option', { name: 'To do' }));
      await userEvent.keyboard('{Enter}');
      expect(props.onChange).not.toHaveBeenCalled();
      expect(props.onCommit).toHaveBeenCalledWith(value);
    }
  );

  it('closes multi-select with Enter after choosing a value instead of adding another option', async () => {
    const { props } = setup({ field: { ...field, multiple: true }, value: ['Done'] });
    await userEvent.click(screen.getByRole('option', { name: 'To do' }));
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('{Enter}');
    expect(props.onChange).toHaveBeenCalledOnce();
    expect(props.onCommit).toHaveBeenCalledWith(['Done', 'To do']);
  });

  it('clearing the filter removes the highlight, and ArrowUp explicitly chooses the last option', async () => {
    const { props } = setup();
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'progress');
    expect(screen.getByRole('option', { name: 'In progress', selected: true })).toBeInTheDocument();
    await userEvent.clear(input);
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect(props.onCommit).toHaveBeenCalledWith('Done');
  });

  it('commits an untouched empty multi-select as [] and a single select as null', async () => {
    const view = setup({ field: { ...field, multiple: true }, value: null });
    await userEvent.tab();
    expect(view.props.onCommit).toHaveBeenCalledWith([]);
    view.unmount();
    const single = setup();
    await userEvent.tab();
    expect(single.props.onCommit).toHaveBeenCalledWith(null);
  });

  it('clears a single value to null and reaches removal without a pointer', async () => {
    const { props } = setup({ value: 'Done' });
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Remove Done' })).toHaveFocus();
    await userEvent.keyboard('{Delete}');
    expect(props.onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('does not offer case-insensitive duplicates or invalid labels for creation', async () => {
    const onCreateOption = vi.fn();
    setup({ onCreateOption });
    const input = screen.getByRole('combobox');
    await userEvent.type(input, '  dOnE  ');
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Done' })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'x'.repeat(101) } });
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('at most 100 characters');
    expect(onCreateOption).not.toHaveBeenCalled();
  });

  it('creates a trimmed new option and uses its returned canonical label', async () => {
    const onCreateOption = vi.fn().mockResolvedValue({
      id: 'opt-new',
      label: 'Canonical label',
      color: 'purple',
    } satisfies TableSelectOption);
    const { props } = setup({ onCreateOption });
    await userEvent.type(screen.getByRole('combobox'), '  new label  ');
    await userEvent.click(screen.getByRole('option', { name: 'Create “new label”' }));
    expect(onCreateOption).toHaveBeenCalledWith('new label');
    expect(props.onChange).toHaveBeenCalledWith('Canonical label');
    expect(props.onCommit).toHaveBeenCalledWith('Canonical label');
  });

  it('freezes choices, removal, typing and Tab until schema creation finishes', async () => {
    let resolve: (option: TableSelectOption | null) => void = () => undefined;
    const onCreateOption = vi.fn(
      () =>
        new Promise<TableSelectOption | null>((complete) => {
          resolve = complete;
        })
    );
    const { props } = setup({
      field: { ...field, multiple: true },
      value: ['Done'],
      onCreateOption,
    });
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'To');
    const create = screen.getByRole('option', { name: 'Create “To”' });
    act(() => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    expect(onCreateOption).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Remove Done' })).toBeDisabled();
    await userEvent.click(screen.getByRole('option', { name: 'To do' }));
    fireEvent.change(input, { target: { value: 'Different' } });
    expect(input).toHaveValue('To');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    await act(async () => resolve({ id: 'opt-to', label: 'To', color: 'blue' }));
    expect(props.onChange).toHaveBeenLastCalledWith(['Done', 'To']);
    expect(input).not.toHaveAttribute('readonly');
    expect(input).toHaveFocus();
  });

  it('shows creation failures inline and retries with the same typed label', async () => {
    const onCreateOption = vi
      .fn()
      .mockRejectedValueOnce(new Error('Option changed elsewhere'))
      .mockResolvedValueOnce({
        id: 'opt-review',
        label: 'Review',
        color: 'yellow',
      } satisfies TableSelectOption);
    const { props } = setup({ onCreateOption });
    await userEvent.type(screen.getByRole('combobox'), 'Review');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Option changed elsewhere');
    expect(screen.getByRole('combobox')).toHaveValue('Review');
    expect(props.onChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onCreateOption).toHaveBeenCalledTimes(2);
    expect(props.onChange).toHaveBeenCalledWith('Review');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the latest ready-schema callbacks after creating an option', async () => {
    let resolve: (option: TableSelectOption | null) => void = () => undefined;
    const option: TableSelectOption = { id: 'opt-review', label: 'Review', color: 'yellow' };
    const onCreateOption = vi.fn(
      () =>
        new Promise<TableSelectOption | null>((complete) => {
          resolve = complete;
        })
    );
    const { props, rerender } = setup({ onCreateOption });
    await userEvent.type(screen.getByRole('combobox'), 'Review');
    await userEvent.keyboard('{Enter}');
    const onChange = vi.fn();
    const onCommit = vi.fn();
    rerender(
      <SelectEntryPicker
        {...props}
        field={{ ...field, revision: 2, options: [...options, option] }}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
    expect(screen.getByRole('combobox')).toHaveAttribute('readonly');
    await act(async () => resolve(option));
    expect(onChange).toHaveBeenCalledWith('Review');
    expect(onCommit).toHaveBeenCalledWith('Review');
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('does not invent a selected value when creation returns no option', async () => {
    const { props } = setup({ onCreateOption: vi.fn().mockResolvedValue(null) });
    await userEvent.type(screen.getByRole('combobox'), 'Review');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The option was not added. Try again.'
    );
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it.each(['escape', 'unmount', 'different field'] as const)(
    'ignores creation results after %s',
    async (ending) => {
      let resolve: (option: TableSelectOption | null) => void = () => undefined;
      const onCreateOption = vi.fn(
        () =>
          new Promise<TableSelectOption | null>((complete) => {
            resolve = complete;
          })
      );
      const { props, unmount, rerender } = setup({ onCreateOption });
      await userEvent.type(screen.getByRole('combobox'), 'Review');
      await userEvent.keyboard('{Enter}');
      if (ending === 'escape') {
        await userEvent.keyboard('{Escape}');
        expect(props.onCancel).toHaveBeenCalledOnce();
      } else if (ending === 'unmount') unmount();
      else
        rerender(
          <SelectEntryPicker
            {...props}
            field={{ ...field, id: 'field-1111111111111-bbbbbbbbb', name: 'Other status' }}
          />
        );
      await act(async () => resolve({ id: 'opt-review', label: 'Review', color: 'yellow' }));
      expect(props.onChange).not.toHaveBeenCalled();
      expect(props.onCommit).not.toHaveBeenCalled();
      if (ending === 'different field')
        expect(screen.getByRole('combobox', { name: 'Find Other status' })).not.toHaveAttribute(
          'readonly'
        );
    }
  );

  it('does not offer creation after the option limit or without the callback', async () => {
    const onCreateOption = vi.fn();
    const { props, rerender } = setup({
      field: {
        ...field,
        options: Array.from({ length: 100 }, (_, n) => ({
          id: `opt-${n}`,
          label: `Option ${n}`,
          color: 'gray',
        })),
      },
      onCreateOption,
    });
    await userEvent.type(screen.getByRole('combobox'), 'New');
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
    expect(screen.getByText('This field has reached its 100-option limit.')).toBeInTheDocument();
    rerender(<SelectEntryPicker {...props} field={field} onCreateOption={undefined} />);
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
    expect(onCreateOption).not.toHaveBeenCalled();
  });

  it('keeps validation visible and blocks edits while externally busy', () => {
    const { props } = setup({ busy: true, value: 'Done', error: 'Reload the latest schema.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Reload the latest schema.');
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-describedby',
      screen.getByRole('alert').id
    );
    fireEvent.click(screen.getByRole('option', { name: 'To do' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('leaves chip rejection to the enclosing cell even when dropped in the popup', () => {
    const paneDrop = vi.fn();
    const onChange = vi.fn();
    render(
      <div onDrop={paneDrop}>
        <table>
          <tbody>
            <tr>
              <EntryCell field={field} active>
                <SelectEntryPicker
                  field={field}
                  value={null}
                  onChange={onChange}
                  onCommit={vi.fn()}
                  onCancel={vi.fn()}
                  busy={false}
                />
              </EntryCell>
            </tr>
          </tbody>
        </table>
      </div>
    );
    const dataTransfer = {
      types: [NODE_CHIP_MIME],
      getData: () => JSON.stringify({ kind: 'table', id: field.tableId, title: 'Table' }),
      dropEffect: 'copy',
      files: [],
    };
    expect(fireEvent.drop(screen.getByRole('combobox'), { dataTransfer })).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Drop links into a Text field instead.');
    expect(onChange).not.toHaveBeenCalled();
    expect(paneDrop).not.toHaveBeenCalled();
  });
});
