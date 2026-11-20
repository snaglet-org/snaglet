/**
 * WorkspaceThemeSync: a `settings:changed` frame for appearance.colors (an
 * agent's change_color_theme, another window's Theme view save) recolors this
 * window at once and repaints the Theme view's pickers; other settings are
 * ignored; every socket open re-reads, so a missed frame or a failed first
 * load (cold start while the server boots) recovers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WsMessage } from '@snaglet/shared/types';
import { defaultTheme } from '@snaglet/theme';

const ws = vi.hoisted(() => {
  const listeners = new Set<(message: WsMessage) => void>();
  return {
    listeners,
    connectionState: 'open' as string,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addMessageListener: (listener: (message: WsMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock('./useWs', () => ({
  useWs: () => ({
    connectionState: ws.connectionState,
    subscribe: ws.subscribe,
    unsubscribe: ws.unsubscribe,
    addMessageListener: ws.addMessageListener,
  }),
}));
const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock('@desktop/utils/api/settings', () => ({ settingsApi: api }));

import { WorkspaceThemeSync } from './WorkspaceThemeSync';
import { ThemeView } from '@desktop/pages/Dashboard/views/ThemeView';
import { getThemeSaveError, initializeWorkspaceTheme } from '@desktop/utils/workspaceTheme';

const savedTheme = (value: Record<string, string>) => ({
  category: 'appearance',
  key: 'colors',
  value,
  isOverridden: true,
});

const css = () => document.documentElement.style;
function settingsChanged(category: string, key: string): void {
  const message = {
    type: 'settings:changed',
    channel: 'settings',
    payload: { category, key },
  } as WsMessage;
  for (const listener of [...ws.listeners]) listener(message);
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  api.list.mockReset().mockResolvedValue([]);
  api.get.mockReset().mockResolvedValue(savedTheme({}));
  api.patch.mockReset().mockResolvedValue(undefined);
  ws.subscribe.mockClear();
  ws.connectionState = 'open';
});

it('recolors the page and the Theme view pickers when an agent changes the theme', async () => {
  render(
    <>
      <WorkspaceThemeSync />
      <ThemeView />
    </>
  );
  expect(ws.subscribe).toHaveBeenCalledWith('settings');
  expect(screen.getByLabelText('Doc hex color')).toHaveValue(defaultTheme['color-node-doc']);

  api.get.mockResolvedValue(savedTheme({ 'color-node-doc': '#123456', detail: '#00AA88' }));
  await act(async () => settingsChanged('appearance', 'colors'));

  await vi.waitFor(() => expect(css().getPropertyValue('--color-node-doc')).toBe('#123456'));
  expect(css().getPropertyValue('--detail')).toBe('#00aa88');
  expect(screen.getByLabelText('Doc hex color')).toHaveValue('#123456');
  expect(screen.getByLabelText('Detail hex color')).toHaveValue('#00aa88');
  expect(api.patch).not.toHaveBeenCalled();

  // A reset elsewhere drops the override: the picker shows the default again.
  api.get.mockResolvedValue(savedTheme({ detail: '#00aa88' }));
  await act(async () => settingsChanged('appearance', 'colors'));
  await vi.waitFor(() => expect(css().getPropertyValue('--color-node-doc')).toBe(''));
  expect(screen.getByLabelText('Doc hex color')).toHaveValue(defaultTheme['color-node-doc']);
});

it('ignores changes to other settings', async () => {
  ws.connectionState = 'connecting';
  render(<WorkspaceThemeSync />);
  await act(async () => settingsChanged('workers', 'mode'));
  expect(api.get).not.toHaveBeenCalled();
});

it('re-reads the theme on every socket open, the first included', async () => {
  ws.connectionState = 'connecting';
  const { rerender } = render(<WorkspaceThemeSync />);
  expect(api.get).not.toHaveBeenCalled();
  ws.connectionState = 'open';
  rerender(<WorkspaceThemeSync />);
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  const reads = api.get.mock.calls.length;
  ws.connectionState = 'closed';
  rerender(<WorkspaceThemeSync />);
  ws.connectionState = 'open';
  rerender(<WorkspaceThemeSync />);
  await vi.waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(reads));
});

it('recovers a window whose first load failed once the socket opens', async () => {
  api.list.mockRejectedValueOnce(new Error('server still booting'));
  await initializeWorkspaceTheme();
  expect(getThemeSaveError()).toContain('Unable to load');
  api.get.mockResolvedValue(savedTheme({ text: '#445566' }));
  ws.connectionState = 'connecting';
  const { rerender } = render(<WorkspaceThemeSync />);
  ws.connectionState = 'open';
  rerender(<WorkspaceThemeSync />);
  await vi.waitFor(() => expect(css().getPropertyValue('--text')).toBe('#445566'));
  expect(getThemeSaveError()).toBe('');
});

it('resets a saved color by removing it, so the stylesheet default shows here and after the sync', async () => {
  // The shipped default, as the stylesheet declares it (@snaglet/theme's color layer).
  const tokens = readFileSync(resolve(process.cwd(), '../../packages/theme/tokens.scss'), 'utf8');
  const stylesheetDetail = /^\s*--detail:\s*(#[0-9a-f]{6});/im.exec(tokens)![1]!;
  const sheet = document.createElement('style');
  sheet.textContent = `:root { --detail: ${stylesheetDetail}; }`;
  document.head.appendChild(sheet);
  // The saved row, merged as PATCH /api/settings/appearance/colors merges it:
  // a null removes the color (nullRemovesEntry).
  let row: Record<string, string> = {};
  api.patch.mockImplementation(
    async (_category: string, _key: string, patch: Record<string, string | null>) => {
      const next = { ...row };
      for (const [name, color] of Object.entries(patch)) {
        if (color === null) delete next[name];
        else next[name] = color;
      }
      row = next;
    }
  );
  api.get.mockImplementation(async () => savedTheme(row));
  const rendered = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--detail').trim();
  try {
    render(
      <>
        <WorkspaceThemeSync />
        <ThemeView />
      </>
    );
    const hex = screen.getByLabelText('Detail hex color');
    expect(hex).toHaveValue(stylesheetDetail);
    fireEvent.change(hex, { target: { value: '#00aa88' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    await vi.waitFor(() => expect(row).toEqual({ detail: '#00aa88' }));
    expect(rendered()).toBe('#00aa88');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to Soft Pastel Garden' }));
    await vi.waitFor(() => expect(row).not.toHaveProperty('detail'));
    expect(row).toEqual({});
    expect(css().getPropertyValue('--detail')).toBe('');
    expect(rendered()).toBe(stylesheetDetail);
    expect(screen.getByLabelText('Detail hex color')).toHaveValue(stylesheetDetail);

    // The save's echo reads the row back: no override returns.
    await act(async () => settingsChanged('appearance', 'colors'));
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(css().getPropertyValue('--detail')).toBe('');
    expect(rendered()).toBe(stylesheetDetail);
  } finally {
    sheet.remove();
  }
});
