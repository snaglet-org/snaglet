/**
 * The calendar popovers' searchable picker: filtering, keyboard (type to
 * filter, arrows, Enter, Escape closing only the picker), outside press, and
 * focus back on the trigger.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnchoredSurface } from './AnchoredSurface';
import { filterOptions, SearchSelect, type SearchSelectOption } from './SearchSelect';

const options: SearchSelectOption[] = [
  { value: '', label: 'None (plain event)' },
  { value: 'f1', label: 'Test table · Due', detail: 'Date' },
  { value: 'f2', label: 'Test table · Start', detail: 'Date & time' },
  { value: 'f3', label: 'Other table · Due', detail: 'Date' },
];

function setup(value = '') {
  const onChange = vi.fn();
  const parentKeyDown = vi.fn();
  render(
    <div onKeyDown={parentKeyDown}>
      <SearchSelect label="Table field" value={value} options={options} onChange={onChange} />
    </div>
  );
  const trigger = screen.getByRole('button', { name: /^Table field:/ });
  return { onChange, parentKeyDown, trigger };
}

async function search() {
  const input = await screen.findByRole('combobox', { name: 'Search table field' });
  await waitFor(() => expect(input).toHaveFocus());
  return input;
}

const listed = () =>
  within(screen.getByRole('listbox', { name: 'Table field' }))
    .queryAllByRole('option')
    .map((o) => o.textContent);

describe('SearchSelect', () => {
  it('filters by label and detail, any case', () => {
    expect(filterOptions(options, 'START').map((o) => o.value)).toEqual(['f2']);
    expect(filterOptions(options, 'date &').map((o) => o.value)).toEqual(['f2']);
    expect(filterOptions(options, '  ')).toHaveLength(4);
  });

  it('shows the choice; typing in the list filters it and Enter picks the active one', async () => {
    const { onChange, trigger } = setup('f1');
    expect(trigger).toHaveAccessibleName('Table field: Test table · Due');
    fireEvent.click(trigger);
    const input = await search();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(listed()).toHaveLength(4);
    // The current choice is selected and active.
    const selected = screen.getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('Test table · Due');
    expect(input).toHaveAttribute('aria-activedescendant', selected.id);

    fireEvent.change(input, { target: { value: 'due' } });
    expect(listed()).toEqual(['Test table · DueDate', 'Other table · DueDate']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('f3');
    expect(screen.queryByRole('listbox')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('arrows stop at the ends; Home / End jump; nothing matching says so', async () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    const input = await search();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('f3');

    fireEvent.click(trigger);
    const again = await search();
    fireEvent.change(again, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('typing a letter on the trigger opens it filtered; ↓ opens it too', async () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'o' });
    const input = await search();
    expect(input).toHaveValue('o');
    expect(listed()).toEqual(['None (plain event)', 'Other table · DueDate']);
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(await search()).toHaveValue('');
  });

  it('Escape closes the picker only: the popover around it never sees it', async () => {
    const { parentKeyDown, trigger, onChange } = setup();
    const documentKeyDown = vi.fn();
    document.addEventListener('keydown', documentKeyDown);
    fireEvent.click(trigger);
    const input = await search();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(documentKeyDown).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    document.removeEventListener('keydown', documentKeyDown);
  });

  it('a press outside closes it; clicking an option picks it', async () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    await search();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);
    await search();
    fireEvent.click(screen.getByRole('option', { name: /Test table · Start/ }));
    expect(onChange).toHaveBeenCalledWith('f2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('inside a popover, one outside press closes the list and the popover', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const onDismiss = vi.fn();
    render(
      <AnchoredSurface anchor={anchor} label="Quick add" onDismiss={onDismiss}>
        <SearchSelect label="Table field" value="" options={options} onChange={vi.fn()} />
      </AnchoredSurface>
    );
    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    await search();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it('a press inside the list picks without closing the popover', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const onDismiss = vi.fn();
    const onChange = vi.fn();
    render(
      <AnchoredSurface anchor={anchor} label="Quick add" onDismiss={onDismiss}>
        <SearchSelect label="Table field" value="" options={options} onChange={onChange} />
      </AnchoredSurface>
    );
    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    await search();
    const option = screen.getByRole('option', { name: /Test table · Start/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('f2');
    expect(onDismiss).not.toHaveBeenCalled();
    anchor.remove();
  });

  it('the trigger toggles it closed (its press is not "outside")', async () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    await search();
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('SearchSelect styling', () => {
  const scss = readFileSync(join(__dirname, 'CalendarPopovers.module.scss'), 'utf8');
  const block = (selector: string) => {
    const start = scss.indexOf(`\n${selector} {`);
    return scss.slice(start, scss.indexOf('\n}', start));
  };

  it('is a square dropdown: trigger, menu and option highlights', () => {
    expect(block('.selectTrigger')).toMatch(/\$radius: var\(--radius-dropdown\)/);
    expect(block('.selectSurface')).toMatch(/border-radius: var\(--radius-dropdown\);/);
    expect(block('.selectOption')).toMatch(/border-radius: var\(--radius-dropdown\);/);
  });

  it("is the popovers' small text field height", () => {
    expect(block('.selectTrigger')).toMatch(/\n  height: 22px;/);
  });
});
