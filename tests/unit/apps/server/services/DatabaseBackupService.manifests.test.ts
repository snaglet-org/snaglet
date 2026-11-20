import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@snaglet/db/db', () => ({
  getDb: jest.fn(),
  getDbClient: jest.fn(),
  transaction: jest.fn(),
  getBackupAdapter: jest.fn(),
}));

jest.mock('@snaglet/db/migrations', () => ({
  pendingMigrationCount: jest.fn(),
  reapplySeedFiles: jest.fn(),
  reapplyProviderCatalogSeed: jest.fn(),
  reapplyLocalModelSeeds: jest.fn(),
  SEED_REPLAY_FILES: [],
}));

jest.mock('@server/config/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock('@server/services/snagletHome', () => ({
  SNAGLET_BACKUPS_DIR: '/should-never-be-used-by-database-backup-manifest-tests',
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(),
    syncToDatabase: jest.fn(),
  },
}));

interface LegacyManifestInput {
  id: string;
  label: string;
  createdAt: string;
  sizeBytes: number;
  dbName: string;
  kind: 'auto' | 'manual';
}

describe('DatabaseBackupService snapshot manifest compatibility', () => {
  let backupsDir: string;
  let originalBackupsDir: string | undefined;
  let service: typeof import('@server/services/DatabaseBackupService');

  beforeAll(async () => {
    backupsDir = await mkdtemp(join(tmpdir(), 'snaglet-database-backup-manifests-'));
    originalBackupsDir = process.env.SNAGLET_BACKUPS_DIR;
    process.env.SNAGLET_BACKUPS_DIR = backupsDir;

    // DatabaseBackupService captures SNAGLET_BACKUPS_DIR at module evaluation time,
    // so import it only after the throwaway directory is configured.
    service = await import('@server/services/DatabaseBackupService');
  });

  afterAll(async () => {
    if (originalBackupsDir === undefined) {
      delete process.env.SNAGLET_BACKUPS_DIR;
    } else {
      process.env.SNAGLET_BACKUPS_DIR = originalBackupsDir;
    }
    await rm(backupsDir, { recursive: true, force: true });
  });

  async function writeLegacySnapshot(
    id: string,
    kind: LegacyManifestInput['kind'] = 'auto'
  ): Promise<{ artifactPath: string; manifestPath: string; artifact: Buffer }> {
    const artifact = Buffer.from(`legacy-embedded-artifact:${id}`);
    const artifactPath = join(backupsDir, `${id}.dump`);
    const manifestPath = join(backupsDir, `${id}.json`);
    const manifest: LegacyManifestInput = {
      id,
      label: `Legacy ${id}`,
      createdAt: '2020-01-02T03:04:05.000Z',
      sizeBytes: 1,
      dbName: 'embedded',
      kind,
    };
    await writeFile(artifactPath, artifact);
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    return { artifactPath, manifestPath, artifact };
  }

  it('normalizes an old manifest with no engine or format as non-restorable legacy embedded', async () => {
    const id = 'legacy-normalization-probe';
    const { artifact } = await writeLegacySnapshot(id, 'manual');

    const listed = (await service.listSnapshots()).find((snapshot) => snapshot.id === id);

    expect(listed).toEqual({
      id,
      label: `Legacy ${id}`,
      createdAt: '2020-01-02T03:04:05.000Z',
      sizeBytes: artifact.byteLength,
      dbName: 'embedded',
      kind: 'manual',
      engine: 'legacy-embedded',
      format: 'legacy-embedded',
      fileName: `${id}.dump`,
      legacy: true,
      restorable: false,
    });
  });

  it('never prunes or parks a legacy automatic snapshot', async () => {
    const id = 'legacy-prune-probe';
    const { artifactPath, manifestPath, artifact } = await writeLegacySnapshot(id, 'auto');
    const entriesBefore = await readdir(backupsDir);

    await expect(service.pruneAutomaticSnapshots()).resolves.toEqual({
      removed: [],
      bytesFreed: 0,
    });

    expect(await readFile(artifactPath)).toEqual(artifact);
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toMatchObject({ id, kind: 'auto' });
    expect(await readdir(backupsDir)).toEqual(expect.arrayContaining(entriesBefore));
    expect(
      (await readdir(backupsDir)).some((name) => name.includes(`${id}.legacy-retained-`))
    ).toBe(false);
  });

  it('parks both files on legacy deletion and stops surfacing the snapshot', async () => {
    const id = 'legacy-delete-probe';
    const { artifactPath, manifestPath, artifact } = await writeLegacySnapshot(id, 'manual');

    await service.deleteSnapshot(id);

    await expect(readFile(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const parked = (await readdir(backupsDir)).filter((name) => name.startsWith(`${id}.`));
    const parkedArtifact = parked.find((name) => name.startsWith(`${id}.dump.legacy-retained-`));
    const parkedManifest = parked.find((name) => name.startsWith(`${id}.json.legacy-retained-`));
    expect(parkedArtifact).toBeDefined();
    expect(parkedManifest).toBeDefined();
    expect(await readFile(join(backupsDir, parkedArtifact!))).toEqual(artifact);
    expect(JSON.parse(await readFile(join(backupsDir, parkedManifest!), 'utf8'))).toMatchObject({
      id,
    });
    expect((await service.listSnapshots()).some((snapshot) => snapshot.id === id)).toBe(false);
  });

  it('lists PostgreSQL plain-gzip metadata without treating it as legacy', async () => {
    const id = 'postgres-portable-probe';
    const fileName = `${id}.sql.gz`;
    const artifact = Buffer.from('gzip-shaped-test-bytes');
    await writeFile(join(backupsDir, fileName), artifact);
    await writeFile(
      join(backupsDir, `${id}.json`),
      JSON.stringify({
        id,
        label: 'Portable PostgreSQL export',
        createdAt: '2026-07-22T12:00:00.000Z',
        sizeBytes: 0,
        dbName: 'snaglet',
        kind: 'manual',
        engine: 'postgres',
        format: 'plain-gzip',
        fileName,
        legacy: false,
        restorable: true,
      }),
      'utf8'
    );

    const listed = (await service.listSnapshots()).find((snapshot) => snapshot.id === id);

    expect(listed).toMatchObject({
      id,
      engine: 'postgres',
      format: 'plain-gzip',
      fileName,
      legacy: false,
      restorable: true,
      sizeBytes: artifact.byteLength,
    });
  });

  describe('unreadable manifests', () => {
    const written: string[] = [];

    afterEach(async () => {
      await Promise.all(written.splice(0).map((p) => rm(p, { force: true })));
    });

    async function writeArtifact(id: string): Promise<Buffer> {
      const artifact = Buffer.from(`postgres-custom-artifact:${id}`);
      const artifactPath = join(backupsDir, `${id}.dump`);
      await writeFile(artifactPath, artifact);
      written.push(artifactPath);
      return artifact;
    }

    async function writeManifestText(id: string, text: string): Promise<void> {
      const manifestPath = join(backupsDir, `${id}.json`);
      await writeFile(manifestPath, text, 'utf8');
      written.push(manifestPath);
    }

    function validManifest(id: string): string {
      return JSON.stringify({
        id,
        label: 'Valid snapshot',
        createdAt: '2026-08-01T00:00:00.000Z',
        sizeBytes: 0,
        dbName: 'snaglet',
        kind: 'manual',
        engine: 'postgres',
        format: 'custom',
        fileName: `${id}.dump`,
        legacy: false,
        restorable: true,
      });
    }

    async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
      return promise.then(
        () => {
          throw new Error('expected the call to reject, but it resolved');
        },
        (err: unknown) => err
      );
    }

    it('fails a corrupt manifest as snapshot-not-found instead of surfacing a SyntaxError', async () => {
      const id = 'corrupt-manifest-probe';
      await writeArtifact(id);
      await writeManifestText(id, '{"id": "corrupt-manifest-probe", "label": ');

      const err = await captureRejection(service.readSnapshotArtifact(id));

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect(getErrorMessage(err)).toBe(`Snapshot not found: ${id}`);
    });

    it('fails a missing manifest and a corrupt manifest identically', async () => {
      // Both paths land on the same operator-facing failure.
      const missingId = 'absent-manifest-probe';
      const corruptId = 'corrupt-twin-probe';
      await writeArtifact(corruptId);
      await writeManifestText(corruptId, 'this was never JSON');

      const missingErr = await captureRejection(service.readSnapshotArtifact(missingId));
      const corruptErr = await captureRejection(service.readSnapshotArtifact(corruptId));

      expect(getErrorMessage(missingErr)).toBe(`Snapshot not found: ${missingId}`);
      expect(getErrorMessage(corruptErr)).toBe(`Snapshot not found: ${corruptId}`);
    });

    it('fails manifests that parse but are not a manifest shape', async () => {
      // JSON.parse succeeds on `null`, arrays, and scalars, so the not-found
      // degrade cannot lean on parse failure alone.
      for (const [suffix, text] of [
        ['json-null', 'null'],
        ['json-array', '[]'],
        ['json-scalar', '42'],
        ['json-empty-object', '{}'],
      ]) {
        const id = `shape-probe-${suffix}`;
        await writeArtifact(id);
        await writeManifestText(id, text);

        const err = await captureRejection(service.readSnapshotArtifact(id));

        expect(getErrorMessage(err)).toBe(`Snapshot not found: ${id}`);
      }
    });

    it('fails a well-formed manifest whose id does not match the requested one', async () => {
      const id = 'id-mismatch-probe';
      await writeArtifact(id);
      await writeManifestText(id, validManifest('some-other-snapshot'));

      const err = await captureRejection(service.readSnapshotArtifact(id));

      expect(getErrorMessage(err)).toBe(`Snapshot not found: ${id}`);
    });

    it('still loads a valid manifest and its artifact', async () => {
      const id = 'valid-manifest-probe';
      const artifact = await writeArtifact(id);
      await writeManifestText(id, validManifest(id));

      await expect(service.readSnapshotArtifact(id)).resolves.toEqual({
        buffer: artifact,
        fileName: `${id}.dump`,
        contentType: 'application/octet-stream',
      });
    });
  });
});
