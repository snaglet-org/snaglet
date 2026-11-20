import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { StatusBar } from '../StatusBar';
import { StatusBarProvider } from '../StatusBarContext';
import { ZoomSlot } from './ZoomSlot';
import { ZOOM_STORAGE_KEY } from './zoomWindow';

// Real zoomWindow module throughout — the slot's observable output (the
// persisted level and the rendered percentage) IS the behavior under test. In
// the desktop shell the level is applied via the native webview zoom (not a DOM
// style), so the assertions read the persisted level rather than a CSS property.

const renderSlot = () =>
  render(
    <StatusBarProvider>
      <ZoomSlot />
      <StatusBar />
    </StatusBarProvider>
  );

const persisted = () => window.localStorage.getItem(ZOOM_STORAGE_KEY);

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty('zoom');
  // ZoomSlot is desktop-only; most tests run "inside" the shell.
  (window as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__ = {
    apiBaseUrl: 'http://localhost',
  };
});

describe('ZoomSlot', () => {
  it('renders zoom out / percentage / zoom in controls in the bar', () => {
    renderSlot();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
  });

  it('registers nothing outside the desktop shell — native browser zoom owns the job there', () => {
    delete (window as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__;
    renderSlot();
    expect(screen.queryByRole('button', { name: 'Zoom out' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument();
  });

  it('+ steps the root zoom up the ladder and updates the percentage', () => {
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(persisted()).toBe('1.1');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('110%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(persisted()).toBe('1.25');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('125%');
  });

  it('− steps down and clamps at 80%, disabling the button at the floor', () => {
    renderSlot();
    const out = () => screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.click(out()); // 90%
    fireEvent.click(out()); // 80%
    expect(persisted()).toBe('0.8');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('80%');
    expect(out()).toBeDisabled();
    fireEvent.click(out()); // no-op at the floor
    expect(persisted()).toBe('0.8');
  });

  it('+ clamps at 200%, disabling the button at the ceiling', () => {
    renderSlot();
    const zoomIn = () => screen.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 7; i += 1) fireEvent.click(zoomIn());
    expect(persisted()).toBe('2');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('200%');
    expect(zoomIn()).toBeDisabled();
  });

  it('shows the persisted level on mount', () => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '1.5');
    renderSlot();
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('150%');
  });

  it('clicking the percentage resets to 100% and persists it', () => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '1.5');
    renderSlot();
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1');
  });

  it('shows the shortcut hints in the tooltips for discoverability', () => {
    renderSlot();
    // Keyboard focus opens the tooltip immediately (no hover delay). The
    // hints read ⌘+/⌘−/⌘0 on mac, Ctrl-based elsewhere — assert the shared parts.
    fireEvent.focus(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Zoom in \(.*\+\)/);
    fireEvent.blur(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.focus(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Reset zoom \(.*0\)/);
  });
});
