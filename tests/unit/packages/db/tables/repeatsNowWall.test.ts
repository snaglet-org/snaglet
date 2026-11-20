/**
 * The server's "now" for a repeat (`nowWall`) and the engine's reading of a
 * moment (`tableRepeatWallTime`) are one conversion: the same wall string,
 * UTC's for a zone the runtime doesn't know.
 */
import { describe, expect, it } from '@jest/globals';
import { tableRepeatWallTime } from '@snaglet/shared/utils';
import { nowWall } from '@snaglet/db/tables/table_entries/repeats';

/** `nowWall` against the helper read just before and just after it (the clock moves on). */
function bracket(tz: string, kind: 'date' | 'datetime') {
  const cut = (wall: string) => (kind === 'date' ? wall.slice(0, 10) : wall);
  const before = cut(tableRepeatWallTime(new Date(), tz));
  const wall = nowWall(tz, kind);
  const after = cut(tableRepeatWallTime(new Date(), tz));
  return { wall, either: [before, after] };
}

describe('nowWall', () => {
  it.each(['America/Los_Angeles', 'Asia/Tokyo', 'UTC'])(
    'is tableRepeatWallTime of the clock in %s',
    (tz) => {
      for (const kind of ['datetime', 'date'] as const) {
        const { wall, either } = bracket(tz, kind);
        expect(either).toContain(wall);
      }
    }
  );

  it('falls back to UTC for an unknown zone, as the helper does', () => {
    const { wall, either } = bracket('Not/A_Zone', 'datetime');
    expect(either).toContain(wall);
    const utc = new Date().toISOString().slice(0, 19);
    const earlier = new Date(Date.now() - 1000).toISOString().slice(0, 19);
    expect([earlier, utc]).toContain(wall);
  });
});
