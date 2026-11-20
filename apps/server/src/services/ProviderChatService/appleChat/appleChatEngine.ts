/**
 * appleChatEngine: Node-side driver for the `snaglet-apple-chat` Swift sidecar.
 * Owns one long-lived sidecar process (spawned lazily, restarted on crash with
 * backoff, like AppleSttEngine) and multiplexes many Snaglet chat sessions over it;
 * the sidecar makes a fresh `LanguageModelSession` per request (chat.swift).
 *
 * Per-session mutex: two concurrent generations on the same FoundationModels
 * session crash the process (SIGTRAP) about 22% of the time. chat.swift never
 * reuses a session, but this engine does not rely on that: requests are
 * serialized per session key (a promise chain per key) while different keys run
 * in parallel. Snapshot diffing happens in chat.swift; this relays each `token`
 * line's `text` to `onChunk`.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { createLineParser, encodeRequestLine, type ChatLine } from './appleChatProtocol';

export interface AppleChatRequest {
  /**
   * Groups requests that must never run concurrently against each other —
   * in practice `${agentId}:${threadId}`. Different keys parallelize freely;
   * the same key is queued (see the per-session-mutex note above).
   */
  readonly sessionKey: string;
  readonly prompt: string;
  readonly instructions?: string;
  readonly maxTokens?: number;
  readonly onChunk?: (text: string) => void;
  readonly signal?: AbortSignal;
}

export interface AppleChatResult {
  readonly text: string;
  readonly stopReason: string;
}

export interface AppleChatAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface AppleChatEngineOptions {
  /** Executable to run (the sidecar binary path, or `node` for the fake). */
  readonly command: string;
  /** Args before the subcommand (e.g. `[fakeScript]` when command is `node`). */
  readonly prefixArgs?: readonly string[];
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  readonly spawn?: typeof spawn;
  /** Min ms between respawn attempts after a crash. */
  readonly restartBackoffMs?: number;
}

interface PendingRequest {
  text: string;
  onChunk?: ((text: string) => void) | undefined;
  resolve: (result: AppleChatResult) => void;
  reject: (err: Error) => void;
}

const DEFAULT_BACKOFF_MS = 500;

function makeAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

export class AppleChatEngine {
  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly spawnFn: typeof spawn;
  private readonly backoffMs: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private lastSpawnAt = 0;
  /** Set true during an intentional teardown so exit isn't treated as a crash. */
  private stopping = false;

  private readonly pending = new Map<string, PendingRequest>();
  /** Per-session request queue tails — see the per-session-mutex note above. */
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(opts: AppleChatEngineOptions) {
    this.command = opts.command;
    this.prefixArgs = opts.prefixArgs ?? [];
    this.spawnFn = opts.spawn ?? spawn;
    this.backoffMs = opts.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /**
   * Run one chat turn. Requests sharing `sessionKey` with an already
   * in-flight (or still-queued) request are queued behind it — never sent to
   * the sidecar concurrently. Requests with a different `sessionKey` run
   * immediately, in parallel with anything else in flight.
   */
  chat(req: AppleChatRequest): Promise<AppleChatResult> {
    const key = req.sessionKey;
    const prevTail = this.sessionQueues.get(key) ?? Promise.resolve();

    // Chain this call behind the previous one for this session (swallow the
    // previous call's rejection here so one failed turn doesn't wedge the
    // queue for the next one).
    // eslint-disable-next-line no-restricted-syntax -- intentional: prior turn's rejection is already surfaced to its own caller; catching here only unblocks the queue
    const runPromise = prevTail.catch(() => undefined).then(() => this.runOne(req));

    const tail = runPromise.then(
      () => undefined,
      () => undefined
    );
    this.sessionQueues.set(key, tail);
    // Self-cleanup: drop the map entry once this is the most recent tail for
    // the key and it has settled, so idle sessions don't accumulate forever.
    void tail.then(() => {
      if (this.sessionQueues.get(key) === tail) this.sessionQueues.delete(key);
    });

    return runPromise;
  }

  /** Query on-device model availability (short-lived, separate process). */
  checkAvailability(): Promise<AppleChatAvailability> {
    return new Promise<AppleChatAvailability>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.command, [...this.prefixArgs, 'availability']);
      } catch (err) {
        resolve({ available: false, reason: `spawnFailed: ${getErrorMessage(err)}` });
        return;
      }
      let settled = false;
      const done = (result: AppleChatAvailability): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const parse = createLineParser((line) => {
        if (line.type === 'availability') {
          done({ available: line.available === true, reason: line.reason });
        }
      });
      child.stdout.on('data', parse);
      child.stderr.on('data', () => {});
      child.on('error', (err) =>
        done({ available: false, reason: `processError: ${err.message}` })
      );
      child.on('exit', (code) => done({ available: false, reason: `exited(${code})` }));
    });
  }

  /** Terminate the sidecar (session teardown / shutdown). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const err = new Error('apple-chat sidecar shutting down');
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this.sessionQueues.clear();
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    if (p) p.kill();
    this.stopping = false;
  }

  private runOne(req: AppleChatRequest): Promise<AppleChatResult> {
    return new Promise<AppleChatResult>((resolve, reject) => {
      let settled = false;
      let id: string | null = null;

      const cleanup = (): void => {
        if (req.signal) req.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (id) {
          this.pending.delete(id);
          try {
            this.write({ id, cancel: true });
          } catch {
            // best-effort — the process may already be gone
          }
        }
        cleanup();
        reject(makeAbortError());
      };

      // Attach the abort listener synchronously, before any `await` below:
      // ensureProcess() can take real time on the first call (spawning the
      // sidecar, waiting for its `ready` line), and AbortSignal's 'abort' event
      // does not replay for listeners added after it fired, so an abort in
      // that window would be lost and the request would run to completion.
      if (req.signal?.aborted) {
        reject(makeAbortError());
        return;
      }
      if (req.signal) req.signal.addEventListener('abort', onAbort, { once: true });

      this.ensureProcess()
        .then(() => {
          if (settled) return; // aborted while we were waiting for the process
          id = randomUUID();
          this.pending.set(id, {
            text: '',
            onChunk: req.onChunk,
            resolve: (result) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(result);
            },
            reject: (err) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(err);
            },
          });
          try {
            this.write({
              id,
              prompt: req.prompt,
              instructions: req.instructions,
              maxTokens: req.maxTokens,
            });
          } catch (err) {
            settled = true;
            cleanup();
            this.pending.delete(id);
            reject(new Error(`apple-chat write failed: ${getErrorMessage(err)}`));
          }
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
        });
    });
  }

  private ensureProcess(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    return this.spawnProcess();
  }

  private spawnProcess(): Promise<void> {
    const wait = Math.max(0, this.backoffMs - (Date.now() - this.lastSpawnAt));
    this.lastSpawnAt = Date.now() + wait;

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const launch = (): void => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.command, [...this.prefixArgs, 'chat']);
      } catch (err) {
        this.readyReject?.(new Error(`apple-chat spawn failed: ${getErrorMessage(err)}`));
        return;
      }
      this.proc = child;
      const parse = createLineParser((line) => this.onLine(line));
      child.stdout.on('data', parse);
      child.stderr.on('data', () => {}); // diagnostics only
      child.on('error', (err) => {
        logger.warn(`[apple-chat] process error: ${err.message}`);
        this.readyReject?.(new Error(err.message));
        this.handleExit(child);
      });
      child.on('exit', (code) => {
        // Only an UNEXPECTED exit of the CURRENT process is a crash — an
        // intentional teardown nulls this.proc before killing (same
        // stale-exit guard as AppleSttEngine).
        if (code !== 0 && this.proc === child && !this.stopping) {
          logger.warn(`[apple-chat] sidecar exited (code ${code})`);
        }
        this.handleExit(child);
      });
    };

    if (wait > 0) setTimeout(launch, wait);
    else launch();
    return this.ready;
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.proc !== child) return; // stale exit from an already-replaced proc
    this.proc = null;
    this.ready = null;
    if (this.stopping) return;
    this.readyReject?.(new Error('apple-chat sidecar exited'));
    this.readyReject = null;
    this.readyResolve = null;
    // Every in-flight request on the dead process fails now; the NEXT chat()
    // call respawns (with backoff) and gets a fresh process.
    const err = new Error('apple-chat sidecar exited');
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private onLine(line: ChatLine): void {
    if (line.type === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (!line.id) return;
    const pending = this.pending.get(line.id);
    if (!pending) return; // already settled (e.g. raced with an abort/cancel)

    switch (line.type) {
      case 'token': {
        const text = line.text ?? '';
        if (text) {
          pending.text += text;
          pending.onChunk?.(text);
        }
        return;
      }
      case 'done': {
        this.pending.delete(line.id);
        pending.resolve({ text: pending.text, stopReason: line.stopReason ?? 'end_turn' });
        return;
      }
      case 'error': {
        this.pending.delete(line.id);
        pending.reject(new Error(line.message ?? 'apple-chat sidecar error'));
        return;
      }
    }
  }

  private write(req: {
    id: string;
    prompt?: string;
    instructions?: string;
    maxTokens?: number;
    cancel?: boolean;
  }): void {
    const p = this.proc;
    if (!p || !p.stdin.writable) throw new Error('apple-chat sidecar not writable');
    p.stdin.write(encodeRequestLine(req));
  }
}
