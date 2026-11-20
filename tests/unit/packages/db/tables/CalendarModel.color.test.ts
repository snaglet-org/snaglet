import { describe, expect, it, jest } from '@jest/globals';
import type { DbQueryable } from '@snaglet/db/db';
import { AppError } from '@snaglet/shared/utils';
import { Calendars, validCalendarColor } from '@snaglet/db/tables/calendars';

function rowWith(color: string | null) {
  return {
    id: 'cal-1111111111111-aaaaaaaaa',
    title: 'Test calendar',
    description: '',
    time_zone: 'UTC',
    color,
    is_default: false,
    sort_order: 0,
    revision: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function runnerWith(rows: unknown[]): DbQueryable {
  const query = jest.fn(async () => ({ rows, rowCount: rows.length }));
  return { query } as unknown as DbQueryable;
}

describe('calendar color validation', () => {
  it('accepts palette ids, theme tokens and hex, normalized; null stays automatic', () => {
    expect(validCalendarColor(null)).toBeNull();
    expect(validCalendarColor('green')).toBe('green');
    expect(validCalendarColor('theme:detail')).toBe('theme:detail');
    expect(validCalendarColor('#3A7BD5')).toBe('#3a7bd5');
    expect(validCalendarColor('#abc')).toBe('#aabbcc');
  });

  it('rejects anything else with a 400 naming what is accepted', () => {
    for (const bad of ['plaid', 'theme:nope', '#12', 7, undefined]) {
      let error: unknown;
      try {
        validCalendarColor(bad);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).message).toMatch(
        /^color must be null \(automatic\), a palette color \(blue, .*gray\), a theme color written theme:<token> \(tokens: .*detail.*\), or a custom hex color like #3a7bd5\.$/
      );
    }
  });

  it('reads stored colors normalized, and one that no longer parses as automatic', async () => {
    for (const [stored, read] of [
      ['blue', 'blue'],
      ['theme:agent', 'theme:agent'],
      ['#3a7bd5', '#3a7bd5'],
      ['theme:color-node-agent', 'theme:agent'],
      ['theme:retired-token', null],
      [null, null],
    ] as const) {
      const calendar = await Calendars.findById('cal-1', runnerWith([rowWith(stored)]));
      expect(calendar?.color).toBe(read);
    }
  });
});
