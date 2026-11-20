/**
 * The calendar picker highlights an option on hover only after the pointer
 * really moves: options that appear or shift under a resting pointer must not
 * take Enter from the active one.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';

const options: SearchSelectOption[] = [
  { value: '', label: 'None (plain event)' },
  { value: 'f1', label: 'Test table · Due', detail: 'Date' },
  { value: 'f2', label: 'Test table · Start', detail: 'Date & time' },
  { value: 'f3', label: 'Test table · End', detail: 'Date' },
];

async function openPicker() {
  const onChange = vi.fn();
  render(<SearchSelect label="Table field" value="" options={options} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
  const input = await screen.findByRole('combobox', { name: 'Search table field' });
  await waitFor(() => expect(input).toHaveFocus());
  return { input, onChange };
}

const option = (name: RegExp) => screen.getByRole('option', { name });

/** What a browser sends when options appear or move under a resting pointer. */
function contentAppearsUnder(element: HTMLElement, clientX: number, clientY: number) {
  fireEvent.mouseOver(element, { clientX, clientY });
  fireEvent.mouseEnter(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
}

function moveAcross(element: HTMLElement, clientX = 100, clientY = 80) {
  fireEvent.mouseMove(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX: clientX + 4, clientY: clientY + 3 });
}

describe('SearchSelect: a pointer that has not moved', () => {
  it('cannot take the highlight, so Enter picks the active option', async () => {
    const { input, onChange } = await openPicker();
    fireEvent.change(input, { target: { value: 'table' } });

    contentAppearsUnder(option(/End/), 100, 80);
    expect(input).toHaveAttribute('aria-activedescendant', option(/Due/).id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('f1');
  });

  it('cannot take it after the search changes either', async () => {
    const { input } = await openPicker();
    fireEvent.change(input, { target: { value: 'table' } });
    moveAcross(option(/End/));
    expect(input).toHaveAttribute('aria-activedescendant', option(/End/).id);

    fireEvent.change(input, { target: { value: 'table ' } });
    expect(input).toHaveAttribute('aria-activedescendant', option(/Due/).id);
    contentAppearsUnder(option(/End/), 104, 83);
    expect(input).toHaveAttribute('aria-activedescendant', option(/Due/).id);
  });

  it('still follows a real move and the arrow keys, and a click picks the clicked option', async () => {
    const { input, onChange } = await openPicker();
    fireEvent.change(input, { target: { value: 'table' } });
    moveAcross(option(/End/));
    expect(input).toHaveAttribute('aria-activedescendant', option(/End/).id);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('f2');

    fireEvent.click(screen.getByRole('button', { name: /^Table field:/ }));
    fireEvent.click(await screen.findByRole('option', { name: /End/ }));
    expect(onChange).toHaveBeenLastCalledWith('f3');
  });
});
