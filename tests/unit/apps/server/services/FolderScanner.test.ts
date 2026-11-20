import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { FolderScanner } from '@server/services/FolderScanner';

describe('FolderScanner request-owned mutations', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'snaglet-folder-scanner-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeFolder(name: string, source: string): Promise<void> {
    const folder = path.join(rootDir, name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'definition.json'), '{"name":"owned-tool"}', 'utf-8');
    await writeFile(path.join(folder, 'tool.ts'), source, 'utf-8');
  }

  it('serializes a scan behind an owned write and acknowledges exactly that source state', async () => {
    const onUpsert = jest.fn(async () => undefined);
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert,
      onRemove: async () => undefined,
    });

    let racingScan: Promise<void> | undefined;
    await scanner.withOwnedUpsert('owned-tool', async (checkpointSource) => {
      await writeFolder('owned-tool', 'export default () => 1;');
      const commitFingerprint = await checkpointSource();
      racingScan = scanner.scan();
      await Promise.resolve();
      commitFingerprint();
    });
    await racingScan;

    expect(onUpsert).not.toHaveBeenCalled();
    await scanner.scan();
    expect(onUpsert).not.toHaveBeenCalled();

    await writeFile(
      path.join(rootDir, 'owned-tool', 'tool.ts'),
      'export default () => 222222;',
      'utf-8'
    );
    await scanner.scan();
    await scanner.scan();
    expect(onUpsert).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a failed owned mutation, so the next scan retries it', async () => {
    const onUpsert = jest.fn(async () => undefined);
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert,
      onRemove: async () => undefined,
    });
    // Keep the failure path deterministic: suppress its fire-and-forget retry,
    // then drive the required reconciliation explicitly.
    scanner.stop();

    await expect(
      scanner.withOwnedUpsert('owned-tool', async (checkpointSource) => {
        await writeFolder('owned-tool', 'export default () => 333;');
        await checkpointSource();
        throw new Error('DB sync failed');
      })
    ).rejects.toThrow('DB sync failed');

    await scanner.scan();
    expect(onUpsert).toHaveBeenCalledTimes(1);
  });

  it('allows direct metadata work when the folder is incomplete without acknowledging it', async () => {
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert: async () => undefined,
      onRemove: async () => undefined,
    });
    scanner.stop();
    const folder = path.join(rootDir, 'owned-tool');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'definition.json'), '{"name":"owned-tool"}', 'utf-8');
    const directSync = jest.fn(async () => undefined);

    await expect(
      scanner.withOwnedUpsert('owned-tool', async (checkpointSource) => {
        const commitFingerprint = await checkpointSource();
        await directSync();
        commitFingerprint();
      })
    ).resolves.toBeUndefined();
    expect(directSync).toHaveBeenCalledTimes(1);
  });

  it('serializes two request mutations for the same canonical folder', async () => {
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert: async () => undefined,
      onRemove: async () => undefined,
    });
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = scanner.withOwnedUpsert('owned-tool', async (checkpointSource) => {
      order.push('first:start');
      await writeFolder('owned-tool', 'export default () => 1;');
      const commitFingerprint = await checkpointSource();
      markFirstStarted();
      await firstBarrier;
      commitFingerprint();
      order.push('first:end');
    });
    await firstStarted;

    const second = scanner.withOwnedUpsert('owned-tool', async (checkpointSource) => {
      order.push('second:start');
      await writeFolder('owned-tool', 'export default () => 22222;');
      const commitFingerprint = await checkpointSource();
      commitFingerprint();
      order.push('second:end');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps deletion scanner-owned and retries a transient remove failure', async () => {
    const onRemove = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('temporary DB failure'))
      .mockResolvedValue(undefined);
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert: async () => undefined,
      onRemove,
    });

    await writeFolder('owned-tool', 'export default () => 1;');
    await scanner.scan();
    scanner.stop();
    await scanner.withOwnedRemove('owned-tool', async () => {
      await rm(path.join(rootDir, 'owned-tool'), { recursive: true, force: true });
    });

    expect(onRemove).toHaveBeenCalledTimes(1);
    await scanner.scan();
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onRemove).toHaveBeenLastCalledWith('owned-tool');
  });

  it('removes through the callback even before the scanner has seen the folder', async () => {
    const onRemove = jest.fn(async () => undefined);
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert: async () => undefined,
      onRemove,
    });
    await writeFolder('owned-tool', 'export default () => 1;');

    await scanner.withOwnedRemove('owned-tool', async () => {
      await rm(path.join(rootDir, 'owned-tool'), { recursive: true, force: true });
    });

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('owned-tool');
  });

  it('rejects non-child ownership keys', async () => {
    const scanner = new FolderScanner({
      dir: rootDir,
      kind: 'test',
      requiredFiles: ['definition.json', 'tool.ts'],
      onUpsert: async () => undefined,
      onRemove: async () => undefined,
    });

    await expect(scanner.withOwnedUpsert('../escape', async () => undefined)).rejects.toThrow(
      'Invalid direct-child folder name'
    );
  });
});
