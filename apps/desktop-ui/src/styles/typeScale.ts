// TypeScript mirror of the type-scale and pane-zoom tokens in `_tokens.scss`:
// autofit-text bounds (TYPE_SCALE, `--type-*`), the fluid per-surface zoom
// that shrinks everything in a pane or the sidebar together (PANE_ZOOM /
// SIDEBAR_ZOOM, `--pane-zoom-*` / `--sidebar-zoom-*`), and the stepped chat-
// bubble geometry (PANE_MSG_STEPS, the `@container pane` `--msg-*` blocks).
// paneTypeScale.test.ts fails if the SCSS and these tables disagree.

/**
 * Autofit-text bounds. Each pair is the [min, max] px window the
 * text may occupy as it fits its box.
 *  - hero   — big empty-state / profile headings
 *  - title  — pane-chrome breadcrumb titles
 *  - header — view header strips (Providers, Profile, …)
 */
export const TYPE_SCALE = {
  heroMin: 18,
  heroMax: 38,
  titleMin: 12,
  titleMax: 17,
  headerMin: 13,
  headerMax: 22,
} as const;

/**
 * A fluid-zoom rule: the surface renders at `zoom: 1` from `fullWidth` px
 * up and shrinks below it, never under `min`. `strength` (0–1, default 1)
 * softens the curve: zoom = 1 − strength·(1 − width / fullWidth). At 1 the
 * zoom tracks width exactly; at 0.5 a half-width pane renders at 0.75, so
 * text keeps shrinking gradually across far more widths before the floor.
 */
export interface FluidZoomSpec {
  /** Width (px, unzoomed) at and above which the content is rendered 1:1. */
  readonly fullWidth: number;
  /** Hard floor for the zoom factor. */
  readonly min: number;
  /** How hard the zoom follows width below `fullWidth` (0–1, default 1). */
  readonly strength?: number;
}

/**
 * Pane-body zoom. 840px is roughly "one comfortable pane on a laptop". Half
 * strength keeps the shrink gentle but continuous: a 600px split pane renders
 * at ~0.86, and the 0.75 floor is only reached at 420px.
 * Mirrors `--pane-zoom-full` / `--pane-zoom-min` / `--pane-zoom-strength`.
 */
export const PANE_ZOOM: FluidZoomSpec = { fullWidth: 840, min: 0.75, strength: 0.5 };

/**
 * Workspace-tree sidebar zoom. 232px is just under the tree's width at the
 * default 280px sidebar (minus the activity rail, ~235–239px), so the
 * default renders 1:1 and only a sidebar dragged narrower shrinks; the
 * 0.75 floor lands at 174px. Mirrors `--sidebar-zoom-full` /
 * `--sidebar-zoom-min`.
 */
export const SIDEBAR_ZOOM: FluidZoomSpec = { fullWidth: 232, min: 0.75 };

/**
 * The zoom factor a surface of `width` px renders at under `spec` — the
 * JS twin of the SCSS `clamp(min, calc(1 - strength * (1 - 100cqi / full)), 1)` expression, used
 * by the ResizeObserver fallback when the engine can't evaluate that
 * expression natively.
 */
export function fluidZoom(width: number, spec: FluidZoomSpec): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  const strength = spec.strength ?? 1;
  const zoom = 1 - strength * (1 - width / spec.fullWidth);
  return Math.min(1, Math.max(spec.min, zoom));
}

/**
 * Pane-responsive chat-message geometry tokens. Live in the
 * `@container pane { .pane-body > * }` step blocks so a narrow chat pane
 * tightens the bubbles themselves — padding, inter-message gap, bubble
 * max-width, and the side gutters — on top of the fluid zoom, which only
 * scales. Consumed by MessageRow.module.scss + MessageList.module.scss.
 */
export const PANE_MSG_TOKENS = [
  '--msg-pad-y',
  '--msg-pad-x',
  '--msg-gap',
  '--msg-max',
  '--msg-gutter-user',
  '--msg-gutter-agent',
] as const;

export type PaneMsgToken = (typeof PANE_MSG_TOKENS)[number];

/**
 * The CSS unit each geometry token carries. Spacing tokens are `px`; the
 * width-share tokens (bubble max-width + side gutters) are `%` so they stay
 * proportional to the pane. The sync test asserts the SCSS unit matches.
 */
export const PANE_MSG_UNITS: Record<PaneMsgToken, 'px' | '%'> = {
  '--msg-pad-y': 'px',
  '--msg-pad-x': 'px',
  '--msg-gap': 'px',
  '--msg-max': '%',
  '--msg-gutter-user': '%',
  '--msg-gutter-agent': '%',
};

/**
 * Bounds each geometry token respects across every tier. Spacing/gutter
 * tokens shrink as the pane narrows and never cross their floor; `--msg-max`
 * grows as the pane narrows and never exceeds 100%. The sync test checks both
 * the direction (monotonic) and the bound.
 */
export const PANE_MSG_FLOORS: Record<PaneMsgToken, number> = {
  '--msg-pad-y': 4,
  '--msg-pad-x': 5,
  '--msg-gap': 3,
  '--msg-max': 92, // widest-tier share; --msg-max only grows from here
  '--msg-gutter-user': 4,
  '--msg-gutter-agent': 3,
};

/**
 * Stepped pane geometry scale. `maxWidth` is the exclusive upper bound on
 * the pane's `inline-size` for that tier; `Infinity` is the default
 * (`:root`) tier. `values` are the absolute numbers (unit per
 * PANE_MSG_UNITS) each token takes at that tier — the SCSS `@container`
 * blocks list the full set at each breakpoint so the narrowest matching
 * block fully defines the values (last-wins cascade).
 */
export const PANE_MSG_STEPS: ReadonlyArray<{
  readonly maxWidth: number;
  readonly values: Record<PaneMsgToken, number>;
}> = [
  {
    maxWidth: Infinity,
    values: {
      '--msg-pad-y': 8,
      '--msg-pad-x': 10,
      '--msg-gap': 5,
      '--msg-max': 92,
      '--msg-gutter-user': 18,
      '--msg-gutter-agent': 6,
    },
  },
  {
    maxWidth: 600,
    values: {
      '--msg-pad-y': 7,
      '--msg-pad-x': 9,
      '--msg-gap': 5,
      '--msg-max': 94,
      '--msg-gutter-user': 14,
      '--msg-gutter-agent': 5,
    },
  },
  {
    maxWidth: 460,
    values: {
      '--msg-pad-y': 6,
      '--msg-pad-x': 8,
      '--msg-gap': 4,
      '--msg-max': 96,
      '--msg-gutter-user': 10,
      '--msg-gutter-agent': 5,
    },
  },
  {
    maxWidth: 340,
    values: {
      '--msg-pad-y': 5,
      '--msg-pad-x': 6,
      '--msg-gap': 4,
      '--msg-max': 98,
      '--msg-gutter-user': 6,
      '--msg-gutter-agent': 4,
    },
  },
  {
    maxWidth: 260,
    values: {
      '--msg-pad-y': 4,
      '--msg-pad-x': 5,
      '--msg-gap': 3,
      '--msg-max': 100,
      '--msg-gutter-user': 4,
      '--msg-gutter-agent': 3,
    },
  },
] as const;
