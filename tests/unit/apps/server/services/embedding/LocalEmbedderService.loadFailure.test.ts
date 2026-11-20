/**
 * LocalEmbedderService — what a failed session load costs the next caller.
 *
 * Runs the real checksum gate against a small temp "model" whose pinned
 * sha256 is swapped into the manifest, with ONNX and the tokenizer mocked.
 * Reads of the model file are counted to prove an unchanged file is hashed
 * once, while a changed file is re-verified immediately.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockModel = { file: '', vocabFile: '', sha256: '' };

jest.mock('@server/services/embedding/embedderModelManifest', () => {
  const actual = jest.requireActual<
    typeof import('@server/services/embedding/embedderModelManifest')
  >('@server/services/embedding/embedderModelManifest');
  return {
    ...actual,
    EMBEDDER_MODEL_MANIFEST: {
      ...actual.EMBEDDER_MODEL_MANIFEST,
      files: [
        {
          localPath: 'onnx/model_quantized.onnx',
          get sha256() {
            return mockModel.sha256;
          },
        },
      ],
    },
    embedderModelFilePath: (role: string) =>
      role === 'model' ? mockModel.file : mockModel.vocabFile,
  };
});

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});

jest.mock('onnxruntime-node', () => {
  const create = jest.fn(async () => ({
    inputNames: ['input_ids', 'attention_mask'],
    outputNames: ['last_hidden_state'],
    run: async () => ({
      last_hidden_state: { dims: [1, 3, 768], data: new Float32Array(3 * 768).fill(0.1) },
    }),
    release: async () => undefined,
  }));
  class FakeTensor {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: number[]
    ) {}
  }
  return { Tensor: FakeTensor, InferenceSession: { create } };
});

jest.mock('@server/services/reranking/WordPieceTokenizer', () => ({
  WordPieceTokenizer: {
    fromFiles: async () => ({
      padTokenId: 0,
      encodeSingle: () => ({
        inputIds: [101, 2001, 102],
        attentionMask: [1, 1, 1],
        tokenTypeIds: [0, 0, 0],
      }),
    }),
  },
}));

import * as fsPromises from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import {
  embedDocument,
  forceIdleUnloadForTests,
  resetLocalEmbedderForTests,
} from '@server/services/embedding/LocalEmbedderService';

const create = ort.InferenceSession.create as unknown as jest.Mock<() => Promise<unknown>>;
const readFileMock = fsPromises.readFile as unknown as jest.Mock;

const FULL_MODEL = 'complete-model-bytes';
const BACKOFF_MS = 30_000;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function modelReads(): number {
  return readFileMock.mock.calls.filter(([file]) => file === mockModel.file).length;
}

let dir: string;
let now: number;
let dateNow: jest.SpiedFunction<typeof Date.now>;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snaglet-embedder-load-failure-'));
  mockModel.file = path.join(dir, 'model_quantized.onnx');
  mockModel.vocabFile = path.join(dir, 'vocab.txt');
  mockModel.sha256 = sha256(FULL_MODEL);
  writeFileSync(mockModel.vocabFile, '[PAD]\n[UNK]\nhello\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.SNAGLET_EMBEDDER_MODEL_FILE;
  delete process.env.SNAGLET_EMBEDDER_VOCAB_FILE;
  delete process.env.SNAGLET_EMBEDDER_TOKENIZER_CONFIG_FILE;
  resetLocalEmbedderForTests();
  jest.clearAllMocks();
  writeFileSync(mockModel.file, FULL_MODEL);
  now = 1_000_000;
  dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  dateNow.mockRestore();
  resetLocalEmbedderForTests();
});

describe('LocalEmbedderService — session load failures', () => {
  it('replays a failed load while the model file is unchanged, without re-reading it', async () => {
    create.mockRejectedValueOnce(new Error('onnx refused the graph'));

    await expect(embedDocument('first')).rejects.toThrow('onnx refused the graph');
    await expect(embedDocument('second')).rejects.toThrow('onnx refused the graph');
    await expect(embedDocument('third')).rejects.toThrow('onnx refused the graph');

    expect(create).toHaveBeenCalledTimes(1);
    expect(modelReads()).toBe(1);
  });

  it('retries after the backoff, reusing the checksum of the unchanged file', async () => {
    create.mockRejectedValueOnce(new Error('onnx refused the graph'));
    await expect(embedDocument('first')).rejects.toThrow('onnx refused the graph');

    now += BACKOFF_MS - 1;
    await expect(embedDocument('inside the backoff')).rejects.toThrow('onnx refused the graph');
    expect(create).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(embedDocument('after the backoff')).resolves.toHaveLength(768);
    expect(create).toHaveBeenCalledTimes(2);
    expect(modelReads()).toBe(1);
  });

  it('re-verifies immediately when the file changes, e.g. a download finishing', async () => {
    writeFileSync(mockModel.file, 'partial');
    await expect(embedDocument('first')).rejects.toThrow(/checksum mismatch/);
    await expect(embedDocument('second')).rejects.toThrow(/checksum mismatch/);
    expect(modelReads()).toBe(1);
    expect(create).not.toHaveBeenCalled();

    writeFileSync(mockModel.file, FULL_MODEL);
    await expect(embedDocument('download finished')).resolves.toHaveLength(768);
    expect(modelReads()).toBe(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('loads as soon as a missing model file appears', async () => {
    unlinkSync(mockModel.file);
    await expect(embedDocument('first')).rejects.toThrow(/missing/);

    writeFileSync(mockModel.file, FULL_MODEL);
    await expect(embedDocument('fetched')).resolves.toHaveLength(768);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('LocalEmbedderService — verified checksum on reload', () => {
  it('reloads an unchanged model after idle unload without re-hashing it', async () => {
    await expect(embedDocument('first')).resolves.toHaveLength(768);
    await forceIdleUnloadForTests();
    await expect(embedDocument('after unload')).resolves.toHaveLength(768);

    expect(create).toHaveBeenCalledTimes(2);
    expect(modelReads()).toBe(1);
  });

  it('still rejects bytes that changed after a successful load', async () => {
    await expect(embedDocument('first')).resolves.toHaveLength(768);
    await forceIdleUnloadForTests();

    writeFileSync(mockModel.file, 'tampered-bytes');
    await expect(embedDocument('after tamper')).rejects.toThrow(/checksum mismatch/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(modelReads()).toBe(2);
  });
});
