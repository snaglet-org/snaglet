import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { QuickSearchSlot } from './QuickSearchSlot';

const renderSlot = (onOpen: () => void) =>
  render(
    <StatusBarProvider>
      <QuickSearchSlot onOpen={onOpen} />
      <StatusBar />
    </StatusBarProvider>
  );

describe('QuickSearchSlot', () => {
  it('renders the Quick search label and a K keycap hint', () => {
    renderSlot(() => {});
    expect(screen.getByText('Quick search')).toBeInTheDocument();
    // The keycap shows the platform modifier + K; the letter is always present.
    expect(screen.getByText('K')).toBeInTheDocument();
  });

  it('calls onOpen when the button is clicked', () => {
    const onOpen = vi.fn();
    renderSlot(onOpen);
    fireEvent.click(screen.getByText('Quick search'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('exposes the shortcut in the button title for discoverability', () => {
    renderSlot(() => {});
    // title contains the shortcut (⌘K on mac, Ctrl+K elsewhere) — assert the K.
    const titled = document.querySelector('[title*="K"]');
    expect(titled).not.toBeNull();
  });
});
