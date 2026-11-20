/**
 * Keeps the fluid surface zoom and the pane-responsive chat-message geometry
 * in _tokens.scss in agreement with their TypeScript mirror (typeScale.ts).
 * Parses _tokens.scss directly and checks every value against the mirror,
 * that type tokens are not stepped by pane width (the zoom already scales
 * them), and that geometry steps stay above their floors and move
 * monotonically as the pane narrows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fluidZoom,
  PANE_MSG_FLOORS,
  PANE_MSG_STEPS,
  PANE_MSG_TOKENS,
  PANE_MSG_UNITS,
  PANE_ZOOM,
  SIDEBAR_ZOOM,
  TYPE_SCALE,
  type PaneMsgToken,
} from './typeScale';

// Vitest runs with cwd at the desktop-ui package root. @snaglet/ui owns the
// canonical runtime tokens; the local _tokens.scss is only a forwarding shim.
const tokensScss = readFileSync(
  resolve(process.cwd(), '../../packages/ui/styles/_tokens.scss'),
  'utf8'
);
const paneChromeScss = readFileSync(
  resolve(process.cwd(), 'src/pages/Dashboard/chrome/PaneChrome/PaneChrome.module.scss'),
  'utf8'
);
const workspaceTreeScss = readFileSync(
  resolve(process.cwd(), 'src/features/workspace-tree/WorkspaceTree.module.scss'),
  'utf8'
);

type ParsedValue = { num: number; unit: string };

/** First (`:root`) numeric value + unit declared for a custom property. */
function rootValue(name: string): ParsedValue {
  const m = tokensScss.match(new RegExp(`${name}:\\s*([\\d.]+)(px|%)?`));
  if (!m) throw new Error(`token ${name} not found in _tokens.scss`);
  return { num: Number(m[1]), unit: m[2] ?? '' };
}

/** Parse every `@container pane (inline-size < Npx) { .pane-body > * { … } }`. */
function parseContainerSteps(): Array<{ maxWidth: number; values: Record<string, ParsedValue> }> {
  const blockRe =
    /@container pane \(inline-size < (\d+)px\)\s*\{\s*\.pane-body > \*\s*\{([^}]*)\}/g;
  const steps: Array<{ maxWidth: number; values: Record<string, ParsedValue> }> = [];
  for (const block of tokensScss.matchAll(blockRe)) {
    const maxWidth = Number(block[1]);
    const values: Record<string, ParsedValue> = {};
    for (const decl of block[2].matchAll(/(--[\w-]+):\s*(\d+)(px|%)/g)) {
      values[decl[1]] = { num: Number(decl[2]), unit: decl[3] };
    }
    steps.push({ maxWidth, values });
  }
  return steps;
}

/** Type tokens that must not be overridden per pane width. */
const TYPE_TOKENS = [
  '--text-base',
  '--text-lg',
  '--text-sm',
  '--text-xs',
  '--font-size-sm',
  '--font-size-xs',
] as const;

/** The surface-scoped reading sizes: docs, chat bodies, the system-prompt editor. */
const READING_TOKENS = ['--doc-text-base', '--chat-text-base', '--sysprompt-text-base'] as const;

describe('Layer 1 fluid surface zoom (SCSS ↔ typeScale.ts)', () => {
  it('--pane-zoom-* tokens mirror PANE_ZOOM', () => {
    expect(rootValue('--pane-zoom-full')).toEqual({ num: PANE_ZOOM.fullWidth, unit: 'px' });
    expect(rootValue('--pane-zoom-min')).toEqual({ num: PANE_ZOOM.min, unit: '' });
    expect(rootValue('--pane-zoom-strength')).toEqual({ num: PANE_ZOOM.strength, unit: '' });
  });

  it('--sidebar-zoom-* tokens mirror SIDEBAR_ZOOM', () => {
    expect(rootValue('--sidebar-zoom-full')).toEqual({ num: SIDEBAR_ZOOM.fullWidth, unit: 'px' });
    expect(rootValue('--sidebar-zoom-min')).toEqual({ num: SIDEBAR_ZOOM.min, unit: '' });
  });

  it('the pane body content and the tree shell content carry the clamp() zoom', () => {
    // Zoom sits on the container's children (`> *`), never on the container
    // itself, so the measured `100cqi` stays unzoomed and can't feed back.
    expect(paneChromeScss).toMatch(
      /\.body\s*\{[\s\S]*?>\s*\*\s*\{[\s\S]*?zoom:\s*var\(\s*--pane-zoom,\s*clamp\(\s*var\(--pane-zoom-min\),\s*calc\(1 - var\(--pane-zoom-strength\) \* \(1 - 100cqi \/ var\(--pane-zoom-full\)\)\),\s*1\s*\)\s*\)/
    );
    expect(workspaceTreeScss).toMatch(
      /\.shell\s*\{[\s\S]*?>\s*\*\s*\{[\s\S]*?zoom:\s*var\(\s*--sidebar-zoom,\s*clamp\(\s*var\(--sidebar-zoom-min\),\s*calc\(100cqi \/ var\(--sidebar-zoom-full\)\),\s*1\s*\)\s*\)/
    );
  });

  it('floors keep body text legible (13px body → ≥ 9px) and never exceed 1', () => {
    const body = rootValue('--text-base').num;
    expect(body * PANE_ZOOM.min).toBeGreaterThanOrEqual(9);
    for (const spec of [PANE_ZOOM, SIDEBAR_ZOOM]) {
      expect(spec.min).toBeGreaterThan(0);
      expect(spec.min).toBeLessThan(1);
      expect(spec.fullWidth).toBeGreaterThan(0);
    }
  });

  it('fluidZoom() is the JS twin of clamp(min, width / full, 1)', () => {
    expect(fluidZoom(PANE_ZOOM.fullWidth, PANE_ZOOM)).toBe(1);
    expect(fluidZoom(PANE_ZOOM.fullWidth * 2, PANE_ZOOM)).toBe(1);
    expect(fluidZoom(PANE_ZOOM.fullWidth / 10, PANE_ZOOM)).toBe(PANE_ZOOM.min);
    expect(fluidZoom(0, PANE_ZOOM)).toBe(1);
    expect(fluidZoom(Number.NaN, PANE_ZOOM)).toBe(1);
    // Between the floor and full width the zoom keeps shrinking, softened by strength.
    const s = PANE_ZOOM.strength ?? 1;
    expect(fluidZoom(PANE_ZOOM.fullWidth * 0.8, PANE_ZOOM)).toBeCloseTo(1 - s * 0.2, 10);
    expect(fluidZoom(600, { fullWidth: 840, min: 0.7 })).toBeCloseTo(600 / 840, 10);
  });

  it('pane zoom still resizes across common split-pane widths (not pinned at the floor)', () => {
    const at = (w: number) => fluidZoom(w, PANE_ZOOM);
    expect(at(800)).toBeGreaterThan(at(700));
    expect(at(700)).toBeGreaterThan(at(600));
    expect(at(600)).toBeGreaterThan(at(500));
    expect(at(500)).toBeGreaterThan(PANE_ZOOM.min);
    // 600px split pane: the doc body (15px) and the default chat body (14px)
    // stay at or above the UI's small text (--text-sm, 12px).
    expect(rootValue('--doc-text-base').num * at(600)).toBeGreaterThanOrEqual(
      rootValue('--text-sm').num
    );
    expect(rootValue('--chat-text-base').num * at(600)).toBeGreaterThanOrEqual(
      rootValue('--text-sm').num
    );
  });

  it('type tokens are fixed px and are not stepped by pane width', () => {
    for (const token of TYPE_TOKENS) expect(rootValue(token).unit).toBe('px');
    for (const step of parseContainerSteps()) {
      for (const token of TYPE_TOKENS) expect(step.values).not.toHaveProperty(token);
    }
  });

  it('reading text tokens are fixed px with no global scale (a thread sets its own chat size)', () => {
    expect(rootValue('--doc-text-base')).toEqual({ num: 15, unit: 'px' });
    expect(rootValue('--sysprompt-text-base')).toEqual({ num: 15, unit: 'px' });
    expect(rootValue('--chat-text-base')).toEqual({ num: 14, unit: 'px' });
    expect(tokensScss).not.toContain('--reading-scale');
    for (const step of parseContainerSteps()) {
      for (const token of READING_TOKENS) expect(step.values).not.toHaveProperty(token);
    }
  });
});

describe('Layer 1 pane-responsive message geometry (SCSS ↔ typeScale.ts)', () => {
  const parsed = parseContainerSteps();
  const defaultStep = PANE_MSG_STEPS[0];
  const narrowSteps = PANE_MSG_STEPS.slice(1);

  it(':root defaults match PANE_MSG_STEPS default tier (value + unit)', () => {
    expect(defaultStep.maxWidth).toBe(Infinity);
    for (const token of PANE_MSG_TOKENS) {
      const v = rootValue(token);
      expect(v.unit).toBe(PANE_MSG_UNITS[token]);
      expect(v.num).toBe(defaultStep.values[token]);
    }
  });

  it('@container geometry blocks match the mirror exactly (value + unit)', () => {
    expect(parsed.map((s) => s.maxWidth)).toEqual(narrowSteps.map((s) => s.maxWidth));
    narrowSteps.forEach((step, i) => {
      const block = parsed[i];
      expect(block.maxWidth).toBe(step.maxWidth);
      // Every step block lists the full geometry set so the last-wins
      // cascade fully defines each tier.
      expect(Object.keys(block.values).sort()).toEqual([...PANE_MSG_TOKENS].sort());
      for (const token of PANE_MSG_TOKENS) {
        expect(block.values[token].unit).toBe(PANE_MSG_UNITS[token]);
        expect(block.values[token].num).toBe(step.values[token]);
      }
    });
  });

  it('blocks are ordered widest-first so the narrowest wins', () => {
    const widths = parsed.map((s) => s.maxWidth);
    const descending = [...widths].sort((a, b) => b - a);
    expect(widths).toEqual(descending);
  });

  it('spacing/gutter tokens shrink to their floor; --msg-max grows to 100%', () => {
    for (const token of PANE_MSG_TOKENS) {
      const values = PANE_MSG_STEPS.map((s) => s.values[token]);
      const floor = PANE_MSG_FLOORS[token as PaneMsgToken];
      if (token === '--msg-max') {
        // Grows as the pane narrows and never exceeds a full-width bubble.
        expect(Math.min(...values)).toBe(floor);
        for (const v of values) expect(v).toBeLessThanOrEqual(100);
      } else {
        expect(Math.min(...values)).toBe(floor);
        for (const v of values) expect(v).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it('each geometry token moves monotonically in one direction', () => {
    for (const token of PANE_MSG_TOKENS) {
      const values = PANE_MSG_STEPS.map((s) => s.values[token]);
      const increasing = values[values.length - 1] >= values[0];
      for (let i = 1; i < values.length; i++) {
        if (increasing) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
        else expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
      }
    }
  });
});

describe('Layer 2 autofit bounds (SCSS ↔ TYPE_SCALE)', () => {
  it('--type-* custom properties mirror TYPE_SCALE', () => {
    expect(rootValue('--type-hero-min').num).toBe(TYPE_SCALE.heroMin);
    expect(rootValue('--type-hero-max').num).toBe(TYPE_SCALE.heroMax);
    expect(rootValue('--type-title-min').num).toBe(TYPE_SCALE.titleMin);
    expect(rootValue('--type-title-max').num).toBe(TYPE_SCALE.titleMax);
    expect(rootValue('--type-header-min').num).toBe(TYPE_SCALE.headerMin);
    expect(rootValue('--type-header-max').num).toBe(TYPE_SCALE.headerMax);
  });
});
