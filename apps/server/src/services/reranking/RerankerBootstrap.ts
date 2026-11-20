/**
 * RerankerBootstrap — automatic seeding of the local reranker model, the
 * reranker's analog of `embedding/EmbeddingBootstrap.ts`.
 *
 * Boot: `bootstrapLocalReranker()` downloads a missing model in the
 * background so a fresh (or wiped) `~/.snaglet/models` heals without manual
 * steps. Runtime: `reseedRerankerIfMissing()` re-runs the pinned-manifest
 * fetch after a resolve failure (files deleted/moved/corrupted) —
 * single-flight with a cooldown so a failing download can't be re-attempted
 * on every rerank call. Both are policy-gated: with local intelligence off
 * there are no automatic downloads and manual `pnpm reranker:fetch` remains
 * the remedy. Both are also gated on the `reranker` feature flag, which is off
 * by default: while it is off the model is never downloaded.
 */
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { getLocalRerankerStatus, RERANKER_FETCH_HINT } from './LocalRerankerService';
import { fetchRerankerModel } from './fetchRerankerModel';
import { isLocalModelEnabled } from '../localModels/localModelPreferences';
import { ModelFetchAbortedError } from '../localModels/fetchModelFiles';
import { isRerankerEnabled, RERANKER_OFF_MESSAGE } from './rerankerFlag';

interface RerankerBootstrapDependencies {
  isFlagEnabled: () => Promise<boolean>;
  getStatus: typeof getLocalRerankerStatus;
  fetchModel: typeof fetchRerankerModel;
  info: (message: string) => void;
  debug: (message: string) => void;
}

const defaultDependencies: RerankerBootstrapDependencies = {
  isFlagEnabled: isRerankerEnabled,
  getStatus: getLocalRerankerStatus,
  fetchModel: fetchRerankerModel,
  info: (message) => logger.info(message),
  debug: (message) => logger.debug(message),
};

/**
 * Run only the automatic reranker bootstrap. Manual fetch and on-demand
 * inference bypass this function and remain available while the policy is
 * off; on-demand inference still needs the `reranker` flag.
 */
export async function bootstrapLocalReranker(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RerankerBootstrapDependencies = defaultDependencies
): Promise<'disabled' | 'ready'> {
  if (!isAutomaticLocalIntelligenceEnabled(env)) {
    return 'disabled';
  }
  if (!(await dependencies.isFlagEnabled())) {
    dependencies.debug(`[reranker] ${RERANKER_OFF_MESSAGE} Skipping the model download.`);
    return 'disabled';
  }
  if (!(await isLocalModelEnabled('reranker'))) {
    dependencies.info('[reranker] disabled by user — skipping automatic download');
    return 'disabled';
  }

  const status = await dependencies.getStatus();
  if (status.ready) {
    dependencies.info(
      `[reranker] local model ready${status.modelFile ? ` (${status.modelFile})` : ''}`
    );
    return 'ready';
  }

  dependencies.info('[reranker] local model missing — downloading in background');
  try {
    // The flag can turn off mid-download; nothing is installed after it does.
    await dependencies.fetchModel({
      log: (line) => dependencies.info(`[reranker:fetch] ${line}`),
      shouldInstall: dependencies.isFlagEnabled,
    });
  } catch (err) {
    if (!(err instanceof ModelFetchAbortedError)) throw err;
    dependencies.debug(`[reranker] ${RERANKER_OFF_MESSAGE} Download stopped and removed.`);
    return 'disabled';
  }
  dependencies.info('[reranker] local model installed — opening-retrieval reranking is available');
  return 'ready';
}

// On-demand auto-reseed

interface RerankerReseedDependencies {
  isFlagEnabled: () => Promise<boolean>;
  fetchModel: typeof fetchRerankerModel;
  info: (message: string) => void;
  debug: (message: string) => void;
  error: (message: string) => void;
}

const defaultReseedDependencies: RerankerReseedDependencies = {
  isFlagEnabled: isRerankerEnabled,
  fetchModel: fetchRerankerModel,
  info: (message) => logger.info(message),
  debug: (message) => logger.debug(message),
  error: (message) => logger.error(message),
};

/** Minimum spacing between reseed attempts (mirrors the embedder's). */
const RESEED_COOLDOWN_MS = 5 * 60_000;

let reseedInFlight: Promise<boolean> | null = null;
let lastReseedAttemptAt = 0;

/** Test-only: reset the single-flight/cooldown state between test cases. */
export function __resetRerankerReseedForTests(): void {
  reseedInFlight = null;
  lastReseedAttemptAt = 0;
}

/**
 * Auto-reseed the local reranker model after a runtime resolve failure.
 * Missing model files are an error state, not a supported configuration —
 * the fetch is idempotent and sha256-verified, so intact files are skipped
 * and corrupt ones re-download. Resolves `true` once the files are in place.
 */
export function reseedRerankerIfMissing(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RerankerReseedDependencies = defaultReseedDependencies
): Promise<boolean> {
  if (reseedInFlight) return reseedInFlight;
  if (!isAutomaticLocalIntelligenceEnabled(env)) return Promise.resolve(false);
  if (Date.now() - lastReseedAttemptAt < RESEED_COOLDOWN_MS) return Promise.resolve(false);

  reseedInFlight = (async () => {
    try {
      // A check while the flag is off is not an attempt, so it starts no cooldown.
      if (!(await dependencies.isFlagEnabled())) return false;
      lastReseedAttemptAt = Date.now();
      if (!(await isLocalModelEnabled('reranker').catch(() => true))) return false;
      dependencies.error(
        `[reranker] local model files missing or invalid (${reason}) — auto-reseeding from the pinned manifest`
      );
      await dependencies.fetchModel({
        log: (line) => dependencies.info(`[reranker:fetch] ${line}`),
        shouldInstall: dependencies.isFlagEnabled,
      });
      dependencies.info('[reranker] auto-reseed complete — reranking resumes on the next call');
      return true;
    } catch (err) {
      if (err instanceof ModelFetchAbortedError) {
        dependencies.debug(`[reranker] ${RERANKER_OFF_MESSAGE} Reseed stopped and removed.`);
        return false;
      }
      dependencies.error(
        `[reranker] auto-reseed failed: ${getErrorMessage(err)}. ${RERANKER_FETCH_HINT}`
      );
      return false;
    } finally {
      reseedInFlight = null;
    }
  })();
  return reseedInFlight;
}
