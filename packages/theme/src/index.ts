/**
 * @snaglet/theme: Snaglet's color theme as data.
 *
 * `defaultTheme` (Soft Pastel Garden) is the single source of truth for the
 * app's default palette. Everything else is generated from this file by
 * `scripts/generate.ts` and committed: `index.js` and `index.d.ts` (this
 * module), `defaultTheme.json`, `theme.css` and `tokens.scss`.
 *
 * No runtime dependencies, so the app, the server and the website can all
 * read the same values.
 */

/**
 * The palette's token keys, in the Theme view's order: the base palette, the
 * two container colors, then the node kinds. They are the keys a saved theme
 * uses (`appearance.colors`), the keys of the `change_color_theme` tool, and
 * the names of the CSS custom properties that paint them (`--<key>`).
 */
export const THEME_TOKEN_KEYS = [
  'disabled',
  'background',
  'foreground',
  'activity-bar',
  'sidebar',
  'status-bar',
  'raised',
  'chrome',
  'field',
  'selected',
  'text',
  'text-muted',
  'line',
  'border',
  'detail',
  'detail-2',
  'color-container-project',
  'color-container-default',
  'color-node-doc',
  'color-node-thread',
  'agent',
  'color-node-tool',
  'color-node-memory',
  'color-node-image',
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

/** A six-digit, lowercase hex color: `#rrggbb`. */
export type HexColor = `#${string}`;

/** A color for every theme token. */
export type ThemePalette = Readonly<Record<ThemeTokenKey, HexColor>>;

/** The default theme's name, as the Theme view shows it. */
export const DEFAULT_THEME_NAME = 'Soft Pastel Garden';

/**
 * The default theme, Soft Pastel Garden ({@link DEFAULT_THEME_NAME}):
 * near-black surfaces, off-white text and pastel accents. A dark theme,
 * whatever the operating system's light or dark setting. What a fresh install
 * shows and what every reset returns to.
 */
export const defaultTheme: ThemePalette = Object.freeze({
  // Base
  disabled: '#2a2a2a', // dim overlay
  background: '#0a0a0a', // deep black
  foreground: '#1a1a1a', // dark panels
  'activity-bar': '#0f0f0f', // left edge
  sidebar: '#0f0f0f',
  'status-bar': '#0f0f0f', // bottom bar
  raised: '#1a1a1a', // buttons
  chrome: '#0f0f0f', // title bars
  field: '#1e1e1e', // input backgrounds
  selected: '#f5b398', // peachy orange: highlights, selections
  text: '#f5f5f5', // off-white
  'text-muted': '#a1a1a1',
  line: '#f5d5e8', // light pink: thin borders
  border: '#e291b5', // dusty pink: strong borders
  detail: '#e291b5', // dusty pink: main accent (links, buttons, focus)
  'detail-2': '#d4a5d6', // soft purple: icons, secondary elements
  // Containers
  'color-container-project': '#b8e6d5', // soft mint green
  'color-container-default': '#d4e8e1', // pale seafoam
  // Node kinds
  'color-node-doc': '#9ed4d1', // soft mint
  'color-node-thread': '#f5b398', // peachy coral
  agent: '#e291b5', // dusty pink
  'color-node-tool': '#e8c4a6', // soft tan
  'color-node-memory': '#d4a5d6', // light lavender
  'color-node-image': '#f5b398', // peachy coral
});

// Contrast

/** WCAG AA contrast for body text. */
export const TEXT_CONTRAST = 4.5;
/** WCAG AA contrast for UI components (outlines, focus rings, icons). */
export const UI_CONTRAST = 3;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 to 1) of a `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio (1 to 21) between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `weight` (0 to 1) of `color` mixed over `base`, per sRGB channel: what
 * `color-mix(in srgb, color weight%, base)` paints.
 */
export function mixHex(color: string, weight: number, base: string): HexColor {
  const a = channels(color);
  const b = channels(base);
  const mixed = a.map((channel, i) =>
    Math.round(channel * weight + b[i]! * (1 - weight))
      .toString(16)
      .padStart(2, '0')
  );
  return `#${mixed.join('')}`;
}

// Derived tokens

/**
 * Values the stylesheet derives from a palette rather than storing: the
 * stylesheet ships them for the default theme, and the app sets them again
 * for a saved theme, so any palette stays readable.
 */
export interface DerivedThemeTokens {
  /** `--on-selected`: text on the Selected color, the palette's text or background, whichever reads better. */
  'on-selected': 'var(--text)' | 'var(--background)';
  /**
   * `--accent-on-selected`: accent glyphs and badges on the Selected color:
   * Detail where it stands out there (3:1), otherwise the on-Selected text.
   */
  'accent-on-selected': 'var(--detail)' | 'var(--on-selected)';
  /** `--hover-mix`: how much Selected tints Raised under a hovered row. */
  'hover-mix': `${number}%`;
  /** `--hover-mix-soft`: the lighter hover tint of large surfaces. */
  'hover-mix-soft': `${number}%`;
  /** The CSS `color-scheme`, for native controls: dark when the background is darker than the text. */
  'color-scheme': 'dark' | 'light';
}

/** The strongest hover tint, and the share of it the soft hover uses. */
const HOVER_MIX_MAX = 58;
const HOVER_MIX_MIN = 12;
const HOVER_SOFT_SHARE = 42 / 58;

/**
 * The derived tokens for `palette`. The hover tint is the strongest one (at
 * most 58 %) under which both Text and Text Muted keep 4.5:1, so a light
 * palette keeps its full tint and a dark one gets a quieter one; it never
 * drops below 12 %, so a hover always shows.
 */
export function deriveThemeTokens(
  palette: Readonly<Record<ThemeTokenKey, string>>
): DerivedThemeTokens {
  const { selected, raised, text, background } = palette;
  const muted = palette['text-muted'];
  const onSelected =
    contrastRatio(background, selected) > contrastRatio(text, selected)
      ? 'var(--background)'
      : 'var(--text)';
  let hover = HOVER_MIX_MAX;
  while (hover > HOVER_MIX_MIN) {
    const surface = mixHex(selected, hover / 100, raised);
    const readable = [text, muted].every((ink) => contrastRatio(ink, surface) >= TEXT_CONTRAST);
    if (readable) break;
    hover -= 2;
  }
  return {
    'on-selected': onSelected,
    'accent-on-selected':
      contrastRatio(palette.detail, selected) >= UI_CONTRAST
        ? 'var(--detail)'
        : 'var(--on-selected)',
    'hover-mix': `${hover}%`,
    'hover-mix-soft': `${Math.round(hover * HOVER_SOFT_SHARE)}%`,
    'color-scheme': relativeLuminance(background) < relativeLuminance(text) ? 'dark' : 'light',
  };
}
