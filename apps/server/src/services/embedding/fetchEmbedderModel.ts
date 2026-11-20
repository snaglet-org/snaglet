/**
 * fetchEmbedderModel — download Snaglet's built-in local embedding model files into
 * the paths the runtime reads (`~/.snaglet/models/embedders/...`).
 *
 * Thin manifest-binding over the shared `fetchModelFiles` (see
 * `services/localModels/fetchModelFiles.ts`, which owns the
 * verify-before-write + atomic-rename download logic and is unit-tested with
 * injected manifests/fetchers).
 */

import {
  fetchModelFiles,
  type FetchImpl,
  type FetchModelFilesResult,
  type FetchResponse,
} from '../localModels/fetchModelFiles';
import type { LocalModelManifest } from '../localModels/localModelManifest';
import { EMBEDDER_MODEL_MANIFEST } from './embedderModelManifest';

export type { FetchImpl, FetchResponse };

export interface FetchEmbedderOptions {
  /** Re-download even if a valid copy already exists. */
  force?: boolean;
  /** Override the manifest (tests). Defaults to the built-in embedder. */
  manifest?: LocalModelManifest;
  /** Override the downloader (tests). Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Progress sink. Defaults to a no-op. */
  log?: (line: string) => void;
}

export type FetchEmbedderResult = FetchModelFilesResult;

export async function fetchEmbedderModel(
  options: FetchEmbedderOptions = {}
): Promise<FetchEmbedderResult> {
  const { manifest, ...rest } = options;
  return fetchModelFiles(manifest ?? EMBEDDER_MODEL_MANIFEST, rest);
}
