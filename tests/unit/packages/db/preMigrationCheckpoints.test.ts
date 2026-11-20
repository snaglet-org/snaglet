import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  newCheckpointName,
  preMigrationCheckpointDir,
  prunePreMigrationCheckpoints,
  summarizePreMigrationCheckpoints,
} from '@snaglet/db/runtime/postgres/pre-migration-checkpoints';
import { PRE_UPDATE_SNAPSHOT_RETENTION } from '@snaglet/shared/constants/backups';

const RETAIN = PRE_UPDATE_SNAPSHOT_RETENTION;

/** RETAIN + 3 checkpoint names, oldest first, one day apart. */
const NAMES = Array.from(
  { length: RETAIN + 3 },
  (_, index) => `2026-01-0${index + 1}T00-00-00-000Z-0000000${index + 1}`
);

describe('pre-migration checkpoint pruning', () => {
  let home: string;
  let base: string;
  let log: jest.SpiedFunction<typeof console.log>;
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'snaglet-checkpoint-prune-'));
    base = preMigrationCheckpointDir(home);
    await mkdir(base, { recursive: true });
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    log.mockRestore();
    warn.mockRestore();
    await rm(home, { recursive: true, force: true });
  });

  /** A checkpoint folder with a dump of `bytes` bytes and a distinct mtime. */
  async function writeCheckpoint(name: string, bytes = 10, day = 1): Promise<void> {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'database.dump'), Buffer.alloc(bytes, 1));
    await writeFile(path.join(dir, 'manifest.json'), '{}');
    const when = new Date(Date.UTC(2026, 0, day));
    await utimes(dir, when, when);
  }

  it('writes names the pruner recognizes', async () => {
    const name = newCheckpointName(new Date('2026-03-04T05:06:07.089Z'));
    expect(name).toMatch(/^2026-03-04T05-06-07-089Z-[0-9a-f]{8}$/);
    await writeCheckpoint(name);
    await expect(summarizePreMigrationCheckpoints(base)).resolves.toMatchObject({ count: 1 });
  });

  it('keeps the newest checkpoints, deletes the rest and logs one line with bytes freed', async () => {
    for (const [index, name] of NAMES.entries()) await writeCheckpoint(name, 100, index + 1);

    const result = await prunePreMigrationCheckpoints(base, { current: NAMES.at(-1) });

    const doomed = NAMES.slice(0, -RETAIN);
    expect((await readdir(base)).sort()).toEqual(NAMES.slice(-RETAIN));
    expect([...result.removed].sort()).toEqual(doomed);
    // Each folder holds a 100-byte dump and a 2-byte manifest.
    expect(result.bytesFreed).toBe(doomed.length * 102);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain(`Pruned ${doomed.length} old pre-migration checkpoint(s)`);
    expect(line).toContain('freed 306 Bytes');
    for (const name of doomed) expect(line).toContain(name);
    // The desktop shell reads "pre-migration backup" as "upgrading the
    // database" (sidecar.rs UPGRADE_MARKERS); a plain boot that only prunes
    // must not trip it.
    expect(line).not.toContain('pre-migration backup');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run removes nothing and logs nothing', async () => {
    for (const name of NAMES) await writeCheckpoint(name);
    await prunePreMigrationCheckpoints(base);
    log.mockClear();

    const again = await prunePreMigrationCheckpoints(base);

    expect(again).toEqual({ removed: [], bytesFreed: 0 });
    expect(await readdir(base)).toHaveLength(RETAIN);
    expect(log).not.toHaveBeenCalled();
  });

  it('ignores files, folders and symlinks it did not write', async () => {
    const outside = path.join(home, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'outside data');
    for (const name of NAMES) await writeCheckpoint(name);
    const foreign = [
      // Oldest-looking names, so retention alone would pick them first.
      '2019-12-30T00-00-00-000Z-0000000e',
      '2019-12-31T00-00-00-000Z-0000000f',
      'manual copy',
      'notes.txt',
      '2026-01-01T00-00-00-000Z-0000001',
    ];
    await symlink(
      outside,
      path.join(base, foreign[0]),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await writeFile(path.join(base, foreign[1]), 'a file, not a checkpoint');
    await mkdir(path.join(base, foreign[2]));
    await writeFile(path.join(base, foreign[3]), 'notes');
    await mkdir(path.join(base, foreign[4]));

    const result = await prunePreMigrationCheckpoints(base);

    expect(result.removed.sort()).toEqual(NAMES.slice(0, -RETAIN));
    expect((await readdir(base)).sort()).toEqual([...foreign, ...NAMES.slice(-RETAIN)].sort());
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside data');
  });

  it('never measures through a symlink inside a checkpoint', async () => {
    const outside = path.join(home, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'big.bin'), Buffer.alloc(5000, 1));
    for (const name of NAMES) await writeCheckpoint(name, 10);
    await symlink(
      outside,
      path.join(base, NAMES[0], 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = await prunePreMigrationCheckpoints(base);

    expect(result.removed).toContain(NAMES[0]);
    expect(result.bytesFreed).toBeLessThan(5000);
    expect(await readFile(path.join(outside, 'big.bin'))).toHaveLength(5000);
  });

  it('handles a missing or empty folder without creating it', async () => {
    await expect(prunePreMigrationCheckpoints(base)).resolves.toEqual({
      removed: [],
      bytesFreed: 0,
    });
    const missing = preMigrationCheckpointDir(path.join(home, 'nowhere'));
    await expect(prunePreMigrationCheckpoints(missing)).resolves.toEqual({
      removed: [],
      bytesFreed: 0,
    });
    await expect(readdir(path.join(home, 'nowhere'))).rejects.toThrow(/ENOENT/);
    await expect(summarizePreMigrationCheckpoints(missing)).resolves.toEqual({
      count: 0,
      totalBytes: 0,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;
  (canTestPermissions ? it : it.skip)(
    'logs a checkpoint it cannot remove and goes on with the rest',
    async () => {
      for (const name of NAMES) await writeCheckpoint(name);
      const stuck = path.join(base, NAMES[0]);
      // Its contents cannot be unlinked while the folder is read-only.
      await chmod(stuck, 0o500);
      try {
        const result = await prunePreMigrationCheckpoints(base);

        expect(result.removed.sort()).toEqual(NAMES.slice(1, -RETAIN));
        expect((await readdir(base)).sort()).toEqual([NAMES[0], ...NAMES.slice(-RETAIN)]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain(
          `Could not remove old pre-migration checkpoint ${stuck}`
        );
      } finally {
        await chmod(stuck, 0o700);
      }

      // Once it can be removed, the next run picks it up.
      const retry = await prunePreMigrationCheckpoints(base);
      expect(retry.removed).toEqual([NAMES[0]]);
    }
  );

  it('keeps the checkpoint just taken and anything newer, even after a clock change', async () => {
    const current = '2000-01-01T00-00-00-000Z-aaaaaaaa';
    const newer = [
      '2030-01-01T00-00-00-000Z-bbbbbbbb',
      '2030-01-02T00-00-00-000Z-cccccccc',
      '2030-01-03T00-00-00-000Z-dddddddd',
    ];
    const older = '1999-01-01T00-00-00-000Z-eeeeeeee';
    for (const name of [older, current, ...newer]) await writeCheckpoint(name);

    const result = await prunePreMigrationCheckpoints(base, { current: path.join(base, current) });

    expect(result.removed).toEqual([older]);
    expect((await readdir(base)).sort()).toEqual([current, ...newer].sort());
  });

  const HOUR = 60 * 60 * 1000;

  /** A half-written staging folder; its dump last changed `fileAgeMs` ago, the folder `dirAgeMs` ago. */
  async function writeStaging(name: string, fileAgeMs: number, dirAgeMs = fileAgeMs) {
    const dir = path.join(base, name);
    await mkdir(dir);
    await writeFile(path.join(dir, 'database.dump'), 'PGDMP-partial');
    const fileTime = new Date(Date.now() - fileAgeMs);
    await utimes(path.join(dir, 'database.dump'), fileTime, fileTime);
    const dirTime = new Date(Date.now() - dirAgeMs);
    await utimes(dir, dirTime, dirTime);
  }

  it('clears staging folders a crashed boot left, but none newer than the current one', async () => {
    for (const name of NAMES.slice(-RETAIN)) await writeCheckpoint(name);
    const current = NAMES.at(-1)!;
    const crashed = '.preparing-2025-12-01T00-00-00-000Z-0000000a';
    const later = '.preparing-2027-01-01T00-00-00-000Z-0000000b';
    await writeStaging(crashed, 2 * HOUR);
    await writeStaging(later, 2 * HOUR);

    const result = await prunePreMigrationCheckpoints(base, { current });

    expect(result.removed).toEqual([crashed]);
    expect((await readdir(base)).sort()).toEqual([later, ...NAMES.slice(-RETAIN)].sort());
  });

  it('never removes a staging folder that changed within the last hour, even with no current checkpoint', async () => {
    const old = '.preparing-2025-12-01T00-00-00-000Z-0000000a';
    // Another Snaglet process could still be writing these.
    const fresh = '.preparing-2025-12-02T00-00-00-000Z-0000000b';
    const freshFile = '.preparing-2025-12-03T00-00-00-000Z-0000000c';
    await writeStaging(old, 2 * HOUR);
    await writeStaging(fresh, 0);
    await writeStaging(freshFile, 10 * 60 * 1000, 3 * HOUR);

    const result = await prunePreMigrationCheckpoints(base);

    expect(result.removed).toEqual([old]);
    expect((await readdir(base)).sort()).toEqual([fresh, freshFile]);
  });

  it('summarizes only real checkpoints', async () => {
    await writeCheckpoint(NAMES[0], 100);
    await writeCheckpoint(NAMES[1], 50);
    await mkdir(path.join(base, 'manual copy'));
    await writeFile(path.join(base, 'manual copy', 'database.dump'), Buffer.alloc(999));
    await mkdir(path.join(base, '.preparing-2026-02-01T00-00-00-000Z-0000000c'));

    await expect(summarizePreMigrationCheckpoints(base)).resolves.toEqual({
      count: 2,
      totalBytes: 100 + 50 + 2 * 2,
    });
  });
});
