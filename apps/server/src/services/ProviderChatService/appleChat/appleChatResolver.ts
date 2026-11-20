/**
 * appleChatResolver — decide whether the `apple-on-device` chat provider is
 * usable and, in dev, build the sidecar on demand. Mirrors
 * `../../voice/sttEngineResolver.ts`'s darwin + swiftc-availability strategy,
 * plus a live `SystemLanguageModel.default.availability` probe (the STT
 * sidecar has no equivalent — Speech/AVFoundation don't gate on Apple
 * Intelligence being enabled).
 *
 * Strictly additive: absent/ineligible Apple support means `available` comes
 * back false with a reason and the provider stays hidden/disabled — nothing
 * else about Snaglet changes (see ProviderService's availability gating).
 *
 * `SNAGLET_APPLE_CHAT` is not read here; it only gates the real-hardware Jest test.
 * Runtime availability is always the live darwin + binary + model probe below,
 * with no env override: there is no alternate engine to pick (unlike STT's
 * apple-vs-local), so a forcing knob would only misreport the machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { AppleChatEngine } from './appleChatEngine';

type AppleChatUnavailableReason =
  | 'nonDarwin'
  | 'binaryUnbuildable'
  | 'notBundled'
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'frameworkUnavailable'
  | 'unknown';

export interface AppleChatAvailabilityResult {
  readonly available: boolean;
  readonly reason?: AppleChatUnavailableReason;
}

/** The sidecar directory (dev: repo source; prod: staged next to the bundle). */
function sidecarDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev/tests: apps/server/src/services/ProviderChatService/appleChat →
  // apps/server/native/apple-chat.
  const devDir = join(here, '..', '..', '..', '..', 'native', 'apple-chat');
  if (existsSync(devDir)) return devDir;
  // Bundle: server.mjs (dist/bundle) → dist/bundle/native/apple-chat.
  return join(here, 'native', 'apple-chat');
}

/** Absolute path the built sidecar binary lives at. */
export function appleChatBinaryPath(): string {
  if (process.env.SNAGLET_APPLE_CHAT_BIN) return process.env.SNAGLET_APPLE_CHAT_BIN;
  return join(sidecarDir(), 'bin', 'snaglet-apple-chat');
}

/**
 * True when this process can ever produce the sidecar binary: it is already
 * built, or the Swift source + build script sit next to it (a source checkout).
 * A packaged desktop bundle stages only the compiled binary — when the release
 * build skipped apple-chat (best-effort helper in apps/server/scripts/bundle.mjs)
 * nothing is staged at all, and no amount of `swiftc` on the user's machine
 * changes that. That case is `notBundled`, reported distinctly from
 * `binaryUnbuildable` (source present, compiler missing/failed) so the gate copy
 * and diagnostics say what actually happened.
 */
export function appleChatSidecarBundled(): boolean {
  return existsSync(appleChatBinaryPath()) || existsSync(join(sidecarDir(), 'build.sh'));
}

let swiftcCache: boolean | null = null;
/** True when `swiftc` is on PATH (so the sidecar is buildable in dev). */
function swiftcAvailable(): boolean {
  if (swiftcCache !== null) return swiftcCache;
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
    swiftcCache = true;
  } catch {
    swiftcCache = false;
  }
  return swiftcCache;
}

/**
 * Ensure the sidecar binary exists, building it on demand when swiftc is
 * present (dev). Returns the binary path, or null if it is neither present
 * nor buildable (including: not darwin at all).
 */
export function ensureAppleChatBinary(): string | null {
  const bin = appleChatBinaryPath();
  if (existsSync(bin)) return bin;
  if (process.platform !== 'darwin' || !swiftcAvailable()) return null;
  const script = join(sidecarDir(), 'build.sh');
  if (!existsSync(script)) return null;
  try {
    logger.info('[apple-chat] building sidecar on demand (swiftc present)…');
    execFileSync('bash', [script], { stdio: 'inherit' });
  } catch (err) {
    logger.warn(`[apple-chat] on-demand build failed: ${getErrorMessage(err)}`);
    return null;
  }
  return existsSync(bin) ? bin : null;
}

let engineSingleton: AppleChatEngine | null = null;

/** The shared engine instance, or null when the sidecar isn't buildable/usable. */
export function getAppleChatEngine(): AppleChatEngine | null {
  const bin = ensureAppleChatBinary();
  if (!bin) return null;
  if (!engineSingleton) engineSingleton = new AppleChatEngine({ command: bin });
  return engineSingleton;
}

const AVAILABILITY_CACHE_MS = 30_000;
let availabilityCache: { result: AppleChatAvailabilityResult; expiresAt: number } | null = null;

const KNOWN_REASONS = new Set<AppleChatUnavailableReason>([
  'deviceNotEligible',
  'appleIntelligenceNotEnabled',
  'modelNotReady',
  'frameworkUnavailable',
]);

function normalizeReason(reason: string | undefined): AppleChatUnavailableReason {
  if (reason && KNOWN_REASONS.has(reason as AppleChatUnavailableReason)) {
    return reason as AppleChatUnavailableReason;
  }
  return 'unknown';
}

/**
 * Pure decision (injectable for tests — mirrors `decideSttEngine`'s shape so
 * platform/availability branching is testable without mocking
 * `process.platform` or spawning anything). `probe` is the sidecar's
 * `availability` subcommand result; omit it when the binary was never even
 * buildable (the probe never ran).
 */
export function decideAppleChatAvailability(input: {
  platform: string;
  binaryBuildable: boolean;
  /**
   * False when the sidecar was never shipped with this build (packaged app
   * whose release skipped apple-chat). Defaults to true — a source checkout
   * always carries the sidecar source.
   */
  bundled?: boolean;
  probe?: { available: boolean; reason?: string } | null;
}): AppleChatAvailabilityResult {
  if (input.platform !== 'darwin') return { available: false, reason: 'nonDarwin' };
  if (!input.binaryBuildable) {
    return {
      available: false,
      reason: input.bundled === false ? 'notBundled' : 'binaryUnbuildable',
    };
  }
  if (!input.probe) return { available: false, reason: 'unknown' };
  if (input.probe.available) return { available: true };
  return { available: false, reason: normalizeReason(input.probe.reason) };
}

/**
 * Resolve whether apple-on-device chat is usable right now: darwin + binary
 * buildable + a live `SystemLanguageModel.default.availability` probe. Cached
 * briefly (30s) since the probe spawns a short-lived process — availability
 * genuinely can flip at runtime (user toggles Apple Intelligence in System
 * Settings) so this is never cached indefinitely or only computed at boot.
 */
export async function resolveAppleChatAvailability(): Promise<AppleChatAvailabilityResult> {
  if (process.platform !== 'darwin') {
    return decideAppleChatAvailability({ platform: process.platform, binaryBuildable: false });
  }

  const now = Date.now();
  if (availabilityCache && availabilityCache.expiresAt > now) return availabilityCache.result;

  const engine = getAppleChatEngine();
  const probe = engine ? await engine.checkAvailability() : null;
  const result = decideAppleChatAvailability({
    platform: process.platform,
    binaryBuildable: !!engine,
    bundled: appleChatSidecarBundled(),
    probe,
  });
  availabilityCache = { result, expiresAt: now + AVAILABILITY_CACHE_MS };
  return result;
}
