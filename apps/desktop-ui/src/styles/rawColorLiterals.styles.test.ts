// Theme guard — raw color literals must not appear in stylesheets.
//
// The theme is driven from the custom properties in
// `packages/ui/styles/_tokens.scss`. A hex / rgb() / hsl() literal in a module
// keeps its color whatever the theme says, so this test fails on them. Two
// explicit escape hatches: TOKEN_SOURCES (files that declare the palette) and
// DOCUMENTED_EXCEPTIONS (one-offs, each with a written reason).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(process.cwd(), '../..');

const SCAN_ROOTS = ['apps/desktop-ui/src', 'packages/ui'];

// Files that define the palette. Raw color belongs here and
// nowhere else.
const TOKEN_SOURCES = new Set(['packages/ui/styles/_tokens.scss']);

// Genuine one-offs. Each entry states why the literal cannot be a token.
const DOCUMENTED_EXCEPTIONS = new Map<string, string>([
  [
    'apps/desktop-ui/src/features/vision/VisionPreviewPanel.module.scss',
    'Letterbox behind a <video> element. Not a themed surface — it exists so ' +
      'the camera frame reads as a screen, and must stay near-black whatever ' +
      'the palette does.',
  ],
  [
    'apps/desktop-ui/src/pages/Dashboard/views/ProvidersView/ProvidersView.module.scss',
    'The single sanctioned `--prov-gold` literal. No gold role exists in the ' +
      'palette and the global warning token is the Detail accent, so Providers derives its ' +
      'whole caution ramp from this one declaration.',
  ],
]);

const HEX = /#[0-9a-fA-F]{3,8}\b/;
// A numeric first argument means a literal color. `rgb(var(--shadow-color) / 0.08)`
// reads its channels from a token and is fine.
const FUNCTIONAL = /\b(?:rgba?|hsla?)\(\s*[\d.]/;

const collectScss = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectScss(full, out);
    else if (entry.endsWith('.scss')) out.push(full);
  }
  return out;
};

// Comments and data-URI payloads legitimately mention colors.
const stripNoise = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\((["']?)[\s\S]*?\1\)/g, 'url()')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const findOffenders = (): { file: string; line: number; text: string }[] => {
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of collectScss(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      if (TOKEN_SOURCES.has(rel) || DOCUMENTED_EXCEPTIONS.has(rel)) continue;
      stripNoise(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          if (HEX.test(text) || FUNCTIONAL.test(text)) {
            offenders.push({ file: rel, line: index + 1, text: text.trim() });
          }
        });
    }
  }
  return offenders;
};

const HOW_TO_FIX = [
  'Raw color literals are not themeable — they ignore packages/ui/styles/_tokens.scss.',
  'Use a role token instead:',
  '  surfaces  --color-background / --color-surface-raised / --color-foreground / --color-field',
  '  text      --color-text / --color-text-muted / --color-text-subtle',
  '  lines     --color-border / --color-border-strong / --color-border-subtle',
  '  action    --color-primary / --color-accent / --color-selected',
  '  status    --color-success / --color-warning / --color-error / --color-danger',
  '  shadows   rgb(var(--shadow-color) / <alpha>)',
  'Need a shade of an existing role? color-mix(in srgb, var(--color-x) N%, transparent).',
  'No token fits? Add one to packages/ui/styles/_tokens.scss named for its ROLE',
  '(--color-surface-raised, never --beige-2), then point every call site at it.',
  'Genuinely un-themeable one-off? Add it to DOCUMENTED_EXCEPTIONS in this file',
  'with a written reason.',
].join('\n');

describe('theme guard: no raw color literals in stylesheets', () => {
  it('keeps every color in the app driven by a theme token', () => {
    const offenders = findOffenders();
    const report = offenders.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n');
    expect(offenders, `${HOW_TO_FIX}\n\nOffending declarations:\n${report}`).toEqual([]);
  });

  it('catches a hex literal, an rgba() literal and an hsl() literal', () => {
    // Guards the guard: proves the patterns actually fire.
    expect(HEX.test('color: #ff00aa;')).toBe(true);
    expect(FUNCTIONAL.test('box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);')).toBe(true);
    expect(FUNCTIONAL.test('background: hsl(320, 80%, 60%);')).toBe(true);
  });

  it('does not flag colors that read their channels from a token', () => {
    expect(FUNCTIONAL.test('box-shadow: 0 1px 2px rgb(var(--shadow-color) / 0.06);')).toBe(false);
    expect(HEX.test('background: color-mix(in srgb, var(--color-primary) 38%, transparent);')).toBe(
      false
    );
  });

  it('keeps the escape hatches small and explained', () => {
    expect(TOKEN_SOURCES.size).toBeLessThanOrEqual(3);
    expect(DOCUMENTED_EXCEPTIONS.size).toBeLessThanOrEqual(5);
    for (const [file, reason] of DOCUMENTED_EXCEPTIONS) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});
