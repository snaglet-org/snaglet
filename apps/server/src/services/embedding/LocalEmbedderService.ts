/**
 * LocalEmbedderService — Snaglet's built-in local embedding engine.
 *
 * Runs nomic-embed-text-v1.5 (int8 ONNX) through onnxruntime-node, mirroring
 * `LocalRerankerService`: lazy session + tokenizer singletons, sha256-verified
 * model file, CPU execution. Files are resolved from `embedderModelManifest`
 * (no DB dependency), downloaded by `pnpm embedder:fetch`.
 *
 * Prefix contract: nomic-embed requires a task-instruction prefix on every
 * input. This service is the only place prefixes are applied — callers choose
 * a method (`embedDocument` for ingest/indexing, `embedQuery` for search
 * queries), never build prefix strings themselves. That makes forgetting the
 * prefix impossible at every call site.
 *
 * Post-processing follows the model card: masked mean pooling over the last
 * hidden state → parameter-free layer norm → L2 normalization. (Layer norm is
 * required for Matryoshka truncation; we ship full 768 dims but stay faithful
 * to the reference pipeline so our vectors match other nomic-embed users'.)
 */

import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { WordPieceTokenizer, type PairEncoding } from '../reranking/WordPieceTokenizer';
import { IdleUnloader } from '../localModels/idleUnload';
import {
  EMBEDDER_MODEL_MANIFEST,
  EMBEDDER_TASK_PREFIXES,
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS,
  LOCAL_EMBEDDER_MODEL_ID,
  LOCAL_EMBEDDER_PROVIDER_ID,
  embedderModelFilePath,
  type EmbedderTaskKind,
} from './embedderModelManifest';

/** Actionable hint appended to "model not installed" diagnostics. */
export const EMBEDDER_FETCH_HINT = 'Run `pnpm embedder:fetch` to download it.';

const DEFAULT_BATCH_SIZE = 8;

// Prefix contract

/**
 * Apply the nomic-embed task prefix for `kind`. Exported for tests — callers
 * outside this module should use `embedDocument`/`embedQuery` instead.
 */
export function applyTaskPrefix(kind: EmbedderTaskKind, text: string): string {
  return EMBEDDER_TASK_PREFIXES[kind] + text;
}

// Pure post-processing math (exported for tests)

/**
 * Masked mean pooling: average the hidden states of non-padding positions.
 * `hidden` is one sequence's `[tokens × dims]` slab, row-major.
 */
export function meanPool(
  hidden: Float32Array,
  tokens: number,
  dims: number,
  attentionMask: number[]
): number[] {
  const pooled = new Array<number>(dims).fill(0);
  let count = 0;
  for (let t = 0; t < tokens; t += 1) {
    if (!attentionMask[t]) continue;
    count += 1;
    const base = t * dims;
    for (let d = 0; d < dims; d += 1) {
      pooled[d] += hidden[base + d]!;
    }
  }
  if (count === 0) return pooled;
  for (let d = 0; d < dims; d += 1) pooled[d] = pooled[d]! / count;
  return pooled;
}

/** Parameter-free layer norm (zero mean, unit variance) — nomic-embed v1.5's Matryoshka step. */
export function layerNorm(vec: number[], eps = 1e-5): number[] {
  const n = vec.length;
  if (n === 0) return vec;
  let mean = 0;
  for (const v of vec) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of vec) variance += (v - mean) ** 2;
  variance /= n;
  const denom = Math.sqrt(variance + eps);
  return vec.map((v) => (v - mean) / denom);
}

/** L2-normalize to a unit vector (cosine distance ≡ inner product downstream). */
export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// Lazy model resources

interface EmbedderFiles {
  modelFile: string;
  vocabFile: string;
  tokenizerConfigFile: string;
}

function resolveFiles(): EmbedderFiles {
  return {
    modelFile: process.env.SNAGLET_EMBEDDER_MODEL_FILE || embedderModelFilePath('model'),
    vocabFile: process.env.SNAGLET_EMBEDDER_VOCAB_FILE || embedderModelFilePath('vocab'),
    tokenizerConfigFile:
      process.env.SNAGLET_EMBEDDER_TOKENIZER_CONFIG_FILE ||
      embedderModelFilePath('tokenizerConfig'),
  };
}

async function assertReadable(file: string, label: string): Promise<void> {
  try {
    await access(file);
  } catch {
    throw new Error(`${label} is missing at ${file}. ${EMBEDDER_FETCH_HINT}`);
  }
}

let tokenizerPromise: Promise<WordPieceTokenizer> | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;

// Load-failure memory
//
// A real load attempt reads and hashes the ~137MB model and then has ONNX
// parse it, and some callers embed on every agent turn. Both records below
// are keyed on the model file's fingerprint, so any change to the file (a
// fetch landing, a re-download) is retried and re-verified at once.

/** How long a failed load is replayed, rather than retried, for an unchanged file. */
const SESSION_LOAD_FAILURE_BACKOFF_MS = 30_000;

interface ModelDigest {
  fingerprint: string;
  sha256: Promise<string>;
}

interface SessionLoadFailure {
  modelFile: string;
  fingerprint: string;
  error: unknown;
  failedAt: number;
}

const modelDigests = new Map<string, ModelDigest>();
let lastSessionLoadFailure: SessionLoadFailure | null = null;

/** Changes whenever the file is replaced, rewritten, or appended to. */
async function fileFingerprint(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
  } catch {
    return null;
  }
}

async function sha256OfFile(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/** Hash the model once per fingerprint, whether or not the digest matched. */
function modelSha256(file: string, fingerprint: string | null): Promise<string> {
  if (!fingerprint) return sha256OfFile(file);
  const cached = modelDigests.get(file);
  if (cached?.fingerprint === fingerprint) return cached.sha256;
  const sha256 = sha256OfFile(file);
  modelDigests.set(file, { fingerprint, sha256 });
  sha256.catch(() => {
    if (modelDigests.get(file)?.sha256 === sha256) modelDigests.delete(file);
  });
  return sha256;
}

function recentLoadFailure(
  modelFile: string,
  fingerprint: string | null
): SessionLoadFailure | null {
  const failure = lastSessionLoadFailure;
  if (
    failure &&
    fingerprint &&
    failure.modelFile === modelFile &&
    failure.fingerprint === fingerprint &&
    Date.now() - failure.failedAt < SESSION_LOAD_FAILURE_BACKOFF_MS
  ) {
    return failure;
  }
  return null;
}

// Idle unload
//
// The ONNX session alone is ~137MB resident (int8 nomic-embed-text-v1.5 +
// ORT's inference arena) — a fixed floor a server pays for as long as the
// singleton stays warm, whether or not embedding work is still happening.
// Boot-time warm is policy-gated (see `shouldWarmEmbedderAtBoot`), but
// even a server that does run background embedding work eventually goes
// quiet (corpus fully indexed, no searches for a while); the idle timer
// releases the session then and the next call reloads from scratch — the
// same cold path as first boot.

/**
 * Idle-unload threshold (env `SNAGLET_EMBEDDER_IDLE_UNLOAD_MS`, default 10 min):
 * after this long with no embed call, `unloadEmbedder` releases the ONNX
 * session and nulls both singletons. Read per-call (not memoized) so tests
 * can override it without a process restart.
 */
const EMBEDDER_IDLE_UNLOAD_DEFAULT_MS = 10 * 60_000;
function embedderIdleUnloadMs(): number {
  const raw = Number(process.env.SNAGLET_EMBEDDER_IDLE_UNLOAD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : EMBEDDER_IDLE_UNLOAD_DEFAULT_MS;
}

/**
 * Release the ONNX session's native memory and null both singletons so the
 * next embed call lazy-reloads. `InferenceSession.release()` calls into the
 * native addon's `handler.dispose()` (onnxruntime-node 1.27.0,
 * dist/backend.js), which frees the native session/arena immediately — it
 * does not wait on JS GC, so the RSS drop is observable right after `await`.
 * The tokenizer holds no native handle (just JS Maps built from the vocab
 * file), so dropping its promise reference is enough; nothing to `.release()`.
 */
async function unloadEmbedder(): Promise<void> {
  const sessionToRelease = sessionPromise;
  sessionPromise = null;
  tokenizerPromise = null;
  if (!sessionToRelease) return;
  try {
    const session = await sessionToRelease;
    await session.release();
    logger.info('[embedder] idle unload: ONNX session released after inactivity');
  } catch (err) {
    // Either the session never loaded successfully, or release itself
    // failed — both leave nothing more to free, so just log and move on.
    logger.warn(`[embedder] idle unload release failed: ${getErrorMessage(err)}`);
  }
}

const idleUnloader = new IdleUnloader(embedderIdleUnloadMs, unloadEmbedder);

/**
 * Whether boot-time eager warm should run at all: only when this process
 * actually opts into automatic local intelligence and owns background workers.
 * The lazy singletons still load on the first explicit embed/search call, so
 * disabling automatic work does not disable on-demand inference.
 */
export function shouldWarmEmbedderAtBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAutomaticLocalIntelligenceEnabled(env) && env.RUN_BACKGROUND_WORKERS !== 'false';
}

async function loadTokenizer(files: EmbedderFiles): Promise<WordPieceTokenizer> {
  await idleUnloader.awaitInFlightDispose();
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      await assertReadable(files.vocabFile, 'Embedder vocabulary file');
      return WordPieceTokenizer.fromFiles(files.vocabFile, files.tokenizerConfigFile);
    })();
    tokenizerPromise.catch(() => {
      tokenizerPromise = null; // allow retry after a fetch
    });
  }
  return tokenizerPromise;
}

async function loadSession(files: EmbedderFiles): Promise<ort.InferenceSession> {
  await idleUnloader.awaitInFlightDispose();
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await assertReadable(files.modelFile, 'Embedder ONNX model file');

      const fingerprint = await fileFingerprint(files.modelFile);
      const recentFailure = recentLoadFailure(files.modelFile, fingerprint);
      if (recentFailure) throw recentFailure.error;

      try {
        // Integrity gate: only the manifest's pinned bytes get loaded. Skipped
        // when the path was overridden via env (tests / experiments).
        if (!process.env.SNAGLET_EMBEDDER_MODEL_FILE) {
          const expected = EMBEDDER_MODEL_MANIFEST.files.find(
            (f) => f.localPath === 'onnx/model_quantized.onnx'
          )?.sha256;
          const actual = await modelSha256(files.modelFile, fingerprint);
          if (expected && actual !== expected) {
            throw new Error(
              `Embedder checksum mismatch for ${files.modelFile}. Expected ${expected}, got ${actual}. ` +
                'Re-download with `pnpm embedder:fetch --force`.'
            );
          }
        }

        const session = await ort.InferenceSession.create(files.modelFile, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        });
        lastSessionLoadFailure = null;
        return session;
      } catch (err) {
        if (fingerprint) {
          lastSessionLoadFailure = {
            modelFile: files.modelFile,
            fingerprint,
            error: err,
            failedAt: Date.now(),
          };
        }
        throw err;
      }
    })();
    sessionPromise.catch(() => {
      sessionPromise = null; // allow retry after a fetch
    });
  }
  return sessionPromise;
}

// Tensor plumbing

function toBigIntTensor(values: number[], dims: readonly number[]): ort.Tensor {
  const data = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    data[i] = BigInt(values[i] ?? 0);
  }
  return new ort.Tensor('int64', data, [...dims]);
}

function makeBatchTensors(
  padTokenId: number,
  encodings: PairEncoding[],
  inputNames: readonly string[]
): { feeds: Record<string, ort.Tensor>; width: number; masks: number[][] } {
  const batch = encodings.length;
  const width = Math.max(...encodings.map((encoding) => encoding.inputIds.length));
  const inputIds: number[] = [];
  const attentionMask: number[] = [];
  const tokenTypeIds: number[] = [];
  const masks: number[][] = [];

  for (const encoding of encodings) {
    const mask: number[] = [];
    for (let i = 0; i < width; i += 1) {
      const isPresent = i < encoding.inputIds.length;
      inputIds.push(isPresent ? encoding.inputIds[i]! : padTokenId);
      attentionMask.push(isPresent ? encoding.attentionMask[i]! : 0);
      tokenTypeIds.push(isPresent ? encoding.tokenTypeIds[i]! : 0);
      mask.push(isPresent ? encoding.attentionMask[i]! : 0);
    }
    masks.push(mask);
  }

  const dims = [batch, width];
  const feeds: Record<string, ort.Tensor> = {
    input_ids: toBigIntTensor(inputIds, dims),
    attention_mask: toBigIntTensor(attentionMask, dims),
  };
  // Some ONNX exports drop token_type_ids; only feed it if the graph wants it.
  if (inputNames.includes('token_type_ids')) {
    feeds.token_type_ids = toBigIntTensor(tokenTypeIds, dims);
  }
  return { feeds, width, masks };
}

// Embedding

async function embedBatch(kind: EmbedderTaskKind, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  for (const [index, text] of texts.entries()) {
    if (!text.trim()) throw new Error(`Embedder input ${index} is empty`);
  }

  // Every real embed call is "activity" — push the idle-unload deadline back
  // out before we even resolve files, so a long-running batch never races
  // its own idle timer mid-flight.
  idleUnloader.touch();
  const files = resolveFiles();
  const [tokenizer, session] = await Promise.all([loadTokenizer(files), loadSession(files)]);

  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += DEFAULT_BATCH_SIZE) {
    const slice = texts.slice(offset, offset + DEFAULT_BATCH_SIZE);
    const encodings = slice.map((text) =>
      tokenizer.encodeSingle(applyTaskPrefix(kind, text), LOCAL_EMBEDDER_MAX_SEQUENCE_TOKENS)
    );
    const { feeds, width, masks } = makeBatchTensors(
      tokenizer.padTokenId,
      encodings,
      session.inputNames
    );
    const outputs = await session.run(feeds);
    const output = outputs.last_hidden_state ?? outputs[session.outputNames[0]!];
    if (!output) {
      throw new Error(
        `Embedder ONNX output missing. Available: ${Object.keys(outputs).join(', ')}`
      );
    }

    const dims = output.dims.map(Number);
    const hiddenSize = dims[2] ?? LOCAL_EMBEDDER_DIMENSIONS;
    if (hiddenSize !== LOCAL_EMBEDDER_DIMENSIONS) {
      throw new Error(
        `Embedder produced hidden size ${hiddenSize}, expected ${LOCAL_EMBEDDER_DIMENSIONS}`
      );
    }
    const data = output.data as Float32Array;
    for (let i = 0; i < slice.length; i += 1) {
      const slab = data.subarray(i * width * hiddenSize, (i + 1) * width * hiddenSize);
      const pooled = meanPool(slab as Float32Array, width, hiddenSize, masks[i]!);
      vectors.push(l2Normalize(layerNorm(pooled)));
    }
  }
  return vectors;
}

/** Embed content for ingest/indexing. Applies the `search_document: ` prefix. */
export async function embedDocument(text: string): Promise<number[]> {
  const [vector] = await embedBatch('document', [text]);
  return vector!;
}

/** Embed a search query. Applies the `search_query: ` prefix. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedBatch('query', [text]);
  return vector!;
}

// Status

export interface LocalEmbedderStatus {
  providerId: string;
  modelId: string;
  dimensions: number;
  /** All model files exist on disk (checksum is verified lazily at load). */
  ready: boolean;
  modelFile: string;
  error?: string;
}

/** Cheap readiness probe: file presence only, no session spin-up. */
export async function getLocalEmbedderStatus(): Promise<LocalEmbedderStatus> {
  const files = resolveFiles();
  const status: LocalEmbedderStatus = {
    providerId: LOCAL_EMBEDDER_PROVIDER_ID,
    modelId: LOCAL_EMBEDDER_MODEL_ID,
    dimensions: LOCAL_EMBEDDER_DIMENSIONS,
    ready: true,
    modelFile: files.modelFile,
  };
  try {
    await Promise.all([
      assertReadable(files.modelFile, 'Embedder ONNX model file'),
      assertReadable(files.vocabFile, 'Embedder vocabulary file'),
      assertReadable(files.tokenizerConfigFile, 'Embedder tokenizer config file'),
    ]);
  } catch (err) {
    status.ready = false;
    status.error = getErrorMessage(err);
  }
  return status;
}

/** Test hook: drop cached session/tokenizer so env-var path overrides take effect. */
export function resetLocalEmbedderForTests(): void {
  tokenizerPromise = null;
  sessionPromise = null;
  modelDigests.clear();
  lastSessionLoadFailure = null;
  idleUnloader.cancel();
}

/**
 * Test hook: force an immediate idle-unload regardless of the timer. Used by
 * the fake-timer unit tests (deterministic — no waiting on a real 10 minute
 * clock).
 */
export async function forceIdleUnloadForTests(): Promise<void> {
  idleUnloader.cancel();
  await unloadEmbedder();
}

/**
 * Warm the embedder in the background (called at boot, when
 * `shouldWarmEmbedderAtBoot()` says to). Missing files log an actionable
 * one-liner instead of throwing — the server must start offline.
 */
export function warmLocalEmbedder(): void {
  void (async () => {
    const status = await getLocalEmbedderStatus();
    if (!status.ready) {
      logger.warn(
        `[embedder] local model not ready — embedding + vector search unavailable. ` +
          `${status.error ? `${status.error} ` : ''}`
      );
      return;
    }
    try {
      const files = resolveFiles();
      await Promise.all([loadTokenizer(files), loadSession(files)]);
      // A warmed-but-never-used model still starts its idle clock here —
      // otherwise a server that warms at boot and then serves nothing for
      // hours would hold the ~137MB session forever (touch() is otherwise
      // only called from an actual embed call).
      idleUnloader.touch();
      logger.info(
        `[embedder] ${LOCAL_EMBEDDER_PROVIDER_ID}/${LOCAL_EMBEDDER_MODEL_ID} ready (${LOCAL_EMBEDDER_DIMENSIONS}d, ONNX)`
      );
    } catch (err) {
      logger.warn(`[embedder] warm-up failed: ${getErrorMessage(err)}`);
    }
  })();
}
