import {
  defaultWorkspaceColors,
  parseWorkspaceColors,
  readSavedWorkspaceColors,
  workspaceColorResetPatch,
} from '@snaglet/shared/constants/workspaceTheme';
import {
  defaultTheme,
  deriveThemeTokens,
  THEME_TOKEN_KEYS,
  type DerivedThemeTokens,
  type ThemeTokenKey,
} from '@snaglet/theme';
import { settingsApi } from './api/settings';

/** A color per token, or null for a token reset to the stylesheet default. */
type ColorPatch = Record<string, string | null>;

export const THEME_CHANGED = 'snaglet:workspace-theme';
let loading: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();
// This window's picks and resets, so a slow first load cannot paint over them.
let edited: ColorPatch = {};
let saveError = '';
const emit = () => window.dispatchEvent(new Event(THEME_CHANGED));
export const getThemeSaveError = () => saveError;
export function subscribeTheme(listener: () => void) {
  window.addEventListener(THEME_CHANGED, listener);
  return () => window.removeEventListener(THEME_CHANGED, listener);
}
// This window's saves not yet settled, and how many it has started. A theme
// change heard meanwhile (often this window's own save echoing back) is read
// only once they settle, so an older saved color never paints over a newer pick.
// The first load defers refreshes the same way.
let initializing = false;
let pendingSaves = 0;
let savesStarted = 0;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
/** The derived tokens the stylesheet ships, for the default palette. */
const DEFAULT_DERIVED = deriveThemeTokens(defaultTheme);
const DERIVED_PROPERTIES = [
  'on-selected',
  'accent-on-selected',
  'hover-mix',
  'hover-mix-soft',
] as const;
/**
 * Re-derive the tokens the stylesheet computes from the palette (text on
 * Selected, the hover tints, `color-scheme`) for the colors on screen now: an
 * inline value where they differ from the shipped default, none where they
 * match. So a saved light theme gets dark text on its highlights and the
 * default theme leaves the root element's style clean.
 */
function applyDerived(style: CSSStyleDeclaration) {
  const palette = Object.fromEntries(
    THEME_TOKEN_KEYS.map((key) => {
      const inline = style.getPropertyValue(`--${key}`).trim();
      return [key, /^#[0-9a-f]{6}$/i.test(inline) ? inline : defaultTheme[key]];
    })
  ) as Record<ThemeTokenKey, string>;
  const derived: DerivedThemeTokens = deriveThemeTokens(palette);
  for (const name of DERIVED_PROPERTIES)
    if (derived[name] === DEFAULT_DERIVED[name]) style.removeProperty(`--${name}`);
    else style.setProperty(`--${name}`, derived[name]);
  if (derived['color-scheme'] === DEFAULT_DERIVED['color-scheme'])
    style.removeProperty('color-scheme');
  else style.setProperty('color-scheme', derived['color-scheme']);
}
/** Set each color as an inline override; a null drops it, showing the stylesheet default. */
function apply(colors: ColorPatch) {
  const style = document.documentElement.style;
  for (const [name, color] of Object.entries(colors))
    if (color) style.setProperty(`--${name}`, color);
    else style.removeProperty(`--${name}`);
  applyDerived(style);
  emit();
}
/** Show exactly the saved theme: saved tokens set, every other token back to the stylesheet default. */
function applySaved(saved: Record<string, string>) {
  const style = document.documentElement.style;
  let changed = false;
  for (const name of Object.keys(defaultWorkspaceColors)) {
    const property = `--${name}`;
    const color = saved[name] ?? '';
    if (style.getPropertyValue(property).trim() === color) continue;
    changed = true;
    if (color) style.setProperty(property, color);
    else style.removeProperty(property);
  }
  if (!changed) return;
  applyDerived(style);
  emit();
}
export function initializeWorkspaceTheme(): Promise<void> {
  if (!loading) {
    const inline = Object.fromEntries(
      Object.keys(defaultWorkspaceColors).flatMap((name) => {
        const value = document.documentElement.style.getPropertyValue(`--${name}`).trim();
        return /^#[0-9a-f]{6}$/i.test(value) ? [[name, value]] : [];
      })
    );
    initializing = true;
    loading = settingsApi
      .list()
      .then(async (rows) => {
        const row = rows.find((r) => r.category === 'appearance' && r.key === 'colors');
        const colors = row ? readSavedWorkspaceColors(row.value) : {};
        const previousPageColors = row ? {} : inline;
        apply({ ...colors, ...previousPageColors, ...edited });
        if (!row && Object.keys(previousPageColors).length)
          await setWorkspaceColors(
            Object.fromEntries(
              Object.entries({ ...previousPageColors, ...edited }).filter(
                (entry): entry is [string, string] => entry[1] !== null
              )
            )
          );
      })
      .catch(() => {
        loading = null;
        saveError =
          'Unable to load the saved workspace theme. Your current colors are still visible.';
        emit();
      })
      .finally(() => {
        initializing = false;
        runDeferredRefresh();
      });
  }
  return loading;
}
/**
 * Re-read the saved palette (`GET /api/settings/appearance/colors`) and show
 * it (never writes): on every socket (re)open, on a theme change from
 * elsewhere, and in windows that outlive theme edits. A good read also clears
 * a load or save error, since the page now shows the saved theme. Calls that
 * land while one is reading, while the first load runs, or while this
 * window's saves are pending collapse into one more read after them.
 */
export function refreshWorkspaceTheme(): Promise<void> {
  if (initializing || pendingSaves > 0 || refreshing) {
    refreshAgain = true;
    return refreshing ?? Promise.resolve();
  }
  const started = savesStarted;
  refreshing = settingsApi
    .get('appearance', 'colors')
    .then((setting) => {
      // A pick made while this read was out may be newer than what it returned.
      if (started !== savesStarted) {
        refreshAgain = true;
        return;
      }
      applySaved(readSavedWorkspaceColors(setting.value));
      if (saveError) {
        saveError = '';
        emit();
      }
    })
    // Keep the colors already applied; the next change or reconnect reads again.
    .catch((err: unknown) => console.debug('[theme] could not re-read the saved theme', err))
    .finally(() => {
      refreshing = null;
      runDeferredRefresh();
    });
  return refreshing;
}
function runDeferredRefresh() {
  if (!refreshAgain || initializing || pendingSaves > 0 || refreshing) return;
  refreshAgain = false;
  void refreshWorkspaceTheme();
}
export async function setWorkspaceColors(value: Record<string, string>): Promise<void> {
  await saveColors(parseWorkspaceColors(value));
}
/**
 * Put tokens back to the shipped default (every token when `names` is left
 * out): their inline overrides go at once and the save removes them from the
 * saved theme, so they follow the stylesheet default, including a later change
 * to it. The Theme view's "Reset all" and ↺ buttons call this.
 */
export async function resetWorkspaceColors(names?: readonly string[]): Promise<void> {
  await saveColors(workspaceColorResetPatch(names));
}
export const resetWorkspaceTheme = () => resetWorkspaceColors();
/**
 * Show `patch` now and merge it into the saved theme (`PATCH`, null removes)
 * after earlier saves. An empty patch changes nothing and sends nothing.
 */
async function saveColors(patch: ColorPatch): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  edited = { ...edited, ...patch };
  apply(patch);
  pendingSaves += 1;
  savesStarted += 1;
  // Serialize writes so a slow earlier color choice cannot replace a newer one.
  queue = queue
    .then(async () => {
      await settingsApi.patch('appearance', 'colors', patch);
      saveError = '';
      emit();
    })
    .catch(() => {
      saveError =
        'Colors changed on this page but could not be saved or shared with agents. Please try again.';
      emit();
    })
    .then(() => {
      pendingSaves -= 1;
      runDeferredRefresh();
    });
  await queue;
}
