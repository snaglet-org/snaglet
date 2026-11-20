// Theme guard: text on a solid Selected fill uses the on-Selected roles.
//
// `--color-selected` (and `--color-primary-bg`, its alias) is a solid, light
// fill in the default palette. The accent (`--color-primary`) reads at about
// 1.3:1 on it and body text at about 1.6:1, so a rule that paints the fill
// must ink its text with the on-Selected roles, which the theme derives to
// read on any palette (`deriveThemeTokens` in @snaglet/theme): the
// `theme-on-selected` / `theme-selected-surface` mixins, a `tree-row-*` mixin,
// or `--color-on-selected`, `--color-on-selected-muted` and
// `--color-primary-on-selected` directly. A hover or focus variant nested in
// such a rule inherits its ink. Fills with no text on them are listed in
// TEXTLESS_FILLS, each with a reason.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@desktop/features/calendar/calendarColors';

const REPO_ROOT = resolve(process.cwd(), '../..');
const SCAN_ROOTS = ['apps/desktop-ui/src', 'packages/ui'];

// Fills that carry no text, keyed `file → selector`.
const TEXTLESS_FILLS = new Map<string, string>([
  [
    'apps/desktop-ui/src/pages/Dashboard/chrome/PaneChrome/PaneChrome.module.scss → .zone',
    'The drag-over drop zone: an empty tinted box over the pane.',
  ],
  [
    'apps/desktop-ui/src/pages/Dashboard/layout/PaneLayout.module.scss → &:hover,\n  &:focus-visible,\n  &[data-resize-handle-active]',
    'A split resize handle lit while hovered or dragged: a thin bar with no label.',
  ],
  [
    'apps/desktop-ui/src/features/rich-markdown/editor/ChipNodeView.module.scss → .imageCardImg',
    'The image card picture box, painted behind the image while it loads.',
  ],
]);

const SOLID_SELECTED = /^background(?:-color)?\s*:\s*var\(--color-(?:selected|primary-bg)\s*[,)]/;
const ON_SELECTED_INK = /var\(--color-(?:on-selected|on-selected-muted|primary-on-selected)\)/;
const INKING_MIXIN =
  /^@include\s+(?:theme-on-selected|theme-selected-surface|tree-row-active|tree-row-selected|-on-selected)\b/;
const TEXT_COLOR = /^color\s*:\s*(.+)$/;
const NEUTRAL_COLOR = /^(?:inherit|currentcolor|transparent)$/i;

interface Block {
  selector: string;
  body: string[];
  parent: Block | null;
}

const collectScss = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectScss(full, out);
    else if (entry.endsWith('.scss')) out.push(full);
  }
  return out;
};

// Comments and data-URI payloads must not reach the brace walker.
const stripNoise = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\((["']?)[\s\S]*?\1\)/g, 'url()')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every `{ … }` block with its own statements (not its nested blocks'). */
function parseBlocks(source: string): Block[] {
  const src = stripNoise(source);
  const blocks: Block[] = [];
  const stack: Block[] = [];
  let buffer = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '#' && src[i + 1] === '{') {
      // Interpolation: copy `#{…}` whole so its braces don't open a block.
      const end = src.indexOf('}', i);
      buffer += src.slice(i, end + 1);
      i = end;
    } else if (ch === '{') {
      const block: Block = {
        selector: buffer.trim(),
        body: [],
        parent: stack[stack.length - 1] ?? null,
      };
      blocks.push(block);
      stack.push(block);
      buffer = '';
    } else if (ch === '}') {
      if (buffer.trim()) stack[stack.length - 1]?.body.push(buffer.trim());
      stack.pop();
      buffer = '';
    } else if (ch === ';') {
      if (buffer.trim()) stack[stack.length - 1]?.body.push(buffer.trim());
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return blocks;
}

const paintsSelected = (block: Block) => block.body.some((s) => SOLID_SELECTED.test(s));
const textColor = (block: Block) =>
  block.body
    .map((s) => TEXT_COLOR.exec(s)?.[1]?.trim())
    .filter((v): v is string => v !== undefined)
    .pop();
const inksOnSelected = (block: Block) =>
  block.body.some((s) => INKING_MIXIN.test(s)) || ON_SELECTED_INK.test(textColor(block) ?? '');
const inKeyframes = (block: Block): boolean =>
  block.parent !== null &&
  (block.parent.selector.startsWith('@keyframes') || inKeyframes(block.parent));
const ancestors = (block: Block): Block[] =>
  block.parent ? [block.parent, ...ancestors(block.parent)] : [];

interface Offender {
  where: string;
  problem: string;
}

// The TEXTLESS_FILLS entries the scan met, so a stale one fails.
const usedExceptions = new Set<string>();

function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of collectScss(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      for (const block of parseBlocks(readFileSync(file, 'utf8'))) {
        if (!paintsSelected(block) || inKeyframes(block)) continue;
        const where = `${rel} → ${block.selector}`;
        const color = textColor(block);
        if (color && !ON_SELECTED_INK.test(color) && !NEUTRAL_COLOR.test(color)) {
          offenders.push({ where, problem: `inks its text with ${color}` });
          continue;
        }
        if (inksOnSelected(block) || ancestors(block).some(inksOnSelected)) continue;
        if (TEXTLESS_FILLS.has(where)) {
          usedExceptions.add(where);
          continue;
        }
        offenders.push({ where, problem: 'leaves its text in the ink of the surface around it' });
      }
    }
  }
  return offenders;
}

const HOW_TO_FIX = [
  'A rule paints the solid Selected fill but its text is not on-Selected ink.',
  'Accent and body text read at about 1.3:1 and 1.6:1 on Selected in the default palette.',
  'Fix: @include theme-on-selected (or theme-selected-surface) in the rule, or ink the',
  'text with --color-on-selected / --color-on-selected-muted (an accent glyph or badge:',
  '--color-primary-on-selected). A hover with no fill change belongs on --color-hover.',
  'A fill with no text on it goes in TEXTLESS_FILLS in this file, with a reason.',
].join('\n');

const tokens = readFileSync(join(REPO_ROOT, 'packages/theme/tokens.scss'), 'utf8');
/** A default-theme palette color as hex, following `var(--…)` aliases. */
function tokenHex(name: string): string {
  const value = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm').exec(tokens)?.[1]?.trim();
  if (!value) throw new Error(`--${name} is not declared`);
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
  if (!alias) throw new Error(`--${name} is neither a hex nor a plain alias: ${value}`);
  return tokenHex(alias);
}

const source = (file: string) =>
  stripNoise(readFileSync(join(REPO_ROOT, 'apps/desktop-ui/src', file), 'utf8'));

describe('theme guard: text on the Selected fill', () => {
  it('inks every Selected fill with the on-Selected roles', () => {
    const offenders = findOffenders();
    const report = offenders.map((o) => `${o.where.replace(/\s+/g, ' ')}  ${o.problem}`);
    expect(offenders, `${HOW_TO_FIX}\n\n${report.join('\n')}`).toEqual([]);
    // Every exception still names a rule that exists, and each has a reason.
    expect([...TEXTLESS_FILLS.keys()].filter((key) => !usedExceptions.has(key))).toEqual([]);
    for (const reason of TEXTLESS_FILLS.values()) expect(reason.length).toBeGreaterThan(30);
  });

  it('measures the problem it guards: plain accent ink is unreadable on Selected', () => {
    const selected = tokenHex('selected');
    expect(contrastRatio(tokenHex('color-primary'), selected)).toBeLessThan(1.5);
    expect(contrastRatio(tokenHex('color-on-selected'), selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenHex('color-primary-on-selected'), selected)).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it('flags a fill inked with the accent and a fill with no ink, and passes a mixin', () => {
    const flagged = (scss: string) =>
      parseBlocks(scss).filter(
        (b) =>
          paintsSelected(b) &&
          (!inksOnSelected(b) || !ON_SELECTED_INK.test(textColor(b) ?? 'var(--color-on-selected)'))
      ).length;
    expect(flagged('.a { background: var(--color-selected); color: var(--color-primary); }')).toBe(
      1
    );
    expect(flagged('.a { background: var(--color-primary-bg, var(--color-hover)); }')).toBe(1);
    expect(
      flagged('.a { background: var(--color-selected); @include theme-on-selected; &:x{a:b} }')
    ).toBe(0);
    expect(parseBlocks('.a { &#{&}:focus { color: red; } }').map((b) => b.selector)).toEqual([
      '.a',
      '&#{&}:focus',
    ]);
  });

  // Children of a Selected surface that keep their own accent rules.
  it('re-inks accent text inside selected tree rows and the pressed md / txt pill', () => {
    const tree = stripNoise(
      readFileSync(join(REPO_ROOT, 'packages/ui/styles/abstracts/_tree.scss'), 'utf8')
    );
    const onSelected = tree.slice(tree.indexOf('@mixin -on-selected'));
    expect(onSelected).toMatch(
      /> \* \{\s*--color-primary: var\(--color-primary-on-selected\);\s*--color-primary-border: var\(--color-primary-on-selected\);/
    );
    const toggle = source('components/MarkdownTextToggle/MarkdownTextToggle.module.scss');
    expect(toggle).toMatch(
      /\.toggle\[data-chrome='pill'\]\[aria-pressed='true'\]:not\(:disabled\),\s*\.toggle\[data-chrome='pill'\]:active:not\(:disabled\) \{[\s\S]*?\.active \{\s*color: var\(--color-primary-on-selected\);/
    );
  });
});
