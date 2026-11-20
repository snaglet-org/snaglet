import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useZoomHotkeys } from './useZoomHotkeys';

// Mock only the actions (the mockable seam, mirroring useReloadHotkey's
// test); keep the real `isDesktopShell`, which reads the __SNAGLET_DESKTOP__
// marker at call time, so each test picks its context via the real signal.
const zoomIn = vi.fn();
const zoomOut = vi.fn();
const resetZoom = vi.fn();
const applyPersistedZoom = vi.fn();
vi.mock('@desktop/components/StatusBar/consumers/zoomWindow', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@desktop/components/StatusBar/consumers/zoomWindow')>();
  return {
    ...actual,
    zoomIn: () => zoomIn(),
    zoomOut: () => zoomOut(),
    resetZoom: () => resetZoom(),
    applyPersistedZoom: () => applyPersistedZoom(),
  };
});

function Harness() {
  useZoomHotkeys();
  return <input data-testid="text-input" />;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Most tests run "inside" the desktop shell.
  (window as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__ = {
    apiBaseUrl: 'http://localhost',
  };
});

describe('useZoomHotkeys', () => {
  it('zooms in on Cmd+= and on Cmd+Shift+= (⌘+)', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    expect(zoomIn).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: '+', metaKey: true, shiftKey: true });
    expect(zoomIn).toHaveBeenCalledTimes(2);
  });

  it('zooms out on Cmd+- and resets on Cmd+0', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '-', metaKey: true });
    expect(zoomOut).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: '0', metaKey: true });
    expect(resetZoom).toHaveBeenCalledTimes(1);
  });

  it('keeps auto-repeating zoom in/out while the combo is held', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '=', metaKey: true });
    fireEvent.keyDown(document.body, { key: '=', metaKey: true, repeat: true });
    fireEvent.keyDown(document.body, { key: '+', metaKey: true, shiftKey: true, repeat: true });
    expect(zoomIn).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(document.body, { key: '-', metaKey: true });
    fireEvent.keyDown(document.body, { key: '-', metaKey: true, repeat: true });
    expect(zoomOut).toHaveBeenCalledTimes(2);
  });

  it('accepts Ctrl as the modifier (Windows/Linux)', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '=', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '-', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '0', ctrlKey: true });
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(zoomOut).toHaveBeenCalledTimes(1);
    expect(resetZoom).toHaveBeenCalledTimes(1);
  });

  it('still fires while typing — like the native browser zoom combos', () => {
    render(<Harness />);
    const input = screen.getByTestId('text-input');
    input.focus();
    fireEvent.keyDown(input, { key: '=', metaKey: true });
    expect(zoomIn).toHaveBeenCalledTimes(1);
  });

  it('ignores the bare keys and combos with extra modifiers', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '=' });
    fireEvent.keyDown(document.body, { key: '-' });
    fireEvent.keyDown(document.body, { key: '0' });
    fireEvent.keyDown(document.body, { key: '=', metaKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: '-', metaKey: true, shiftKey: true });
    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
    expect(resetZoom).not.toHaveBeenCalled();
  });

  it('re-applies the persisted zoom once on mount (boot path)', () => {
    render(<Harness />);
    expect(applyPersistedZoom).toHaveBeenCalledTimes(1);
  });

  it('registers nothing outside the desktop shell — combos pass through to native zoom', () => {
    delete (window as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__;
    render(<Harness />);
    // fireEvent returns false when a handler preventDefault-ed — an attached
    // matcher would cancel these, suppressing the browser's own zoom.
    expect(fireEvent.keyDown(document.body, { key: '=', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: '-', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: '0', metaKey: true })).toBe(true);
    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
    expect(resetZoom).not.toHaveBeenCalled();
    expect(applyPersistedZoom).not.toHaveBeenCalled();
  });
});
