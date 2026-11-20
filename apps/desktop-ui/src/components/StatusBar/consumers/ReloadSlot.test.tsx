import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { ReloadSlot } from './ReloadSlot';

// jsdom's `location.reload` is non-configurable, so the shared action
// module is the mockable seam (same reason it exists in production code).
const reloadWindow = vi.fn();
vi.mock('./reloadWindow', () => ({
  reloadWindow: () => reloadWindow(),
}));

const renderSlot = () =>
  render(
    <StatusBarProvider>
      <ReloadSlot />
      <StatusBar />
    </StatusBarProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReloadSlot', () => {
  it('renders an icon-only reload button in the bar', () => {
    renderSlot();
    expect(screen.getByRole('button', { name: 'Reload UI' })).toBeInTheDocument();
  });

  it('reloads the webview when clicked', () => {
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: 'Reload UI' }));
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  it('shows the shortcut hint in the tooltip for discoverability', () => {
    renderSlot();
    // Keyboard focus opens the tooltip immediately (no hover delay).
    fireEvent.focus(screen.getByRole('button', { name: 'Reload UI' }));
    // The hint reads ⌘R on mac, Ctrl+R elsewhere — assert the shared parts.
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Reload UI \(.*R\)/);
  });
});
