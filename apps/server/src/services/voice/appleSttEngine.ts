/**
 * appleSttEngine — Node-side driver for the `snaglet-apple-stt` Swift sidecar.
 *
 * Owns ONE long-lived sidecar process (spawned lazily, restarted on crash with
 * backoff) and multiplexes Snaglet's per-utterance STT sessions over it — one at a
 * time, matching how VoiceSessionService opens/finalizes/closes a session per
 * utterance. Exposes the same session surface the voice engine adapter consumes:
 * `feed` / `onPartial` / `finalize` / `close`, plus `wantsNativeRate: true` so
 * the session layer streams NATIVE-rate pcm straight through (the sidecar does a
 * band-limited AVAudioConverter down-convert internally — no client resampling).
 *
 * Native inference stays out of Node entirely; a sidecar crash is contained and
 * respawned. On non-darwin hosts (or when the binary can't be built) the resolver
 * never constructs this — Snaglet falls back to the local ONNX STT engine.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  createLineParser,
  encodeAudioFrame,
  encodeFinalizeFrame,
  type SttFailureCode,
  type SttLine,
} from './appleSttProtocol';

/**
 * Apple speech recognition can't run. `message` is plain language that names
 * the fix, ready to show the user; `code` is the sidecar's classification.
 */
export class AppleSttError extends Error {
  constructor(
    readonly code: SttFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'AppleSttError';
  }
}

const FAILURE_CODES: ReadonlySet<string> = new Set<SttFailureCode>([
  'unsupported-os',
  'locale',
  'assets',
  'not-authorized',
  'failed',
]);

/** The user-facing reason for a sidecar failure (`detail` = Apple's own words). */
function appleSttFailure(code: string | undefined, detail?: string): AppleSttError {
  const known: SttFailureCode =
    code && FAILURE_CODES.has(code) ? (code as SttFailureCode) : 'failed';
  const why = detail?.trim() ? ` (${detail.trim()})` : '';
  switch (known) {
    case 'not-authorized':
      return new AppleSttError(
        known,
        'macOS is blocking speech recognition for Snaglet. Allow Snaglet in System Settings → ' +
          'Privacy & Security → Speech Recognition, then try again.'
      );
    case 'unsupported-os':
      return new AppleSttError(
        known,
        "Apple's built-in speech recognition needs macOS 26 or later. Install Snaglet's own " +
          'voice models from Settings → Local storage to dictate on this Mac.'
      );
    case 'locale':
      return new AppleSttError(
        known,
        `Apple's built-in speech recognition has no English model on this Mac${why}.`
      );
    case 'assets':
      return new AppleSttError(
        known,
        `macOS couldn't set up its on-device speech model${why}. Check your internet ` +
          'connection, then try again.'
      );
    default:
      return new AppleSttError(
        'failed',
        `Apple's built-in speech recognition didn't start${why}. Check System Settings → ` +
          'Privacy & Security → Speech Recognition and Microphone, then try again.'
      );
  }
}

/** A sidecar that could not be spawned at all (missing binary, no permission). */
function spawnFailure(err: unknown): AppleSttError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return appleSttFailure(
      'failed',
      "Snaglet's speech helper is missing or can't run; reinstalling Snaglet restores it"
    );
  }
  return appleSttFailure('failed', getErrorMessage(err));
}

/**
 * Tracks why one sidecar process failed: its `error` line, or (an older binary
 * that never sends one) its last `ERROR:` stderr line, and whether it had
 * started — a process that dies after `ready` quit; one that dies before
 * didn't start.
 */
function createFailureTracker(): {
  onLine(line: SttLine): void;
  onStderr(chunk: Buffer): void;
  failure(): AppleSttError;
} {
  let reported: AppleSttError | null = null;
  let started = false;
  let stderrDetail = '';
  return {
    onLine(line) {
      if (line.type === 'ready') started = true;
      if (line.type === 'error') reported = appleSttFailure(line.code, line.message);
    },
    onStderr(chunk) {
      const match = /ERROR: (.+)/.exec(chunk.toString('utf8'));
      if (match?.[1]) stderrDetail = match[1].trim();
    },
    failure() {
      if (reported) return reported;
      if (!started) return appleSttFailure('failed', stderrDetail);
      const why = stderrDetail ? ` (${stderrDetail})` : '';
      return new AppleSttError(
        'failed',
        `Apple's built-in speech recognition quit unexpectedly${why}. Turn Dictation off ` +
          'and on to try again.'
      );
    },
  };
}

/** Streaming STT session over the Apple sidecar (one active at a time). */
export interface AppleSttSession {
  /** Stream NATIVE-rate pcm16 (the sidecar down-converts to 16 kHz internally). */
  feed(pcm16: Int16Array): void;
  /** Subscribe to interim (cased + punctuated) partial transcripts. */
  onPartial(cb: (text: string) => void): void;
  /**
   * Called once if the sidecar can't serve this session: it never started, it
   * crashed, or it stopped accepting audio. The error is an {@link AppleSttError}
   * whose message names the fix. Later feeds are dropped.
   */
  onError(cb: (err: Error) => void): void;
  /** End the utterance; resolves the full, cased + punctuated final. */
  finalize(): Promise<string>;
  /** Discard the utterance (re-arms the sidecar for the next one). */
  close(): void;
  /** The session layer must feed native-rate audio (no server-side decimation). */
  readonly wantsNativeRate: true;
}

export interface AppleSttEngineOptions {
  /** Executable to run (the sidecar binary path, or `node` for the fake). */
  readonly command: string;
  /** Args before the subcommand (e.g. `[fakeScript]` when command is `node`). */
  readonly prefixArgs?: readonly string[];
  /** Contextual biasing strings (unverified — see the sidecar README). */
  readonly hints?: readonly string[];
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  readonly spawn?: typeof spawn;
  /** Min ms between respawn attempts after a crash. */
  readonly restartBackoffMs?: number;
  /** Max ms to wait for a `final` line after FINALIZE before falling back. */
  readonly finalizeTimeoutMs?: number;
}

const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_FINALIZE_TIMEOUT_MS = 5_000;

export class AppleSttEngine {
  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly hints: readonly string[];
  private readonly spawnFn: typeof spawn;
  private readonly backoffMs: number;
  private readonly finalizeTimeoutMs: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private procRate: number | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private lastSpawnAt = 0;
  /** Set true during an intentional teardown so exit isn't treated as a crash. */
  private stopping = false;

  // Current-session routing (only one session is active at a time).
  private partialCb: ((text: string) => void) | null = null;
  /** Fails the active session (see AppleSttSession.onError); null between sessions. */
  private activeFail: ((err: Error) => void) | null = null;
  /** Failure reports from the current stream process. */
  private streamFailures = createFailureTracker();
  private lastPartial = '';
  private pendingFinal: ((text: string) => void) | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AppleSttEngineOptions) {
    this.command = opts.command;
    this.prefixArgs = opts.prefixArgs ?? [];
    this.hints = opts.hints ?? [];
    this.spawnFn = opts.spawn ?? spawn;
    this.backoffMs = opts.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.finalizeTimeoutMs = opts.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS;
  }

  /**
   * Pre-install the on-device model (the sidecar `warmup` subcommand: a short-
   * lived process that downloadAndInstall()s and exits). Pays the one-time ~4 s
   * asset cost up front so the first real utterance's stream spawn is fast.
   * Doubles as the "can Apple speech run here?" probe: it rejects with an
   * {@link AppleSttError} whose message names the fix.
   */
  warmup(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.command, [...this.prefixArgs, 'warmup']);
      } catch (err) {
        reject(spawnFailure(err));
        return;
      }
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const failures = createFailureTracker();
      const parse = createLineParser((line) => {
        failures.onLine(line);
        if (line.type === 'ready') done(resolve);
      });
      child.stdout.on('data', parse);
      child.stderr.on('data', (chunk: Buffer) => failures.onStderr(chunk));
      child.on('error', (err) => done(() => reject(spawnFailure(err))));
      child.on('exit', (code) => done(() => (code === 0 ? resolve() : reject(failures.failure()))));
    });
  }

  /** Open a streaming STT session for one utterance at `sampleRate` (native). */
  createSttSession(opts?: { sampleRate?: number }): AppleSttSession {
    const rate = opts?.sampleRate && opts.sampleRate > 0 ? Math.round(opts.sampleRate) : 16_000;
    const ready = this.ensureStream(rate);

    this.partialCb = null;
    this.lastPartial = '';
    let queue: Promise<void> = ready;
    let finalized = false;
    let fedAny = false;
    let failure: Error | null = null;
    let errorCb: ((err: Error) => void) | null = null;

    const engine = this;
    const fail = (err: Error): void => {
      // An intentional teardown is not a failure; report a real one once.
      if (failure || engine.stopping) return;
      failure = err;
      logger.warn(`[apple-stt] session failed: ${err.message}`);
      errorCb?.(err);
    };
    this.activeFail = fail;
    // A stream that never comes up fails the session (once) instead of every feed.
    ready.catch((err: unknown) => fail(engine.streamFailureFrom(err)));

    return {
      wantsNativeRate: true,
      feed(pcm16: Int16Array): void {
        if (failure) return; // the sidecar is gone; onError already reported it
        fedAny = true;
        queue = queue
          .then(() => {
            engine.write(encodeAudioFrame(pcm16));
          })
          .catch((err) => {
            fail(engine.streamFailureFrom(err));
          });
      },
      onPartial(cb: (text: string) => void): void {
        engine.partialCb = cb;
      },
      onError(cb: (err: Error) => void): void {
        errorCb = cb;
        if (failure) cb(failure);
      },
      async finalize(): Promise<string> {
        if (finalized) return engine.lastPartial;
        finalized = true;
        // eslint-disable-next-line no-restricted-syntax -- intentional: feed failures are already reported via fail(); this only awaits the drain
        await queue.catch(() => {});
        return engine.requestFinal(fedAny);
      },
      close(): void {
        engine.partialCb = null;
        if (engine.activeFail === fail) engine.activeFail = null;
        errorCb = null;
        // Not finalized but audio was fed → tell the sidecar to drop it and
        // re-arm, so the next session doesn't inherit stale analyzer state.
        if (!finalized && fedAny) {
          finalized = true;
          void engine.requestFinal(true).catch((err) => {
            logger.debug(`[apple-stt] drop+re-arm on close failed: ${getErrorMessage(err)}`);
          });
        }
      },
    };
  }

  /** Terminate the sidecar (session teardown / shutdown). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.rejectPending(new Error('apple-stt shutting down'));
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    this.procRate = null;
    if (p) {
      p.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            p.kill('SIGKILL');
          } finally {
            resolve();
          }
        }, 250);
        timer.unref?.();
        p.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Ensure a stream process at `rate` is running; (re)spawn if needed. */
  private ensureStream(rate: number): Promise<void> {
    // A new voice session explicitly re-arms the engine after shutdown.
    this.stopping = false;
    if (this.proc && this.procRate === rate && this.ready) return this.ready;
    if (this.proc && this.procRate !== rate) {
      // Rate changed (unusual) — restart on the new rate.
      this.stopping = true;
      this.proc.kill();
      this.proc = null;
      this.ready = null;
      this.stopping = false;
    }
    if (this.proc && this.ready) return this.ready;
    return this.spawnStream(rate);
  }

  private spawnStream(rate: number): Promise<void> {
    const wait = Math.max(0, this.backoffMs - (Date.now() - this.lastSpawnAt));
    this.lastSpawnAt = Date.now() + wait;
    const args = [...this.prefixArgs, 'stream', '--rate', String(rate)];
    if (this.hints.length > 0) args.push('--hints', this.hints.join(','));

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.procRate = rate;

    const launch = (): void => {
      if (this.stopping) return;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.command, args);
      } catch (err) {
        this.readyReject?.(spawnFailure(err));
        return;
      }
      this.proc = child;
      const failures = createFailureTracker();
      this.streamFailures = failures;
      const parse = createLineParser((line) => {
        if (this.proc === child) failures.onLine(line);
        this.onLine(line);
      });
      child.stdout.on('data', parse);
      // Diagnostics only — kept just to name a failure an older binary reports there.
      child.stderr.on('data', (chunk: Buffer) => failures.onStderr(chunk));
      child.on('error', (err) => {
        logger.warn(`[apple-stt] process error: ${err.message}`);
        this.readyReject?.(spawnFailure(err));
        this.handleExit(child);
      });
      child.on('exit', (code) => {
        // Only an UNEXPECTED exit of the CURRENT process is a crash — an
        // intentional teardown nulls this.proc before killing.
        if (code !== 0 && this.proc === child && !this.stopping) {
          logger.warn(`[apple-stt] sidecar exited (code ${code})`);
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
    this.procRate = null;
    if (this.stopping) return;
    // Name the cause (the sidecar's own error line when it sent one) to the
    // session that was using it and to a start still waiting on `ready`.
    const failure = this.streamFailures.failure();
    this.rejectPending(failure);
    this.activeFail?.(failure);
  }

  /** The user-facing reason the stream failed: the process's own report, if any. */
  private streamFailureFrom(err: unknown): AppleSttError {
    if (err instanceof AppleSttError) return err;
    if (!this.proc) return this.streamFailures.failure();
    return appleSttFailure('failed', getErrorMessage(err));
  }

  private onLine(line: SttLine): void {
    switch (line.type) {
      case 'ready':
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        return;
      case 'partial': {
        const text = line.text ?? '';
        this.lastPartial = text;
        if (text) this.partialCb?.(text);
        return;
      }
      case 'final': {
        const text = (line.text ?? '').trim();
        this.lastPartial = text;
        const resolve = this.pendingFinal;
        this.pendingFinal = null;
        if (this.finalizeTimer) {
          clearTimeout(this.finalizeTimer);
          this.finalizeTimer = null;
        }
        resolve?.(text);
        return;
      }
      case 'error':
        // Recorded by the stream's failure tracker; the exit that follows reports it.
        return;
    }
  }

  /** Send FINALIZE and await the sidecar's single `final` line (with a timeout). */
  private requestFinal(fedAny: boolean): Promise<string> {
    if (!fedAny) return Promise.resolve('');
    return new Promise<string>((resolve) => {
      this.pendingFinal = resolve;
      this.finalizeTimer = setTimeout(() => {
        // Sidecar didn't answer in time — fall back to the last partial.
        if (this.pendingFinal === resolve) {
          logger.warn('[apple-stt] finalize timed out — using last partial');
          this.pendingFinal = null;
          resolve(this.lastPartial.trim());
        }
      }, this.finalizeTimeoutMs);
      this.finalizeTimer.unref?.();
      try {
        this.write(encodeFinalizeFrame());
      } catch (err) {
        logger.warn(`[apple-stt] finalize write failed: ${getErrorMessage(err)}`);
        if (this.pendingFinal === resolve) {
          this.pendingFinal = null;
          resolve(this.lastPartial.trim());
        }
      }
    });
  }

  private write(frame: Buffer): void {
    const p = this.proc;
    if (!p || !p.stdin.writable) throw new Error('apple-stt sidecar not writable');
    p.stdin.write(frame);
  }

  private rejectPending(err: Error): void {
    const resolve = this.pendingFinal;
    this.pendingFinal = null;
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    // A rejected finalize should still resolve (best-effort) with the last
    // partial so the pipeline degrades rather than hangs.
    if (resolve) resolve(this.lastPartial.trim());
    if (this.readyReject) {
      this.readyReject(err);
      this.readyReject = null;
      this.readyResolve = null;
    }
  }
}
