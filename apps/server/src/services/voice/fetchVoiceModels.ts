/**
 * fetchVoiceModels — download Snaglet's built-in local voice models into the paths
 * the runtime reads (selected Snaglet home’s `models/{stt,vad,tts}/...`).
 *
 * Thin orchestration over the shared `fetchModelFiles` (per-file sha256 +
 * atomic rename) for every pinned weight file, plus `fetchArchive` for the
 * shared piper `espeak-ng-data`. Selectable so callers/tests can fetch just one
 * component (e.g. the smoke script fetches STT + VAD + the default voice only).
 */

import {
  fetchModelFiles,
  type FetchImpl,
  type FetchModelFilesResult,
  type ModelFileProgress,
} from '../localModels/fetchModelFiles';

export type { FetchModelFilesResult } from '../localModels/fetchModelFiles';
import type { LocalModelManifest } from '../localModels/localModelManifest';
import { fetchArchive, type ExtractImpl, type FetchArchiveResult } from './fetchArchive';
import {
  ESPEAK_ARCHIVE,
  QUALITY_STT_MANIFEST,
  STT_MANIFEST,
  VAD_MANIFEST,
  VOICE_CATALOG,
  type VoiceCatalogEntry,
} from './voiceModelManifest';

export type VoiceComponent = 'stt' | 'vad' | 'tts';

export interface FetchVoiceModelsOptions {
  /** Which components to fetch. Defaults to all three. */
  components?: readonly VoiceComponent[];
  /** For 'tts': restrict to these voice ids. Defaults to the full catalog. */
  voiceIds?: readonly string[];
  /** Re-download even if a valid copy already exists. */
  force?: boolean;
  /** Override the downloader (tests). Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Override the archive extractor (tests). Defaults to spawning `tar`. */
  extractImpl?: ExtractImpl;
  /** Progress sink. Defaults to a no-op. */
  log?: (line: string) => void;
  /**
   * Structured per-file progress sink (download OR already-present), fired once
   * as each file settles. Carries the file's byte size so a caller can drive a
   * received/total progress bar; pair it with `expectedVoiceModelBytes` for the
   * same selection to know the denominator. Defaults to a no-op.
   */
  onProgress?: (progress: ModelFileProgress) => void;
}

/**
 * Total pinned byte size of a component/voice selection — the denominator for
 * the byte progress `onProgress` reports. Computed from the same manifests the
 * fetch walks, so the two always agree (streaming + quality STT, VAD, the
 * shared espeak archive, and each selected TTS voice's files).
 */
export function expectedVoiceModelBytes(options: FetchVoiceModelsOptions = {}): number {
  const components = new Set(options.components ?? (['stt', 'vad', 'tts'] as const));
  const sumFiles = (m: LocalModelManifest): number => m.files.reduce((n, f) => n + f.bytes, 0);
  let total = 0;
  if (components.has('stt')) {
    total += sumFiles(STT_MANIFEST) + sumFiles(QUALITY_STT_MANIFEST);
  }
  if (components.has('vad')) {
    total += sumFiles(VAD_MANIFEST);
  }
  if (components.has('tts')) {
    total += ESPEAK_ARCHIVE.bytes;
    const wanted = options.voiceIds ? new Set(options.voiceIds) : null;
    const voices = wanted ? VOICE_CATALOG.filter((v) => wanted.has(v.id)) : VOICE_CATALOG;
    for (const voice of voices) total += sumFiles(voice.manifest);
  }
  return total;
}

export interface FetchVoiceModelsResult {
  stt?: FetchModelFilesResult;
  /** Quality (offline Moonshine) STT — fetched alongside the streaming STT. */
  qualityStt?: FetchModelFilesResult;
  vad?: FetchModelFilesResult;
  voices: Array<{ id: string; result: FetchModelFilesResult }>;
  espeak?: FetchArchiveResult;
}

async function fetchManifest(
  manifest: LocalModelManifest,
  opts: FetchVoiceModelsOptions
): Promise<FetchModelFilesResult> {
  return fetchModelFiles(manifest, {
    force: opts.force,
    fetchImpl: opts.fetchImpl,
    log: opts.log,
    onProgress: opts.onProgress,
  });
}

export async function fetchVoiceModels(
  options: FetchVoiceModelsOptions = {}
): Promise<FetchVoiceModelsResult> {
  const components = new Set(options.components ?? (['stt', 'vad', 'tts'] as const));
  const log = options.log ?? (() => {});
  const result: FetchVoiceModelsResult = { voices: [] };

  if (components.has('stt')) {
    log(`[stt] ${STT_MANIFEST.hf.repo}@${STT_MANIFEST.hf.revision.slice(0, 12)}`);
    result.stt = await fetchManifest(STT_MANIFEST, options);
    // Quality tier (offline Moonshine) rides the same component — the two-tier
    // STT needs both the streaming zipformer AND this cased+punctuated re-decoder.
    log(
      `[stt:quality] ${QUALITY_STT_MANIFEST.hf.repo}@${QUALITY_STT_MANIFEST.hf.revision.slice(0, 12)}`
    );
    result.qualityStt = await fetchManifest(QUALITY_STT_MANIFEST, options);
  }

  if (components.has('vad')) {
    log(`[vad] ${VAD_MANIFEST.hf.repo}@${VAD_MANIFEST.hf.revision.slice(0, 12)}`);
    result.vad = await fetchManifest(VAD_MANIFEST, options);
  }

  if (components.has('tts')) {
    // Shared phonemizer data first — a voice without it can't synthesize.
    log(`[tts] espeak-ng-data (shared)`);
    result.espeak = await fetchArchive(ESPEAK_ARCHIVE, {
      force: options.force,
      fetchImpl: options.fetchImpl,
      extractImpl: options.extractImpl,
      log,
      onProgress: options.onProgress,
    });

    const wanted = options.voiceIds ? new Set(options.voiceIds) : null;
    const voices: readonly VoiceCatalogEntry[] = wanted
      ? VOICE_CATALOG.filter((v) => wanted.has(v.id))
      : VOICE_CATALOG;
    for (const voice of voices) {
      log(`[tts] ${voice.id}@${voice.manifest.hf.revision.slice(0, 12)}`);
      const r = await fetchManifest(voice.manifest, options);
      result.voices.push({ id: voice.id, result: r });
    }
  }

  return result;
}
