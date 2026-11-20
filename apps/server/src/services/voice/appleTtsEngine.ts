/**
 * appleTtsEngine — Node-side driver for the `snaglet-apple-tts` Swift daemon.
 *
 * Owns ONE long-lived daemon process (spawned lazily, restarted on crash with
 * backoff) and multiplexes synthesis requests over it by a per-request `id`, so
 * concurrent `synthesize` calls each get their own ordered frame stream even
 * though the daemon renders them serially. Exposes exactly the TTS surface the
 * voice router consumes: `synthesize(text, voiceId): AsyncIterable<TtsChunk>`
 * (float32 @ 22050 → Int16 via `f32ToI16`) plus `listVoices()` for the voice
 * capabilities endpoint.
 *
 * Mirror of {@link AppleSttEngine} (same spawn/backoff/injectable-spawn shape);
 * the difference is direction — TTS streams audio OUT rather than IN, so frames
 * are routed by request id rather than a single active session.
 *
 * Native rendering stays out of Node entirely; a daemon crash is contained and
 * respawned. On non-darwin hosts (or when the binary can't be built) the resolver
 * never constructs this — Snaglet uses the local piper TTS engine (the default).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { f32ToI16 } from './pcm';
import {
  createTtsFrameParser,
  encodeCancel,
  encodeListVoices,
  encodeSynthesize,
  type AppleVoiceInfo,
  type TtsFrame,
  type TtsJson,
} from './appleTtsProtocol';
import type { TtsChunk } from '@server/services/SocketService/voiceSession/types';

/**
 * AVSpeechSynthesizer renders at 22050 Hz; the daemon hands us float32 @ 22050
 * and we report that rate on every chunk (matches VOICE_TTS_DEFAULT_SAMPLE_RATE
 * and piper's own output rate, so the pipeline plays either engine at pitch).
 */
const APPLE_TTS_SAMPLE_RATE = 22_050;

export interface AppleTtsEngineOptions {
  /** Executable to run (the daemon binary path, or `node` for the fake). */
  readonly command: string;
  /** Args before the subcommand (e.g. `[fakeScript]` when command is `node`). */
  readonly prefixArgs?: readonly string[];
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  readonly spawn?: typeof spawn;
  /** Min ms between respawn attempts after a crash. */
  readonly restartBackoffMs?: number;
  /** Max ms to wait for a list-voices reply before returning []. */
  readonly listVoicesTimeoutMs?: number;
}

const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_LIST_VOICES_TIMEOUT_MS = 5_000;

/**
 * One in-flight synthesis: buffers coalesced frames and exposes them as an
 * ordered async iterable. `push` converts float32 → Int16 (the daemon is
 * float-native; the codec lives host-side). `done` distinguishes a natural
 * finish (END/error) from a consumer that abandoned the iterator early (which
 * the engine turns into a `cancel` so the daemon stops rendering — barge-in).
 */
class TtsStream {
  private readonly buffer: TtsChunk[] = [];
  private notify: (() => void) | null = null;
  private failure: Error | null = null;
  private ended = false;

  /** True once the stream reached a terminal state (END or error), not abort. */
  get done(): boolean {
    return this.ended || this.failure !== null;
  }

  push(float32: Float32Array): void {
    if (this.done) return;
    this.buffer.push({ pcm16: f32ToI16(float32), sampleRate: APPLE_TTS_SAMPLE_RATE });
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  fail(err: Error): void {
    if (this.done) return;
    this.failure = err;
    this.wake();
  }

  private wake(): void {
    const n = this.notify;
    this.notify = null;
    n?.();
  }

  async *iterate(): AsyncGenerator<TtsChunk> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}

interface VoicesPending {
  resolve: (voices: AppleVoiceInfo[]) => void;
}

export class AppleTtsEngine {
  private readonly command: string;
  private readonly prefixArgs: readonly string[];
  private readonly spawnFn: typeof spawn;
  private readonly backoffMs: number;
  private readonly listVoicesTimeoutMs: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private lastSpawnAt = 0;
  /** Set true during an intentional teardown so exit isn't treated as a crash. */
  private stopping = false;

  private nextId = 1;
  private readonly streams = new Map<number, TtsStream>();
  private readonly voicePending = new Map<number, VoicesPending>();

  constructor(opts: AppleTtsEngineOptions) {
    this.command = opts.command;
    this.prefixArgs = opts.prefixArgs ?? [];
    this.spawnFn = opts.spawn ?? spawn;
    this.backoffMs = opts.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.listVoicesTimeoutMs = opts.listVoicesTimeoutMs ?? DEFAULT_LIST_VOICES_TIMEOUT_MS;
  }

  /**
   * Synthesize `text` in `voiceId` (a bare AVSpeechSynthesisVoice identifier —
   * the router strips the `apple:` namespace first), yielding pcm16 @ 22050 as
   * the daemon renders. Abandoning the iterator early (barge-in) sends a
   * `cancel` so the daemon stops mid-utterance.
   */
  async *synthesize(text: string, voiceId: string): AsyncGenerator<TtsChunk> {
    const id = this.nextId++;
    const stream = new TtsStream();
    this.streams.set(id, stream);
    try {
      await this.ensureDaemon();
      this.write(encodeSynthesize(id, text, voiceId));
      yield* stream.iterate();
    } finally {
      const abandoned = !stream.done; // consumer broke before END/error → barge-in
      this.streams.delete(id);
      if (abandoned) {
        try {
          this.write(encodeCancel(id));
        } catch {
          // daemon already gone — nothing to cancel.
        }
      }
    }
  }

  /**
   * List the on-device voices AVSpeechSynthesizer reports as installed. Degrades
   * to `[]` (never throws/hangs) so the capabilities endpoint always answers —
   * a missing/slow daemon just means "no Apple voices offered", piper remains.
   */
  async listVoices(): Promise<AppleVoiceInfo[]> {
    const id = this.nextId++;
    try {
      await this.ensureDaemon();
    } catch {
      return [];
    }
    return new Promise<AppleVoiceInfo[]>((resolve) => {
      const timer = setTimeout(() => {
        if (this.voicePending.delete(id)) {
          logger.warn('[apple-tts] list-voices timed out — returning none');
          resolve([]);
        }
      }, this.listVoicesTimeoutMs);
      timer.unref?.();
      this.voicePending.set(id, {
        resolve: (voices) => {
          clearTimeout(timer);
          resolve(voices);
        },
      });
      try {
        this.write(encodeListVoices(id));
      } catch {
        clearTimeout(timer);
        this.voicePending.delete(id);
        resolve([]);
      }
    });
  }

  /** Pre-spawn the daemon so the first real synth pays no cold-start cost. */
  async warmup(): Promise<void> {
    await this.ensureDaemon();
  }

  /** Terminate the daemon (shutdown). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const s of this.streams.values()) s.fail(new Error('apple-tts shutting down'));
    this.streams.clear();
    for (const p of this.voicePending.values()) p.resolve([]);
    this.voicePending.clear();
    const p = this.proc;
    this.proc = null;
    this.ready = null;
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

  private ensureDaemon(): Promise<void> {
    // A new voice session explicitly re-arms the engine after shutdown.
    this.stopping = false;
    if (this.proc && this.ready) return this.ready;
    return this.spawnDaemon();
  }

  private spawnDaemon(): Promise<void> {
    const wait = Math.max(0, this.backoffMs - (Date.now() - this.lastSpawnAt));
    this.lastSpawnAt = Date.now() + wait;
    const args = [...this.prefixArgs, 'serve'];

    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const launch = (): void => {
      if (this.stopping) return;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.command, args);
      } catch (err) {
        this.readyReject?.(new Error(`apple-tts spawn failed: ${getErrorMessage(err)}`));
        return;
      }
      this.proc = child;
      const parse = createTtsFrameParser((frame) => this.onFrame(frame));
      child.stdout.on('data', parse);
      child.stderr.on('data', () => {}); // diagnostics only
      child.on('error', (err) => {
        logger.warn(`[apple-tts] process error: ${err.message}`);
        this.readyReject?.(new Error(err.message));
        this.handleExit(child);
      });
      child.on('exit', (code) => {
        // Only an UNEXPECTED exit of the CURRENT process is a crash — an
        // intentional teardown nulls this.proc before killing.
        if (code !== 0 && this.proc === child && !this.stopping) {
          logger.warn(`[apple-tts] daemon exited (code ${code})`);
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
    if (!this.stopping) {
      // Fail every in-flight synth + resolve pending list-voices so no caller
      // hangs on a dead daemon. The next synthesize()/listVoices() respawns.
      for (const s of this.streams.values()) s.fail(new Error('apple-tts daemon exited'));
      this.streams.clear();
      for (const p of this.voicePending.values()) p.resolve([]);
      this.voicePending.clear();
      this.readyReject?.(new Error('apple-tts daemon exited'));
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private onFrame(frame: TtsFrame): void {
    switch (frame.kind) {
      case 'audio':
        this.streams.get(frame.id)?.push(frame.float32);
        return;
      case 'end':
        this.streams.get(frame.id)?.end();
        return;
      case 'json':
        this.onJson(frame.json);
        return;
    }
  }

  private onJson(json: TtsJson): void {
    switch (json.type) {
      case 'ready':
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        return;
      case 'voices': {
        const pending = this.voicePending.get(json.id);
        this.voicePending.delete(json.id);
        pending?.resolve(json.voices);
        return;
      }
      case 'error': {
        if (typeof json.id === 'number') {
          this.streams.get(json.id)?.fail(new Error(json.message ?? 'apple-tts synth error'));
        }
        return;
      }
    }
  }

  private write(frame: Buffer): void {
    const p = this.proc;
    if (!p || !p.stdin.writable) throw new Error('apple-tts daemon not writable');
    p.stdin.write(frame);
  }
}
