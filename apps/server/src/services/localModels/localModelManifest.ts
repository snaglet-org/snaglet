/**
 * localModelManifest — shared shape for Snaglet's built-in local ONNX model
 * manifests (reranker, embedder): the pinned Hugging Face source, the on-disk
 * layout under `~/.snaglet/models/`, and per-file integrity metadata. A manifest is
 * the single source of truth both the fetch script (download side) and the
 * runtime resolver (load side) read, so they can never disagree about paths.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { expandHomePath } from '@snaglet/shared/utils/paths';

export interface LocalModelFile {
  /** Path within the HF repo, e.g. `onnx/model_quantized.onnx`. */
  readonly repoPath: string;
  /** Path under the model directory — mirrors `repoPath` for these files. */
  readonly localPath: string;
  /** Lowercase hex sha256 of the file's bytes — verified after download. */
  readonly sha256: string;
  /** Size in bytes (sanity/progress; the sha256 is the real integrity check). */
  readonly bytes: number;
}

export interface LocalModelManifest {
  readonly providerId: string;
  readonly modelId: string;
  readonly hf: { readonly repo: string; readonly revision: string };
  /** Directory the files live in, with a literal `~` for the home directory. */
  readonly dir: string;
  readonly files: readonly LocalModelFile[];
}

/**
 * Resolve paths in local-model manifests. The built-in manifests store
 * `~/.snaglet/...`; that prefix means the selected Snaglet data home, not the
 * process user's OS home. Other `~/...` paths retain normal shell semantics.
 *
 * This is the write destination. modelReadPaths separately allows a verified,
 * read-only fallback to the default installation without changing HOME or
 * redirecting repairs into that other installation.
 */
export function expandHome(input: string): string {
  if (input === '~/.snaglet') return snagletDataHome();
  if (input.startsWith('~/.snaglet/'))
    return path.join(snagletDataHome(), input.slice('~/.snaglet/'.length));
  return expandHomePath(input);
}

/** The selected Snaglet data home. `SNAGLET_HOME` itself is `~`-expanded — dotenv
 * delivers `SNAGLET_HOME=~/.snaglet-dev` literally — so a tilde-configured home cannot
 * leak back out of this rewrite as an unexpanded prefix. */
function snagletDataHome(): string {
  const configured = process.env.SNAGLET_HOME?.trim();
  return configured ? expandHomePath(configured) : path.join(homedir(), '.snaglet');
}

/** Absolute on-disk path of a manifest file. */
export function modelFileAbsPath(file: LocalModelFile, manifest: LocalModelManifest): string {
  return path.join(expandHome(manifest.dir), file.localPath);
}

/** Hugging Face download URL for a manifest file, pinned to the revision. */
export function hfDownloadUrl(file: LocalModelFile, manifest: LocalModelManifest): string {
  const { repo, revision } = manifest.hf;
  return `https://huggingface.co/${repo}/resolve/${revision}/${file.repoPath}`;
}
