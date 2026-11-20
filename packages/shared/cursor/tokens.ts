/** Theme token names (see constants/workspaceTheme.ts) the flower may use per role. */

export const PETAL_TOKENS = [
  'detail',
  'detail-2',
  'chrome',
  'selected',
  'sidebar',
  'field',
  'foreground',
  'color-container-project',
  'color-container-default',
  'color-node-thread',
  'agent',
  'color-node-tool',
  'color-node-memory',
  'color-node-image',
] as const;

export const CENTER_TOKENS = [
  'activity-bar',
  'status-bar',
  'foreground',
  'background',
  'raised',
  'color-node-tool',
  'color-container-default',
  'agent',
  'selected',
  'disabled',
] as const;

/** Eyes, mouth and brows. */
export const FEATURE_TOKENS = ['text', 'border', 'text-muted', 'detail'] as const;

export const CHEEK_TOKENS = [
  'detail',
  'detail-2',
  'color-node-thread',
  'selected',
  'chrome',
  'color-node-image',
] as const;

export const OUTLINE_TOKENS = ['border', 'text', 'text-muted'] as const;

/** Every token name usable in a spec or as a fallback in the contrast guard. */
export const ALL_THEME_TOKENS = [
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
  'color-node-thread',
  'agent',
  'color-node-tool',
  'color-node-memory',
  'color-node-image',
] as const;

export type ThemeToken = (typeof ALL_THEME_TOKENS)[number];

const TOKEN_SET: ReadonlySet<string> = new Set(ALL_THEME_TOKENS);

export function isThemeToken(value: unknown): value is ThemeToken {
  return typeof value === 'string' && TOKEN_SET.has(value);
}
