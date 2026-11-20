/**
 * NlpHelperClient — Node-side driver for the `snaglet-nlp-helper` Swift daemon.
 *
 * Owns ONE long-lived helper process (spawned lazily on first use, restarted
 * on crash/timeout with a BOUNDED retry count) and serializes every
 * `extractEntities()` call through it one request at a time. The wire
 * protocol (see nlpProtocol.ts) has no request-id correlation — response
 * line N answers request N purely by stdout ordering — so strict
 * one-in-flight sequencing is what keeps requests and responses matched; a
 * second call made while the first is still pending queues behind it rather
 * than racing a second frame onto the same pipe.
 *
 * Never throws: `extractEntities` always resolves, falling back to
 * `{ entities: [], language: null }` when the binary is absent (probed once
 * at construction — see nlpHelperResolver.ensureNlpHelperBinary), spawn
 * ENOENTs, the process crashes, or a request times out. The fire-and-forget
 * write hook on the chat-send path (NlpEntityService.syncMessageEntities)
 * depends on this contract — a native-helper hiccup must never surface as an
 * error on the message-send path, and absent the helper this is strictly
 * additive: search still works without it (see
 * apps/server/src/services/search/ftsSearchNodes.ts's COALESCE fallback).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { createResponseLineParser, encodeRequestFrame, type NlpResponseLine } from './nlpProtocol';

export interface EntityExtractionResult {
  readonly entities: readonly string[];
  readonly language: string | null;
}

/**
 * The fallback result — see the class doc's never-throws contract. Frozen
 * (including the nested `entities` array) because this exact object is
 * returned by reference on every fallback path; without freezing, a caller
 * that mutated its `entities` array would corrupt every future fallback
 * result process-wide.
 */
export const EMPTY_EXTRACTION_RESULT: EntityExtractionResult = Object.freeze({
  entities: Object.freeze([] as string[]),
  language: null,
});

export interface NlpHelperClientOptions {
  /** Executable to run, or `null` when the helper is unavailable — never spawn. */
  readonly command: string | null;
  /** Args before/after the command (e.g. the fake helper script path + flags in tests). */
  readonly prefixArgs?: readonly string[];
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  readonly spawn?: typeof spawn;
  /** Max ms to wait for a response line before falling back + discarding the process. */
  readonly requestTimeoutMs?: number;
  /** Min ms between spawn attempts after a crash/timeout-triggered kill. */
  readonly restartBackoffMs?: number;
  /** Max spawn attempts before giving up permanently (bounded restart). */
  readonly maxRestarts?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_MAX_RESTARTS = 3;

export class NlpHelperClient {
  private readonly command: string | null;
  private readonly prefixArgs: readonly string[];
  private readonly spawnFn: typeof spawn;
  private readonly requestTimeoutMs: number;
  private readonly backoffMs: number;
  private readonly maxRestarts: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private lastSpawnAt = 0;
  private restarts = 0;
  /** Sticky: once true, never attempt to spawn again (binary absent/ENOENT,
   *  or the bounded restart budget is exhausted). */
  private disabled = false;
  /** Set true during an intentional teardown so exit isn't treated as a crash. */
  private stopping = false;

  // Serializes every request onto this chain — see class doc for why at most
  // one request may be in flight at a time.
  private queue: Promise<unknown> = Promise.resolve();

  // Monotonically-increasing id, bumped on every spawn. Each child's stdout
  // parser closure is tagged with the generation it was spawned as (see
  // spawnProc); a response line is only ever accepted for the CURRENT
  // pending request if it originates from that same generation (see onLine)
  // — this is what stops a killed-but-still-buffered child's stdout chunk
  // from being misdelivered into a later, unrelated request's slot.
  private generation = 0;
  private pendingResolve: ((result: EntityExtractionResult) => void) | null = null;
  /** The generation of the child the currently in-flight request was sent to. */
  private pendingGeneration: number | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: NlpHelperClientOptions) {
    this.command = opts.command;
    this.prefixArgs = opts.prefixArgs ?? [];
    this.spawnFn = opts.spawn ?? spawn;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffMs = opts.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    // Probed once at construction time: a null command means the caller
    // already determined the helper is unavailable (see
    // nlpHelperResolver.ensureNlpHelperBinary) — never attempt to spawn.
    if (this.command === null) this.disabled = true;
  }

  /** Extract entities + dominant language for `text`. Never throws. */
  extractEntities(text: string): Promise<EntityExtractionResult> {
    const run = this.queue.then(() => this.doExtract(text));
    // Keep the queue alive regardless of this request's outcome so one
    // failed/timed-out request never wedges every request queued after it.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Terminate the helper process (server shutdown / test teardown). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.rejectPending();
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    if (p) {
      this.detachChild(p); // see killForDesync's comment — this is a kill path too
      p.kill();
    }
    this.stopping = false;
  }

  private async doExtract(text: string): Promise<EntityExtractionResult> {
    if (this.disabled) return EMPTY_EXTRACTION_RESULT;
    try {
      await this.ensureProc();
    } catch {
      return EMPTY_EXTRACTION_RESULT;
    }
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) return EMPTY_EXTRACTION_RESULT;
    // The generation of the child this request is being sent to — captured
    // now, while `proc`/`this.generation` are still in lockstep (set
    // together in spawnProc's launch()). See the `generation` field doc.
    const requestGeneration = this.generation;

    return new Promise<EntityExtractionResult>((resolve) => {
      let settled = false;
      const finish = (result: EntityExtractionResult): void => {
        if (settled) return;
        settled = true;
        if (this.pendingTimer) {
          clearTimeout(this.pendingTimer);
          this.pendingTimer = null;
        }
        this.pendingResolve = null;
        this.pendingGeneration = null;
        resolve(result);
      };

      this.pendingResolve = finish;
      this.pendingGeneration = requestGeneration;
      this.pendingTimer = setTimeout(() => {
        logger.warn('[nlp-helper] request timed out — falling back to empty entities');
        finish(EMPTY_EXTRACTION_RESULT);
        // If the response eventually arrives after this, it would otherwise
        // misalign with the next request (no request-id correlation in the
        // protocol) — kill the process now so the next call respawns a clean
        // one rather than risk reading a stale/desynced line.
        this.killForDesync();
      }, this.requestTimeoutMs);
      this.pendingTimer.unref?.();

      try {
        proc.stdin.write(encodeRequestFrame(text));
      } catch (err) {
        logger.warn(`[nlp-helper] request write failed: ${getErrorMessage(err)}`);
        finish(EMPTY_EXTRACTION_RESULT);
      }
    });
  }

  private killForDesync(): void {
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    // Detach before kill: a response this child already wrote for the
    // timed-out request can still be sitting, fully readable, in the OS
    // pipe buffer — killing the process does not discard those bytes, and
    // without removing the 'data' listener + destroying the stream, that
    // buffered chunk can surface later (after a replacement child has been
    // spawned for the next request) and get misdelivered into it. The
    // generation check in onLine is a second, independent guard against the
    // same race.
    this.detachChild(p);
    p.kill();
    this.proc = null;
    this.ready = null;
    this.stopping = false;
  }

  /**
   * Permanently sever a discarded child so it can never deliver another
   * event to this client — called whenever a child is being replaced (kill
   * for desync, crash exit) or torn down (shutdown). See killForDesync's
   * comment for why this matters even after the process has been kill()ed.
   */
  private detachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout?.removeAllListeners();
    child.stdout?.destroy();
    child.removeAllListeners();
  }

  private ensureProc(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    return this.spawnProc();
  }

  private spawnProc(): Promise<void> {
    if (this.disabled) return Promise.reject(new Error('nlp-helper disabled'));
    if (this.restarts >= this.maxRestarts) {
      this.disabled = true;
      logger.warn(`[nlp-helper] giving up after ${this.restarts} restart(s) — disabling helper`);
      return Promise.reject(new Error('nlp-helper restart budget exhausted'));
    }

    const wait = Math.max(0, this.backoffMs - (Date.now() - this.lastSpawnAt));
    this.lastSpawnAt = Date.now() + wait;

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const launch = (): void => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(
          this.command as string,
          this.prefixArgs as string[]
        ) as ChildProcessWithoutNullStreams;
      } catch (err) {
        // Synchronous spawn failure (e.g. ENOENT on some platforms) — never
        // retry a binary that doesn't exist.
        this.disabled = true;
        this.readyReject?.(new Error(`nlp-helper spawn failed: ${getErrorMessage(err)}`));
        return;
      }
      this.proc = child;
      // Tag this child's generation at spawn time and close over it in the
      // parser closure — every line this SPECIFIC child ever emits is
      // reported to onLine with that fixed generation id, regardless of
      // what `this.generation`/`this.proc` have moved on to by the time the
      // line is actually parsed (see onLine + the `generation` field doc).
      this.generation += 1;
      const gen = this.generation;
      const parseLine = createResponseLineParser((line) => this.onLine(gen, line));
      child.stdout.on('data', parseLine);
      child.stderr.on('data', () => {}); // diagnostics only, never parsed
      // Node commonly reports ENOENT asynchronously via 'error' rather than a
      // synchronous throw from spawn(); swallow the matching stdin EPIPE so
      // a write to an already-dead process doesn't crash as an unhandled
      // stream error — the 'exit' handler below resolves any pending request.
      child.stdin.on('error', () => {});
      child.on('error', (err) => {
        logger.warn(`[nlp-helper] process error: ${err.message}`);
        if (/ENOENT/.test(err.message)) this.disabled = true;
        this.readyReject?.(new Error(err.message));
        this.handleExit(child);
      });
      child.on('exit', (code) => {
        if (code !== 0 && this.proc === child && !this.stopping) {
          logger.warn(`[nlp-helper] helper exited (code ${code})`);
        }
        this.handleExit(child);
      });
      // The daemon has no explicit "ready" handshake (unlike the STT sidecar,
      // which waits for the on-device model to install) — NLTagger/
      // NLLanguageRecognizer need no asset install, so "ready" here just
      // means "spawned without a synchronous error".
      this.readyResolve?.();
    };

    if (wait > 0) setTimeout(launch, wait);
    else launch();
    return this.ready;
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    // Belt-and-suspenders even on a "natural" crash/exit (not just the
    // explicit killForDesync path) — see detachChild's doc.
    this.detachChild(child);
    if (this.proc !== child) return; // stale exit from an already-replaced proc
    this.proc = null;
    this.ready = null;
    if (!this.stopping) {
      this.restarts += 1;
      this.rejectPending();
    }
  }

  private onLine(sourceGeneration: number, line: NlpResponseLine): void {
    // Drop any line whose child generation doesn't match the generation the
    // CURRENTLY pending request was dispatched to. Without this: if the
    // event loop stalls past requestTimeoutMs while a response this child
    // already wrote sits unread, killForDesync() discards the child and the
    // next request goes to a freshly spawned replacement — but the old
    // child's buffered chunk can still arrive afterward and, absent this
    // check, would be misdelivered as the answer to that later request (see
    // the response-ordering desync test in NlpHelperClient.test.ts).
    if (sourceGeneration !== this.pendingGeneration) {
      logger.warn(
        `[nlp-helper] dropping stale response from generation ${sourceGeneration} (expected ${this.pendingGeneration})`
      );
      return;
    }
    // A healthy round trip — reset the consecutive-crash counter so a single
    // old crash early in a long-running server doesn't count against a much
    // later, unrelated one (the budget bounds a CRASH STREAK, not lifetime
    // total restarts).
    this.restarts = 0;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingGeneration = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    resolve?.({ entities: line.entities, language: line.language });
  }

  private rejectPending(): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingGeneration = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    // Degrade rather than hang/throw — see class doc's never-throws contract.
    resolve?.(EMPTY_EXTRACTION_RESULT);
  }
}
