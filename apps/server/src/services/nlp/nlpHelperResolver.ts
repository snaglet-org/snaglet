/**
 * nlpHelperResolver — locate/build the `snaglet-nlp-helper` Swift daemon.
 *
 * Mirrors `../voice/sttEngineResolver.ts` (the snaglet-apple-stt sidecar resolver)
 * for the same reason: darwin-only native binary, on-demand build in dev when
 * `swiftc` is present, silent no-op otherwise. Kept as an independent copy
 * (rather than importing the voice resolver) so the nlp domain has no
 * dependency on the voice domain — this feature is additive and self-
 * contained; a future refactor could extract the shared swiftc-probe/on-
 * demand-build logic if a third native helper shows up.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

/** The helper directory (dev: repo source; prod: staged next to the bundle). */
function helperDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev/tests: apps/server/src/services/nlp → apps/server/native/nlp-helper.
  const devDir = join(here, '..', '..', '..', 'native', 'nlp-helper');
  if (existsSync(devDir)) return devDir;
  // Bundle: server.mjs (dist/bundle) → dist/bundle/native/nlp-helper (bundle.mjs).
  return join(here, 'native', 'nlp-helper');
}

/** Absolute path the built helper binary lives at. */
export function nlpHelperBinaryPath(): string {
  if (process.env.SNAGLET_NLP_HELPER_BIN) return process.env.SNAGLET_NLP_HELPER_BIN;
  return join(helperDir(), 'bin', 'snaglet-nlp-helper');
}

/** True when the compiled helper binary exists on disk. */
export function nlpHelperBinaryExists(): boolean {
  return existsSync(nlpHelperBinaryPath());
}

let swiftcCache: boolean | null = null;
/** True when `swiftc` is on PATH (so the helper is buildable in dev). */
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

/**
 * Ensure the helper binary exists, building it on demand when swiftc is
 * present (dev). Returns the binary path, or null if it is neither present
 * nor buildable — callers (NlpHelperClient) must treat null as "never spawn,
 * always resolve the empty-entities fallback", never throw.
 */
export function ensureNlpHelperBinary(): string | null {
  const bin = nlpHelperBinaryPath();
  if (existsSync(bin)) return bin;
  if (process.platform !== 'darwin' || !swiftcAvailable()) return null;
  const script = join(helperDir(), 'build.sh');
  if (!existsSync(script)) return null;
  try {
    logger.info('[nlp-helper] building helper on demand (swiftc present)…');
    execFileSync('bash', [script], { stdio: 'inherit' });
  } catch (err) {
    logger.warn(`[nlp-helper] on-demand build failed: ${getErrorMessage(err)}`);
    return null;
  }
  return existsSync(bin) ? bin : null;
}
