import type { ThemeToken } from './tokens';

export const CURSOR_SPEC_VERSION = 1 as const;

/** Geometry of the flower in a 100x100-ish viewBox (outer radius R = 50). */
export interface FlowerShape {
  /** petal count (integer) */
  n: number;
  /** petal base distance from center */
  b: number;
  /** petal tip distance from center */
  t: number;
  /** petal half-width */
  w: number;
  /** where the petal is widest, 0..1 along its length */
  pos: number;
  /** tip roundness 0 (pointed) .. 1 (round) */
  round: number;
  /** a second, offset ring of petals */
  ring: boolean;
  ringScale: number;
  /** face disc radius */
  cr: number;
  /** eye radius as a fraction of cr */
  eyeSize: number;
  /** eye x offset as a fraction of cr */
  eyeSpacing: number;
}

export interface FlowerColors {
  petal: ThemeToken;
  ring: ThemeToken;
  center: ThemeToken;
  feature: ThemeToken;
  cheek: ThemeToken;
  outline: ThemeToken;
}

export interface CursorSpec {
  v: 1;
  shape: FlowerShape;
  colors: FlowerColors;
}
