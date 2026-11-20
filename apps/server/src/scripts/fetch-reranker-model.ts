/**
 * fetch-reranker-model — download Snaglet's built-in local reranker model.
 *
 * The reranker (`LocalRerankerService`) loads an ONNX cross-encoder + tokenizer
 * from the selected Snaglet home's `models/rerankers/` directory. Without
 * this step opening-retrieval reranking degrades to a no-op. This downloads the
 * three required files from the pinned, checksum-verified Hugging Face source
 * (see `rerankerModelManifest`) into the exact paths the runtime resolver reads.
 * This is the manual opt-in: Snaglet uses the model only while the `reranker`
 * feature flag is on, and `db:init` runs this only with `--with-reranker`.
 *
 * Idempotent: a file already present with the right sha256 is left untouched.
 * Best-effort by default — a failure prints an actionable warning and exits 0
 * so it never blocks `db:init`; pass `--strict` to exit non-zero on failure
 * (CI / explicit installs). `--force` re-downloads even if present.
 *
 * Defaults to SNAGLET_ENV=dev and loads the same env files as the dev server.
 * Explicit SNAGLET_ENV/SNAGLET_HOME overrides are preserved.
 *
 * Usage:
 *   pnpm reranker:fetch [--strict] [--force]
 */

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { loadModelFetchEnvironment } from './modelFetchEnvironment';
import { fetchRerankerModel } from '../services/reranking/fetchRerankerModel';
import {
  RERANKER_MODEL_MANIFEST,
  RETIRED_RERANKER_DIRS,
  expandHome,
} from '../services/reranking/rerankerModelManifest';

const argv = new Set(process.argv.slice(2));
const STRICT = argv.has('--strict');
const FORCE = argv.has('--force');

async function main(): Promise<void> {
  loadModelFetchEnvironment(dirname(fileURLToPath(import.meta.url)));
  const manifest = RERANKER_MODEL_MANIFEST;
  console.log(`[reranker:fetch] ${manifest.providerId}/${manifest.modelId}`);
  console.log(`[reranker:fetch] source: ${manifest.hf.repo}@${manifest.hf.revision.slice(0, 12)}`);

  const result = await fetchRerankerModel({
    force: FORCE,
    log: (line) => console.log(`  ${line}`),
  });

  console.log(`[reranker:fetch] target: ${result.dir}`);
  console.log(
    `[reranker:fetch] done — ${result.downloaded.length} downloaded, ${result.present.length} present`
  );

  // Sweep superseded model dirs only after the current model is fully in
  // place, so an interrupted upgrade never leaves zero usable rerankers.
  for (const dir of RETIRED_RERANKER_DIRS) {
    const abs = expandHome(dir);
    await rm(abs, { recursive: true, force: true }).catch((err) => {
      console.warn(`[reranker:fetch] could not remove retired dir ${abs}: ${getErrorMessage(err)}`);
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[reranker:fetch] failed: ${getErrorMessage(err)}`);
    console.error('  Opening-retrieval reranking stays disabled until this succeeds.');
    console.error('  Retry with network access: pnpm reranker:fetch');
    process.exit(STRICT ? 1 : 0);
  });
