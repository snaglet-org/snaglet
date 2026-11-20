import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('ChipEditableInput pending hydration', () => {
  it.each([false, true])(
    'cancels an older queued replacement when the latest value already matches the document (rich=%s)',
    async (richBlocks) => {
      const props = {
        onChange: vi.fn(),
        ariaLabel: 'Notes',
        enableNodeMentions: false,
        richBlocks,
        multiline: richBlocks,
      };
      const view = render(<ChipEditableInput {...props} value="Original" />);
      await act(async () => Promise.resolve());
      expect(screen.getByRole('textbox')).toHaveTextContent('Original');

      view.rerender(<ChipEditableInput {...props} value="Discarded interim value" />);
      view.rerender(<ChipEditableInput {...props} value="Original" />);
      await act(async () => Promise.resolve());

      expect(screen.getByRole('textbox')).toHaveTextContent(/^Original$/);
      expect(props.onChange).not.toHaveBeenCalled();
    }
  );

  it('hydrates the latest value without emitting a change when several replacements are pending', async () => {
    const props = { onChange: vi.fn(), ariaLabel: 'Notes', enableNodeMentions: false };
    const view = render(<ChipEditableInput {...props} value="Original" />);
    await act(async () => Promise.resolve());

    view.rerender(<ChipEditableInput {...props} value="Discarded interim value" />);
    view.rerender(<ChipEditableInput {...props} value="Latest server value" />);
    await act(async () => Promise.resolve());

    expect(screen.getByRole('textbox')).toHaveTextContent(/^Latest server value$/);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('keeps immediate typing at the hydrated end when initial replacements supersede each other', async () => {
    vi.useFakeTimers();
    const props = {
      onChange: vi.fn(),
      ariaLabel: 'Notes',
      enableNodeMentions: false,
      autoFocus: true,
    };
    const view = render(<ChipEditableInput {...props} value="Original" />);
    view.rerender(<ChipEditableInput {...props} value="Discarded interim value" />);
    view.rerender(<ChipEditableInput {...props} value="Latest" />);
    await act(async () => Promise.resolve());

    const input = screen.getByRole('textbox');
    expect(input).toHaveFocus();
    expect(input).toHaveTextContent(/^Latest$/);
    expect(props.onChange).not.toHaveBeenCalled();

    vi.useRealTimers();
    await userEvent.setup({ delay: null }).keyboard('!');
    expect(input).toHaveTextContent(/^Latest!$/);
    expect(props.onChange).toHaveBeenLastCalledWith('Latest!');
  });
});
