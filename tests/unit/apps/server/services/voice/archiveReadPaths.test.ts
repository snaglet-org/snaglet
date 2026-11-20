import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fetchArchive } from '@server/services/voice/fetchArchive';
import { archiveReadDir, archiveTreeMatches } from '@server/services/voice/archiveReadPaths';
import type { EspeakArchiveSpec } from '@server/services/voice/voiceModelManifest';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('archive shared reads', () => {
  it('reuses only a complete verified shared tree, invalidates cache after edits, and prefers selected home', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'snaglet-voice-read-'));
    roots.push(root);
    jest.spyOn(os, 'homedir').mockReturnValue(root);
    const sharedPath = '~/.snaglet/models/tts/espeak-ng-data';
    const shared = path.join(root, sharedPath.slice(2));
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, 'phontab'), 'fixture');
    const fileHash = createHash('sha256').update('fixture').digest('hex');
    const treeSha256 = createHash('sha256').update(`phontab\0${fileHash}\n`).digest('hex');
    const spec: EspeakArchiveSpec = {
      url: '',
      sha256: '',
      bytes: 0,
      member: 'espeak-ng-data',
      destDir: path.join(root, 'dev', 'espeak-ng-data'),
      sentinelRelPath: 'phontab',
      sharedPath,
      treeSha256,
    };
    expect(archiveReadDir(spec)).toBe(shared);
    expect(archiveReadDir(spec)).toBe(shared);
    const fetchImpl = jest.fn<() => Promise<never>>(async () => {
      throw new Error('download attempted');
    });
    expect(await fetchArchive(spec, { fetchImpl })).toEqual({ extracted: false, dir: shared });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchArchive(spec, { fetchImpl, force: true })).rejects.toThrow(
      'download attempted'
    );
    writeFileSync(path.join(shared, 'phontab'), 'corrupt');
    expect(archiveReadDir(spec)).toBe(spec.destDir);
    writeFileSync(path.join(shared, 'phontab'), 'fixture');
    writeFileSync(path.join(shared, 'extra'), 'unexpected');
    expect(archiveTreeMatches(shared, treeSha256)).toBe(false);
    mkdirSync(spec.destDir, { recursive: true });
    writeFileSync(path.join(spec.destDir, 'phontab'), 'local');
    expect(archiveReadDir(spec)).toBe(spec.destDir);
  });
});
