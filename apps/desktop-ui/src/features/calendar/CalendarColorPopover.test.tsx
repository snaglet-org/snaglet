/**
 * The calendar color popover: theme swatches from the live workspace theme
 * (stored as token references, following theme edits), custom colors with
 * recent picks, Automatic, and the custom picker layer — saved only on Save
 * or Enter, closed one layer per outside press or Escape.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarColor } from '@snaglet/shared/types';
import {
  defaultWorkspaceColors,
  workspaceColorTokens,
} from '@snaglet/shared/constants/workspaceTheme';
import { THEME_CHANGED } from '@desktop/utils/workspaceTheme';
import { getRecentColors, reloadRecentColors } from './colorSwatches';
import { CalendarColorPopover } from './CalendarColorPopover';

let anchor: HTMLButtonElement;

/** A token's swatch name in the default theme: every token sharing its color, in order. */
const swatchName = (token: string) =>
  workspaceColorTokens
    .filter((t) => defaultWorkspaceColors[t.name] === defaultWorkspaceColors[token])
    .map((t) => t.label)
    .join(', ');

function setup(value: CalendarColor | null = null) {
  const onPick = vi.fn();
  const onDismiss = vi.fn();
  render(
    <CalendarColorPopover anchor={anchor} value={value} onPick={onPick} onDismiss={onDismiss} />
  );
  return { onPick, onDismiss };
}

const popover = () => screen.getByRole('dialog', { name: 'Calendar color' });
const themeGroup = () => within(popover()).getByRole('group', { name: 'Theme colors' });
const customGroup = () => within(popover()).getByRole('group', { name: 'Custom colors' });

async function openPicker() {
  fireEvent.click(within(popover()).getByRole('button', { name: 'Custom color…' }));
  const picker = await screen.findByRole('dialog', { name: 'Custom color' });
  const hex = within(picker).getByRole('textbox', { name: 'Hex color' });
  await waitFor(() => expect(hex).toHaveFocus());
  return { picker, hex };
}

function setTheme(token: string, hex: string) {
  act(() => {
    document.documentElement.style.setProperty(`--${token}`, hex);
    window.dispatchEvent(new Event(THEME_CHANGED));
  });
}

describe('CalendarColorPopover', () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadRecentColors();
    anchor = document.createElement('button');
    document.body.appendChild(anchor);
  });
  afterEach(() => {
    anchor.remove();
    document.documentElement.removeAttribute('style');
  });

  it('lists the workspace theme’s colors, one swatch per color, and stores a token', () => {
    const { onPick } = setup();
    const swatches = within(themeGroup()).getAllByRole('button');
    expect(swatches.length).toBe(new Set(Object.values(defaultWorkspaceColors)).size);
    // Tokens sharing a color share a swatch (the default theme paints the
    // activity bar, sidebar, status bar and chrome alike).
    expect(swatchName('activity-bar')).toContain('Activity Bar, Sidebar, Status Bar');
    const shared = within(themeGroup()).getByRole('button', { name: swatchName('activity-bar') });
    expect(shared).toHaveAttribute(
      'title',
      `${swatchName('activity-bar')} · ${defaultWorkspaceColors['activity-bar']}`
    );

    const text = within(themeGroup()).getByRole('button', { name: 'Text' });
    // Painted by reference, not by a frozen hex.
    expect(text).toHaveAttribute('data-cal-color', 'theme:text');
    expect(text.style.getPropertyValue('--cal-accent')).toBe('var(--text)');
    fireEvent.click(text);
    expect(onPick).toHaveBeenCalledWith('theme:text');
  });

  it('follows theme edits', () => {
    setup('theme:detail');
    // Pressed even while Detail shares its swatch with other tokens.
    const detail = within(themeGroup()).getByRole('button', { name: swatchName('detail') });
    expect(detail).toHaveAttribute('aria-pressed', 'true');

    setTheme('detail', '#123456');
    expect(within(themeGroup()).getByRole('button', { name: 'Detail' })).toHaveAttribute(
      'title',
      'Detail · #123456'
    );
    // A token edited to another token's color joins that swatch, still pressed.
    setTheme('detail', defaultWorkspaceColors.text!);
    const merged = within(themeGroup()).getByRole('button', { name: 'Text, Detail' });
    expect(merged).toHaveAttribute('aria-pressed', 'true');
    expect(merged).toHaveAttribute('data-cal-color', 'theme:text');
  });

  it('Automatic is pressed for no color and picks null', () => {
    const { onPick } = setup(null);
    const automatic = within(popover()).getByRole('button', { name: 'Automatic' });
    expect(automatic).toHaveAttribute('aria-pressed', 'true');
    expect(within(themeGroup()).queryByRole('button', { pressed: true })).toBeNull();
    fireEvent.click(automatic);
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('shows the calendar’s custom color pressed, before recent ones', () => {
    window.localStorage.setItem(
      'snaglet.calendar.recentColors',
      JSON.stringify({ version: 1, colors: ['#111111', '#3a7bd5'] })
    );
    reloadRecentColors();
    const { onPick } = setup('#3a7bd5');
    const customs = within(customGroup()).getAllByRole('button');
    expect(customs.map((b) => b.getAttribute('aria-label'))).toEqual([
      '#3a7bd5',
      '#111111',
      'Custom color…',
    ]);
    expect(customs[0]).toHaveAttribute('aria-pressed', 'true');
    expect(customs[0]!.style.getPropertyValue('--cal-accent')).toBe('#3a7bd5');
    fireEvent.click(customs[1]!);
    expect(onPick).toHaveBeenCalledWith('#111111');
  });

  it('falls back to the legacy sketch key once, migrating it to the calendar key', () => {
    window.localStorage.setItem(
      'snaglet.sketch.recentColors',
      JSON.stringify({ version: 1, colors: ['#123456', '#abcdef'] })
    );
    reloadRecentColors();
    expect(getRecentColors()).toEqual(['#123456', '#abcdef']);
    // Copied: the calendar key holds the payload and the sketch key is gone.
    expect(window.localStorage.getItem('snaglet.sketch.recentColors')).toBeNull();
    expect(window.localStorage.getItem('snaglet.calendar.recentColors')).toBe(
      JSON.stringify({ version: 1, colors: ['#123456', '#abcdef'] })
    );
    setup();
    const customs = within(customGroup()).getAllByRole('button');
    expect(customs.map((b) => b.getAttribute('aria-label'))).toEqual([
      '#123456',
      '#abcdef',
      'Custom color…',
    ]);
  });

  it('prefers the calendar key over a stale legacy sketch key', () => {
    window.localStorage.setItem(
      'snaglet.calendar.recentColors',
      JSON.stringify({ version: 1, colors: ['#111111'] })
    );
    window.localStorage.setItem(
      'snaglet.sketch.recentColors',
      JSON.stringify({ version: 1, colors: ['#222222'] })
    );
    reloadRecentColors();
    expect(getRecentColors()).toEqual(['#111111']);
    // Not copied over an existing value; the sketch key is left alone.
    expect(window.localStorage.getItem('snaglet.sketch.recentColors')).not.toBeNull();
  });

  it('the picker saves a custom hex, normalized, and remembers it', async () => {
    const { onPick } = setup('theme:detail');
    const { picker, hex } = await openPicker();
    // Starts from the color the calendar shows.
    expect(hex).toHaveValue(defaultWorkspaceColors.detail);
    fireEvent.change(hex, { target: { value: 'ABC' } });
    expect(within(picker).getByLabelText('Color')).toHaveValue('#aabbcc');
    fireEvent.click(within(picker).getByRole('button', { name: 'Save' }));
    expect(onPick).toHaveBeenCalledWith('#aabbcc');
    expect(getRecentColors()[0]).toBe('#aabbcc');
  });

  it('the color well drafts; Enter in the hex field saves', async () => {
    const { onPick } = setup();
    const { picker, hex } = await openPicker();
    fireEvent.change(within(picker).getByLabelText('Color'), { target: { value: '#00ff88' } });
    expect(hex).toHaveValue('#00ff88');
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('#00ff88');
  });

  it('an invalid hex can’t be saved and says why', async () => {
    const { onPick } = setup();
    const { picker, hex } = await openPicker();
    fireEvent.change(hex, { target: { value: '#12' } });
    expect(hex).toHaveAttribute('aria-invalid', 'true');
    expect(within(picker).getByText('Use a hex color like #3a7bd5.')).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('one outside press closes the picker and the popover, unsaved', async () => {
    const { onPick, onDismiss } = setup();
    const { hex } = await openPicker();
    fireEvent.change(hex, { target: { value: '#00ff88' } });

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Escape closes the picker only; the next Escape closes the popover', async () => {
    const { onPick, onDismiss } = setup();
    const { hex } = await openPicker();
    fireEvent.keyDown(hex, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('＋ toggles the picker; a press inside the popover closes only the picker', async () => {
    setup();
    await openPicker();
    const add = within(popover()).getByRole('button', { name: 'Custom color…' });
    expect(add).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(add);
    fireEvent.click(add);
    expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull();

    await openPicker();
    fireEvent.pointerDown(themeGroup());
    expect(screen.queryByRole('dialog', { name: 'Custom color' })).toBeNull();
    expect(popover()).toBeInTheDocument();
  });
});
