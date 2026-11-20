/**
 * fetchRerankerModel — download Snaglet's built-in local reranker model files into
 * the paths the runtime resolver reads (`~/.snaglet/models/rerankers/...`).
 *
 * Thin manifest-binding over the shared `fetchModelFiles` (see
 * `services/localModels/fetchModelFiles.ts`, which owns the
 * verify-before-write + atomic-rename download logic). Kept as its own module
 * so callers/tests keep a reranker-named API with the reranker manifest as
 * the default.
 */

import {
  fetchModelFiles,
  type FetchImpl,
  type FetchModelFilesResult,
  type FetchResponse,
} from '../localModels/fetchModelFiles';
import { RERANKER_MODEL_MANIFEST, type RerankerModelManifest } from './rerankerModelManifest';

export type { FetchImpl, FetchResponse };

export interface FetchRerankerOptions {
  /** Re-download even if a valid copy already exists. */
  force?: boolean;
  /** Override the manifest (tests). Defaults to the built-in reranker. */
  manifest?: RerankerModelManifest;
  /** Override the downloader (tests). Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Progress sink. Defaults to a no-op. */
  log?: (line: string) => void;
  /** Asked before each downloaded file is installed; false stops and cleans up. */
  shouldInstall?: () => Promise<boolean>;
}

export type FetchRerankerResult = FetchModelFilesResult;

export async function fetchRerankerModel(
  options: FetchRerankerOptions = {}
): Promise<FetchRerankerResult> {
  const { manifest, ...rest } = options;
  return fetchModelFiles(manifest ?? RERANKER_MODEL_MANIFEST, rest);
}
