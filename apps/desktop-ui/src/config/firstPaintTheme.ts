// Build-time: index.html's first paint. The stylesheets reach the page after
// the HTML (in dev, only once the scripts run), and until then the window shows
// the browser's own white canvas. This plugin puts the default theme's canvas
// color, text color and color scheme into index.html's <head> so the very
// first frame is already in the default theme (Soft Pastel Garden), with no
// flash of white or of a light theme. A saved theme still applies when the
// app loads it.
import { defaultTheme, deriveThemeTokens } from '@snaglet/theme';
import type { HtmlTagDescriptor, Plugin } from 'vite';

/** The CSS for the first frame: the page canvas as the stylesheet paints `body` (--disabled). */
export function firstPaintCss(): string {
  const scheme = deriveThemeTokens(defaultTheme)['color-scheme'];
  return (
    `html{background:${defaultTheme.disabled};color:${defaultTheme.text};` +
    `color-scheme:${scheme}}`
  );
}

/** The tags index.html gains, first thing in its <head>. */
export function firstPaintTags(): HtmlTagDescriptor[] {
  const scheme = deriveThemeTokens(defaultTheme)['color-scheme'];
  return [
    {
      tag: 'meta',
      attrs: { name: 'color-scheme', content: scheme },
      injectTo: 'head-prepend',
    },
    {
      tag: 'style',
      attrs: { id: 'snaglet-first-paint' },
      children: firstPaintCss(),
      injectTo: 'head-prepend',
    },
  ];
}

export const firstPaintTheme = (): Plugin => ({
  name: 'snaglet-first-paint-theme',
  transformIndexHtml: () => firstPaintTags(),
});
