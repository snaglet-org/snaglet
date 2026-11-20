// Web Audio playback queue for incoming TTS. Decodes voice:tts:chunk pcm16 into
// AudioBuffers and schedules them back-to-back on a single play head (the floor
// = one speaker at a time), plays each utterance's chunks in seq order, and
// fires onUtteranceDone when an utterance's audio has fully played out (the
// floor heartbeat → voice:playback:done). Barge-in calls flush(): instant stop +
// clear, returning the estimated heardUpTo of whatever was playing.
//
// The AudioContext is injectable so tests drive it with a fake clock + manual
// onended, without a real Web Audio stack.

import type {
  HeardUpTo,
  PlaybackController,
  PlaybackOptions,
  VoiceTtsChunkPayload,
} from '../voiceTypes';
import { ESTIMATED_CHARS_PER_SECOND, VOICE_TTS_DEFAULT_SAMPLE_RATE } from '../voiceConstants';
import { base64ToInt16, int16ToFloat32 } from './pcm';

interface UtteranceState {
  id: string;
  agentId: string;
  /** Synthesis rate for this utterance's pcm (from the chunk payload). */
  sampleRate: number;
  /** seq → decoded samples awaiting scheduling. */
  buffered: Map<number, Int16Array>;
  /** Next seq to schedule (contiguous drain). */
  nextSeq: number;
  /** voice:tts:end seen. */
  ended: boolean;
  /** Scheduled sources not yet finished. */
  sourcesActive: number;
  /** ctx.currentTime at which this utterance's first buffer starts. */
  startedAt: number | null;
  /** Running sum of scheduled buffer durations (seconds). */
  totalDurationSec: number;
  done: boolean;
}

export interface PlaybackQueueOptions extends PlaybackOptions {
  /** Injectable for tests; defaults to a real AudioContext. */
  createContext?: () => AudioContext;
}

export class PlaybackQueue implements PlaybackController {
  private readonly onUtteranceDone: (utteranceId: string) => void;
  private readonly createContext: () => AudioContext;

  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private playHead = 0;
  private readonly utterances = new Map<string, UtteranceState>();
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  /** The utterance currently owning the play head (barge-in target). */
  private currentUtteranceId: string | null = null;
  /** utteranceIds flushed by a real cancel. The server's abort is checked
   *  between synthesis frames (not instant), so a chunk already in flight when
   *  flush() fires can still arrive after — this fences it out instead of
   *  letting enqueueChunk recreate a fresh entry and drain it onto the reset
   *  play head, which would play the straggler over the user. */
  private readonly deadIds = new Set<string>();

  constructor(opts: PlaybackQueueOptions) {
    this.onUtteranceDone = opts.onUtteranceDone;
    this.createContext =
      opts.createContext ??
      (() => {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        return new Ctor();
      });
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.createContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.ctx.destination);
      this.playHead = this.ctx.currentTime;
    }
    return this.ctx;
  }

  // Returns whether the chunk was accepted. Callers (useVoiceSession's ttsChunk
  // handler) use this to decide whether the agent-speaking indicator should
  // flip on — a fenced/rejected chunk must not be treated as "speaking resumed",
  // or a straggler that lands after flush() leaks its utteranceId back into the
  // caller's speaking-tracking and wedges the indicator on.
  enqueueChunk(chunk: VoiceTtsChunkPayload): boolean {
    if (this.deadIds.has(chunk.utteranceId)) return false;
    let utt = this.utterances.get(chunk.utteranceId);
    if (!utt) {
      utt = {
        id: chunk.utteranceId,
        agentId: chunk.agentId,
        sampleRate:
          chunk.sampleRate && chunk.sampleRate > 0
            ? chunk.sampleRate
            : VOICE_TTS_DEFAULT_SAMPLE_RATE,
        buffered: new Map(),
        nextSeq: 0,
        ended: false,
        sourcesActive: 0,
        startedAt: null,
        totalDurationSec: 0,
        done: false,
      };
      this.utterances.set(chunk.utteranceId, utt);
    }
    if (utt.done) return false;
    if (chunk.sampleRate && chunk.sampleRate > 0) utt.sampleRate = chunk.sampleRate;
    utt.buffered.set(chunk.seq, base64ToInt16(chunk.pcm16));
    this.drain(utt);
    return true;
  }

  private drain(utt: UtteranceState): void {
    // Schedule every contiguous seq that's now available.
    while (utt.buffered.has(utt.nextSeq)) {
      const samples = utt.buffered.get(utt.nextSeq)!;
      utt.buffered.delete(utt.nextSeq);
      utt.nextSeq += 1;
      this.schedule(utt, samples);
    }
  }

  private schedule(utt: UtteranceState, samples: Int16Array): void {
    if (samples.length === 0) return;
    const ctx = this.ensureCtx();
    const buffer = ctx.createBuffer(1, samples.length, utt.sampleRate);
    buffer.getChannelData(0).set(int16ToFloat32(samples));

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (this.gain) src.connect(this.gain);

    const startAt = Math.max(this.playHead, ctx.currentTime);
    if (utt.startedAt === null) utt.startedAt = startAt;
    this.currentUtteranceId = utt.id;

    const durationSec = samples.length / utt.sampleRate;
    utt.totalDurationSec += durationSec;
    utt.sourcesActive += 1;
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      utt.sourcesActive -= 1;
      this.maybeDone(utt);
    };
    src.start(startAt);
    this.playHead = startAt + durationSec;
  }

  markEnd(utteranceId: string): void {
    if (this.deadIds.has(utteranceId)) return; // defense in depth: same fence as enqueueChunk
    const utt = this.utterances.get(utteranceId);
    if (!utt) return;
    utt.ended = true;
    this.drain(utt);
    this.maybeDone(utt);
  }

  private maybeDone(utt: UtteranceState): void {
    // Fire once the stream is closed and every scheduled buffer has ended.
    // Unreachable gaps (a missing seq the server never sent) are tolerated —
    // we don't wedge the floor waiting on audio that will never arrive.
    if (utt.done || !utt.ended || utt.sourcesActive > 0) return;
    utt.done = true;
    this.utterances.delete(utt.id);
    if (this.currentUtteranceId === utt.id) this.currentUtteranceId = null;
    if (this.utterances.size === 0 && this.ctx) this.playHead = this.ctx.currentTime;
    this.onUtteranceDone(utt.id);
  }

  private heardUpToFor(utt: UtteranceState | undefined): HeardUpTo | null {
    if (!utt || !this.ctx) return null;
    const startedAt = utt.startedAt ?? this.ctx.currentTime;
    const played = Math.min(Math.max(0, this.ctx.currentTime - startedAt), utt.totalDurationSec);
    return {
      utteranceId: utt.id,
      charOffset: Math.max(0, Math.round(played * ESTIMATED_CHARS_PER_SECOND)),
      // The server maps playedMs → a precise, word-snapped charOffset.
      playedMs: Math.max(0, Math.round(played * 1000)),
    };
  }

  /** heardUpTo of the utterance currently holding the floor (no side effects). */
  getHeardUpTo(): HeardUpTo | null {
    if (!this.currentUtteranceId) return null;
    return this.heardUpToFor(this.utterances.get(this.currentUtteranceId));
  }

  flush(): HeardUpTo | null {
    const heard = this.getHeardUpTo();
    // Poison every utterance this flush cancels before clearing, so a straggler
    // chunk for one of these ids can't resurrect it (see deadIds above).
    for (const id of this.utterances.keys()) this.deadIds.add(id);
    if (this.currentUtteranceId) this.deadIds.add(this.currentUtteranceId);
    for (const src of this.activeSources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
      src.disconnect();
    }
    this.activeSources.clear();
    this.utterances.clear();
    this.currentUtteranceId = null;
    if (this.ctx) this.playHead = this.ctx.currentTime;
    return heard;
  }

  /**
   * Open-mic barge-in: pause the play head without discarding buffered audio
   * (suspending the context freezes every scheduled source), so a backchannel
   * can resume() where it left off. Returns heardUpTo of the paused utterance.
   */
  pause(): HeardUpTo | null {
    const heard = this.getHeardUpTo();
    if (this.ctx && this.ctx.state === 'running') {
      void this.ctx.suspend().catch((err: unknown) => {
        console.error('PlaybackQueue: failed to suspend AudioContext', err);
      });
    }
    return heard;
  }

  /** Resume after pause() (backchannel over, or a fresh speaker). */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch((err: unknown) => {
        console.error('PlaybackQueue: failed to resume AudioContext', err);
      });
    }
  }

  isSpeaking(): boolean {
    return this.activeSources.size > 0 || this.utterances.size > 0;
  }

  dispose(): void {
    this.flush();
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch((err: unknown) => {
        console.error('PlaybackQueue: failed to close AudioContext', err);
      });
      this.ctx = null;
    }
  }
}
