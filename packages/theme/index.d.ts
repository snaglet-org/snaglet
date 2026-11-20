// Generated from src/index.ts by scripts/generate.ts. Do not edit by hand.
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
export declare const THEME_TOKEN_KEYS: readonly ["disabled", "background", "foreground", "activity-bar", "sidebar", "status-bar", "raised", "chrome", "field", "selected", "text", "text-muted", "line", "border", "detail", "detail-2", "color-container-project", "color-container-default", "color-node-doc", "color-node-thread", "agent", "color-node-tool", "color-node-memory", "color-node-image"];
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
/** A six-digit, lowercase hex color: `#rrggbb`. */
export type HexColor = `#${string}`;
/** A color for every theme token. */
export type ThemePalette = Readonly<Record<ThemeTokenKey, HexColor>>;
/** The default theme's name, as the Theme view shows it. */
export declare const DEFAULT_THEME_NAME = "Soft Pastel Garden";
/**
 * The default theme, Soft Pastel Garden ({@link DEFAULT_THEME_NAME}):
 * near-black surfaces, off-white text and pastel accents. A dark theme,
 * whatever the operating system's light or dark setting. What a fresh install
 * shows and what every reset returns to.
 */
export declare const defaultTheme: ThemePalette;
/** WCAG AA contrast for body text. */
export declare const TEXT_CONTRAST = 4.5;
/** WCAG AA contrast for UI components (outlines, focus rings, icons). */
export declare const UI_CONTRAST = 3;
/** WCAG relative luminance (0 to 1) of a `#rrggbb` color. */
export declare function relativeLuminance(hex: string): number;
/** WCAG contrast ratio (1 to 21) between two `#rrggbb` colors. */
export declare function contrastRatio(a: string, b: string): number;
/**
 * `weight` (0 to 1) of `color` mixed over `base`, per sRGB channel: what
 * `color-mix(in srgb, color weight%, base)` paints.
 */
export declare function mixHex(color: string, weight: number, base: string): HexColor;
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
/**
 * The derived tokens for `palette`. The hover tint is the strongest one (at
 * most 58 %) under which both Text and Text Muted keep 4.5:1, so a light
 * palette keeps its full tint and a dark one gets a quieter one; it never
 * drops below 12 %, so a hover always shows.
 */
export declare function deriveThemeTokens(palette: Readonly<Record<ThemeTokenKey, string>>): DerivedThemeTokens;
