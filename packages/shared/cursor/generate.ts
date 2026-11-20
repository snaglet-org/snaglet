import { isRecord } from '../utils/type-guards';
import { makeRng, seedFromId } from './prng';
import {
  CENTER_TOKENS,
  CHEEK_TOKENS,
  FEATURE_TOKENS,
  OUTLINE_TOKENS,
  PETAL_TOKENS,
  type ThemeToken,
} from './tokens';
import { CURSOR_SPEC_VERSION, type CursorSpec, type FlowerColors, type FlowerShape } from './types';

/** Rings draw from the same palette as petals. */
const RING_TOKENS = PETAL_TOKENS;

/** Petal count choices (weighted by repetition, as in the prototype). */
const PETAL_COUNTS = [4, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 10] as const;

/** Inclusive ranges every generated shape falls inside. */
export const SHAPE_RANGES = {
  n: { min: 4, max: 10 },
  b: { min: 7, max: 17.5 },
  t: { min: 37, max: 50 },
  w: { min: 1, max: 30 },
  pos: { min: 0.4, max: 0.7 },
  round: { min: 0, max: 1 },
  ringScale: { min: 0.62, max: 0.8 },
  cr: { min: 20, max: 25 },
  eyeSize: { min: 0.13, max: 0.18 },
  eyeSpacing: { min: 0.34, max: 0.42 },
} as const;

const R = 50;
const q = (v: number): number => Math.round(v * 1000) / 1000;
const MIX = 2654435761;

/** Same layout/ranges as the prototype's `gen` (shape part only). */
export function generateShape(seed: number): FlowerShape {
  const r = makeRng(Math.imul((seed | 0) + 1, MIX));
  const n = PETAL_COUNTS[Math.floor(r() * PETAL_COUNTS.length)];
  const t = R * (0.74 + r() * 0.26);
  const cr = R * (0.4 + r() * 0.1);
  const b = cr * (0.35 + r() * 0.35);
  const pos = 0.4 + r() * 0.3;
  const round = r();
  const mid = b + (t - b) * pos;
  const wMax = mid * Math.sin(Math.PI / n) * 1.3;
  const w = Math.min(wMax, (t - b) * (0.22 + r() * 0.24) * (1 + (7 - n) * 0.07));
  const ring = n >= 5 && r() < 0.4;
  const ringScale = 0.62 + r() * 0.18;
  const eyeSize = 0.13 + r() * 0.05;
  const eyeSpacing = 0.34 + r() * 0.08;
  return {
    n,
    b: q(b),
    t: q(t),
    w: q(w),
    pos: q(pos),
    round: q(round),
    ring,
    ringScale: q(ringScale),
    cr: q(cr),
    eyeSize: q(eyeSize),
    eyeSpacing: q(eyeSpacing),
  };
}

function pickFrom<T>(r: () => number, list: readonly T[], not?: readonly T[]): T {
  const pool = not ? list.filter((x) => !not.includes(x)) : list;
  return pool[Math.floor(r() * pool.length)];
}

/** Picks a token per role; ring != petal and center != petal always. */
export function generateColors(seed: number): FlowerColors {
  const r = makeRng(Math.imul((seed | 0) + 7, MIX));
  const petal: ThemeToken = pickFrom(r, PETAL_TOKENS);
  const ring = pickFrom<ThemeToken>(r, RING_TOKENS, [petal]);
  const center = pickFrom<ThemeToken>(r, CENTER_TOKENS, [petal]);
  return {
    petal,
    ring,
    center,
    feature: pickFrom(r, FEATURE_TOKENS),
    cheek: pickFrom(r, CHEEK_TOKENS),
    outline: pickFrom(r, OUTLINE_TOKENS),
  };
}

export function generateCursorSpec(
  shapeSeed: number,
  colorSeed: number = shapeSeed + 1013
): CursorSpec {
  return {
    v: CURSOR_SPEC_VERSION,
    shape: generateShape(shapeSeed),
    colors: generateColors(colorSeed),
  };
}

export function defaultCursorSpec(agentId: string): CursorSpec {
  return generateCursorSpec(seedFromId(agentId));
}

const COLOR_LISTS: Record<keyof FlowerColors, readonly string[]> = {
  petal: PETAL_TOKENS,
  ring: RING_TOKENS,
  center: CENTER_TOKENS,
  feature: FEATURE_TOKENS,
  cheek: CHEEK_TOKENS,
  outline: OUTLINE_TOKENS,
};

function assertExactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  where: string
): void {
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) throw new Error(`${where}: unexpected key "${k}"`);
  }
  for (const k of keys) {
    if (!(k in obj)) throw new Error(`${where}: missing key "${k}"`);
  }
}

/** Throws an Error with a clear message unless `value` is a valid CursorSpec. Returns it typed. */
export function validateCursorSpec(value: unknown): CursorSpec {
  if (!isRecord(value)) throw new Error('cursorSpec must be an object');
  assertExactKeys(value, ['v', 'shape', 'colors'], 'cursorSpec');
  if (value.v !== CURSOR_SPEC_VERSION)
    throw new Error(`cursorSpec.v must be ${CURSOR_SPEC_VERSION}`);

  const shape = value.shape;
  if (!isRecord(shape)) throw new Error('cursorSpec.shape must be an object');
  assertExactKeys(shape, [...Object.keys(SHAPE_RANGES), 'ring'], 'cursorSpec.shape');
  if (typeof shape.ring !== 'boolean') throw new Error('cursorSpec.shape.ring must be a boolean');
  for (const [key, range] of Object.entries(SHAPE_RANGES)) {
    const v = shape[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`cursorSpec.shape.${key} must be a finite number`);
    }
    if (v < range.min || v > range.max) {
      throw new Error(`cursorSpec.shape.${key} must be between ${range.min} and ${range.max}`);
    }
  }
  if (!Number.isInteger(shape.n)) throw new Error('cursorSpec.shape.n must be an integer');

  const colors = value.colors;
  if (!isRecord(colors)) throw new Error('cursorSpec.colors must be an object');
  assertExactKeys(colors, Object.keys(COLOR_LISTS), 'cursorSpec.colors');
  for (const [role, list] of Object.entries(COLOR_LISTS)) {
    const c = colors[role];
    if (typeof c !== 'string' || !list.includes(c)) {
      throw new Error(`cursorSpec.colors.${role} must be one of: ${list.join(', ')}`);
    }
  }
  return value as unknown as CursorSpec;
}
