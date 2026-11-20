/**
 * fetchArchive — the espeak-ng-data download/verify/extract helper. Verifies the
 * sha256 before publishing, is idempotent via a sentinel, atomically swaps the
 * extracted tree into place, and never runs a real `tar` (extractor injected).
 */

import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fetchArchive, type ExtractImpl } from '@server/services/voice/fetchArchive';
import type { FetchImpl, FetchResponse } from '@server/services/localModels/fetchModelFiles';
import type { EspeakArchiveSpec } from '@server/services/voice/voiceModelManifest';

const BODY = Buffer.from('fake-tar-bz2-bytes');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function okResponse(body: Buffer): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false
  );

describe('fetchArchive', () => {
  let root: string;
  let spec: EspeakArchiveSpec;
  /** Fake extractor: create <intoDir>/espeak-ng-data/phontab. */
  const extractImpl: ExtractImpl = async ({ intoDir }) => {
    const dir = path.join(intoDir, 'espeak-ng-data');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'phontab'), 'x');
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'snaglet-espeak-'));
    spec = {
      url: 'https://example.com/vits-piper-en_US-amy-medium.tar.bz2',
      sha256: sha256(BODY),
      bytes: BODY.byteLength,
      member: 'vits-piper-en_US-amy-medium/espeak-ng-data',
      destDir: path.join(root, 'espeak-ng-data'),
      sentinelRelPath: 'phontab',
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('downloads, verifies, and extracts into the destination', async () => {
    const fetchImpl = jest.fn<FetchImpl>(async () => okResponse(BODY));
    const result = await fetchArchive(spec, { fetchImpl, extractImpl });
    expect(result.extracted).toBe(true);
    expect(await exists(path.join(spec.destDir, 'phontab'))).toBe(true);
  });

  it('is idempotent: skips when the sentinel already exists', async () => {
    await mkdir(spec.destDir, { recursive: true });
    await writeFile(path.join(spec.destDir, 'phontab'), 'x');
    const fetchImpl = jest.fn<FetchImpl>(async () => okResponse(BODY));
    const result = await fetchArchive(spec, { fetchImpl, extractImpl });
    expect(result.extracted).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-extracts when forced', async () => {
    await mkdir(spec.destDir, { recursive: true });
    await writeFile(path.join(spec.destDir, 'phontab'), 'x');
    const fetchImpl = jest.fn<FetchImpl>(async () => okResponse(BODY));
    const result = await fetchArchive(spec, { fetchImpl, extractImpl, force: true });
    expect(result.extracted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a checksum mismatch without publishing', async () => {
    const fetchImpl = jest.fn<FetchImpl>(async () => okResponse(Buffer.from('tampered')));
    await expect(fetchArchive(spec, { fetchImpl, extractImpl })).rejects.toThrow(
      /checksum mismatch/
    );
    expect(await exists(spec.destDir)).toBe(false);
  });

  it('throws if extraction produced no sentinel', async () => {
    const fetchImpl = jest.fn<FetchImpl>(async () => okResponse(BODY));
    const badExtract: ExtractImpl = async ({ intoDir }) => {
      await mkdir(path.join(intoDir, 'espeak-ng-data'), { recursive: true });
      // no phontab written
    };
    await expect(fetchArchive(spec, { fetchImpl, extractImpl: badExtract })).rejects.toThrow(
      /phontab/
    );
    expect(await exists(spec.destDir)).toBe(false);
  });

  it('propagates a failed download', async () => {
    const fetchImpl = jest.fn<FetchImpl>(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(fetchArchive(spec, { fetchImpl, extractImpl })).rejects.toThrow(/HTTP 404/);
  });
});
