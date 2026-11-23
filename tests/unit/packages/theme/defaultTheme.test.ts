/**
 * @snaglet/theme: the default theme is Soft Pastel Garden exactly as specified,
 * its generated files match the source, its keys are the app's theme keys, and
 * the default palette (with its derived tokens) keeps text and controls
 * readable.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  contrastRatio,
  DEFAULT_THEME_NAME,
  defaultTheme,
  deriveThemeTokens,
  mixHex,
  TEXT_CONTRAST,
  THEME_TOKEN_KEYS,
  UI_CONTRAST,
  type ThemePalette,
} from '@snaglet/theme';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';
import { renderThemeFiles, staleThemeFiles } from '../../../../packages/theme/scripts/generate';

const PACKAGE_DIR = path.resolve(__dirname, '../../../../packages/theme');

/** Soft Pastel Garden (dark mode), value for value as specified. */
const SPEC: Record<string, string> = {
  // Base
  background: '#0A0A0A',
  foreground: '#1A1A1A',
  text: '#F5F5F5',
  'text-muted': '#A1A1A1',
  field: '#1E1E1E',
  raised: '#1A1A1A',
  chrome: '#0F0F0F',
  sidebar: '#0F0F0F',
  'activity-bar': '#0F0F0F',
  'status-bar': '#0F0F0F',
  disabled: '#2A2A2A',
  // Accents
  detail: '#E291B5',
  'detail-2': '#D4A5D6',
  selected: '#F5B398',
  line: '#F5D5E8',
  border: '#E291B5',
  // Node colors
  'color-node-doc': '#9ED4D1',
  'color-node-thread': '#F5B398',
  'color-node-tool': '#E8C4A6',
  'color-node-memory': '#D4A5D6',
  'color-node-image': '#F5B398',
  agent: '#E291B5',
  // Container colors
  'color-container-project': '#B8E6D5',
  'color-container-default': '#D4E8E1',
};

/** The light palette Snaglet shipped before Soft Pastel Garden. */
const SAGE: ThemePalette = {
  disabled: '#e6e9df',
  background: '#fffdf7',
  foreground: '#f1f3e9',
  'activity-bar': '#d8e3cf',
  sidebar: '#e8efdf',
  'status-bar': '#d8e3cf',
  raised: '#ffffff',
  chrome: '#dce7d3',
  field: '#f5f5eb',
  selected: '#f2cfb8',
  text: '#30392d',
  'text-muted': '#59664f',
  line: '#d5ddcb',
  border: '#8b9c7b',
  detail: '#a54e32',
  'detail-2': '#526d47',
  'color-container-project': '#678353',
  'color-container-default': '#98ab7d',
  'color-node-doc': '#4d7b82',
  'color-node-thread': '#ad4d4c',
  agent: '#aa91b6',
  'color-node-tool': '#977229',
  'color-node-memory': '#91769f',
  'color-node-image': '#bd754e',
};

describe('the default theme', () => {
  it('is Soft Pastel Garden, every value exactly as specified', () => {
    expect(DEFAULT_THEME_NAME).toBe('Soft Pastel Garden');
    expect(Object.keys(defaultTheme).sort()).toEqual(Object.keys(SPEC).sort());
    for (const [key, value] of Object.entries(SPEC))
      expect({ key, value: defaultTheme[key as keyof ThemePalette] }).toEqual({
        key,
        value: value.toLowerCase(),
      });
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(defaultTheme)).toBe(true);
  });

  it('uses the app’s theme keys: the Theme view’s colors, in its order', () => {
    expect([...THEME_TOKEN_KEYS]).toEqual(workspaceColorTokens.map((token) => token.name));
    expect(Object.fromEntries(workspaceColorTokens.map((t) => [t.name, t.defaultValue]))).toEqual({
      ...defaultTheme,
    });
  });
});

describe('generated files', () => {
  it('match src/ (run `pnpm --filter @snaglet/theme generate` when this fails)', () => {
    expect(staleThemeFiles()).toEqual([]);
  });

  it('write defaultTheme.json as a flat, sorted map with 2-space indent and a final newline', () => {
    const text = readFileSync(path.join(PACKAGE_DIR, 'defaultTheme.json'), 'utf8');
    const json = JSON.parse(text) as Record<string, string>;
    expect(json).toEqual({ ...defaultTheme });
    expect(Object.keys(json)).toEqual([...THEME_TOKEN_KEYS].sort());
    expect(text).toBe(`${JSON.stringify(json, null, 2)}\n`);
  });

  it('declare every palette color and the derived tokens in theme.css and tokens.scss', () => {
    const files = renderThemeFiles();
    const derived = deriveThemeTokens(defaultTheme);
    for (const file of ['theme.css', 'tokens.scss']) {
      const css = files[file]!;
      for (const key of THEME_TOKEN_KEYS)
        expect(css).toContain(`  --${key}: ${defaultTheme[key]};`);
      expect(css).toContain(`  --on-selected: ${derived['on-selected']};`);
      expect(css).toContain(`  --hover-mix: ${derived['hover-mix']};`);
      expect(css).toContain(`  color-scheme: ${derived['color-scheme']};`);
      expect(css).toContain('  --color-on-selected: var(--on-selected);');
    }
    expect(files['tokens.scss']).toContain(`$default-theme: (`);
  });

  it('ship as a publishable package with no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      private: boolean;
      license: string;
      dependencies?: object;
      exports: Record<string, unknown>;
      files: string[];
    };
    // Every workspace package carries the release version (pnpm version:set).
    const root = JSON.parse(
      readFileSync(path.join(PACKAGE_DIR, '..', '..', 'package.json'), 'utf8')
    ) as { version: string };
    expect(pkg).toMatchObject({
      name: '@snaglet/theme',
      version: root.version,
      private: true,
      license: 'MIT',
    });
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.exports)).toEqual(
      expect.arrayContaining(['.', './theme.css', './tokens.scss', './defaultTheme.json'])
    );
    for (const file of Object.keys(renderThemeFiles())) expect(pkg.files).toContain(file);
  });
});

describe('derived tokens', () => {
  it('put dark text on Selected and a quiet hover tint in the dark default', () => {
    expect(deriveThemeTokens(defaultTheme)).toEqual({
      'on-selected': 'var(--background)',
      'accent-on-selected': 'var(--on-selected)',
      'hover-mix': '18%',
      'hover-mix-soft': '13%',
      'color-scheme': 'dark',
    });
  });

  it('keep a light palette as it looked before (text on Selected, the full 58 % hover)', () => {
    expect(deriveThemeTokens(SAGE)).toEqual({
      'on-selected': 'var(--text)',
      'accent-on-selected': 'var(--detail)',
      'hover-mix': '58%',
      'hover-mix-soft': '42%',
      'color-scheme': 'light',
    });
  });
});

describe('default theme contrast (WCAG)', () => {
  const t = defaultTheme;
  const derived = deriveThemeTokens(t);
  const onSelected = derived['on-selected'] === 'var(--background)' ? t.background : t.text;
  const hover = mixHex(t.selected, parseInt(derived['hover-mix'], 10) / 100, t.raised);
  const surfaces = [
    'background',
    'foreground',
    'field',
    'raised',
    'chrome',
    'sidebar',
    'activity-bar',
    'status-bar',
  ] as const;

  it.each(surfaces)('text and muted text read on %s', (surface) => {
    expect(contrastRatio(t.text, t[surface])).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrastRatio(t['text-muted'], t[surface])).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it('text and muted text read on a hovered row', () => {
    expect(contrastRatio(t.text, hover)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrastRatio(t['text-muted'], hover)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it('text reads on Selected highlights, secondary text too', () => {
    expect(contrastRatio(onSelected, t.selected)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    const onSelectedMuted = mixHex(onSelected, 0.72, t.selected);
    expect(contrastRatio(onSelectedMuted, t.selected)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it('accent glyphs on Selected fall back to the on-Selected text where Detail would not show', () => {
    expect(contrastRatio(t.detail, t.selected)).toBeLessThan(UI_CONTRAST);
    expect(derived['accent-on-selected']).toBe('var(--on-selected)');
  });

  it('text reads on accent buttons (the background color on Detail)', () => {
    expect(contrastRatio(t.background, t.detail)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it('links and accents read on the work surfaces', () => {
    for (const surface of ['background', 'foreground', 'field'] as const)
      expect(contrastRatio(t.detail, t[surface])).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  });

  it('focus outlines, strong borders and icons stand out at 3:1 or better', () => {
    for (const surface of ['background', 'sidebar', 'activity-bar', 'chrome'] as const) {
      expect(contrastRatio(t.detail, t[surface])).toBeGreaterThanOrEqual(UI_CONTRAST);
      expect(contrastRatio(t.border, t[surface])).toBeGreaterThanOrEqual(UI_CONTRAST);
      expect(contrastRatio(t['detail-2'], t[surface])).toBeGreaterThanOrEqual(UI_CONTRAST);
      for (const key of THEME_TOKEN_KEYS.filter((k) => /^color-(node|container)-|^agent$/.test(k)))
        expect(contrastRatio(t[key], t[surface])).toBeGreaterThanOrEqual(UI_CONTRAST);
    }
  });
});
