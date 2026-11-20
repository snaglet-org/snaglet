import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { modelReadDir, modelReadFilePath } from '@server/services/localModels/modelReadPaths';
import { fetchModelFiles } from '@server/services/localModels/fetchModelFiles';
import type { LocalModelManifest } from '@server/services/localModels/localModelManifest';

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  homedir: jest.fn(),
}));

describe('shared model fallback', () => {
  let root: string;
  let local: string;
  let shared: string;
  let savedHome: string | undefined;
  const data = Buffer.from('verified model fixture');
  const manifest: LocalModelManifest = {
    providerId: 'test',
    modelId: 'test',
    dir: '~/.snaglet/models/embedders/test',
    hf: { repo: 'test/test', revision: 'pinned' },
    files: ['onnx/model.onnx', 'vocab.txt', 'tokenizer_config.json'].map((localPath) => ({
      localPath,
      repoPath: localPath,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };

  function install(dir: string): void {
    for (const file of manifest.files) {
      const dest = path.join(dir, file.localPath);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
  }

  beforeEach(() => {
    savedHome = process.env.SNAGLET_HOME;
    root = mkdtempSync(path.join(os.tmpdir(), 'snaglet-model-fallback-'));
    jest.mocked(os.homedir).mockReturnValue(root);
    process.env.SNAGLET_HOME = path.join(root, '.snaglet-dev');
    local = path.join(root, '.snaglet-dev/models/embedders/test');
    shared = path.join(root, '.snaglet/models/embedders/test');
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.SNAGLET_HOME;
    else process.env.SNAGLET_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a complete verified shared bundle without creating a local directory', () => {
    install(shared);
    expect(modelReadDir(manifest)).toBe(shared);
    for (const file of manifest.files) {
      expect(modelReadFilePath(manifest, file.localPath)).toBe(path.join(shared, file.localPath));
    }
    expect(existsSync(local)).toBe(false);
  });

  it('prefers a complete local bundle, leaving its existing validation to the runtime', () => {
    install(local);
    install(shared);
    writeFileSync(path.join(local, 'vocab.txt'), 'local override');
    expect(modelReadDir(manifest)).toBe(local);
  });

  it('uses the whole shared bundle when the local bundle is partial', () => {
    install(shared);
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, 'vocab.txt'), 'partial local version');
    expect(modelReadFilePath(manifest, 'vocab.txt')).toBe(path.join(shared, 'vocab.txt'));
  });

  it('rejects incomplete or modified shared bundles, including after a cached verification', () => {
    install(shared);
    expect(modelReadDir(manifest)).toBe(shared);
    writeFileSync(path.join(shared, 'vocab.txt'), 'corrupt');
    expect(modelReadDir(manifest)).toBe(local);
    rmSync(path.join(shared, 'vocab.txt'));
    expect(modelReadDir(manifest)).toBe(local);
  });

  it('does not reinterpret a custom absolute manifest directory', () => {
    install(shared);
    const custom = path.join(root, 'custom-model');
    expect(modelReadDir({ ...manifest, dir: custom })).toBe(custom);
  });

  it('skips downloads and reports the shared location when it can be reused', async () => {
    install(shared);
    const fetchImpl = jest.fn<() => Promise<never>>();
    const result = await fetchModelFiles(manifest, { fetchImpl });
    expect(result).toEqual({
      downloaded: [],
      present: manifest.files.map((file) => file.localPath),
      dir: shared,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(local)).toBe(false);
  });

  it.each([false, true])(
    'repairs locally without changing shared files (force=%s)',
    async (force) => {
      install(shared);
      if (!force) writeFileSync(path.join(shared, 'vocab.txt'), 'corrupt');
      const before = readFileSync(path.join(shared, 'vocab.txt'));
      const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Uint8Array.from(data).buffer,
      }));
      const result = await fetchModelFiles(manifest, { force, fetchImpl });
      expect(result.dir).toBe(local);
      expect(result.downloaded).toHaveLength(3);
      expect(readFileSync(path.join(shared, 'vocab.txt'))).toEqual(before);
      expect(modelReadDir(manifest)).toBe(local);
    }
  );
});
