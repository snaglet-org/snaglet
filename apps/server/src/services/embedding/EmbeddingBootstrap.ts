import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  EMBEDDER_FETCH_HINT,
  getLocalEmbedderStatus,
  shouldWarmEmbedderAtBoot,
  warmLocalEmbedder,
} from './LocalEmbedderService';
import { fetchEmbedderModel } from './fetchEmbedderModel';

interface EmbeddingBootstrapDependencies {
  getStatus: typeof getLocalEmbedderStatus;
  fetchModel: typeof fetchEmbedderModel;
  shouldWarm: typeof shouldWarmEmbedderAtBoot;
  warm: typeof warmLocalEmbedder;
  info: (message: string) => void;
}

const defaultDependencies: EmbeddingBootstrapDependencies = {
  getStatus: getLocalEmbedderStatus,
  fetchModel: fetchEmbedderModel,
  shouldWarm: shouldWarmEmbedderAtBoot,
  warm: warmLocalEmbedder,
  info: (message) => logger.info(message),
};

/**
 * Run only the automatic embedder bootstrap. Manual fetch and on-demand
 * inference bypass this function and remain available while the policy is off.
 */
export async function bootstrapLocalEmbedder(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: EmbeddingBootstrapDependencies = defaultDependencies
): Promise<'disabled' | 'ready'> {
  if (!isAutomaticLocalIntelligenceEnabled(env)) {
    dependencies.info(
      '[local-intelligence] disabled by default: embedder bootstrap=false; background worker inference=false; explicit inference remains available'
    );
    return 'disabled';
  }

  const status = await dependencies.getStatus();
  if (!status.ready) {
    dependencies.info('[embedder] local model missing — downloading in background');
    await dependencies.fetchModel({
      log: (line) => dependencies.info(`[embedder:fetch] ${line}`),
    });
  }

  if (dependencies.shouldWarm(env)) {
    dependencies.warm();
  } else {
    dependencies.info(
      '[embedder] RUN_BACKGROUND_WORKERS=false — skipping eager warm at boot; ' +
        'embeds still lazy-load on the first on-demand call'
    );
  }
  return 'ready';
}

// On-demand auto-reseed

interface EmbedderReseedDependencies {
  fetchModel: typeof fetchEmbedderModel;
  info: (message: string) => void;
  error: (message: string) => void;
}

const defaultReseedDependencies: EmbedderReseedDependencies = {
  fetchModel: fetchEmbedderModel,
  info: (message) => logger.info(message),
  error: (message) => logger.error(message),
};

/** Minimum spacing between reseed attempts — a failing download (offline
 *  machine, upstream outage) must not be re-tried on every sweep tick. */
const RESEED_COOLDOWN_MS = 5 * 60_000;

let reseedInFlight: Promise<boolean> | null = null;
let lastReseedAttemptAt = 0;

/** Test-only: reset the single-flight/cooldown state between test cases. */
export function __resetEmbedderReseedForTests(): void {
  reseedInFlight = null;
  lastReseedAttemptAt = 0;
}

/**
 * Auto-reseed the local embedder model after a runtime resolve failure — the
 * files under `~/.snaglet/models/embedders/` vanished (deleted/moved) or fail
 * their sha256 check. The app relies on local models: missing files are an
 * ERROR state, not a supported configuration, so callers that hit it log
 * loudly and invoke this instead of silently skipping embeds.
 *
 * Runs the same manifest fetch as `pnpm embedder:fetch`: idempotent and
 * hash-verified, so intact files are skipped and corrupt ones re-download.
 * Single-flight with a cooldown so concurrent callers share one attempt and
 * a failing download can't be hammered every tick. Resolves `true` once the
 * model files are in place. Policy-gated like the boot bootstrap: with local
 * intelligence off there are no automatic downloads (manual
 * `pnpm embedder:fetch` remains the remedy).
 */
export function reseedEmbedderIfMissing(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: EmbedderReseedDependencies = defaultReseedDependencies
): Promise<boolean> {
  if (reseedInFlight) return reseedInFlight;
  if (!isAutomaticLocalIntelligenceEnabled(env)) return Promise.resolve(false);
  const now = Date.now();
  if (now - lastReseedAttemptAt < RESEED_COOLDOWN_MS) return Promise.resolve(false);
  lastReseedAttemptAt = now;

  reseedInFlight = (async () => {
    try {
      dependencies.error(
        `[embedder] local model files missing or invalid (${reason}) — auto-reseeding from the pinned manifest`
      );
      await dependencies.fetchModel({
        log: (line) => dependencies.info(`[embedder:fetch] ${line}`),
      });
      dependencies.info('[embedder] auto-reseed complete — embedding resumes on the next pass');
      return true;
    } catch (err) {
      dependencies.error(
        `[embedder] auto-reseed failed: ${getErrorMessage(err)}. ${EMBEDDER_FETCH_HINT}`
      );
      return false;
    } finally {
      reseedInFlight = null;
    }
  })();
  return reseedInFlight;
}
