import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { Models, type ModelRow } from '@snaglet/db/tables/models';
import { clampInt, getErrorMessage } from '@snaglet/shared/utils';
import type { RerankingMeta } from '@snaglet/shared/types/metadata';
import { logger } from '@server/config/logger';
import { expandHome, RERANKER_MODEL_MANIFEST } from './rerankerModelManifest';
import { modelReadDir } from '../localModels/modelReadPaths';
import { WordPieceTokenizer, type PairEncoding } from './WordPieceTokenizer';
import { IdleUnloader } from '../localModels/idleUnload';
import { isLocalModelEnabled } from '../localModels/localModelPreferences';

export const DEFAULT_RERANKER_PROVIDER_ID = 'snaglet-local';
export const DEFAULT_RERANKER_MODEL_ID = 'ms-marco-MiniLM-L6-v2-qint8-arm64';

/** Actionable hint appended to "model not installed" diagnostics. */
export const RERANKER_FETCH_HINT = 'Run `pnpm reranker:fetch` to download it.';

const MAX_CANDIDATES = 200;
const DEFAULT_MAX_SEQUENCE_TOKENS = 512;
const DEFAULT_BATCH_SIZE = 8;

export interface RerankCandidate {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RerankInput {
  query: string;
  candidates: RerankCandidate[];
  providerId?: string;
  modelId?: string;
  topK?: number;
  maxSequenceTokens?: number;
  batchSize?: number;
}

interface RerankResult {
  index: number;
  id?: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RerankResponse {
  providerId: string;
  modelId: string;
  modelRowId: string;
  results: RerankResult[];
  candidateCount: number;
  elapsedMs: number;
}

interface ResolvedRerankerModel {
  row: ModelRow;
  meta: Required<Pick<RerankingMeta, 'modelFile' | 'vocabFile'>> & RerankingMeta;
  modelFile: string;
  vocabFile: string;
  tokenizerConfigFile?: string;
  maxSequenceTokens: number;
  batchSize: number;
}

const tokenizerCache = new Map<string, Promise<WordPieceTokenizer>>();
const sessionCache = new Map<string, Promise<ort.InferenceSession>>();
const checksumCache = new Map<string, Promise<string>>();

// Idle unload
//
// Same rationale + mechanism as LocalEmbedderService's idle unload (shared
// `IdleUnloader` helper): a loaded reranker session is real resident memory
// for as long as the cache holds it, regardless of whether reranking is
// still happening. `sessionCache`/`tokenizerCache` are keyed by model file
// path (multiple reranker models could be cached at once), but in practice
// one process reranks against one model — idle-unload treats the whole
// cache as one unit and clears everything after a shared inactivity window,
// rather than tracking per-key timers. `checksumCache` is intentionally not cleared: it holds tiny
// strings (not native memory) and clearing it would force a redundant
// sha256 re-hash of the (large) model file on every reload.

/**
 * Idle-unload threshold (env `SNAGLET_RERANKER_IDLE_UNLOAD_MS`, default 10 min).
 * Read per-call (not memoized) so tests can override it without a restart.
 */
const RERANKER_IDLE_UNLOAD_DEFAULT_MS = 10 * 60_000;
function rerankerIdleUnloadMs(): number {
  const raw = Number(process.env.SNAGLET_RERANKER_IDLE_UNLOAD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : RERANKER_IDLE_UNLOAD_DEFAULT_MS;
}

/**
 * Release every cached ONNX session's native memory and clear the session +
 * tokenizer caches so the next rerank lazy-reloads. `InferenceSession
 * .release()` frees the native session immediately (see LocalEmbedderService
 * for the verified onnxruntime-node 1.27.0 code path) — independent of JS GC.
 */
async function unloadReranker(): Promise<void> {
  const sessionsToRelease = [...sessionCache.values()];
  sessionCache.clear();
  tokenizerCache.clear();
  if (sessionsToRelease.length === 0) return;
  let released = 0;
  for (const sessionPromise of sessionsToRelease) {
    try {
      const session = await sessionPromise;
      await session.release();
      released += 1;
    } catch (err) {
      // Never loaded successfully, or release failed — nothing more to free.
      logger.warn(`[reranker] idle unload release failed: ${getErrorMessage(err)}`);
    }
  }
  logger.info(`[reranker] idle unload: released ${released} session(s) after inactivity`);
}

const idleUnloader = new IdleUnloader(rerankerIdleUnloadMs, unloadReranker);

/** Release any loaded local reranker session immediately after removal. */
export async function releaseLocalReranker(): Promise<void> {
  idleUnloader.cancel();
  await unloadReranker();
}

/** Test hook: force an immediate idle-unload regardless of the timer. */
export async function forceRerankerIdleUnloadForTests(): Promise<void> {
  await releaseLocalReranker();
}

/** Test hook: drop cached session/tokenizer/timer state between test files. */
export function resetLocalRerankerForTests(): void {
  sessionCache.clear();
  tokenizerCache.clear();
  checksumCache.clear();
  idleUnloader.cancel();
}

function getRerankingMeta(row: ModelRow): RerankingMeta {
  const raw = row.metadata?.reranking;
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

async function sha256File(file: string): Promise<string> {
  let cached = checksumCache.get(file);
  if (!cached) {
    cached = readFile(file).then((bytes) => createHash('sha256').update(bytes).digest('hex'));
    checksumCache.set(file, cached);
  }
  return cached;
}

async function assertReadable(file: string, label: string): Promise<void> {
  try {
    await access(file);
  } catch {
    throw new Error(`${label} is missing at ${file}`);
  }
}

async function loadTokenizer(model: ResolvedRerankerModel): Promise<WordPieceTokenizer> {
  await idleUnloader.awaitInFlightDispose();
  const key = `${model.vocabFile}:${model.tokenizerConfigFile ?? ''}`;
  let cached = tokenizerCache.get(key);
  if (!cached) {
    cached = WordPieceTokenizer.fromFiles(model.vocabFile, model.tokenizerConfigFile);
    tokenizerCache.set(key, cached);
  }
  return cached;
}

async function loadSession(model: ResolvedRerankerModel): Promise<ort.InferenceSession> {
  await idleUnloader.awaitInFlightDispose();
  let cached = sessionCache.get(model.modelFile);
  if (!cached) {
    cached = ort.InferenceSession.create(model.modelFile, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    sessionCache.set(model.modelFile, cached);
  }
  return cached;
}

function toBigIntTensor(values: number[], dims: readonly number[]): ort.Tensor {
  const data = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    data[i] = BigInt(values[i] ?? 0);
  }
  return new ort.Tensor('int64', data, [...dims]);
}

function makeBatchTensors(
  tokenizer: WordPieceTokenizer,
  encodings: PairEncoding[]
): Record<string, ort.Tensor> {
  const batch = encodings.length;
  const width = Math.max(...encodings.map((encoding) => encoding.inputIds.length));
  const inputIds: number[] = [];
  const attentionMask: number[] = [];
  const tokenTypeIds: number[] = [];

  for (const encoding of encodings) {
    for (let i = 0; i < width; i += 1) {
      const isPresent = i < encoding.inputIds.length;
      inputIds.push(isPresent ? encoding.inputIds[i]! : tokenizer.padTokenId);
      attentionMask.push(isPresent ? encoding.attentionMask[i]! : 0);
      tokenTypeIds.push(isPresent ? encoding.tokenTypeIds[i]! : 0);
    }
  }

  const dims = [batch, width];
  return {
    input_ids: toBigIntTensor(inputIds, dims),
    attention_mask: toBigIntTensor(attentionMask, dims),
    token_type_ids: toBigIntTensor(tokenTypeIds, dims),
  };
}

function outputScores(output: ort.Tensor, batchSize: number): number[] {
  const values = Array.from(output.data as Iterable<number | bigint>).map(Number);
  const dims = output.dims.map(Number);
  const stride = dims.length > 1 ? dims.slice(1).reduce((acc, dim) => acc * dim, 1) : 1;
  const scores: number[] = [];
  for (let i = 0; i < batchSize; i += 1) {
    scores.push(values[i * stride] ?? 0);
  }
  return scores;
}

async function resolveModel(input: RerankInput): Promise<ResolvedRerankerModel> {
  const providerId = input.providerId || DEFAULT_RERANKER_PROVIDER_ID;
  const modelId = input.modelId || DEFAULT_RERANKER_MODEL_ID;
  const row = await Models.findByProviderAndModelId(providerId, modelId);

  if (!row || !row.isActive) {
    throw new Error(`Reranker model is not registered or active: ${providerId}/${modelId}`);
  }
  if (row.type !== 'reranker') {
    throw new Error(`Model ${providerId}/${modelId} has type "${row.type}", not "reranker"`);
  }

  const meta = getRerankingMeta(row);
  if (!meta.modelFile || !meta.vocabFile) {
    throw new Error(`Reranker model ${providerId}/${modelId} is missing local model metadata`);
  }

  const manifest = RERANKER_MODEL_MANIFEST;
  const builtinPaths = manifest.files.map((file) => `${manifest.dir}/${file.localPath}`);
  const useBuiltinBundle =
    providerId === manifest.providerId &&
    modelId === manifest.modelId &&
    !process.env.SNAGLET_RERANKER_MODEL_FILE &&
    !process.env.SNAGLET_RERANKER_VOCAB_FILE &&
    !process.env.SNAGLET_RERANKER_TOKENIZER_CONFIG_FILE &&
    [meta.modelFile, meta.vocabFile, meta.tokenizerConfigFile].every(
      (file) => file && builtinPaths.includes(file)
    );
  const readDir = useBuiltinBundle ? modelReadDir(manifest) : null;
  const resolveFile = (file: string): string =>
    readDir ? path.join(readDir, file.slice(manifest.dir.length + 1)) : expandHome(file);
  const modelFile = resolveFile(process.env.SNAGLET_RERANKER_MODEL_FILE || meta.modelFile);
  const vocabFile = resolveFile(process.env.SNAGLET_RERANKER_VOCAB_FILE || meta.vocabFile);
  const tokenizerConfigFile = meta.tokenizerConfigFile
    ? resolveFile(process.env.SNAGLET_RERANKER_TOKENIZER_CONFIG_FILE || meta.tokenizerConfigFile)
    : undefined;

  await Promise.all([
    assertReadable(modelFile, 'Reranker ONNX model file'),
    assertReadable(vocabFile, 'Reranker vocabulary file'),
    tokenizerConfigFile
      ? assertReadable(tokenizerConfigFile, 'Reranker tokenizer config file')
      : Promise.resolve(),
  ]);

  if (meta.sha256) {
    const actual = await sha256File(modelFile);
    if (actual !== meta.sha256) {
      throw new Error(
        `Reranker checksum mismatch for ${modelFile}. Expected ${meta.sha256}, got ${actual}`
      );
    }
  }

  return {
    row,
    meta: meta as ResolvedRerankerModel['meta'],
    modelFile,
    vocabFile,
    tokenizerConfigFile,
    maxSequenceTokens: clampInt(
      input.maxSequenceTokens,
      meta.maxSequenceTokens ?? row.contextWindowTokens ?? DEFAULT_MAX_SEQUENCE_TOKENS,
      32,
      row.contextWindowTokens ?? DEFAULT_MAX_SEQUENCE_TOKENS
    ),
    batchSize: clampInt(input.batchSize, meta.defaultBatchSize ?? DEFAULT_BATCH_SIZE, 1, 32),
  };
}

function normalizeCandidates(candidates: RerankCandidate[]): RerankCandidate[] {
  if (candidates.length === 0) throw new Error('At least one candidate is required');
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(`Rerank accepts at most ${MAX_CANDIDATES} candidates per request`);
  }

  return candidates.map((candidate, index) => {
    const text = candidate.text.trim();
    if (!text) throw new Error(`Candidate ${index} text is empty`);
    return {
      id: candidate.id?.trim() || undefined,
      text,
      metadata: candidate.metadata,
    };
  });
}

export async function rerank(input: RerankInput): Promise<RerankResponse> {
  const started = Date.now();
  const query = input.query.trim();
  if (!query) throw new Error('query is required');

  const candidates = normalizeCandidates(input.candidates);
  const topK = clampInt(input.topK, candidates.length, 1, candidates.length);
  const model = await resolveModel(input);
  // Every real rerank call is activity — push the idle-unload deadline out.
  idleUnloader.touch();
  const [tokenizer, session] = await Promise.all([loadTokenizer(model), loadSession(model)]);

  const scores: number[] = [];
  for (let offset = 0; offset < candidates.length; offset += model.batchSize) {
    const batchCandidates = candidates.slice(offset, offset + model.batchSize);
    const encodings = batchCandidates.map((candidate) =>
      tokenizer.encodePair(query, candidate.text, model.maxSequenceTokens)
    );
    const feeds = makeBatchTensors(tokenizer, encodings);
    const outputs = await session.run(feeds);
    const outputName = session.outputNames[0];
    const output = outputs.logits ?? outputs[outputName];
    if (!output) {
      throw new Error(
        `Reranker ONNX output missing. Available: ${Object.keys(outputs).join(', ')}`
      );
    }
    scores.push(...outputScores(output, batchCandidates.length));
  }

  const results = candidates
    .map((candidate, index) => ({
      index,
      id: candidate.id,
      score: scores[index] ?? 0,
      text: candidate.text,
      metadata: candidate.metadata,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    providerId: model.row.providerId,
    modelId: model.row.modelId,
    modelRowId: model.row.id,
    results,
    candidateCount: candidates.length,
    elapsedMs: Date.now() - started,
  };
}

export async function getLocalRerankerStatus(): Promise<{
  providerId: string;
  modelId: string;
  registered: boolean;
  ready: boolean;
  modelFile?: string;
  error?: string;
}> {
  try {
    const model = await resolveModel({
      query: 'status',
      candidates: [{ text: 'status' }],
    });
    return {
      providerId: model.row.providerId,
      modelId: model.row.modelId,
      registered: true,
      ready: true,
      modelFile: model.modelFile,
    };
  } catch (err) {
    const row = await Models.findByProviderAndModelId(
      DEFAULT_RERANKER_PROVIDER_ID,
      DEFAULT_RERANKER_MODEL_ID
    ).catch(() => null);
    return {
      providerId: DEFAULT_RERANKER_PROVIDER_ID,
      modelId: DEFAULT_RERANKER_MODEL_ID,
      registered: Boolean(row),
      ready: false,
      error: getErrorMessage(err),
    };
  }
}

let lastUnavailableWarnAt = 0;
const UNAVAILABLE_WARN_THROTTLE_MS = 5 * 60_000;

/**
 * Call this from a rerank failure path to distinguish "the local model isn't
 * installed" (expected on a fresh install, actionable) from a genuine runtime
 * error. When the reranker is not ready it emits a single throttled, actionable
 * warning — so callers that catch rerank errors don't silently no-op the
 * feature — and returns `true`. Returns `false` (no warning) when the model is
 * ready, i.e. the failure was something else.
 *
 * Cheap to call: only invoke it after a rerank has already failed.
 */
export async function warnIfRerankerUnavailable(context: string): Promise<boolean> {
  if (!(await isLocalModelEnabled('reranker').catch(() => true))) return true;
  const status = await getLocalRerankerStatus().catch(() => null);
  if (!status || status.ready) return false;

  const now = Date.now();
  if (now - lastUnavailableWarnAt > UNAVAILABLE_WARN_THROTTLE_MS) {
    lastUnavailableWarnAt = now;
    logger.warn(
      `[reranker] local model not ready — ${context} is running without reranking. ` +
        `${status.error ? `${status.error}. ` : ''}${RERANKER_FETCH_HINT}`
    );
    // Missing model files are an error state, not a supported configuration —
    // kick the automatic reseed (single-flight, cooldown-throttled, policy-
    // gated) so reranking heals without manual steps. Dynamic import avoids a
    // module cycle (RerankerBootstrap imports this file's status probe).
    void import('./RerankerBootstrap')
      .then(({ reseedRerankerIfMissing }) => reseedRerankerIfMissing(context))
      .catch((err: unknown) => {
        // reseed logs its own failures; this guards the dynamic import itself
        // and never lets the caller's path reject.
        logger.warn(`[reranker] failed to start automatic reseed: ${getErrorMessage(err)}`);
      });
  }
  return true;
}
