/**
 * fetch-voice-models — download Snaglet's built-in local voice models.
 *
 * The voice engine (`VoiceEngineService`) loads a streaming STT model, the
 * silero VAD, and the piper TTS voice catalog from the selected Snaglet home’s `models/{stt,vad,tts}`.
 * Nothing else ships those files, so without this step voice mode stays
 * unavailable. This downloads every pinned, checksum-verified file from the
 * sources in `voiceModelManifest` into the exact paths the runtime reads.
 *
 * Idempotent: a file already present with the right sha256 is left untouched.
 * Best-effort by default — a failure prints an actionable warning and exits 0
 * so it never blocks install; pass `--strict` to exit non-zero on failure
 * (CI / explicit installs). `--force` re-downloads even if present.
 *
 * Defaults to SNAGLET_ENV=dev and loads checkout env files like pnpm dev.
 * Explicit SNAGLET_ENV/SNAGLET_HOME overrides are preserved. Verified shared-home models
 * are reused without copying; --force writes into the selected home.
 *
 * Flags:
 *   --strict           exit non-zero on failure
 *   --force            re-download even if present
 *   --only=stt,vad,tts limit to these components (default: all)
 *   --voices=a,b       limit TTS to these voice ids (default: full catalog)
 *
 * Usage:
 *   pnpm --filter @snaglet/server voice:fetch [--strict] [--force] [--only=stt,vad,tts] [--voices=en_US-amy-medium]
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelFetchEnvironment } from './modelFetchEnvironment';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  fetchVoiceModels,
  type VoiceComponent,
  type FetchModelFilesResult,
} from '../services/voice/fetchVoiceModels';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => !a.includes('=')));
const kv = new Map(
  argv
    .filter((a) => a.includes('='))
    .map((a) => {
      const [k, v] = a.split('=');
      return [k, v] as const;
    })
);

const STRICT = flags.has('--strict');
const FORCE = flags.has('--force');
const onlyRaw = kv.get('--only');
const voicesRaw = kv.get('--voices');

const components = onlyRaw ? (onlyRaw.split(',').filter(Boolean) as VoiceComponent[]) : undefined;
const voiceIds = voicesRaw ? voicesRaw.split(',').filter(Boolean) : undefined;

function summarize(label: string, r: FetchModelFilesResult): void {
  console.log(
    `[voice:fetch] ${label} — ${r.downloaded.length} downloaded, ${r.present.length} present -> ${r.dir}`
  );
}

async function main(): Promise<void> {
  loadModelFetchEnvironment(dirname(fileURLToPath(import.meta.url)));
  console.log('[voice:fetch] downloading local voice models (stt + vad + tts)');
  const result = await fetchVoiceModels({
    components,
    voiceIds,
    force: FORCE,
    log: (line) => console.log(`  ${line}`),
  });

  if (result.stt) summarize('stt', result.stt);
  if (result.qualityStt) summarize('stt:quality', result.qualityStt);
  if (result.vad) summarize('vad', result.vad);
  if (result.espeak) {
    console.log(
      `[voice:fetch] espeak-ng-data — ${result.espeak.extracted ? 'extracted' : 'present'} -> ${result.espeak.dir}`
    );
  }
  for (const v of result.voices) summarize(`tts:${v.id}`, v.result);

  console.log('[voice:fetch] done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[voice:fetch] failed: ${getErrorMessage(err)}`);
    console.error('  Voice mode stays unavailable until this succeeds.');
    console.error('  Retry with network access: pnpm --filter @snaglet/server voice:fetch');
    process.exit(STRICT ? 1 : 0);
  });
