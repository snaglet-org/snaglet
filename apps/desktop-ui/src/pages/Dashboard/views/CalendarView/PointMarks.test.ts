import { describe, expect, it } from 'vitest';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { POINT_GAP_PX, clusterPoints, type PlacedPoint } from './PointMarks';

const point = (key: string, minutes: number): PlacedPoint => ({
  o: { key } as CalendarOccurrence,
  minutes,
});

describe('clusterPoints', () => {
  it('keeps points apart when their marks would not overlap', () => {
    // 1 px a minute: 30 min apart = 30 px, more than one mark's height.
    const out = clusterPoints([point('a', 600), point('b', 630)], 1);
    expect(out.map((c) => c.points.map((p) => p.o.key))).toEqual([['a'], ['b']]);
  });

  it('groups points that would overlap, measured from the group start', () => {
    // 0.8 px a minute (the default scale): marks closer than 22.5 min overlap.
    // c is 20 min after a (16 px) so it joins; d is 25 min after a (20 px) so it starts anew.
    const out = clusterPoints(
      [point('c', 620), point('a', 600), point('b', 610), point('d', 625)],
      0.8
    );
    expect(out.map((c) => c.points.map((p) => p.o.key))).toEqual([['a', 'b', 'c'], ['d']]);
    expect(out[0]).toMatchObject({ key: 'a', minutes: 600 });
  });

  it('splits a group again when zoomed in', () => {
    const list = [point('a', 600), point('b', 605)];
    expect(clusterPoints(list, 1)).toHaveLength(1);
    expect(clusterPoints(list, POINT_GAP_PX / 5 + 0.1)).toHaveLength(2);
  });

  it('puts points at the same minute together at any zoom', () => {
    expect(clusterPoints([point('a', 600), point('b', 600)], 12)).toHaveLength(1);
  });
});
