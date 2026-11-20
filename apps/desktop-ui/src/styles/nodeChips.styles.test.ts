import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, mixHex } from '@desktop/features/calendar/calendarColors';

const source = readFileSync(resolve(process.cwd(), 'src/styles/globals/_node-chips.scss'), 'utf8');
// The color layer is @snaglet/theme's generated tokens.scss.
const tokens = readFileSync(resolve(process.cwd(), '../../packages/theme/tokens.scss'), 'utf8');

/** The stylesheet without comments, so only real declarations are checked. */
const rules = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The declarations of the first top-level rule for `selector`. */
function block(selector: string): string {
  const start = rules.search(new RegExp(`^${selector.replace(/[.-]/g, '\\$&')}\\s*\\{`, 'm'));
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return rules.slice(start, rules.indexOf('\n}', start));
}

/** A default theme token as a hex color, following `var(--…)` aliases. */
function tokenHex(name: string): string {
  const value = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm').exec(tokens)?.[1]?.trim();
  if (!value) throw new Error(`--${name} is not declared`);
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const alias = /^var\(--([a-z0-9-]+)/.exec(value)?.[1];
  if (!alias) throw new Error(`--${name} is neither a hex nor an alias: ${value}`);
  return tokenHex(alias);
}

/** Every kind rule: its selectors, the accent token and the label's accent share. */
const kinds = [...rules.matchAll(/^((?:\.md-chip-[a-z_]+,\s*)*\.md-chip-[a-z_]+)\s*\{([^}]*)\}/gm)]
  .map(([, selectors, body]) => ({
    selectors: selectors?.replace(/\s+/g, ' ') ?? '',
    accent: /--md-chip-color:\s*var\(--([a-z0-9-]+)/.exec(body ?? '')?.[1],
    share: Number(/--md-chip-ink-share:\s*(\d+)%/.exec(body ?? '')?.[1] ?? 50),
  }))
  .filter(
    (kind): kind is { selectors: string; accent: string; share: number } =>
      kind.accent !== undefined && kind.accent !== 'color-text-subtle'
  );

// The surfaces a chip sits on: doc body / menus, form fields, panels, the
// sidebar and the status strip, in the default theme.
const SURFACES = ['background', 'raised', 'field', 'foreground', 'sidebar', 'status-bar'];
// The rest tint (`--chip-bg-tint`) and the hover tint.
const TINTS = [0.12, 0.22];

describe('node chip label color', () => {
  it("inks every chip's label from its kind accent, toward the text color", () => {
    expect(block('.md-chip')).toMatch(
      /color: var\(\s*--md-chip-text,\s*color-mix\(\s*in srgb,\s*var\(--md-chip-color, var\(--color-primary\)\) var\(--md-chip-ink-share, 50%\),\s*var\(--color-text\)\s*\)\s*\);/
    );
    expect(kinds.map((kind) => kind.selectors)).toEqual(
      expect.arrayContaining(['.md-chip-page, .md-chip-doc, .md-chip-block', '.md-chip-agent'])
    );
  });

  it('reads at 4.5:1 or better on its own tint, at rest and on hover, for every kind', () => {
    const text = tokenHex('color-text');
    const all = [...kinds, { selectors: '.md-chip (no kind)', accent: 'color-primary', share: 50 }];
    for (const kind of all) {
      const accent = tokenHex(kind.accent);
      const ink = mixHex(accent, text, 1 - kind.share / 100);
      for (const surface of SURFACES) {
        for (const tint of TINTS) {
          const background = mixHex(tokenHex(surface), accent, tint);
          expect(
            contrastRatio(ink, background),
            `${kind.selectors} on ${surface} at ${tint * 100}% tint`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps dead and archived references muted', () => {
    expect(block('.md-chip-unavailable')).toContain('--md-chip-text: var(--md-chip-color);');
    expect(block('.md-chip-archived')).toContain('--md-chip-text: var(--md-chip-color);');
  });

  it('keeps the action bar out of sight and out of the line until the chip is engaged', () => {
    const bar = block('.md-chip-actions');
    // Floats over the line above: showing it never widens the chip.
    expect(bar).toMatch(/position: absolute;/);
    expect(bar).toMatch(/bottom: calc\(100% - 1px\);/);
    // Hidden at rest, unclickable, so no stray click lands on remove.
    expect(bar).toMatch(/opacity: 0;/);
    expect(bar).toMatch(/visibility: hidden;/);
    expect(bar).toMatch(/pointer-events: none;/);
    // The chip anchors it and does not clip it.
    expect(block('.md-chip')).toMatch(/position: relative;/);
    expect(block('.md-chip')).not.toMatch(/overflow: hidden;/);
    // Hover, keyboard focus (on the chip or a control in it) and an editor
    // node selection each bring it up.
    const shown = rules.slice(rules.indexOf('.md-chip:hover > .md-chip-actions'));
    expect(shown).toMatch(
      /^\.md-chip:hover > \.md-chip-actions,\s*\.md-chip:focus-visible > \.md-chip-actions,\s*\.md-chip:has\(:focus-visible\) > \.md-chip-actions,\s*\.md-chip\[data-chip-selected='true'\] > \.md-chip-actions,\s*\.md-chip\.ProseMirror-selectednode > \.md-chip-actions,\s*\.ProseMirror-selectednode > \.md-chip > \.md-chip-actions \{\s*opacity: 1;\s*visibility: visible;\s*pointer-events: auto;/
    );
  });

  it('shows the copy and remove marks as live controls, full strength on hover or focus', () => {
    for (const selector of [
      '.md-chip-copy',
      '.md-chip-copy.md-chip-copy-compact',
      '.md-chip-remove',
      '.md-chip-remove.md-chip-remove-compact',
    ]) {
      const body = block(selector);
      expect(body, selector).toMatch(/^\s{2}opacity: 0\.8;/m);
      expect(body, selector).toMatch(/&:hover,\s*&:focus-visible\s*\{\s*opacity: 1;/);
    }
  });
});
