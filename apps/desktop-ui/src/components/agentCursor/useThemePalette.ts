import { useEffect, useState } from 'react';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';
import { subscribeTheme } from '@desktop/utils/workspaceTheme';

export type ThemePalette = Record<string, string>;

/**
 * Resolve every workspace token through `read` (a CSS custom property reader),
 * falling back to the token's default when the property is unset or empty.
 */
export function resolvePalette(read: (name: string) => string | null | undefined): ThemePalette {
  const palette: ThemePalette = {};
  for (const token of workspaceColorTokens) {
    const value = (read(`--${token.name}`) ?? '').trim();
    palette[token.name] = value || token.defaultValue;
  }
  return palette;
}

const samePalette = (a: ThemePalette, b: ThemePalette) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const readDocument = (): ThemePalette => {
  if (typeof document === 'undefined') return resolvePalette(() => '');
  const style = getComputedStyle(document.documentElement);
  return resolvePalette((name) => style.getPropertyValue(name));
};

/** The workspace palette as resolved CSS colors; updates when the theme changes. */
export function useThemePalette(): ThemePalette {
  const [palette, setPalette] = useState<ThemePalette>(readDocument);
  useEffect(() => {
    const refresh = () =>
      setPalette((prev) => {
        const next = readDocument();
        return samePalette(prev, next) ? prev : next;
      });
    refresh();
    return subscribeTheme(refresh);
  }, []);
  return palette;
}
