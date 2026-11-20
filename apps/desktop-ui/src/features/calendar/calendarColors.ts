/**
 * Painting a calendar color (docs/architecture.md). Every
 * calendar surface reads `--cal-accent`: a palette id sets it from CSS
 * (`data-cal-color`, `_calendarShared.scss`), a theme token or a custom hex
 * sets it inline here. `data-cal-color` always carries the stored color.
 *
 * Contrast. Items are light tints of the color (at most about a third) over
 * the theme background and keep the theme's own text color, so their text
 * reads on any color. A custom color also gets
 * - `--cal-on-accent`: black or white, whichever reads better on the solid
 *   color (always at least 4.5:1), for marks drawn on it;
 * - `--cal-accent-ink`: the color itself, or, when it would not reach 4.5:1
 *   on the theme background, the least mix toward the theme text that does,
 *   for the ✓ ticks drawn in the color.
 * Palette and theme colors keep their existing tokens.
 */
import type { CSSProperties } from 'react';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import { calendarColorParts, normalizeHexColor } from '@snaglet/shared/utils';

type CalendarColorVar = '--cal-accent' | '--cal-on-accent' | '--cal-accent-ink';
type CalendarColorStyle = CSSProperties & Partial<Record<CalendarColorVar, string>>;

interface CalendarColorProps {
  'data-cal-color'?: string;
  style?: CSSProperties;
}

/** @public WCAG AA for normal text; unit-tested. */
export const TEXT_CONTRAST = 4.5;

const BLACK = '#000000';
const WHITE = '#ffffff';

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** @public WCAG contrast ratio between two `#rrggbb` colors (1–21); unit-tested. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `hex`; never below 4.5:1. */
export function inkOn(hex: string): string {
  return contrastRatio(hex, BLACK) >= contrastRatio(hex, WHITE) ? BLACK : WHITE;
}

/**
 * @public `amount` (0–1) of the way from `from` to `to`, per sRGB channel,
 * like `color-mix(in srgb)`; unit-tested.
 */
export function mixHex(from: string, to: string, amount: number): string {
  const [r1, g1, b1] = rgb(from);
  const [r2, g2, b2] = rgb(to);
  const mix = (a: number, b: number) =>
    Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(r1, r2)}${mix(g1, g2)}${mix(b1, b2)}`;
}

/**
 * @public `hex` when it reads on `background`, else the least 10 % step
 * toward `text` that does; unit-tested.
 */
export function readableAccent(hex: string, background: string, text: string): string {
  for (let step = 0; step < 10; step += 1) {
    const ink = step === 0 ? hex : mixHex(hex, text, step / 10);
    if (contrastRatio(ink, background) >= TEXT_CONTRAST) return ink;
  }
  return text;
}

/** A workspace theme token as the app paints it now: the applied override, else its default. */
export function liveThemeHex(token: string): string | null {
  const applied =
    typeof document === 'undefined'
      ? ''
      : document.documentElement.style.getPropertyValue(`--${token}`);
  return normalizeHexColor(applied) ?? normalizeHexColor(defaultWorkspaceColors[token]);
}

/**
 * Props that paint an element (and what it holds) in a calendar color:
 * spread them onto the element. `style` is merged in.
 * Nothing that isn't a calendar color paints: the surface's default applies.
 */
export function calendarColorProps(
  color: string | null | undefined,
  style?: CSSProperties
): CalendarColorProps {
  const parts = calendarColorParts(color);
  if (!parts) return style ? { style } : {};
  if (parts.kind === 'palette')
    return { 'data-cal-color': parts.color, ...(style ? { style } : {}) };
  const vars: CalendarColorStyle =
    parts.kind === 'theme'
      ? { '--cal-accent': `var(--${parts.token})` }
      : {
          '--cal-accent': parts.color,
          '--cal-on-accent': inkOn(parts.color),
          '--cal-accent-ink': readableAccent(
            parts.color,
            liveThemeHex('background') ?? WHITE,
            liveThemeHex('text') ?? BLACK
          ),
        };
  return { 'data-cal-color': parts.color, style: { ...style, ...vars } };
}
