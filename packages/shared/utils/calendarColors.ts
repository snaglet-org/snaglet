/**
 * Calendar colors: the one check every writer shares (the calendars API,
 * the color popover). A color is stored as text in one of three forms:
 *
 * - a palette id (`blue` … `gray`), drawn from the theme's palette tokens;
 * - `theme:<token>`, a workspace theme token by name (`theme:detail`), so the
 *   calendar re-skins when the theme changes;
 * - a custom `#rrggbb`, lowercase (`#rgb` and any case are accepted and
 *   normalized).
 *
 * null means automatic (the palette by sort order) and is handled by callers.
 */
import { defaultWorkspaceColors, LEGACY_WORKSPACE_COLOR_KEYS } from '../constants/workspaceTheme';
import {
  CALENDAR_COLORS,
  CALENDAR_THEME_COLOR_PREFIX,
  type CalendarColor,
  type CalendarCustomColor,
  type CalendarPaletteColor,
  type CalendarThemeColor,
} from '../types/calendar';

export type CalendarColorParts =
  | { kind: 'palette'; color: CalendarPaletteColor }
  | { kind: 'theme'; color: CalendarThemeColor; token: string }
  | { kind: 'custom'; color: CalendarCustomColor };

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** `#rgb` / `#rrggbb` in any case → lowercase `#rrggbb`; anything else null. */
export function normalizeHexColor(value: unknown): CalendarCustomColor | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase() as CalendarCustomColor;
  if (/^#[0-9a-f]{3}$/i.test(text))
    return `#${[...text.slice(1)].map((c) => c + c).join('')}`.toLowerCase() as CalendarCustomColor;
  return null;
}

/** A current theme token name; a renamed token resolves to its successor. */
function themeToken(name: string): string | null {
  if (own(defaultWorkspaceColors, name)) return name;
  if (!own(LEGACY_WORKSPACE_COLOR_KEYS, name)) return null;
  return LEGACY_WORKSPACE_COLOR_KEYS[name]?.[0] ?? null;
}

/** What a calendar color is, normalized; null when `value` is not one. */
export function calendarColorParts(value: unknown): CalendarColorParts | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const palette = CALENDAR_COLORS.find((id) => id === text);
  if (palette) return { kind: 'palette', color: palette };
  if (text.startsWith(CALENDAR_THEME_COLOR_PREFIX)) {
    const token = themeToken(text.slice(CALENDAR_THEME_COLOR_PREFIX.length));
    return token ? { kind: 'theme', color: `${CALENDAR_THEME_COLOR_PREFIX}${token}`, token } : null;
  }
  const hex = normalizeHexColor(text);
  return hex ? { kind: 'custom', color: hex } : null;
}

/** The stored form of a calendar color, or null when `value` is not one. */
export function normalizeCalendarColor(value: unknown): CalendarColor | null {
  return calendarColorParts(value)?.color ?? null;
}

/** The accepted forms, for a 400 message or a tool description. */
export const CALENDAR_COLOR_FORMATS =
  `null (automatic), a palette color (${CALENDAR_COLORS.join(', ')}), ` +
  `a theme color written ${CALENDAR_THEME_COLOR_PREFIX}<token> ` +
  `(tokens: ${Object.keys(defaultWorkspaceColors).join(', ')}), ` +
  'or a custom hex color like #3a7bd5';
