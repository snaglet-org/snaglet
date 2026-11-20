/**
 * Voice REST routes.
 * - POST /api/voice/preview {voiceId, text?} → WAV sample for the voice picker
 *   (503 when the audio engine is unavailable).
 * - GET /api/voice/capabilities → the selectable voices (piper, plus installed
 *   Apple voices on macOS) with namespaced ids; degrades to piper, never 503.
 * - POST /api/voice/speak-message {agentId?, text} → WAV for a message's listen
 *   button, even with voice mode off; no agent means the default voice.
 * - GET /api/voice/models/status → install state, per-mode capabilities and
 *   every catalog voice with its own state.
 * - POST /api/voice/models/install {voiceIds?} → install the base pieces plus
 *   the chosen voices (202; the status poll settles it).
 * - POST /api/voice/models/uninstall {voiceIds} → remove the chosen voices.
 * Synthesis goes through `synthesizeWav` (markdown spoken as prose), never raw text.
 */

import { Router } from 'express';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { asyncHandler } from '@server/middleware';
import {
  getVoiceEngine,
  piperVoiceInfos as piperCatalogFallback,
} from '@server/services/SocketService/voiceSession/engineAdapter';
import { resolveAgentVoiceId } from '@server/services/SocketService/voiceSession/resolveAgentVoice';
import { speakingVoiceId } from '@server/services/SocketService/voiceSession/speakingVoice';
import { engineSegmenter } from '@server/services/SocketService/voiceSession/speakability';
import { encodeWav } from '@server/services/SocketService/voiceSession/audioCodec';
import type { VoiceEngineApi } from '@server/services/SocketService/voiceSession/types';
import {
  DEFAULT_VOICE_ID,
  VOICE_SAMPLE_RATE,
} from '@server/services/SocketService/voiceSession/constants';
import { fetchVoiceModels, expectedVoiceModelBytes } from '@server/services/voice/fetchVoiceModels';
import {
  DEFAULT_VOICE_ID as PINNED_DEFAULT_VOICE_ID,
  ESPEAK_ARCHIVE,
  QUALITY_STT_MANIFEST,
  STT_MANIFEST,
  sttModelPaths,
  qualitySttModelPaths,
  VAD_MANIFEST,
  vadModelPath,
  VOICE_CATALOG,
  VOICE_IDS,
} from '@server/services/voice/voiceModelManifest';
import {
  installedVoiceIds,
  voiceLang,
  voiceModelId,
  voiceQuality,
} from '@server/services/voice/installedVoices';
import { archiveReadDir } from '@server/services/voice/archiveReadPaths';
import { access } from 'fs/promises';
import {
  getDisabledLocalModels,
  setLocalModelEnabled,
} from '@server/services/localModels/localModelPreferences';
import {
  clearSnagletVoiceStorageModel,
  getSnagletVoiceStorage,
} from '@server/services/snagletHome';

const router = Router();

const DEFAULT_PREVIEW_TEXT = 'Hi, this is how I sound. I can help you get things done.';
const MAX_PREVIEW_CHARS = 400;
// Chat messages run far longer than a preview sentence, but synthesis time
// scales with length (~15 chars/s, see ESTIMATED_CHARS_PER_SECOND) — cap so a
// pathologically long message can't hang the request for minutes.
const MAX_SPEAK_MESSAGE_CHARS = 2_000;

async function allPresent(paths: readonly string[]): Promise<boolean> {
  const present = await Promise.all(
    paths.map((file) =>
      access(file)
        .then(() => true)
        .catch(() => false)
    )
  );
  return present.every(Boolean);
}

type VoiceComponentKind = 'stt' | 'vad' | 'tts';

/**
 * What is on disk, read the way the engine loads it so a verified shared copy
 * (in ~/.snaglet/models, or a shared espeak dir) counts as installed. TTS is
 * the shared espeak data plus at least one installed voice (which voices comes
 * from disk too, see `installedVoiceIds`). Computed per call: files come and go.
 */
interface VoiceDiskState {
  present: Record<VoiceComponentKind, boolean>;
  espeak: boolean;
  installedVoices: string[];
}

async function voiceDiskState(): Promise<VoiceDiskState> {
  const stt = sttModelPaths();
  const qstt = qualitySttModelPaths();
  const [sttPresent, vadPresent, espeak, installedVoices] = await Promise.all([
    allPresent([...Object.values(stt), ...Object.values(qstt)]),
    allPresent([vadModelPath()]),
    allPresent([archiveReadDir(ESPEAK_ARCHIVE)]),
    installedVoiceIds(),
  ]);
  return {
    present: { stt: sttPresent, vad: vadPresent, tts: espeak && installedVoices.length > 0 },
    espeak,
    installedVoices,
  };
}

/**
 * Which components each voice mode needs for the resolved STT engine, matching
 * VoiceSessionService's gating. Dictation on Apple's recognizer needs no local
 * model; locally it needs STT + VAD. Voice mode always needs VAD (barge-in) +
 * TTS, plus STT when STT is local. `engine` is 'apple' only when the macOS
 * sidecar is actually usable.
 */
function modeNeeds(engine: 'apple' | 'local'): {
  dictate: VoiceComponentKind[];
  speak: VoiceComponentKind[];
} {
  const localStt = engine === 'local';
  return {
    dictate: localStt ? ['stt', 'vad'] : [],
    speak: localStt ? ['stt', 'vad', 'tts'] : ['vad', 'tts'],
  };
}

async function resolveSttEngine(): Promise<'apple' | 'local'> {
  const engine = await getVoiceEngine();
  return engine?.sttEngine === 'apple' ? 'apple' : 'local';
}

interface ModeCapability {
  /** Components this mode needs from the active engine (empty = nothing to download). */
  needs: VoiceComponentKind[];
  /** Every needed component is present on disk (an empty need is always ready). */
  ready: boolean;
}

interface VoiceCapabilities {
  /** Active STT engine: 'apple' = macOS on-device recognizer, 'local' = bundled ONNX. */
  sttEngine: 'apple' | 'local';
  dictate: ModeCapability;
  speak: ModeCapability;
}

/**
 * Per-mode capability report for the engine actually in use, so the client can
 * gate each voice toggle on only what that mode needs (and never prompt a Mac
 * for STT models dictation won't touch). With no voice installed, TTS is
 * missing and Voice mode is not ready, exactly as with no TTS files at all.
 * The presence check never hits the network and never touches a real
 * ~/.snaglet in tests (fs mocked).
 */
function voiceCapabilities(sttEngine: 'apple' | 'local', disk: VoiceDiskState): VoiceCapabilities {
  const needs = modeNeeds(sttEngine);
  const ready = (components: VoiceComponentKind[]): boolean =>
    components.every((component) => disk.present[component]);
  return {
    sttEngine,
    dictate: { needs: needs.dictate, ready: ready(needs.dictate) },
    speak: { needs: needs.speak, ready: ready(needs.speak) },
  };
}

/**
 * In-app voice-model install (Settings → Storage and the first-use mic prompt):
 * the base pieces (streaming + quality STT, VAD, espeak data) plus the chosen
 * voices. Files already on disk are verified and skipped, so the base pieces
 * download once. One install runs per process; a request for the same voices
 * (or a first-use prompt, which names none) joins it and both see the progress
 * at GET /models/status. Percent is exact: `fetchVoiceModels` reports every
 * file and `expectedVoiceModelBytes` sizes the same selection.
 */
const BASE_COMPONENTS = ['stt', 'vad', 'tts'] as const;
const BASE_MODEL_IDS = ['stt-streaming', 'stt-quality', 'vad', 'tts-espeak'] as const;

function installSelection(voiceIds: readonly string[]) {
  return { components: BASE_COMPONENTS, voiceIds };
}

/** The pinned size of a first-use install (the base pieces and the default voice). */
const FIRST_USE_SELECTION = installSelection([PINNED_DEFAULT_VOICE_ID]);

interface VoiceInstallProgress {
  receivedBytes: number;
  totalBytes: number;
}

let voiceInstall: Promise<void> | null = null;
let voiceInstallError: string | null = null;
let voiceInstallProgress: VoiceInstallProgress | null = null;
/** Voices the running install fetches. */
let installingVoiceIds: readonly string[] = [];
/** Voices of the last install that failed, until they are installed or uninstalled. */
let failedVoiceIds: readonly string[] = [];

const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the download server. Check your connection and retry.";

/**
 * Turn a download failure into a message a non-technical user can act on. A
 * connection/DNS failure (Node's global fetch throws `TypeError: fetch failed`
 * with a DNS/socket `cause`, or the message mentions getaddrinfo/ECONN…)
 * becomes plain language; everything else (an HTTP status, a checksum mismatch)
 * keeps its specific text.
 */
function toInstallErrorMessage(error: unknown): string {
  const raw = getErrorMessage(error);
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? getErrorMessage((error as { cause: unknown }).cause)
      : '';
  const haystack = `${raw} ${cause}`.toLowerCase();
  const networkMarkers = [
    'fetch failed',
    'getaddrinfo',
    'enotfound',
    'econnrefused',
    'econnreset',
    'etimedout',
    'network',
    'dns',
    'socket hang up',
  ];
  return networkMarkers.some((marker) => haystack.includes(marker)) ? NETWORK_ERROR_MESSAGE : raw;
}

function startVoiceInstall(voiceIds: readonly string[]): Promise<void> {
  if (voiceInstall) return voiceInstall;
  const selection = installSelection(voiceIds);
  voiceInstallError = null;
  failedVoiceIds = [];
  installingVoiceIds = voiceIds;
  voiceInstallProgress = {
    receivedBytes: 0,
    totalBytes: expectedVoiceModelBytes(selection),
  };
  voiceInstall = fetchVoiceModels({
    ...selection,
    onProgress: ({ bytes }) => {
      if (voiceInstallProgress) voiceInstallProgress.receivedBytes += bytes;
    },
  })
    .then(async () => {
      // Flip every installed piece on, so an earlier uninstall/removal doesn't
      // leave freshly-downloaded files disabled.
      await Promise.all(
        [...BASE_MODEL_IDS, ...voiceIds.map(voiceModelId)].map((id) =>
          setLocalModelEnabled(id, true)
        )
      );
    })
    .catch((error: unknown) => {
      voiceInstallError = toInstallErrorMessage(error);
      failedVoiceIds = voiceIds;
      throw error;
    })
    .finally(() => {
      voiceInstall = null;
      voiceInstallProgress = null;
      installingVoiceIds = [];
    });
  return voiceInstall;
}

/**
 * Test-only: clear the module-level install state (in-flight promise, error,
 * progress) so one test's install can't leak into the next. Never called by
 * the app; the install state is otherwise process-lifetime by design.
 */
export function __resetVoiceInstallStateForTest(): void {
  voiceInstall = null;
  voiceInstallError = null;
  voiceInstallProgress = null;
  installingVoiceIds = [];
  failedVoiceIds = [];
}

/** One catalog voice as Settings → Storage lists it. */
interface VoiceInstallInfo {
  id: string;
  name: string;
  description: string;
  /** BCP-47 language tag, e.g. `en-US`. */
  lang: string;
  /** Piper quality tier, e.g. `medium`. */
  quality: string;
  /** Pinned download size of the voice's own files. */
  downloadBytes: number;
  state: 'installed' | 'not-installed' | 'installing' | 'failed';
  error?: string;
}

const manifestBytes = (files: readonly { bytes: number }[]): number =>
  files.reduce((sum, file) => sum + file.bytes, 0);

function voiceInstallInfos(installed: readonly string[]): VoiceInstallInfo[] {
  return VOICE_CATALOG.map((voice) => {
    const info: VoiceInstallInfo = {
      id: voice.id,
      name: voice.label,
      description: voice.description,
      lang: voiceLang(voice.id),
      quality: voiceQuality(voice.id),
      downloadBytes: manifestBytes(voice.manifest.files),
      state: 'not-installed',
    };
    if (installed.includes(voice.id)) info.state = 'installed';
    else if (installingVoiceIds.includes(voice.id)) info.state = 'installing';
    else if (failedVoiceIds.includes(voice.id)) {
      info.state = 'failed';
      if (voiceInstallError) info.error = voiceInstallError;
    }
    return info;
  });
}

/** Pinned bytes of the base pieces not yet on disk: what any install adds besides voices. */
function baseMissingBytes(disk: VoiceDiskState): number {
  return (
    (disk.present.stt
      ? 0
      : manifestBytes(STT_MANIFEST.files) + manifestBytes(QUALITY_STT_MANIFEST.files)) +
    (disk.present.vad ? 0 : manifestBytes(VAD_MANIFEST.files)) +
    (disk.espeak ? 0 : ESPEAK_ARCHIVE.bytes)
  );
}

interface VoiceStatusInputs {
  sttEngine: 'apple' | 'local';
  disk: VoiceDiskState;
}

async function readVoiceStatusInputs(): Promise<VoiceStatusInputs> {
  const [sttEngine, disk] = await Promise.all([resolveSttEngine(), voiceDiskState()]);
  return { sttEngine, disk };
}

/**
 * The install status every voice-model route answers with: the overall state,
 * progress while a download runs, per-mode capabilities, and every catalog
 * voice with its own state. Synchronous over the disk state read beforehand, so
 * an install route can start the download and answer with the state it just
 * entered.
 */
function voiceModelStatusBody({ sttEngine, disk }: VoiceStatusInputs): Record<string, unknown> {
  const capabilities = voiceCapabilities(sttEngine, disk);
  const ready =
    capabilities.speak.ready &&
    capabilities.dictate.ready &&
    disk.present.stt &&
    disk.present.vad &&
    disk.present.tts;
  const state = voiceInstall
    ? 'downloading'
    : ready
      ? 'ready'
      : voiceInstallError
        ? 'failed'
        : 'not-installed';
  const body: Record<string, unknown> = {
    state,
    // The pinned size of a first-use install, from the manifest — always present
    // so the prompt's size text is computed ("~469 MB"), never hardcoded.
    expectedTotalBytes: expectedVoiceModelBytes(FIRST_USE_SELECTION),
    baseMissingBytes: baseMissingBytes(disk),
    defaultVoiceId: PINNED_DEFAULT_VOICE_ID,
    voices: voiceInstallInfos(disk.installedVoices),
    capabilities,
  };
  if (state === 'downloading' && voiceInstallProgress) {
    const { receivedBytes, totalBytes } = voiceInstallProgress;
    body.receivedBytes = receivedBytes;
    body.totalBytes = totalBytes;
    body.percent =
      totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  }
  if (state === 'failed' && voiceInstallError) body.error = voiceInstallError;
  return body;
}

/**
 * Read `voiceIds` from a request body: `null` when absent, else the known ids
 * in catalog order. Anything else (not a string array, an unknown id) is an
 * error message for a 400.
 */
function readVoiceIds(body: unknown): { voiceIds: string[] | null } | { error: string } {
  const raw = (body ?? {}) as { voiceIds?: unknown };
  if (raw.voiceIds === undefined) return { voiceIds: null };
  if (!Array.isArray(raw.voiceIds) || raw.voiceIds.some((id) => typeof id !== 'string')) {
    return { error: 'voiceIds must be a list of voice ids.' };
  }
  const requested = new Set(raw.voiceIds as string[]);
  const unknown = [...requested].filter((id) => !VOICE_IDS.includes(id));
  if (unknown.length > 0) return { error: `Unknown voice: ${unknown.join(', ')}` };
  return { voiceIds: VOICE_IDS.filter((id) => requested.has(id)) };
}

const sameVoices = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

router.get('/models/status', async (_req, res) => {
  // Report per-mode capabilities and per-voice states on every status read, so
  // the client can gate each toggle on what that mode needs for the active
  // engine (e.g. a Mac never prompts for STT models dictation won't use).
  // Computed even mid-download so a joining caller still learns what each mode
  // needs.
  res.json(voiceModelStatusBody(await readVoiceStatusInputs()));
});

router.post('/models/install', async (req, res) => {
  // `voiceIds` names the voices to install with the base pieces; an empty list
  // installs the base pieces only. Without it (the first-use prompt), the
  // installed voices are kept current, or the default voice is installed.
  const parsed = readVoiceIds(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (voiceInstall && parsed.voiceIds && !sameVoices(parsed.voiceIds, installingVoiceIds)) {
    res.status(409).json({ error: 'Another voice install is running. Wait for it to finish.' });
    return;
  }
  const inputs = await readVoiceStatusInputs();
  const installed = inputs.disk.installedVoices;
  const voiceIds =
    parsed.voiceIds ?? (installed.length > 0 ? installed : [PINNED_DEFAULT_VOICE_ID]);
  // Answer at once — never hold the request for the whole multi-hundred-MB
  // download. Start (or join) the install and return 202 with the current
  // status; the client's 1s status poll settles it to 'ready'/'failed'.
  // Fire-and-forget: the download's outcome is already captured into
  // voiceInstallError by startVoiceInstall's own .catch and surfaces via the
  // status poll. Log here only so this floating promise never becomes an
  // unhandled rejection.
  void startVoiceInstall(voiceIds).catch((err: unknown) => {
    logger.debug(`[voice] background install settled with error: ${getErrorMessage(err)}`);
  });
  res.status(202).json(voiceModelStatusBody(inputs));
});

router.post('/models/uninstall', async (req, res) => {
  // Deletes the named voices' files and marks them uninstalled. The shared
  // espeak data and the speech models stay, as removing a voice in Storage
  // always has: reinstalling a voice is then just that voice's download.
  const parsed = readVoiceIds(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!parsed.voiceIds || parsed.voiceIds.length === 0) {
    res.status(400).json({ error: 'voiceIds must name at least one voice.' });
    return;
  }
  if (voiceInstall) {
    res.status(409).json({ error: 'A voice install is running. Wait for it to finish.' });
    return;
  }
  try {
    const storage = await getSnagletVoiceStorage();
    let freedBytes = 0;
    for (const voiceId of parsed.voiceIds) {
      const id = voiceModelId(voiceId);
      freedBytes += storage.find((model) => model.id === id)?.bytes ?? 0;
      await clearSnagletVoiceStorageModel(id);
    }
    failedVoiceIds = failedVoiceIds.filter((id) => !parsed.voiceIds?.includes(id));
    res.json({ ...voiceModelStatusBody(await readVoiceStatusInputs()), freedBytes });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

/**
 * Synthesize already-speakable `sentences` in `voiceId` and wrap every frame
 * in one WAV buffer. Shared by /preview and /speak-message — both buffer the
 * whole utterance and ship a single playable file (no PlaybackQueue/
 * streaming; see playOneShot.ts on the client for why one-shot needs no
 * queue). Synthesizes one sentence at a time (mirrors the auto voice-mode
 * catch-up path's `speakWhole` in ttsPipeline.ts) and concatenates PCM frames
 * across all of them. Throws on a known voice whose model files are absent/
 * corrupt; callers turn that into a 503 rather than a generic 500.
 */
async function synthesizeWav(
  engine: VoiceEngineApi,
  sentences: readonly string[],
  voiceId: string
): Promise<Buffer> {
  const chunks: Int16Array[] = [];
  let sampleRate = VOICE_SAMPLE_RATE;
  for (const sentence of sentences) {
    for await (const frame of engine.synthesize(sentence, voiceId)) {
      chunks.push(frame.pcm16);
      if (frame.sampleRate > 0) sampleRate = frame.sampleRate;
    }
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }

  return encodeWav(pcm, sampleRate);
}

/**
 * Turn raw (possibly markdown-laden) text into the speakable sentence list
 * `synthesizeWav` synthesizes — the same segment+filter composition the auto
 * voice-mode pipeline uses (`engineSegmenter` in `./speakability`), so a
 * message with `**bold**`, `# heading`, `` `code` ``, links, `@mentions`, etc.
 * is spoken as clean prose instead of literal markdown.
 */
function toSpeakableSentences(text: string): string[] {
  return engineSegmenter.segment(text).map((s) => s.text);
}

router.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    // The selectable-voice catalog the VoicePicker consumes: the piper catalog
    // (always) plus any INSTALLED Apple voices (hybrid engine, darwin only). Each
    // entry is namespaced (piper bare, apple `apple:`-prefixed) so the value the
    // picker stores routes to the right engine. Never 503s — with no engine at
    // all we still return the static piper catalog so the picker has a list.
    const engine = await getVoiceEngine();
    const voices = engine?.listVoices ? await engine.listVoices() : piperCatalogFallback();
    const disabled = await getDisabledLocalModels();
    res.json({
      voices: voices.filter(
        (voice) => voice.engine !== 'piper' || !disabled.has(`tts:${voice.id}`)
      ),
    });
  })
);

router.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const engine = await getVoiceEngine();
    if (!engine) {
      res.status(503).json({ error: 'voice engine unavailable' });
      return;
    }

    const body = (req.body ?? {}) as { voiceId?: unknown; text?: unknown };
    const voiceId =
      typeof body.voiceId === 'string' && body.voiceId.trim().length > 0
        ? body.voiceId.trim()
        : DEFAULT_VOICE_ID;
    const rawText =
      typeof body.text === 'string' && body.text.trim().length > 0
        ? body.text.trim()
        : DEFAULT_PREVIEW_TEXT;
    const text = rawText.slice(0, MAX_PREVIEW_CHARS);
    const sentences = toSpeakableSentences(text);

    try {
      const wav = await synthesizeWav(engine, sentences, voiceId);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.send(wav);
    } catch {
      // A known voice whose model files are absent/corrupt on disk. Surface a
      // clear, non-500 signal so the picker can say "voice not installed —
      // download them in Settings → Storage" instead of a generic error toast.
      res.status(503).json({ error: `voice model unavailable: ${voiceId}` });
    }
  })
);

router.post(
  '/speak-message',
  asyncHandler(async (req, res) => {
    const engine = await getVoiceEngine();
    if (!engine) {
      res.status(503).json({ error: 'voice engine unavailable' });
      return;
    }

    const body = (req.body ?? {}) as { agentId?: unknown; text?: unknown };
    // No agentId (or one that doesn't resolve to a configured voice) → the
    // deterministic default. That covers both the "unknown agent" case and
    // the USER-message re-listen case, which has no agent to look up at all.
    // Either way an uninstalled voice speaks as the first installed one.
    const agentId =
      typeof body.agentId === 'string' && body.agentId.trim().length > 0
        ? body.agentId.trim()
        : null;
    const voiceId = agentId
      ? await resolveAgentVoiceId(agentId)
      : await speakingVoiceId(DEFAULT_VOICE_ID);

    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    if (!rawText) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const text = rawText.slice(0, MAX_SPEAK_MESSAGE_CHARS);
    const sentences = toSpeakableSentences(text);

    try {
      const wav = await synthesizeWav(engine, sentences, voiceId);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.send(wav);
    } catch {
      res.status(503).json({ error: `voice model unavailable: ${voiceId}` });
    }
  })
);

export default router;
