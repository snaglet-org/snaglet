import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  fetchRerankerModel,
  type FetchImpl,
  type FetchResponse,
} from '@server/services/reranking/fetchRerankerModel';
import type { RerankerModelManifest } from '@server/services/reranking/rerankerModelManifest';
import { ModelFetchAbortedError } from '@server/services/localModels/fetchModelFiles';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const ONNX = Buffer.from('fake-onnx-weights');
const VOCAB = Buffer.from('[PAD]\n[UNK]\n[CLS]\n[SEP]\n');

function okResponse(body: Buffer): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('fetchRerankerModel', () => {
  let dir: string;
  let manifest: RerankerModelManifest;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-reranker-'));
    manifest = {
      providerId: 'snaglet-local',
      modelId: 'test-model',
      hf: { repo: 'test/repo', revision: 'a'.repeat(40) },
      dir, // absolute — expandHome leaves it untouched
      files: [
        {
          repoPath: 'onnx/model.onnx',
          localPath: 'onnx/model.onnx',
          sha256: sha256(ONNX),
          bytes: ONNX.byteLength,
        },
        {
          repoPath: 'vocab.txt',
          localPath: 'vocab.txt',
          sha256: sha256(VOCAB),
          bytes: VOCAB.byteLength,
        },
      ],
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads every file to the manifest path and verifies its checksum', async () => {
    const fetchImpl = jest.fn<FetchImpl>((url) =>
      Promise.resolve(okResponse(url.endsWith('vocab.txt') ? VOCAB : ONNX))
    );

    const result = await fetchRerankerModel({ manifest, fetchImpl });

    expect(result.downloaded).toEqual(['onnx/model.onnx', 'vocab.txt']);
    expect(result.present).toEqual([]);
    expect(await readFile(path.join(dir, 'onnx/model.onnx'))).toEqual(ONNX);
    expect(await readFile(path.join(dir, 'vocab.txt'))).toEqual(VOCAB);
    // URLs are the pinned HF resolve URLs.
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://huggingface.co/test/repo/resolve/${'a'.repeat(40)}/onnx/model.onnx`
    );
  });

  it('is idempotent — a valid existing copy is skipped, not re-fetched', async () => {
    const fetchImpl = jest.fn<FetchImpl>((url) =>
      Promise.resolve(okResponse(url.endsWith('vocab.txt') ? VOCAB : ONNX))
    );

    await fetchRerankerModel({ manifest, fetchImpl });
    fetchImpl.mockClear();

    const second = await fetchRerankerModel({ manifest, fetchImpl });
    expect(second.downloaded).toEqual([]);
    expect(second.present).toEqual(['onnx/model.onnx', 'vocab.txt']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-downloads when force is set even if a valid copy exists', async () => {
    const fetchImpl = jest.fn<FetchImpl>((url) =>
      Promise.resolve(okResponse(url.endsWith('vocab.txt') ? VOCAB : ONNX))
    );

    await fetchRerankerModel({ manifest, fetchImpl });
    fetchImpl.mockClear();

    const forced = await fetchRerankerModel({ manifest, fetchImpl, force: true });
    expect(forced.downloaded).toEqual(['onnx/model.onnx', 'vocab.txt']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a checksum mismatch and never writes the bad file', async () => {
    const fetchImpl = jest.fn<FetchImpl>(() =>
      Promise.resolve(okResponse(Buffer.from('corrupted')))
    );

    await expect(fetchRerankerModel({ manifest, fetchImpl })).rejects.toThrow(/checksum mismatch/);
    await expect(access(path.join(dir, 'onnx/model.onnx'))).rejects.toThrow();
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchImpl = jest.fn<FetchImpl>(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      })
    );

    await expect(fetchRerankerModel({ manifest, fetchImpl })).rejects.toThrow(/HTTP 404/);
  });

  describe('when installing is called off mid-fetch', () => {
    const fetchBoth = () =>
      jest.fn<FetchImpl>((url) =>
        Promise.resolve(okResponse(url.endsWith('vocab.txt') ? VOCAB : ONNX))
      );

    it('stops before installing and removes the files and folders this run installed', async () => {
      const shouldInstall = jest
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await expect(
        fetchRerankerModel({ manifest, fetchImpl: fetchBoth(), shouldInstall })
      ).rejects.toBeInstanceOf(ModelFetchAbortedError);

      expect(shouldInstall).toHaveBeenCalledTimes(2);
      await expect(access(path.join(dir, 'onnx'))).rejects.toThrow();
      await expect(access(path.join(dir, 'vocab.txt'))).rejects.toThrow();
    });

    it('downloads nothing when the install is called off before it starts', async () => {
      const fetchImpl = fetchBoth();

      await expect(
        fetchRerankerModel({ manifest, fetchImpl, shouldInstall: async () => false })
      ).rejects.toBeInstanceOf(ModelFetchAbortedError);

      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('keeps files that were already in place before the run', async () => {
      await mkdir(path.join(dir, 'onnx'), { recursive: true });
      await writeFile(path.join(dir, 'onnx/model.onnx'), ONNX);

      await expect(
        fetchRerankerModel({
          manifest,
          fetchImpl: fetchBoth(),
          shouldInstall: async () => false,
        })
      ).rejects.toBeInstanceOf(ModelFetchAbortedError);

      expect(await readFile(path.join(dir, 'onnx/model.onnx'))).toEqual(ONNX);
      await expect(access(path.join(dir, 'vocab.txt'))).rejects.toThrow();
    });
  });
});
