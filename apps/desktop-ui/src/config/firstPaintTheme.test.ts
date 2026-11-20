import { describe, expect, it } from 'vitest';
import { defaultTheme } from '@snaglet/theme';
import { firstPaintCss, firstPaintTags, firstPaintTheme } from './firstPaintTheme';

describe('first paint', () => {
  it('paints the default theme before any stylesheet: its canvas, text and dark scheme', () => {
    expect(firstPaintCss()).toBe(
      `html{background:${defaultTheme.disabled};color:${defaultTheme.text};color-scheme:dark}`
    );
    expect(defaultTheme.disabled).toBe('#2a2a2a');
  });

  it('puts the tags first in index.html’s head', () => {
    const tags = firstPaintTags();
    expect(tags.map((tag) => [tag.tag, tag.injectTo])).toEqual([
      ['meta', 'head-prepend'],
      ['style', 'head-prepend'],
    ]);
    expect(tags[0]?.attrs).toEqual({ name: 'color-scheme', content: 'dark' });
    expect(tags[1]?.children).toBe(firstPaintCss());
  });

  it('is a Vite plugin that transforms index.html', () => {
    const plugin = firstPaintTheme();
    expect(plugin.name).toBe('snaglet-first-paint-theme');
    expect(typeof plugin.transformIndexHtml).toBe('function');
  });
});
