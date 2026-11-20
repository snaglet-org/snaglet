import { clampLimit } from '@server/utils/pagination';

/**
 * clampLimit parses and bounds a `limit` query param. Defaults: 50, range
 * [1, 200], with non-positive values snapping back to the default unless
 * the caller opts out.
 */
describe('clampLimit', () => {
  test('parses numeric strings and numbers', () => {
    expect(clampLimit('30')).toBe(30);
    expect(clampLimit(30)).toBe(30);
  });

  test('floors fractional values', () => {
    expect(clampLimit(50.9)).toBe(50);
  });

  test('clamps to the [min, max] range', () => {
    expect(clampLimit(500)).toBe(200);
    expect(clampLimit(2, { min: 5 })).toBe(5);
    expect(clampLimit(100, { max: 10 })).toBe(10);
  });

  test('uses the default for missing / unparseable / non-finite input', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit('')).toBe(50);
    expect(clampLimit('abc')).toBe(50);
    expect(clampLimit(Infinity)).toBe(50);
    expect(clampLimit(undefined, { defaultLimit: 25 })).toBe(25);
  });

  test('snaps non-positive values to the default by default', () => {
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(-5)).toBe(50);
    expect(clampLimit(0, { defaultLimit: 25 })).toBe(25);
  });

  test('clamps non-positive values to min when defaultOnNonPositive is false', () => {
    expect(clampLimit(0, { defaultOnNonPositive: false })).toBe(1);
    expect(clampLimit(-5, { defaultOnNonPositive: false, min: 2 })).toBe(2);
  });
});
