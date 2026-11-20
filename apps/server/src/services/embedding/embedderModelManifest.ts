/**
 * embedderModelManifest — the single source of truth for Snaglet's built-in local
 * embedding model: where its files live on disk and where they are fetched
 * from. Mirrors `rerankerModelManifest.ts` so the local embedder and reranker
 * share one lifecycle (manifest → fetch → verify → load) via the shared
 * `services/localModels/` helpers.
 *
 * Model: nomic-embed-text-v1.5 (bi-encoder, 768-dim, BERT/WordPiece tokenizer,
 * Matryoshka-capable, 8192-token context). We ship the int8-quantized ONNX
 * (~137 MB) — the size/quality sweet spot for a desktop app. Only the three
 * files the runtime actually loads are fetched — the quantized ONNX model, the
 * WordPiece `vocab.txt`, and `tokenizer_config.json`.
 *
 * Task prefixes: nomic-embed requires an instruction prefix on
 * every input. The `LocalEmbedderService` bakes these in so no caller can
 * forget them:
 *   - documents (ingest):  "search_document: <text>"
 *   - queries   (search):  "search_query: <text>"
 * See `EMBEDDER_TASK_PREFIXES` below; these are contract, not decoration.
 *
 * Checksums are the real SHA-256 of the pinned revision's files, verified
 * against Hugging Face (the ONNX file's LFS ETag and a fresh
 * download of the small files). The download is pinned to an immutable commit
 * `revision` so a silent upstream re-tag can never change the bytes under us.
 */

import type { LocalModelManifest } from '../localModels/localModelManifest';
import { expandHome } from '../localModels/localModelManifest';
import { modelReadFilePath } from '../localModels/modelReadPaths';

/** Immutable Hugging Face commit the checksums below were computed against. */
export const EMBEDDER_MODEL_REVISION = 'e9b6763023c676ca8431644204f50c2b100d9aab';

/** Provider id used in the providers catalog + `resolveEmbeddingProvider`. */
export const LOCAL_EMBEDDER_PROVIDER_ID = 'local-onnx';

/** Model id for the built-in embedder (matches the seed migration row). */
export const LOCAL_EMBEDDER_MODEL_ID = 'nomic-embed-text-v1.5';

/** Output dimensionality of nomic-embed-text-v1.5 (full, un-truncated). */
export const LOCAL_EMBEDDER_DIMENSIONS = 768;

/**
 * Max sequence length fed to the ONNX session (the tokenizer truncates).
 * nomic supports 8192, but ingest chunks are far smaller; cap at 512 to keep
 * per-call latency bounded. Raise only if chunk sizes grow — and keep
 * `contextWindowTokens` on the seeded models row in sync so the chunker
 * targets the same budget.
 */
export const LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS = 512;

/** Task-instruction prefixes required by nomic-embed. Baked in by the service. */
export const EMBEDDER_TASK_PREFIXES = {
  document: 'search_document: ',
  query: 'search_query: ',
} as const;

export type EmbedderTaskKind = keyof typeof EMBEDDER_TASK_PREFIXES;

export const EMBEDDER_MODEL_MANIFEST: LocalModelManifest = {
  providerId: LOCAL_EMBEDDER_PROVIDER_ID,
  modelId: LOCAL_EMBEDDER_MODEL_ID,
  hf: {
    repo: 'nomic-ai/nomic-embed-text-v1.5',
    // Immutable commit — pinning the revision makes the download reproducible
    // and protects against the upstream repo changing under us.
    revision: EMBEDDER_MODEL_REVISION,
  },
  dir: `~/.snaglet/models/embedders/${LOCAL_EMBEDDER_MODEL_ID}`,
  files: [
    {
      repoPath: 'onnx/model_quantized.onnx',
      localPath: 'onnx/model_quantized.onnx',
      sha256: 'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27',
      bytes: 137_296_292,
    },
    {
      repoPath: 'vocab.txt',
      localPath: 'vocab.txt',
      sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      bytes: 231_508,
    },
    {
      repoPath: 'tokenizer_config.json',
      localPath: 'tokenizer_config.json',
      sha256: 'd7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc',
      bytes: 1_191,
    },
  ],
};

/** Roles the runtime resolves files by, mapped to manifest localPaths. */
const ROLE_LOCAL_PATH = {
  model: 'onnx/model_quantized.onnx',
  vocab: 'vocab.txt',
  tokenizerConfig: 'tokenizer_config.json',
} as const;

export type EmbedderModelFileRole = keyof typeof ROLE_LOCAL_PATH;

/** Absolute on-disk path of an embedder model file, resolved by role. */
export function embedderModelFilePath(role: EmbedderModelFileRole): string {
  const localPath = ROLE_LOCAL_PATH[role];
  const file = EMBEDDER_MODEL_MANIFEST.files.find((f) => f.localPath === localPath);
  if (!file) throw new Error(`No embedder model file for role "${role}"`);
  return modelReadFilePath(EMBEDDER_MODEL_MANIFEST, file.localPath);
}

/** Absolute directory the embedder model files live in on disk. */
export function embedderModelDir(): string {
  return expandHome(EMBEDDER_MODEL_MANIFEST.dir);
}
