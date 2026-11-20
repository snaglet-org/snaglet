/**
 * ttsEngineResolver — decide whether the Apple on-device TTS engine is available
 * and, in dev, build the `snaglet-apple-tts` sidecar on demand.
 *
 * Mirror of {@link sttEngineResolver}, with one key difference: TTS is additive,
 * not a swap. Piper (sherpa-onnx VITS) is always present and stays the default
 * (`DEFAULT_VOICE_ID` is a piper voice). This resolver only answers "should the
 * router also offer Apple voices?" — `'apple'` means the router holds both
 * engines and `apple:<id>` voices route to the sidecar; `'local'` means piper
 * only (an `apple:` voice would fall back to the piper default).
 *
 * Rule: on darwin, offer Apple TTS when its binary is present or buildable
 * (swiftc available); otherwise piper only. `SNAGLET_TTS_ENGINE=local` forces piper
 * only, `=apple` forces Apple on — both honored ahead of platform detection
 * (same knob shape as `SNAGLET_VOICE_STT_ENGINE`).
 *
 * This resolver shares the swiftc/sidecar-build plumbing with sttEngineResolver
 * (`swiftcAvailable` is imported from there rather than duplicated).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { swiftcAvailable } from './sttEngineResolver';

export type TtsEngineKind = 'apple' | 'local';

/** Pure decision (injectable for tests). */
export function decideTtsEngine(input: {
  platform: string;
  forced?: string | undefined;
  binaryAvailable: boolean;
}): TtsEngineKind {
  const forced = input.forced?.trim().toLowerCase();
  if (forced === 'local') return 'local';
  if (forced === 'apple') return 'apple';
  if (input.platform !== 'darwin') return 'local';
  return input.binaryAvailable ? 'apple' : 'local';
}

/** The sidecar directory (dev: repo source; prod: staged next to the bundle). */
function sidecarDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev/tests: apps/server/src/services/voice → apps/server/native/apple-tts.
  const devDir = join(here, '..', '..', '..', 'native', 'apple-tts');
  if (existsSync(devDir)) return devDir;
  // Bundle: server.mjs (dist/bundle) → dist/bundle/native/apple-tts.
  return join(here, 'native', 'apple-tts');
}

/** Absolute path the built sidecar binary lives at. */
export function appleTtsBinaryPath(): string {
  if (process.env.SNAGLET_APPLE_TTS_BIN) return process.env.SNAGLET_APPLE_TTS_BIN;
  return join(sidecarDir(), 'bin', 'snaglet-apple-tts');
}

/** True when the compiled sidecar binary exists on disk. */
function appleTtsBinaryExists(): boolean {
  return existsSync(appleTtsBinaryPath());
}

/** Apple TTS is usable when the binary exists or can be built (swiftc present). */
function appleTtsAvailable(): boolean {
  return appleTtsBinaryExists() || swiftcAvailable();
}

/** Resolve the engine kind for this process (env + platform + availability). */
export function resolveTtsEngineKind(): TtsEngineKind {
  return decideTtsEngine({
    platform: process.platform,
    forced: process.env.SNAGLET_TTS_ENGINE,
    binaryAvailable: appleTtsAvailable(),
  });
}

/**
 * Ensure the sidecar binary exists, building it on demand when swiftc is present
 * (dev). Returns the binary path, or null if it is neither present nor buildable.
 */
export function ensureAppleTtsBinary(): string | null {
  const bin = appleTtsBinaryPath();
  if (existsSync(bin)) return bin;
  if (process.platform !== 'darwin' || !swiftcAvailable()) return null;
  const script = join(sidecarDir(), 'build.sh');
  if (!existsSync(script)) return null;
  try {
    logger.info('[apple-tts] building sidecar on demand (swiftc present)…');
    execFileSync('bash', [script], { stdio: 'inherit' });
  } catch (err) {
    logger.warn(`[apple-tts] on-demand build failed: ${getErrorMessage(err)}`);
    return null;
  }
  return existsSync(bin) ? bin : null;
}
