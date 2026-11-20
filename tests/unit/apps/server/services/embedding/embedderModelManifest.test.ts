/**
 * Guards the embedder manifest's invariants: the prefix contract strings, the
 * 768-dim constant, pinned-revision URLs, and the role→path resolution the
 * runtime loads files by. If any of these drift, embedding output (and every
 * stored vector) silently changes — fail loudly here instead.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `modelReadFilePath` may fall back to a verified copy under the OS home
// (`~/.snaglet/models`). Point homedir at an empty scratch dir so the role→path
// assertions below stay about SNAGLET_HOME on every machine, including ones that
// have the real model installed in ~/.snaglet.
const EMPTY_OS_HOME = mkdtempSync(path.join(tmpdir(), 'snaglet-embedder-manifest-home-'));
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  homedir: () => EMPTY_OS_HOME,
}));
afterAll(() => rmSync(EMPTY_OS_HOME, { recursive: true, force: true }));
import {
  EMBEDDER_MODEL_MANIFEST,
  EMBEDDER_MODEL_REVISION,
  EMBEDDER_TASK_PREFIXES,
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS,
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
  embedderModelDir,
  embedderModelFilePath,
} from '@server/services/embedding/embedderModelManifest';
import { hfDownloadUrl } from '@server/services/localModels/localModelManifest';
import { SNAGLET_HOME } from '@server/services/snagletHome';

describe('embedderModelManifest', () => {
  it('pins the exact task-prefix contract strings', () => {
    // These are part of nomic-embed's input format — not free to change.
    expect(EMBEDDER_TASK_PREFIXES.document).toBe('search_document: ');
    expect(EMBEDDER_TASK_PREFIXES.query).toBe('search_query: ');
  });

  it('declares the identity constants the seed migration mirrors', () => {
    expect(LOCAL_EMBEDDER_PROVIDER_ID).toBe('local-onnx');
    expect(LOCAL_EMBEDDER_MODEL_ID).toBe('nomic-embed-text-v1.5');
    expect(LOCAL_EMBEDDER_DIMENSIONS).toBe(768);
    expect(LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS).toBe(512);
    expect(EMBEDDER_MODEL_MANIFEST.providerId).toBe(LOCAL_EMBEDDER_PROVIDER_ID);
    expect(EMBEDDER_MODEL_MANIFEST.modelId).toBe(LOCAL_EMBEDDER_MODEL_ID);
  });

  it('pins downloads to an immutable revision with checksums for every file', () => {
    expect(EMBEDDER_MODEL_MANIFEST.hf.revision).toBe(EMBEDDER_MODEL_REVISION);
    expect(EMBEDDER_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(EMBEDDER_MODEL_MANIFEST.files.length).toBe(3);
    for (const file of EMBEDDER_MODEL_MANIFEST.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
      expect(hfDownloadUrl(file, EMBEDDER_MODEL_MANIFEST)).toBe(
        `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/${EMBEDDER_MODEL_REVISION}/${file.repoPath}`
      );
    }
  });

  it('resolves every runtime role to a manifest-backed absolute path', () => {
    const dir = embedderModelDir();
    expect(dir).toBe(path.join(SNAGLET_HOME, 'models', 'embedders', LOCAL_EMBEDDER_MODEL_ID));
    expect(embedderModelFilePath('model')).toBe(path.join(dir, 'onnx', 'model_quantized.onnx'));
    expect(embedderModelFilePath('vocab')).toBe(path.join(dir, 'vocab.txt'));
    expect(embedderModelFilePath('tokenizerConfig')).toBe(path.join(dir, 'tokenizer_config.json'));
  });
});
