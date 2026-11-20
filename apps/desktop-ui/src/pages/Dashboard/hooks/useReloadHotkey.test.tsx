import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReloadHotkey } from './useReloadHotkey';

// jsdom's `location.reload` is non-configurable, so the shared action
// module is the mockable seam (same reason it exists in production code).
const reloadWindow = vi.fn();
vi.mock('@desktop/components/StatusBar/consumers/reloadWindow', () => ({
  reloadWindow: () => reloadWindow(),
}));

function Harness() {
  useReloadHotkey();
  return <input data-testid="text-input" />;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useReloadHotkey', () => {
  it('reloads on Cmd+R', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'r', metaKey: true });
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  it('accepts Ctrl as the modifier (Windows/Linux)', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'R', ctrlKey: true });
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  it('still fires while typing — mirrors ⌘K and the native browser reload', () => {
    render(<Harness />);
    const input = screen.getByTestId('text-input');
    input.focus();
    fireEvent.keyDown(input, { key: 'r', metaKey: true });
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  it('ignores plain R and combos with extra modifiers', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'r' });
    fireEvent.keyDown(document.body, { key: 'r', metaKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'r', metaKey: true, altKey: true });
    expect(reloadWindow).not.toHaveBeenCalled();
  });
});
