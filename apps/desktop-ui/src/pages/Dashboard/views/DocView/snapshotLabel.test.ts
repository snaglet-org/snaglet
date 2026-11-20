import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@snaglet/shared/utils';
import { snapshotLabel } from './snapshotLabel';

const at = '2026-11-16T20:32:11.000Z';
const when = formatDateTime(at);

describe('snapshotLabel', () => {
  it('names a Snapshot-button version and its time, without seconds or a raw reason', () => {
    const label = snapshotLabel({ label: null, reason: 'manual', created_at: at });
    expect(label).toBe(`Snapshot · ${when}`);
    expect(label).not.toMatch(/manual|:\d\d:\d\d/);
  });

  it('names the versions Snaglet takes before a restore or an agent edit', () => {
    expect(
      snapshotLabel({
        label: 'pre-restore of snap-1111111111111-aaaaaaaa',
        reason: 'pre-restore',
        created_at: at,
      })
    ).toBe(`Before restore · ${when}`);
    expect(
      snapshotLabel({
        label: 'pre-restore',
        reason: 'auto: pre-restore of snapshot snap-1',
        created_at: at,
      })
    ).toBe(`Before restore · ${when}`);
    expect(
      snapshotLabel({
        label: 'pre-edit',
        reason: 'Auto-snapshot before edit_doc with 2 edit(s)',
        created_at: at,
      })
    ).toBe(`Before an agent edit · ${when}`);
  });

  it('keeps a label someone gave the version', () => {
    expect(snapshotLabel({ label: 'First draft', reason: 'manual', created_at: at })).toBe(
      `First draft · ${when}`
    );
    expect(snapshotLabel({ label: null, reason: null, created_at: at })).toBe(`Snapshot · ${when}`);
  });
});
