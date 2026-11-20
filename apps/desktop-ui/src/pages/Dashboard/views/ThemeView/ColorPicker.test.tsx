import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const save = vi.hoisted(() => vi.fn());
const reset = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/workspaceTheme', () => ({
  setWorkspaceColors: save,
  resetWorkspaceColors: reset,
  subscribeTheme: () => () => {},
}));
import { ColorPicker } from './ColorPicker';
const DESCRIPTION = 'The strip along the top of the test pane.';
it('shares a valid color choice but Escape does not save the discarded draft', () => {
  render(<ColorPicker name="test" label="Test" description={DESCRIPTION} defaultValue="#123456" />);
  const input = screen.getByLabelText('Test hex color');
  input.focus();
  fireEvent.change(input, { target: { value: '#abcdef' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(save).not.toHaveBeenCalled();
  input.focus();
  fireEvent.change(input, { target: { value: '#abcdef' } });
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledWith({ test: '#abcdef' });
});
it('saves a color committed with Enter once, not again on the blur that follows', () => {
  save.mockClear();
  render(<ColorPicker name="test" label="Test" description={DESCRIPTION} defaultValue="#123456" />);
  const input = screen.getByLabelText('Test hex color');
  input.focus();
  fireEvent.change(input, { target: { value: 'abcdef' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({ test: '#abcdef' });
  expect(input).toHaveValue('#abcdef');
});
it('does not save again when the hex field is left unchanged', () => {
  save.mockClear();
  render(<ColorPicker name="test" label="Test" description={DESCRIPTION} defaultValue="#123456" />);
  const input = screen.getByLabelText('Test hex color');
  input.focus();
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
});
it('names the reset button after its color', () => {
  render(<ColorPicker name="test" label="Test" description={DESCRIPTION} defaultValue="#123456" />);
  const input = screen.getByLabelText('Test hex color');
  input.focus();
  fireEvent.change(input, { target: { value: '#abcdef' } });
  fireEvent.blur(input);
  expect(screen.getByRole('button', { name: 'Reset Test to default' })).toBeInTheDocument();
});
it('resets by removing the saved color, not by saving the default', () => {
  save.mockClear();
  render(<ColorPicker name="test" label="Test" description={DESCRIPTION} defaultValue="#123456" />);
  const input = screen.getByLabelText('Test hex color');
  input.focus();
  fireEvent.change(input, { target: { value: '#abcdef' } });
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole('button', { name: 'Reset Test to default' }));
  expect(reset).toHaveBeenCalledWith(['test']);
  expect(save).not.toHaveBeenCalledWith({ test: '#123456' });
  expect(input).toHaveValue('#123456');
  expect(screen.queryByRole('button', { name: 'Reset Test to default' })).not.toBeInTheDocument();
});
it('shows what the color paints under its label and reads it out for both inputs', () => {
  render(<ColorPicker name="test" label="Test" description={DESCRIPTION} defaultValue="#123456" />);
  expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
  expect(screen.getByLabelText('Test color')).toHaveAccessibleDescription(DESCRIPTION);
  expect(screen.getByLabelText('Test hex color')).toHaveAccessibleDescription(DESCRIPTION);
});
