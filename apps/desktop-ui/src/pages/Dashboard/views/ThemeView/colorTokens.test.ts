import { describe, expect, it } from 'vitest';
import { containerColorTokens } from './colorTokens';

describe('taxonomy color tokens', () => {
  it('keeps only project and plain-container colors', () => {
    expect(containerColorTokens.map((token) => token.name)).toEqual([
      'color-container-project',
      'color-container-default',
    ]);
    expect(containerColorTokens.map((token) => token.label)).not.toEqual(
      expect.arrayContaining(['Reference', 'Log'])
    );
  });
});

describe('base palette chrome tokens', () => {
  it('names the work surfaces Background / Foreground and gives each chrome region its own color', async () => {
    const { baseColorTokens } = await import('./colorTokens');
    const labels = Object.fromEntries(baseColorTokens.map((t) => [t.name, t.label]));
    expect(labels).toMatchObject({
      disabled: 'Disabled',
      background: 'Background',
      foreground: 'Foreground',
      'activity-bar': 'Activity Bar',
      sidebar: 'Sidebar',
      'status-bar': 'Status Bar',
    });
    expect(Object.values(labels)).not.toEqual(
      expect.arrayContaining(['Surface', 'Panel', 'Canvas'])
    );
    // Each region is its own token, so it can be recolored alone, even where
    // the default theme paints them alike.
    const names = baseColorTokens.map((t) => t.name);
    expect(names.filter((n) => ['activity-bar', 'sidebar', 'status-bar'].includes(n))).toEqual([
      'activity-bar',
      'sidebar',
      'status-bar',
    ]);
  });
});
