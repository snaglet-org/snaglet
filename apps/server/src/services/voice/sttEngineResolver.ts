/**
 * sttEngineResolver — pick the speech-to-text engine and, in dev, build the
 * Apple sidecar on demand.
 *
 * Rule: on macOS 26 or later, prefer Apple's on-device SpeechAnalyzer via the
 * `snaglet-apple-stt` sidecar when its binary is present, or buildable in a source
 * checkout (build script and swiftc present); otherwise fall back to Snaglet's
 * bundled local ONNX STT engine (the Linux/fallback tier). An older macOS has
 * no SpeechAnalyzer, so the sidecar could only report `unsupported-os`.
 * `SNAGLET_VOICE_STT_ENGINE=local` forces the fallback, `=apple` forces Apple — both
 * honored ahead of platform detection.
 *
 * TTS + VAD always stay on the local engine — Apple replaces STT only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

export type SttEngineKind = 'apple' | 'local';

/** Pure decision (injectable for tests). */
export function decideSttEngine(input: {
  platform: string;
  forced?: string | undefined;
  /** The OS has SpeechAnalyzer (macOS 26 or later). */
  osSupported: boolean;
  binaryAvailable: boolean;
}): SttEngineKind {
  const forced = input.forced?.trim().toLowerCase();
  if (forced === 'local') return 'local';
  if (forced === 'apple') return 'apple';
  if (input.platform !== 'darwin') return 'local';
  return input.osSupported && input.binaryAvailable ? 'apple' : 'local';
}

/**
 * True when a Darwin kernel release (`os.release()`) is macOS 26 or later.
 * macOS 26 runs Darwin 25 and macOS 15 runs Darwin 24, so the kernel answers
 * without starting a process.
 */
export function appleSpeechOsSupported(darwinRelease: string = release()): boolean {
  const major = Number.parseInt(darwinRelease, 10);
  return Number.isFinite(major) && major >= 25;
}

/** The sidecar directory (dev: repo source; prod: staged next to the bundle). */
function sidecarDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev/tests: apps/server/src/services/voice → apps/server/native/apple-stt.
  const devDir = join(here, '..', '..', '..', 'native', 'apple-stt');
  if (existsSync(devDir)) return devDir;
  // Bundle: server.mjs (dist/bundle) → dist/bundle/native/apple-stt (see bundle.mjs).
  return join(here, 'native', 'apple-stt');
}

/** Absolute path the built sidecar binary lives at. */
export function appleSttBinaryPath(): string {
  if (process.env.SNAGLET_APPLE_STT_BIN) return process.env.SNAGLET_APPLE_STT_BIN;
  return join(sidecarDir(), 'bin', 'snaglet-apple-stt');
}

/** True when the compiled sidecar binary exists on disk. */
function appleSttBinaryExists(): boolean {
  return existsSync(appleSttBinaryPath());
}

/**
 * The sidecar's build script: present in a source checkout, absent from a
 * packaged app, which ships only the binary. Checked before swiftc so a
 * packaged app never runs `swiftc`, which on a Mac without the Command Line
 * Tools opens the system prompt to install them.
 */
function appleSttBuildScript(): string | null {
  const script = join(sidecarDir(), 'build.sh');
  return existsSync(script) ? script : null;
}

let swiftcCache: boolean | null = null;
/** True when `swiftc` is on PATH (so the sidecar is buildable in dev). */
export function swiftcAvailable(): boolean {
  if (swiftcCache !== null) return swiftcCache;
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
    swiftcCache = true;
  } catch {
    swiftcCache = false;
  }
  return swiftcCache;
}

/** Apple STT is usable when the binary exists or the checkout can build it. */
function appleSttAvailable(): boolean {
  return appleSttBinaryExists() || (appleSttBuildScript() !== null && swiftcAvailable());
}

/** Resolve the engine kind for this process (env + platform + OS + availability). */
export function resolveSttEngineKind(): SttEngineKind {
  const osSupported = process.platform === 'darwin' && appleSpeechOsSupported();
  return decideSttEngine({
    platform: process.platform,
    forced: process.env.SNAGLET_VOICE_STT_ENGINE,
    osSupported,
    binaryAvailable: osSupported && appleSttAvailable(),
  });
}

/**
 * Ensure the sidecar binary exists, building it on demand in a source checkout
 * with swiftc. Returns the binary path, or null if it is neither present nor
 * buildable.
 */
export function ensureAppleSttBinary(): string | null {
  const bin = appleSttBinaryPath();
  if (existsSync(bin)) return bin;
  if (process.platform !== 'darwin') return null;
  const script = appleSttBuildScript();
  if (!script || !swiftcAvailable()) return null;
  try {
    logger.info('[apple-stt] building sidecar on demand (swiftc present)…');
    execFileSync('bash', [script], { stdio: 'inherit' });
  } catch (err) {
    logger.warn(`[apple-stt] on-demand build failed: ${getErrorMessage(err)}`);
    return null;
  }
  return existsSync(bin) ? bin : null;
}
