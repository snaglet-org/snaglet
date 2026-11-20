// Theme guard — the token layer must be coherent.
//
// `var(--color-danger)` looks themed but does nothing if nothing declares
// `--color-danger`: the element silently falls back to inherited or initial.
// Scope: the theme namespaces in THEME_NAMESPACES. Component-scoped instance
// variables (--chip-fg, --md-chip-color, …) are declared by their component
// and are out of scope.
//
// KNOWN_ORPHANS is a ratchet so this test fails on new orphans. Shrink it,
// never grow it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';
import { defaultTheme, deriveThemeTokens, THEME_TOKEN_KEYS } from '@snaglet/theme';

const REPO_ROOT = resolve(process.cwd(), '../..');
// The color layer is @snaglet/theme's generated tokens.scss, which
// _tokens.scss loads; _tokens.scss declares everything else.
const TOKEN_FILES = ['packages/theme/tokens.scss', 'packages/ui/styles/_tokens.scss'];
const TOKENS_FILE = TOKEN_FILES.join(' + ');
const SCAN_ROOTS = ['apps/desktop-ui/src', 'packages/ui'];

const THEME_NAMESPACES = [
  '--color-',
  '--text-',
  '--radius-',
  '--letter-spacing-',
  '--scrollbar-',
  '--shadow-',
  '--font-',
  '--space-',
  '--density-',
  '--transition-',
  '--type-',
  '--msg-',
  '--leading-',
];

// Custom properties a component declares on itself and consumes locally.
const COMPONENT_SCOPED = new Set(['--chip-fg', '--chip-bg', '--chip-border']);

// Pre-existing orphans, recorded so new ones fail the build. Each of these
// renders as an invalid declaration today — worth fixing, but fixing them
// changes pixels, so they are tracked rather than silently repaired.
const KNOWN_ORPHANS = new Set([
  '--color-background-secondary',
  '--color-text-faint',
  '--color-primary-subtle',
  '--color-subtle',
  '--color-surface-overlay',
  '--color-text', // base palette declares --text, not --color-text
  '--color-text-muted', // ditto --text-muted
  '--color-text-secondary',
  '--radius-full', // --radius-pill is the real name
  '--space-1-5',
  '--space-2-5',
]);

// Tokens several call sites depend on without a hex fallback; these must stay
// declared.
const REQUIRED_TOKENS = [
  '--color-danger',
  '--color-danger-bg',
  '--color-accent',
  '--text-3xs',
  '--text-2xs',
  '--text-md',
  '--text-xl',
  '--text-2xl',
  '--letter-spacing-snug',
  '--letter-spacing-normal',
  '--letter-spacing-wide',
  '--letter-spacing-wider',
  '--letter-spacing-widest',
  '--scrollbar-size',
  '--scrollbar-thumb',
  '--scrollbar-thumb-hover',
  '--shadow-color',
];

const collectScss = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectScss(full, out);
    else if (entry.endsWith('.scss')) out.push(full);
  }
  return out;
};

const files = SCAN_ROOTS.flatMap((root) => collectScss(join(REPO_ROOT, root)));
const tokensSource = TOKEN_FILES.map((file) => readFileSync(join(REPO_ROOT, file), 'utf8')).join(
  '\n'
);

const declaredInTokens = new Set(
  [...tokensSource.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
);

const references = new Map<string, string[]>();
for (const file of files) {
  const rel = relative(REPO_ROOT, file);
  for (const match of readFileSync(file, 'utf8').matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    const name = match[1];
    references.set(name, [...(references.get(name) ?? []), rel]);
  }
}

describe('theme guard: token layer coherence', () => {
  it('declares every token the refactor introduced', () => {
    const missing = REQUIRED_TOKENS.filter((t) => !declaredInTokens.has(t));
    expect(
      missing,
      `These tokens are referenced across the app but no longer declared in ${TOKENS_FILE}. ` +
        'Removing one silently reverts every call site to an invalid declaration.'
    ).toEqual([]);
  });

  it('has no NEW theme tokens that are referenced but never declared', () => {
    const orphans = [...references.keys()]
      .filter((name) => THEME_NAMESPACES.some((ns) => name.startsWith(ns)))
      .filter((name) => !declaredInTokens.has(name))
      .filter((name) => !COMPONENT_SCOPED.has(name))
      .filter((name) => !KNOWN_ORPHANS.has(name))
      .sort();

    const detail = orphans
      .map((name) => `  ${name}  ← ${[...new Set(references.get(name))].join(', ')}`)
      .join('\n');

    expect(
      orphans,
      `var() references to theme tokens that nothing declares. The declaration is invalid ` +
        `at computed-value time, so the element silently inherits instead of being themed.\n` +
        `Either declare the token in ${TOKENS_FILE} (named for its ROLE) or point the call ` +
        `site at an existing role token.\n\n${detail}`
    ).toEqual([]);
  });

  it('keeps the known-orphan ratchet from growing', () => {
    // If you fix an orphan, delete it from KNOWN_ORPHANS so it can never
    // come back. This bound only ever moves down.
    expect(KNOWN_ORPHANS.size).toBeLessThanOrEqual(11);
  });

  it('ships the same default for every Theme view color as workspaceTheme.ts', () => {
    // The stylesheet paints a token nobody saved; the Theme view, Reset and
    // change_color_theme report workspaceTheme.ts. Both must name one palette.
    const mismatched = workspaceColorTokens.flatMap((token) => {
      const declared = new RegExp(`^\\s*--${token.name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm').exec(
        tokensSource
      )?.[1];
      return declared?.toLowerCase() === token.defaultValue.toLowerCase()
        ? []
        : [
            `--${token.name}: ${declared ?? 'not declared'} (workspaceTheme.ts ${token.defaultValue})`,
          ];
    });
    expect(mismatched).toEqual([]);
  });

  it("takes the app's default colors from @snaglet/theme, declared once", () => {
    const [themeSource, appSource] = TOKEN_FILES.map((file) =>
      readFileSync(join(REPO_ROOT, file), 'utf8')
    );
    // _tokens.scss loads the package's color layer and redeclares none of it.
    expect(appSource).toMatch(/^@use '@snaglet\/theme\/tokens\.scss';$/m);
    const themeNames = [...themeSource!.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    const appNames = new Set([...appSource!.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
    expect(themeNames.filter((name) => appNames.has(name))).toEqual([]);
    expect(appSource).not.toMatch(/^\s*--color-(?!.*shadow)[a-z-]+\s*:/m);
    // The effective defaults: every palette color and derived token as the package says.
    const declared = (name: string) =>
      new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(themeSource!)?.[1]?.trim();
    for (const key of THEME_TOKEN_KEYS)
      expect({ key, value: declared(`--${key}`) }).toEqual({ key, value: defaultTheme[key] });
    const derived = deriveThemeTokens(defaultTheme);
    expect(declared('--on-selected')).toBe(derived['on-selected']);
    expect(declared('--accent-on-selected')).toBe(derived['accent-on-selected']);
    expect(declared('--hover-mix')).toBe(derived['hover-mix']);
    expect(declared('--hover-mix-soft')).toBe(derived['hover-mix-soft']);
    expect(declared('color-scheme')).toBe(derived['color-scheme']);
  });

  it('aliases resolve to a role token rather than a literal', () => {
    for (const alias of ['--color-danger', '--color-accent']) {
      const declaration = new RegExp(`${alias}:\\s*([^;]+);`).exec(tokensSource)?.[1] ?? '';
      expect(declaration, `${alias} must point at another token, not a literal`).toMatch(/var\(--/);
    }
  });
});
