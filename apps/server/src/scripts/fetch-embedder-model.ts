/**
 * fetch-embedder-model — download Snaglet's built-in local embedding model.
 *
 * The embedder (`LocalEmbedderService`) loads an ONNX bi-encoder + tokenizer
 * from the selected Snaglet home's `models/embedders/` directory. Without
 * this step embedding (and therefore vector search) stays unavailable. This
 * downloads the three required files from the pinned, checksum-verified
 * Hugging Face source (see `embedderModelManifest`) into the exact paths the
 * runtime reads.
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
 *   pnpm embedder:fetch [--strict] [--force]
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { loadModelFetchEnvironment } from './modelFetchEnvironment';
import { fetchEmbedderModel } from '../services/embedding/fetchEmbedderModel';
import { EMBEDDER_MODEL_MANIFEST } from '../services/embedding/embedderModelManifest';

const argv = new Set(process.argv.slice(2));
const STRICT = argv.has('--strict');
const FORCE = argv.has('--force');

async function main(): Promise<void> {
  loadModelFetchEnvironment(dirname(fileURLToPath(import.meta.url)));
  const manifest = EMBEDDER_MODEL_MANIFEST;
  console.log(`[embedder:fetch] ${manifest.providerId}/${manifest.modelId}`);
  console.log(`[embedder:fetch] source: ${manifest.hf.repo}@${manifest.hf.revision.slice(0, 12)}`);

  const result = await fetchEmbedderModel({
    force: FORCE,
    log: (line) => console.log(`  ${line}`),
  });

  console.log(`[embedder:fetch] target: ${result.dir}`);
  console.log(
    `[embedder:fetch] done — ${result.downloaded.length} downloaded, ${result.present.length} present`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[embedder:fetch] failed: ${getErrorMessage(err)}`);
    console.error('  Embedding + vector search stay unavailable until this succeeds.');
    console.error('  Retry with network access: pnpm embedder:fetch');
    process.exit(STRICT ? 1 : 0);
  });
