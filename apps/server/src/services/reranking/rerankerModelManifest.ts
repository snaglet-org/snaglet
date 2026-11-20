/**
 * rerankerModelManifest — the single source of truth for Snaglet's built-in local
 * reranker model: where its files live on disk and where they are fetched from.
 *
 * The runtime resolver (`LocalRerankerService.resolveModel`) loads the model's
 * on-disk paths + sha256 from the seeded `models` catalog row
 * (`packages/db/migrations/seeds/local-models.sql`). This manifest mirrors those values
 * so the fetch script can DOWNLOAD the files to exactly the paths the resolver
 * later reads. A unit test (`rerankerModelManifest.test.ts`) asserts the
 * manifest and the seed never drift.
 *
 * Source: the canonical, Apache-2.0 `cross-encoder/ms-marco-MiniLM-L6-v2` repo
 * on Hugging Face, pinned to an immutable commit. Only the three files the
 * runtime actually loads are fetched — the qint8/arm64 ONNX cross-encoder, the
 * WordPiece `vocab.txt`, and `tokenizer_config.json`; the repo's other
 * artifacts (full-precision ONNX variants, safetensors, etc.) are not needed.
 *
 * L6 vs the smaller `ms-marco-MiniLM-L2-v2`: same tokenizer family,
 * ~4-point MRR@10 gain on MS MARCO for ~1.5× the per-pair CPU cost. Reranking only runs on committed searches (≤50
 * candidates), so the latency trade is cheap.
 *
 * The manifest shape + path helpers are shared with the local embedder — see
 * `services/localModels/localModelManifest.ts`.
 */

import {
  expandHome,
  hfDownloadUrl as genericHfDownloadUrl,
  modelFileAbsPath as genericModelFileAbsPath,
  type LocalModelFile,
  type LocalModelManifest,
} from '../localModels/localModelManifest';

export type RerankerModelFile = LocalModelFile;
export type RerankerModelManifest = LocalModelManifest;

export { expandHome };

export const RERANKER_MODEL_MANIFEST: RerankerModelManifest = {
  providerId: 'snaglet-local',
  modelId: 'ms-marco-MiniLM-L6-v2-qint8-arm64',
  hf: {
    repo: 'cross-encoder/ms-marco-MiniLM-L6-v2',
    // Immutable commit — pinning the revision makes the download reproducible
    // and protects against the upstream repo changing under us.
    revision: 'c5ee24cb16019beea0893ab7796b1df96625c6b8',
  },
  dir: '~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2',
  files: [
    {
      repoPath: 'onnx/model_qint8_arm64.onnx',
      localPath: 'onnx/model_qint8_arm64.onnx',
      sha256: '3573b6b9593cb2f75987a31815d409ca3dd8808629118fd20451bb1a5d90cec7',
      bytes: 23_200_716,
    },
    // vocab + tokenizer config are byte-identical to the L2 predecessor's
    // (same BERT WordPiece family) but live under the L6 dir so the model
    // directory stays self-contained.
    {
      repoPath: 'vocab.txt',
      localPath: 'vocab.txt',
      sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      bytes: 231_508,
    },
    {
      repoPath: 'tokenizer_config.json',
      localPath: 'tokenizer_config.json',
      sha256: 'a5c2e5a7b1a29a0702cd28c08a399b5ecc110c263009d17f7e3b415f25905fd8',
      bytes: 1_330,
    },
  ],
};

/**
 * Older model dirs the manifest above does not use. The fetch script removes
 * these after a successful fetch so unused weights don't sit on disk.
 */
export const RETIRED_RERANKER_DIRS: readonly string[] = [
  '~/.snaglet/models/rerankers/ms-marco-MiniLM-L2-v2',
];

/** Absolute on-disk path of a manifest file. */
export function modelFileAbsPath(
  file: RerankerModelFile,
  manifest: RerankerModelManifest = RERANKER_MODEL_MANIFEST
): string {
  return genericModelFileAbsPath(file, manifest);
}

/** Hugging Face download URL for a manifest file, pinned to the revision. */
export function hfDownloadUrl(
  file: RerankerModelFile,
  manifest: RerankerModelManifest = RERANKER_MODEL_MANIFEST
): string {
  return genericHfDownloadUrl(file, manifest);
}
