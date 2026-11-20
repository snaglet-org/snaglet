// Zoom guard: the UI zoom is CSS `zoom` on the root (zoomWindow.ts), and
// engines disagree on whether it scales `vw` / `vh` (standardized zoom does,
// Safari 17's WebKit does not, current WebKit skips grid tracks). So the app
// shell fills the window through `inset: 0` alone, and viewport units are
// never divided by the zoom level, only by the measured `--snaglet-viewport-zoom`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(process.cwd(), '../..');
const SCAN_ROOTS = ['apps/desktop-ui/src', 'packages/ui'];

const collectScss = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectScss(full, out);
    else if (entry.endsWith('.scss')) out.push(full);
  }
  return out;
};

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The `.shell` rule's own declarations, without its nested rules. */
const shellDeclarations = (): string => {
  const source = stripComments(
    readFileSync(resolve(process.cwd(), 'src/pages/Dashboard/Dashboard.module.scss'), 'utf8')
  );
  const start = source.indexOf('.shell {');
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let own = '';
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth === 0) break;
    if (depth === 1 && ch !== '{') own += ch;
  }
  return own;
};

const VIEWPORT_UNIT = /\d(?:vw|vh|dvh|svh|lvh|vmin|vmax)\b/;

describe('UI zoom and viewport units', () => {
  it('sizes the app shell with inset: 0, not viewport units', () => {
    const own = shellDeclarations();
    expect(own).toMatch(/\binset:\s*0\s*;/);
    expect(own).not.toMatch(/(^|[\s;])(width|height):/);
    expect(own).not.toMatch(VIEWPORT_UNIT);
  });

  it('never divides viewport units by the zoom level', () => {
    const dividedByLevel = /(?:vw|vh|dvh|svh|lvh)\s*\/\s*var\(\s*--snaglet-zoom\b/;
    const offenders = SCAN_ROOTS.flatMap((root) => collectScss(resolve(REPO_ROOT, root)))
      .filter((file) => dividedByLevel.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
