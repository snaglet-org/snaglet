import {
  formatTableDateRange,
  parseTableDateRange,
  tableDateRangeToCanonical,
} from '@snaglet/shared/utils';

const NY = 'America/New_York';

describe('table date ranges', () => {
  it('reads date ranges with an inclusive end, and single days', () => {
    expect(parseTableDateRange('2026-10-12/2026-10-15', 'date', NY)).toEqual({
      ok: true,
      range: { start: '2026-10-12', end: '2026-10-15' },
    });
    expect(tableDateRangeToCanonical('2026-10-12', 'date', NY)).toBe('2026-10-12');
    // An end equal to the start is a single day.
    expect(tableDateRangeToCanonical('2026-10-12/2026-10-12', 'date', NY)).toBe('2026-10-12');
    expect(tableDateRangeToCanonical(' 2026-10-12 / 2026-10-13 ', 'date', NY)).toBe(
      '2026-10-12/2026-10-13'
    );
  });

  it('canonicalizes datetime ranges to UTC instants, wall times in the zone', () => {
    expect(tableDateRangeToCanonical('2026-10-12T09:00/2026-10-12T10:30', 'datetime', NY)).toBe(
      '2026-10-12T13:00:00.000000Z/2026-10-12T14:30:00.000000Z'
    );
    expect(tableDateRangeToCanonical('2026-10-12T13:00:00Z', 'datetime', NY)).toBe(
      '2026-10-12T13:00:00.000000Z'
    );
    // Across a DST change the instants stay exact.
    expect(tableDateRangeToCanonical('2026-11-01T00:30/2026-11-01T03:30', 'datetime', NY)).toBe(
      '2026-11-01T04:30:00.000000Z/2026-11-01T08:30:00.000000Z'
    );
  });

  it('refuses reversed, malformed and mixed-kind ranges with a sentence', () => {
    expect(parseTableDateRange('2026-10-15/2026-10-12', 'date', NY)).toEqual({
      ok: false,
      problem: 'The end is before the start.',
    });
    expect(parseTableDateRange('2026-10-12T10:00/2026-10-12T09:00', 'datetime', NY)).toMatchObject({
      ok: false,
      problem: 'The end is before the start.',
    });
    expect(parseTableDateRange('2026-10-12/2026-10-13/2026-10-14', 'date', NY)).toMatchObject({
      ok: false,
    });
    expect(parseTableDateRange('2026-02-30', 'date', NY)).toMatchObject({ ok: false });
    expect(parseTableDateRange('2026-10-12T09:00/2026-10-13', 'date', NY)).toMatchObject({
      ok: false,
    });
    expect(parseTableDateRange('/2026-10-13', 'date', NY)).toMatchObject({
      ok: false,
      problem: "The range's start is empty.",
    });
    expect(tableDateRangeToCanonical('soon', 'datetime', NY)).toBeNull();
  });

  it('formats a parsed range back to its wire form', () => {
    expect(formatTableDateRange({ start: '2026-10-12', end: null })).toBe('2026-10-12');
    expect(formatTableDateRange({ start: '2026-10-12', end: '2026-10-14' })).toBe(
      '2026-10-12/2026-10-14'
    );
  });
});
