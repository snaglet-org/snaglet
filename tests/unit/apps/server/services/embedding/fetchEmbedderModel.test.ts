/**
 * fetchEmbedderModel is a thin binding of the shared `fetchModelFiles` engine
 * (whose download/verify/atomic-write behavior is covered in depth by
 * fetchRerankerModel.test.ts) to the embedder manifest. These tests pin the
 * binding: the wrapper honors an injected manifest, verifies checksums, and
 * is idempotent.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  fetchEmbedderModel,
  type FetchImpl,
  type FetchResponse,
} from '@server/services/embedding/fetchEmbedderModel';
import { EMBEDDER_MODEL_MANIFEST } from '@server/services/embedding/embedderModelManifest';
import type { LocalModelManifest } from '@server/services/localModels/localModelManifest';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const ONNX = Buffer.from('fake-embedder-weights');
const VOCAB = Buffer.from('[PAD]\n[UNK]\n[CLS]\n[SEP]\n');

function okResponse(body: Buffer): FetchResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

describe('fetchEmbedderModel', () => {
  let dir: string;
  let manifest: LocalModelManifest;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'snaglet-embedder-'));
    manifest = {
      providerId: 'local-onnx',
      modelId: 'test-embedder',
      hf: { repo: 'test/repo', revision: 'b'.repeat(40) },
      dir, // absolute — expandHome leaves it untouched
      files: [
        {
          repoPath: 'onnx/model_quantized.onnx',
          localPath: 'onnx/model_quantized.onnx',
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

  it('downloads to the manifest paths from pinned-revision URLs', async () => {
    const urls: string[] = [];
    const fetchImpl = jest.fn<FetchImpl>(async (url) => {
      urls.push(url);
      return okResponse(url.includes('onnx') ? ONNX : VOCAB);
    });

    const result = await fetchEmbedderModel({ manifest, fetchImpl });

    expect(result.downloaded).toEqual(['onnx/model_quantized.onnx', 'vocab.txt']);
    expect(result.present).toEqual([]);
    expect(urls).toEqual([
      `https://huggingface.co/test/repo/resolve/${'b'.repeat(40)}/onnx/model_quantized.onnx`,
      `https://huggingface.co/test/repo/resolve/${'b'.repeat(40)}/vocab.txt`,
    ]);
    expect(await readFile(path.join(dir, 'onnx/model_quantized.onnx'))).toEqual(ONNX);
    expect(await readFile(path.join(dir, 'vocab.txt'))).toEqual(VOCAB);
  });

  it('rejects checksum mismatches without leaving files behind', async () => {
    const fetchImpl = jest.fn<FetchImpl>(async () => okResponse(Buffer.from('tampered')));

    await expect(fetchEmbedderModel({ manifest, fetchImpl })).rejects.toThrow(/checksum mismatch/);
    await expect(readFile(path.join(dir, 'onnx/model_quantized.onnx'))).rejects.toThrow();
  });

  it('is idempotent: valid files present are not re-downloaded', async () => {
    const fetchImpl = jest.fn<FetchImpl>(async (url) =>
      okResponse(url.includes('onnx') ? ONNX : VOCAB)
    );
    await fetchEmbedderModel({ manifest, fetchImpl });
    fetchImpl.mockClear();

    const result = await fetchEmbedderModel({ manifest, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.downloaded).toEqual([]);
    expect(result.present).toEqual(['onnx/model_quantized.onnx', 'vocab.txt']);
  });

  it('defaults to the real embedder manifest', async () => {
    // Sanity-pin the default binding without touching disk: a fetchImpl that
    // rejects everything proves which manifest drove the URLs.
    const urls: string[] = [];
    const fetchImpl = jest.fn<FetchImpl>(async (url) => {
      urls.push(url);
      return {
        ok: false,
        status: 503,
        statusText: 'nope',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

    // Force so pre-existing local files (dev machines) don't short-circuit.
    await expect(fetchEmbedderModel({ fetchImpl, force: true })).rejects.toThrow(/download failed/);
    expect(urls[0]).toContain(EMBEDDER_MODEL_MANIFEST.hf.repo);
    expect(urls[0]).toContain(EMBEDDER_MODEL_MANIFEST.hf.revision);
  });
});
