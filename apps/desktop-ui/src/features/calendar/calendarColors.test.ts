/**
 * Painting calendar colors: palette ids by CSS, theme tokens by reference,
 * custom hexes inline with contrast-picked ink.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import {
  calendarColorProps,
  contrastRatio,
  inkOn,
  liveThemeHex,
  mixHex,
  readableAccent,
  TEXT_CONTRAST,
} from './calendarColors';

type Vars = Record<string, string | number | undefined>;
const vars = (color: string | null | undefined, style?: Vars) =>
  (calendarColorProps(color, style).style ?? {}) as Vars;

/** Every 0x33 step per channel: 216 colors from black to white. */
const SWEEP = [0, 0x33, 0x66, 0x99, 0xcc, 0xff].flatMap((r) =>
  [0, 0x33, 0x66, 0x99, 0xcc, 0xff].flatMap((g) =>
    [0, 0x33, 0x66, 0x99, 0xcc, 0xff].map(
      (b) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
    )
  )
);

describe('calendarColorProps', () => {
  afterEach(() => document.documentElement.removeAttribute('style'));

  it('leaves a palette id to the stylesheet, so existing calendars look as before', () => {
    expect(calendarColorProps('blue')).toEqual({ 'data-cal-color': 'blue' });
    expect(calendarColorProps('gray', { top: 4 })).toEqual({
      'data-cal-color': 'gray',
      style: { top: 4 },
    });
  });

  it('paints a theme token by reference', () => {
    expect(calendarColorProps('theme:detail')).toEqual({
      'data-cal-color': 'theme:detail',
      style: { '--cal-accent': 'var(--detail)' },
    });
    // A renamed token follows its successor.
    expect(vars('theme:panel')['--cal-accent']).toBe('var(--foreground)');
  });

  it('paints a custom hex inline with its ink, merging the caller’s style', () => {
    const props = calendarColorProps('#FFEE88', { height: 20 });
    expect(props['data-cal-color']).toBe('#ffee88');
    expect(props.style).toMatchObject({
      height: 20,
      '--cal-accent': '#ffee88',
      '--cal-on-accent': '#000000',
    });
  });

  it('paints nothing for what is not a calendar color', () => {
    expect(calendarColorProps(undefined)).toEqual({});
    expect(calendarColorProps('plaid')).toEqual({});
    expect(calendarColorProps('theme:nope', { top: 1 })).toEqual({ style: { top: 1 } });
  });

  it('picks a custom color’s tick ink against the live theme background', () => {
    const pale = '#ffee88';
    const onDefault = vars(pale)['--cal-accent-ink'] as string;
    expect(contrastRatio(onDefault, defaultWorkspaceColors.background!)).toBeGreaterThanOrEqual(
      TEXT_CONTRAST
    );
    // On a dark theme the pale color already reads, so it is used as is.
    document.documentElement.style.setProperty('--background', '#1a1a1a');
    document.documentElement.style.setProperty('--text', '#f0f0f0');
    expect(liveThemeHex('background')).toBe('#1a1a1a');
    expect(vars(pale)['--cal-accent-ink']).toBe(pale);
  });
});

describe('contrast', () => {
  it('ink on a color is black or white and always at least 4.5:1', () => {
    expect(inkOn('#ffee88')).toBe('#000000');
    expect(inkOn('#1f2a5c')).toBe('#ffffff');
    for (const hex of SWEEP) expect(contrastRatio(inkOn(hex), hex)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a readable accent and darkens only as far as needed', () => {
    // A light theme: dark ink on white.
    const white = '#ffffff';
    const text = '#30392d';
    expect(readableAccent('#1f4fbf', white, text)).toBe('#1f4fbf');
    const pale = readableAccent('#ffee88', white, text);
    expect(contrastRatio(pale, white)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    // Still a shade of the color, not the plain text color.
    expect(pale).not.toBe(text);
    for (const hex of SWEEP)
      expect(contrastRatio(readableAccent(hex, white, text), white)).toBeGreaterThanOrEqual(
        TEXT_CONTRAST
      );
  });

  it('keeps every accent readable on the default (dark) theme', () => {
    const background = defaultWorkspaceColors.background!;
    const text = defaultWorkspaceColors.text!;
    for (const hex of SWEEP)
      expect(
        contrastRatio(readableAccent(hex, background, text), background)
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it('item text (the theme text on the strongest item tint) reads on every custom color', () => {
    const background = defaultWorkspaceColors.background!;
    const text = defaultWorkspaceColors.text!;
    // The pane's tints go up to 32 % of the color over the background.
    for (const hex of SWEEP)
      expect(contrastRatio(text, mixHex(background, hex, 0.32))).toBeGreaterThanOrEqual(
        TEXT_CONTRAST
      );
  });
});
