/**
 * hashedStatCache — when a reconcile may settle a file from its stat instead of
 * reading it: every stat field must match what the last read saw, for the same
 * folder and root, and the stat must be older than the recent-write window.
 */

import { describe, expect, it } from '@jest/globals';
import type { Stats } from 'node:fs';
import {
  cachedRead,
  forgetHashedStat,
  forgetProjectHashedStats,
  openHashedStats,
  rememberRead,
} from '@server/services/fileIndexing/hashedStatCache';

const ROOT = { dev: 1, ino: 100 };
const OLD_MS = Date.parse('2026-01-01T00:00:00Z');
const STAT_AT = OLD_MS + 60_000;
const HASHED = { kind: 'hashed', contentHash: 'hash-a' } as const;
let seq = 0;

type StatFields = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'dev'>;

function stats(overrides: Partial<StatFields> = {}): Stats {
  return { size: 10, mtimeMs: OLD_MS, ctimeMs: OLD_MS + 1, ino: 7, dev: 1, ...overrides } as Stats;
}

/** A fresh project id with an open cache holding `a.ts` hashed to `hash-a`. */
function cachedProject(): string {
  seq += 1;
  const projectId = `proj-stat-${seq}`;
  openHashedStats(projectId, '/work/folder', ROOT);
  rememberRead(projectId, '/work/folder', 'a.ts', stats(), STAT_AT, HASHED);
  return projectId;
}

describe('hashedStatCache', () => {
  it('returns the last read while every stat field matches', () => {
    const p = cachedProject();
    expect(cachedRead(p, 'a.ts', stats())).toEqual(HASHED);
  });

  it.each([
    ['size', { size: 11 }],
    ['mtime', { mtimeMs: OLD_MS + 5 }],
    ['ctime', { ctimeMs: OLD_MS + 9 }],
    ['inode (a file renamed over it)', { ino: 8 }],
    ['device (a retargeted symlink)', { dev: 2 }],
  ])('returns nothing once the %s moves', (_field, overrides) => {
    const p = cachedProject();
    expect(cachedRead(p, 'a.ts', stats(overrides))).toBeNull();
  });

  it('remembers a skip decided by the bytes', () => {
    const p = cachedProject();
    rememberRead(p, '/work/folder', 'bin.dat', stats({ ino: 9 }), STAT_AT, { kind: 'skipped' });
    expect(cachedRead(p, 'bin.dat', stats({ ino: 9 }))).toEqual({ kind: 'skipped' });
  });

  it('does not remember a file whose mtime or ctime is within two seconds of the stat', () => {
    const p = cachedProject();
    const recentMtime = stats({ mtimeMs: STAT_AT - 1_500, ctimeMs: STAT_AT - 1_500 });
    rememberRead(p, '/work/folder', 'a.ts', recentMtime, STAT_AT, HASHED);
    expect(cachedRead(p, 'a.ts', recentMtime)).toBeNull();

    const recentCtime = stats({ ctimeMs: STAT_AT - 500 });
    rememberRead(p, '/work/folder', 'a.ts', recentCtime, STAT_AT, HASHED);
    expect(cachedRead(p, 'a.ts', recentCtime)).toBeNull();
  });

  it('remembers nothing before a reconcile opens the cache, or for another folder', () => {
    seq += 1;
    const p = `proj-stat-${seq}`;
    rememberRead(p, '/work/folder', 'a.ts', stats(), STAT_AT, HASHED);
    expect(cachedRead(p, 'a.ts', stats())).toBeNull();

    openHashedStats(p, '/work/folder', ROOT);
    rememberRead(p, '/work/other', 'a.ts', stats(), STAT_AT, HASHED);
    expect(cachedRead(p, 'a.ts', stats())).toBeNull();
  });

  it('keeps entries when the same folder and root open again', () => {
    const p = cachedProject();
    openHashedStats(p, '/work/folder', { ...ROOT });
    expect(cachedRead(p, 'a.ts', stats())).toEqual(HASHED);
  });

  it('starts empty when the root identity, the folder path or the root itself changes', () => {
    const swapped = cachedProject();
    openHashedStats(swapped, '/work/folder', { dev: 1, ino: 200 });
    expect(cachedRead(swapped, 'a.ts', stats())).toBeNull();

    const moved = cachedProject();
    openHashedStats(moved, '/work/moved', ROOT);
    expect(cachedRead(moved, 'a.ts', stats())).toBeNull();

    const missing = cachedProject();
    openHashedStats(missing, '/work/folder', null);
    expect(cachedRead(missing, 'a.ts', stats())).toBeNull();
  });

  it('forgets one file, or a whole project', () => {
    const one = cachedProject();
    forgetHashedStat(one, 'a.ts');
    expect(cachedRead(one, 'a.ts', stats())).toBeNull();

    const all = cachedProject();
    forgetProjectHashedStats(all);
    expect(cachedRead(all, 'a.ts', stats())).toBeNull();
  });
});
