/**
 * fetchModelFiles — per-file `onProgress` contract (byte-accurate install
 * progress). Fires once per file as it settles, carrying the pinned byte size
 * and whether it was downloaded this run or already present, so a caller can
 * drive a received/total progress bar. Uses an injected fetch + a throwaway
 * manifest in a temp dir — never the network or a real ~/.snaglet.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  fetchModelFiles,
  type FetchImpl,
  type FetchResponse,
  type ModelFileProgress,
} from '@server/services/localModels/fetchModelFiles';
import type { LocalModelManifest } from '@server/services/localModels/localModelManifest';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const A = Buffer.from('file-a-bytes');
const B = Buffer.from('file-b-bytes-longer');

function okResponse(body: Buffer): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('fetchModelFiles onProgress', () => {
  let dir: string;
  let manifest: LocalModelManifest;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-progress-'));
    manifest = {
      providerId: 'snaglet-local',
      modelId: 'test-model',
      hf: { repo: 'test/repo', revision: 'a'.repeat(40) },
      dir, // absolute — expandHome leaves it untouched, no ~/.snaglet touched
      files: [
        { repoPath: 'a.bin', localPath: 'a.bin', sha256: sha256(A), bytes: A.byteLength },
        { repoPath: 'b.bin', localPath: 'b.bin', sha256: sha256(B), bytes: B.byteLength },
      ],
    } as LocalModelManifest;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fires once per downloaded file with the pinned byte size and done=downloaded', async () => {
    const fetchImpl = jest.fn<FetchImpl>((url) =>
      Promise.resolve(okResponse(url.endsWith('a.bin') ? A : B))
    );
    const events: ModelFileProgress[] = [];

    await fetchModelFiles(manifest, { fetchImpl, onProgress: (p) => events.push(p) });

    expect(events).toEqual([
      { localPath: 'a.bin', bytes: A.byteLength, done: 'downloaded' },
      { localPath: 'b.bin', bytes: B.byteLength, done: 'downloaded' },
    ]);
    // Summing the reported bytes equals the manifest total — the denominator a
    // progress bar divides by.
    const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
    expect(events.reduce((n, e) => n + e.bytes, 0)).toBe(total);
  });

  it('reports an already-present file as done=present (no re-download)', async () => {
    const fetchImpl = jest.fn<FetchImpl>((url) =>
      Promise.resolve(okResponse(url.endsWith('a.bin') ? A : B))
    );
    // First run downloads both.
    await fetchModelFiles(manifest, { fetchImpl });
    fetchImpl.mockClear();

    const events: ModelFileProgress[] = [];
    await fetchModelFiles(manifest, { fetchImpl, onProgress: (p) => events.push(p) });

    expect(fetchImpl).not.toHaveBeenCalled(); // idempotent
    expect(events.map((e) => e.done)).toEqual(['present', 'present']);
    expect(events.every((e) => e.bytes > 0)).toBe(true);
  });
});
