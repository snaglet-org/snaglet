import { describe, expect, it } from '@jest/globals';

import { resolveSearchTimeRange } from '@server/services/search/timeRange';

const NOW = new Date('2026-06-03T12:00:00Z');

describe('resolveSearchTimeRange', () => {
  // The window's exact start comes from chrono's reading of "last week", so
  // this pins its shape (seven whole days, ending no later than today).
  it('turns last week into a filter window and cleans the query', () => {
    const out = resolveSearchTimeRange({
      query: 'what did we do last week about search',
      now: NOW,
    });

    expect(out.query).toBe('what did we do about search');
    expect(out.timeRange).toMatchObject({
      mode: 'filter',
      field: 'activity_at',
      label: 'last week',
      source: 'query',
    });
    const from = Date.parse(out.timeRange?.from ?? '');
    const to = Date.parse(out.timeRange?.to ?? '');
    expect(to - from).toBe(7 * 24 * 60 * 60 * 1000);
    expect(to).toBeLessThanOrEqual(NOW.getTime());
  });

  it('treats vague recency as a boost instead of a hard filter', () => {
    const out = resolveSearchTimeRange({
      query: 'recently dashboard automation',
      now: NOW,
    });

    expect(out.query).toBe('dashboard automation');
    expect(out.timeRange).toMatchObject({
      from: '2026-05-04T00:00:00.000Z',
      to: null,
      mode: 'boost',
      field: 'activity_at',
      label: 'recently',
      source: 'query',
    });
  });

  it('normalizes explicit time_range input', () => {
    const out = resolveSearchTimeRange({
      query: 'search',
      timeRange: {
        from: '2026-05-01',
        to: '2026-06-01',
        mode: 'boost',
        field: 'updated_at',
      },
      now: NOW,
    });

    expect(out.query).toBe('search');
    expect(out.timeRange).toMatchObject({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
      mode: 'boost',
      field: 'updated_at',
      source: 'explicit',
    });
  });
});
