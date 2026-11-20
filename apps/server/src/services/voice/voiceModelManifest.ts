/**
 * voiceModelManifest — single source of truth for Snaglet's built-in local voice
 * models: streaming STT (sherpa-onnx zipformer transducer), the silero VAD, and
 * the piper TTS voice catalog. Mirrors `embedderModelManifest` /
 * `rerankerModelManifest` so the voice models share the same
 * manifest -> fetch (verify + atomic rename) -> load lifecycle via the shared
 * `services/localModels/` helpers.
 *
 * Every weight file is pinned to an immutable Hugging Face commit and carries
 * the real sha256 of that revision's bytes (verified after download), so a
 * silent upstream re-tag can never change the bytes under us.
 *
 * One exception to the per-file rule: piper's phonemizer data (`espeak-ng-data`,
 * 355 model-agnostic dictionary files, identical across every piper voice) is
 * fetched once from a single sha256-pinned sherpa release archive and shared by
 * all voices via each voice's sherpa `dataDir`. Enumerating 355 files per voice
 * would be neither maintainable nor cheaper — see `fetchArchive.ts`.
 *
 * Layout on disk (under the selected Snaglet home’s `models/`; the `~/.snaglet`
 * manifest prefix is resolved by expandHome/modelReadFilePath):
 *   stt/<STT_MODEL_ID>/{encoder,decoder,joiner}...int8.onnx, tokens.txt
 *   vad/<VAD_MODEL_ID>/silero_vad.onnx
 *   tts/<voiceId>/{<voiceId>.onnx,<voiceId>.onnx.json,tokens.txt}
 *   tts/espeak-ng-data/...            (shared phonemizer data)
 */

import path from 'node:path';
import { expandHome, type LocalModelManifest } from '../localModels/localModelManifest';

import { modelReadFilePath } from '../localModels/modelReadPaths';
import { archiveReadDir } from './archiveReadPaths';

// STT — sherpa-onnx streaming zipformer transducer (English, INT8)

/** Model id / on-disk dir name for the streaming STT model. */
const STT_MODEL_ID = 'sherpa-onnx-streaming-zipformer-en-2023-06-26';

/** Immutable HF commit the STT checksums below were computed against. */
const STT_MODEL_REVISION = '672fbf1b30579d6585301139bb363f42a0ad4a24';

/**
 * INT8 streaming zipformer transducer. The `chunk-16-left-128` variant is the
 * canonical low-latency streaming config (16-frame chunk, 128 left-context
 * frames). Encoder/decoder/joiner are all INT8 for the smallest footprint;
 * tokens.txt is the BPE token table the transducer decodes against.
 */
export const STT_MANIFEST: LocalModelManifest = {
  providerId: 'snaglet-local-voice',
  modelId: STT_MODEL_ID,
  hf: {
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26',
    revision: STT_MODEL_REVISION,
  },
  dir: `~/.snaglet/models/stt/${STT_MODEL_ID}`,
  files: [
    {
      repoPath: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      localPath: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1',
      bytes: 71_083_163,
    },
    {
      repoPath: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      localPath: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02',
      bytes: 1_307_236,
    },
    {
      repoPath: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      localPath: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297',
      bytes: 259_335,
    },
    {
      repoPath: 'tokens.txt',
      localPath: 'tokens.txt',
      sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb',
      bytes: 5_048,
    },
  ],
};

/** Roles the runtime resolves STT files by, mapped to manifest localPaths. */
const STT_ROLE_LOCAL_PATH = {
  encoder: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
  joiner: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
  tokens: 'tokens.txt',
} as const;

export type SttModelFileRole = keyof typeof STT_ROLE_LOCAL_PATH;

/** Absolute on-disk paths of the four STT model files, keyed by role. */
export function sttModelPaths(): Record<SttModelFileRole, string> {
  const out = {} as Record<SttModelFileRole, string>;
  for (const [role, localPath] of Object.entries(STT_ROLE_LOCAL_PATH)) {
    const file = STT_MANIFEST.files.find((f) => f.localPath === localPath);
    if (!file) throw new Error(`No STT model file for role "${role}"`);
    out[role as SttModelFileRole] = modelReadFilePath(STT_MANIFEST, file.localPath);
  }
  return out;
}

// Quality STT — sherpa-onnx Moonshine base (English, INT8): cased + punctuated
//
// The streaming zipformer above is fast but uppercase + unpunctuated + dated on
// conversational speech.
// Moonshine base is a short-utterance-optimized offline recognizer whose training
// text is cased and punctuated, so its output reads like natural writing. The
// voice pipeline re-decodes each FINALIZED utterance with this model and
// dispatches its text (two-tier STT); the zipformer still drives live
// partials for latency. Measured locally: exact transcript on a 4.1 s
// utterance, ~125 ms warm decode, ~730 ms cold recognizer construction.

/** Model id / on-disk dir name for the quality (offline) STT model. */
const QUALITY_STT_MODEL_ID = 'sherpa-onnx-moonshine-base-en-int8';

/** Immutable HF commit the quality-STT checksums below were computed against. */
const QUALITY_STT_MODEL_REVISION = '052b0798ad1bf046a140fdd4efcd9426530fa3f5';

/**
 * Moonshine base, INT8. sherpa-onnx's offline recognizer loads it as four ONNX
 * graphs — preprocessor, encoder, and an uncached/cached decoder pair — plus the
 * BPE tokens table. All checksums are the real bytes of the pinned revision
 * (verified after download).
 */
export const QUALITY_STT_MANIFEST: LocalModelManifest = {
  providerId: 'snaglet-local-voice',
  modelId: QUALITY_STT_MODEL_ID,
  hf: {
    repo: 'csukuangfj/sherpa-onnx-moonshine-base-en-int8',
    revision: QUALITY_STT_MODEL_REVISION,
  },
  dir: `~/.snaglet/models/stt/${QUALITY_STT_MODEL_ID}`,
  files: [
    {
      repoPath: 'preprocess.onnx',
      localPath: 'preprocess.onnx',
      sha256: 'ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2',
      bytes: 14_077_290,
    },
    {
      repoPath: 'encode.int8.onnx',
      localPath: 'encode.int8.onnx',
      sha256: '7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2',
      bytes: 50_311_494,
    },
    {
      repoPath: 'uncached_decode.int8.onnx',
      localPath: 'uncached_decode.int8.onnx',
      sha256: 'c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987',
      bytes: 122_120_451,
    },
    {
      repoPath: 'cached_decode.int8.onnx',
      localPath: 'cached_decode.int8.onnx',
      sha256: '2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03',
      bytes: 99_983_837,
    },
    {
      repoPath: 'tokens.txt',
      localPath: 'tokens.txt',
      sha256: '1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea',
      bytes: 436_688,
    },
  ],
};

/** Roles the runtime resolves quality-STT files by, mapped to manifest localPaths. */
const QUALITY_STT_ROLE_LOCAL_PATH = {
  preprocessor: 'preprocess.onnx',
  encoder: 'encode.int8.onnx',
  uncachedDecoder: 'uncached_decode.int8.onnx',
  cachedDecoder: 'cached_decode.int8.onnx',
  tokens: 'tokens.txt',
} as const;

export type QualitySttModelFileRole = keyof typeof QUALITY_STT_ROLE_LOCAL_PATH;

/** Absolute on-disk paths of the five quality-STT model files, keyed by role. */
export function qualitySttModelPaths(): Record<QualitySttModelFileRole, string> {
  const out = {} as Record<QualitySttModelFileRole, string>;
  for (const [role, localPath] of Object.entries(QUALITY_STT_ROLE_LOCAL_PATH)) {
    const file = QUALITY_STT_MANIFEST.files.find((f) => f.localPath === localPath);
    if (!file) throw new Error(`No quality-STT model file for role "${role}"`);
    out[role as QualitySttModelFileRole] = modelReadFilePath(QUALITY_STT_MANIFEST, file.localPath);
  }
  return out;
}

// VAD — silero VAD v5 (server-side safety VAD; primary VAD is client-side)

/** Model id / on-disk dir name for the silero VAD. */
const VAD_MODEL_ID = 'silero-vad-v5';

/** Immutable HF commit the VAD checksum below was computed against. */
const VAD_MODEL_REVISION = 'e71cae966052b992a7eca6b17738916ce0eca4ec';

/**
 * silero VAD v5 (full precision ONNX). The v5 export takes a 576-sample window
 * at 16 kHz (64 context samples prepended to the 512-sample frame) plus a
 * recurrent `state` tensor — see `sileroVad.ts`. Feeding a bare 512-sample
 * frame silently returns ~0 probabilities, so the context handling is baked in.
 */
export const VAD_MANIFEST: LocalModelManifest = {
  providerId: 'snaglet-local-voice',
  modelId: VAD_MODEL_ID,
  hf: {
    repo: 'onnx-community/silero-vad',
    revision: VAD_MODEL_REVISION,
  },
  dir: `~/.snaglet/models/vad/${VAD_MODEL_ID}`,
  files: [
    {
      repoPath: 'onnx/model.onnx',
      localPath: 'silero_vad.onnx',
      sha256: 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808',
      bytes: 2_243_022,
    },
  ],
};

/** Absolute on-disk path of the silero VAD ONNX model. */
export function vadModelPath(): string {
  return modelReadFilePath(VAD_MANIFEST, VAD_MANIFEST.files[0].localPath);
}

// TTS — piper vits voice catalog (sherpa-onnx offline TTS)

export interface VoiceCatalogEntry {
  /** Stable voice id — also the on-disk dir name and sherpa model basename. */
  readonly id: string;
  /** Human label for the agent-detail voice picker. */
  readonly label: string;
  /** One-line character sketch for the picker. */
  readonly description: string;
  /** Manifest for this voice's weight files (per-file sha256, pinned). */
  readonly manifest: LocalModelManifest;
}

/** Shared phonemizer data dir name (under `~/.snaglet/models/tts/`). */
export const ESPEAK_DATA_DIRNAME = 'espeak-ng-data';

interface VoiceManifestSpec {
  id: string;
  revision: string;
  onnxSha: string;
  onnxBytes: number;
  cfgSha: string;
  cfgBytes: number;
  tokensSha: string;
  tokensBytes: number;
}

function voiceManifest(s: VoiceManifestSpec): LocalModelManifest {
  return {
    providerId: 'snaglet-local-voice',
    modelId: s.id,
    hf: { repo: `csukuangfj/vits-piper-${s.id}`, revision: s.revision },
    dir: `~/.snaglet/models/tts/${s.id}`,
    files: [
      {
        repoPath: `${s.id}.onnx`,
        localPath: `${s.id}.onnx`,
        sha256: s.onnxSha,
        bytes: s.onnxBytes,
      },
      {
        repoPath: `${s.id}.onnx.json`,
        localPath: `${s.id}.onnx.json`,
        sha256: s.cfgSha,
        bytes: s.cfgBytes,
      },
      {
        repoPath: 'tokens.txt',
        localPath: 'tokens.txt',
        sha256: s.tokensSha,
        bytes: s.tokensBytes,
      },
    ],
  };
}

/**
 * Starter pack of four distinct piper voices (medium quality, ~63 MB each).
 * `en_US-amy-medium` is the deterministic default (see `DEFAULT_VOICE_ID`).
 * Note `en_GB-alan-medium`'s onnx is 5 bytes larger and `en_US-joe-medium`
 * ships a slightly different tokens table — both reflected below.
 */
const SHARED_TOKENS_SHA = '87c8ef66eae5473ed0cc0366b3964c736ca6c5f676c979522ea31234e47430b9';

export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
  {
    id: 'en_US-amy-medium',
    label: 'Amy (US, warm)',
    description: 'Warm, upbeat US-English female voice — the default voice.',
    manifest: voiceManifest({
      id: 'en_US-amy-medium',
      revision: '79936839cc9409b1a752a45c629fe21639e1c1b2',
      onnxSha: 'fbaa8e36d8f26fe6f3ebb65cab461e629d8b37a5b7c5fb78fb64317db73e1c25',
      onnxBytes: 63_201_425,
      cfgSha: '95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77',
      cfgBytes: 4882,
      tokensSha: SHARED_TOKENS_SHA,
      tokensBytes: 921,
    }),
  },
  {
    id: 'en_US-ryan-medium',
    label: 'Ryan (US, deep)',
    description: 'Deeper, measured US-English male voice.',
    manifest: voiceManifest({
      id: 'en_US-ryan-medium',
      revision: '2784cf0f7510312ed567a5d227bcbec28dcd661e',
      onnxSha: '8a4063318faeda9bf67f89d25b29cc4bd5fde8832422aa451a5d5d2647553081',
      onnxBytes: 63_201_425,
      cfgSha: '44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d',
      cfgBytes: 4883,
      tokensSha: SHARED_TOKENS_SHA,
      tokensBytes: 921,
    }),
  },
  {
    id: 'en_GB-alan-medium',
    label: 'Alan (UK)',
    description: 'British-English male voice — distinct accent from the US set.',
    manifest: voiceManifest({
      id: 'en_GB-alan-medium',
      revision: 'a449faf03a5e8e2eed012793ce95441d0738b605',
      onnxSha: 'd907c48857000940104a9ad3248a94617df917d1a525c9495490fdbf87fd54b2',
      onnxBytes: 63_201_430, // 5 bytes larger than the US voices
      cfgSha: 'c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e',
      cfgBytes: 4888,
      tokensSha: SHARED_TOKENS_SHA,
      tokensBytes: 921,
    }),
  },
  {
    id: 'en_US-joe-medium',
    label: 'Joe (US, casual)',
    description: 'Relaxed, conversational US-English male voice.',
    manifest: voiceManifest({
      id: 'en_US-joe-medium',
      revision: 'cda0697165d154bb152754dcdf4ea4ad13650e37',
      onnxSha: 'c9dc0dd883bd662937e8986af97efb25636c557469bde904dc4fcc9344cd2918',
      onnxBytes: 63_201_425,
      cfgSha: '3d6d5410b3795cb1950595247ef8f06190719e6fdbfa3a2356d8ec368e1aad33',
      cfgBytes: 4794,
      tokensSha: 'da19d3f9a439574f66c072baafced1d1c79f42d8c5981619ea9274a7ab0dbba5',
      tokensBytes: 899,
    }),
  },
];

/** All voice ids, in catalog order. */
export const VOICE_IDS: readonly string[] = VOICE_CATALOG.map((v) => v.id);

/**
 * The deterministic fallback voice used when an agent has no `voice` set, and
 * for a stored voice id the catalog no longer ships. Never random — agents
 * without a configured voice always speak as Amy.
 */
export const DEFAULT_VOICE_ID = 'en_US-amy-medium';

/** Look up a catalog entry by id, or `undefined` if unknown. */
export function findVoice(voiceId: string): VoiceCatalogEntry | undefined {
  return VOICE_CATALOG.find((v) => v.id === voiceId);
}

/**
 * Resolve a requested voice id to a catalog entry, falling back to the default
 * voice for unknown/empty ids. Returns the resolved id alongside the entry so
 * callers can tell whether a fallback happened.
 */
export function resolveVoice(voiceId: string | null | undefined): VoiceCatalogEntry {
  const found = voiceId ? findVoice(voiceId) : undefined;
  if (found) return found;
  const fallback = findVoice(DEFAULT_VOICE_ID);
  if (!fallback) throw new Error(`Default voice "${DEFAULT_VOICE_ID}" missing from catalog`);
  return fallback;
}

export interface VoiceModelPaths {
  /** Absolute path to the voice's vits ONNX model. */
  readonly model: string;
  /** Absolute path to the voice's tokens.txt. */
  readonly tokens: string;
  /** Absolute path to the shared espeak-ng-data dir (sherpa `dataDir`). */
  readonly dataDir: string;
}

/** Absolute directory the TTS voices + shared espeak data live under. */
function ttsRootDir(): string {
  return expandHome('~/.snaglet/models/tts');
}

/** Absolute path to the shared espeak-ng-data phonemizer directory. */
export function espeakDataDir(): string {
  return path.join(ttsRootDir(), ESPEAK_DATA_DIRNAME);
}

/**
 * Absolute on-disk paths sherpa needs to load a given voice: the vits model,
 * its tokens table, and the shared espeak data dir. Falls back to the default
 * voice for unknown ids.
 */
export function voiceModelPaths(voiceId: string | null | undefined): VoiceModelPaths {
  const entry = resolveVoice(voiceId);
  const modelFile = entry.manifest.files.find((f) => f.localPath === `${entry.id}.onnx`);
  const tokensFile = entry.manifest.files.find((f) => f.localPath === 'tokens.txt');
  if (!modelFile || !tokensFile) {
    throw new Error(`Voice "${entry.id}" manifest missing model/tokens file`);
  }
  return {
    model: modelReadFilePath(entry.manifest, modelFile.localPath),
    tokens: modelReadFilePath(entry.manifest, tokensFile.localPath),
    dataDir: archiveReadDir(ESPEAK_ARCHIVE),
  };
}

// espeak-ng-data — shared phonemizer archive (single pinned download)

export interface EspeakArchiveSpec {
  /** Immutable sherpa release asset URL for the archive. */
  readonly url: string;
  /** sha256 of the whole `.tar.bz2` archive (verified before extract). */
  readonly sha256: string;
  /** Archive size in bytes (progress/sanity). */
  readonly bytes: number;
  /**
   * Path within the archive to extract (its `espeak-ng-data` tree). The leading
   * component (`vits-piper-en_US-amy-medium/`) is stripped on extract so the
   * data lands at `~/.snaglet/models/tts/espeak-ng-data/`.
   */
  readonly member: string;
  /** Absolute destination dir the extracted data ends up in. */
  readonly destDir: string;
  /**
   * A file that exists inside the extracted tree — used as the idempotency
   * sentinel (present => already extracted, skip unless forced).
   */
  readonly sentinelRelPath: string;
  /** Built-in path eligible for verified shared-home reads. */
  readonly sharedPath?: string;
  /** SHA256 of sorted relative paths and file digests in the extracted tree. */
  readonly treeSha256?: string;
}

/**
 * espeak-ng-data is shipped inside every sherpa vits-piper release archive and
 * is byte-identical across voices, so we pull it once from the archive of the
 * default voice (Amy) and share it. Pinned to the immutable `tts-models`
 * release asset; the sha256 is of the whole archive. The archive's sha256 and
 * size, and the digest of its extracted espeak-ng-data tree (355 files, equal
 * to `treeSha256` below), were verified from a real download on 2026-11-16.
 */
export const ESPEAK_ARCHIVE: EspeakArchiveSpec = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-medium.tar.bz2',
  sha256: '9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264',
  bytes: 67_223_746,
  member: 'vits-piper-en_US-amy-medium/espeak-ng-data',
  get destDir() {
    return espeakDataDir();
  },
  sentinelRelPath: 'phontab',
  sharedPath: '~/.snaglet/models/tts/espeak-ng-data',
  // Generated from the checksum-verified archive using archiveTreeMatches’
  // sorted relative-path + NUL + per-file SHA256 + newline digest format.
  treeSha256: '1c2ec0747e40d30f8f123b65c93dcba64f2404195b3344ed614df41237df8332',
};
