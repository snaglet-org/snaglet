/**
 * ttsPipeline: turns an agent's spoken text into streamed audio, speaking on the
 * first completed sentence instead of waiting for the utterance to persist.
 *  1. Delta tap (voiceStreamEvents): each completed sentence synthesizes at once
 *     under a synthetic utterance id (`${runId}:${iteration}`), in order.
 *  2. Persist tap (utteranceEvents): closes the streaming job, flushes the last
 *     partial sentence, and maps the synthetic id to the real messageId. A run
 *     that never streamed is synthesized whole here. Cut-off (abort-partial)
 *     utterances are not spoken further.
 */

import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { VoiceTtsChunkPayload, VoiceTtsEndPayload } from './types';
import { onUtterancePersisted, type UtterancePersistedEvent } from './utteranceEvents';
import { onVoiceDelta, type VoiceDeltaEvent } from './voiceStreamEvents';
import { enqueueUtterance } from './floorArbiter';
import { getVoiceEngine } from './engineAdapter';
import { resolveAgentVoiceId } from './resolveAgentVoice';
import {
  engineSegmenter,
  createEngineStreamSegmenter,
  type Segmenter,
  type StreamSegmenter,
} from './speakability';
import { pcm16ToBase64 } from './audioCodec';
import { addSynthesizedMs, addSpokenText, reconcileUtteranceId } from './ttsDurationTracker';

/** Where synthesized audio for a thread goes (the owning voice client). */
export interface TtsSink {
  emitChunk(payload: VoiceTtsChunkPayload): void;
  emitEnd(payload: VoiceTtsEndPayload): void;
}

const sinksByThread = new Map<string, TtsSink>();

// One-shot segmenter for the catch-up (whole-utterance) path; swappable so tests
// can inject a deterministic one via this seam.
let segmenter: Segmenter = engineSegmenter;
export function __setSegmenter(next: Segmenter): void {
  segmenter = next;
}

// Streaming-segmenter factory for the delta path; swappable for tests.
let streamSegmenterFactory: () => StreamSegmenter = createEngineStreamSegmenter;
export function __setStreamSegmenterFactory(next: () => StreamSegmenter): void {
  streamSegmenterFactory = next;
}

/** Register the audio sink for a thread (voice session start). */
export function registerTtsSink(threadId: string, sink: TtsSink): void {
  sinksByThread.set(threadId, sink);
}
export function unregisterTtsSink(threadId: string): void {
  sinksByThread.delete(threadId);
}

// Streaming jobs, one open per run at a time

interface StreamingJob {
  readonly threadId: string;
  readonly agentId: string;
  readonly runId: string;
  /** Stable synthetic utterance id for the whole utterance. */
  readonly syntheticId: string;
  readonly sink: TtsSink;
  readonly stream: StreamSegmenter;
  /** Completed speakable sentences awaiting synthesis (FIFO). */
  readonly pending: string[];
  /** True once the floor job is enqueued (first sentence became ready). */
  enqueued: boolean;
  /** True once the persist/abort boundary closed the utterance. */
  closed: boolean;
  /** Wakes the play() consumer when a sentence is pushed or the job closes. */
  notify: (() => void) | null;
}

/** At most one open streaming utterance per run (model calls are sequential). */
const openByRun = new Map<string, StreamingJob>();

let wired = false;

/** Subscribe to the delta + utterance streams once. Idempotent. */
export function initTtsPipeline(): void {
  if (wired) return;
  wired = true;
  onVoiceDelta(handleDelta);
  onUtterancePersisted(handleUtterance);
}

/** Wake a job's play() consumer (or no-op if it isn't parked on notify). */
function wake(job: StreamingJob): void {
  const n = job.notify;
  job.notify = null;
  n?.();
}

/** Enqueue the floor job once the first speakable sentence exists. */
function enqueueIfReady(job: StreamingJob): void {
  if (job.enqueued || job.pending.length === 0) return;
  job.enqueued = true;
  enqueueUtterance(job.threadId, {
    utteranceId: job.syntheticId,
    agentId: job.agentId,
    runId: job.runId,
    play: (signal) => playStreaming(job, signal),
  });
}

/** Delta tap: feed the per-run streaming segmenter and speak completed sentences. */
function handleDelta(evt: VoiceDeltaEvent): void {
  const sink = sinksByThread.get(evt.threadId);
  if (!sink) return; // no voice session on this thread — nothing to speak

  let job = openByRun.get(evt.runId);
  const syntheticId = `${evt.runId}:${evt.iteration}`;
  // A new iteration (fresh synthetic id) starts a fresh job even if the previous
  // one for this run is still in the map (it was closed at persist).
  if (job && job.syntheticId !== syntheticId) {
    job = undefined;
  }
  if (!job) {
    job = {
      threadId: evt.threadId,
      agentId: evt.agentId,
      runId: evt.runId,
      syntheticId,
      sink,
      stream: streamSegmenterFactory(),
      pending: [],
      enqueued: false,
      closed: false,
      notify: null,
    };
    openByRun.set(evt.runId, job);
  }

  let produced = false;
  try {
    for (const sentence of job.stream.push(evt.text)) {
      job.pending.push(sentence);
      produced = true;
    }
  } catch (err) {
    logger.warn(`[voice] stream segment failed [thread=${evt.threadId}]: ${getErrorMessage(err)}`);
  }
  if (produced) {
    enqueueIfReady(job);
    wake(job);
  }
}

/**
 * Close a run's streaming job at its utterance boundary. Flushes the segmenter
 * remainder (unless the utterance was cut off), reconciles the synthetic id to
 * the real messageId, and lets the job drain + emit tts:end. Returns true if a
 * streaming job existed (→ caller must not re-synthesize).
 */
function closeStreamingJob(
  runId: string,
  messageId: string,
  opts: { discardRemainder: boolean }
): boolean {
  const job = openByRun.get(runId);
  if (!job) return false;
  openByRun.delete(runId);

  if (opts.discardRemainder) {
    job.stream.reset();
  } else {
    try {
      for (const sentence of job.stream.flush()) job.pending.push(sentence);
    } catch (err) {
      logger.warn(`[voice] stream flush failed [thread=${job.threadId}]: ${getErrorMessage(err)}`);
    }
    // A short utterance with no sentence terminator only becomes speakable now.
    enqueueIfReady(job);
  }

  // Reconcile so heard-up-to (and the DB-row fallback) resolve by either id even
  // when a barge-in only ever saw the synthetic id.
  reconcileUtteranceId(job.syntheticId, messageId);
  job.closed = true;
  wake(job);
  return true;
}

/** Persist tap: close/reconcile the streaming job, or catch-up synthesize. */
function handleUtterance(evt: UtterancePersistedEvent): void {
  const sink = sinksByThread.get(evt.threadId);
  if (!sink) return; // no active voice session on this thread

  // Dedup: if this run streamed, the persist event is bookkeeping only — close +
  // reconcile the streaming job and do not synthesize again. An abort-partial
  // discards its remainder (the user interrupted mid-sentence).
  const streamed = closeStreamingJob(evt.runId, evt.messageId, {
    discardRemainder: evt.kind === 'partial-abort',
  });
  if (streamed) return;

  // Catch-up: nothing streamed for this run (voice toggled on mid-run, or a
  // path that produced no deltas) → synthesize the whole utterance at once.
  // A cut-off partial is never spoken.
  if (evt.kind === 'partial-abort') return;

  const sentences = segmenter.segment(evt.content);
  if (sentences.length === 0) return;

  enqueueUtterance(evt.threadId, {
    utteranceId: evt.messageId,
    agentId: evt.agentId,
    runId: evt.runId,
    play: (signal) =>
      speakWhole(
        evt,
        sentences.map((s) => s.text),
        sink,
        signal
      ),
  });
}

/**
 * Streaming synthesis: consume the job's completed sentences in order, streaming
 * each sentence's PCM frames as voice:tts:chunk, until the utterance closes and
 * the queue drains. Serialized per job (one synthesize at a time) so sentences
 * stream strictly in order. Emits voice:tts:end once, in `finally`.
 */
async function playStreaming(job: StreamingJob, signal: AbortSignal): Promise<void> {
  const engine = await getVoiceEngine();
  try {
    if (!engine) return; // session start already guards; belt-and-suspenders
    const voiceId = await resolveAgentVoiceId(job.agentId);
    let seq = 0;
    for (;;) {
      if (signal.aborted) break;
      const text = job.pending.shift();
      if (text === undefined) {
        if (job.closed) break; // drained + closed → done
        await new Promise<void>((resolve) => {
          job.notify = resolve;
        });
        job.notify = null;
        continue;
      }
      try {
        for await (const frame of engine.synthesize(text, voiceId)) {
          if (signal.aborted) break;
          if (frame.sampleRate > 0) {
            addSynthesizedMs(job.syntheticId, (frame.pcm16.length / frame.sampleRate) * 1000);
          }
          job.sink.emitChunk({
            utteranceId: job.syntheticId,
            agentId: job.agentId,
            seq: seq++,
            pcm16: pcm16ToBase64(frame.pcm16),
            sampleRate: frame.sampleRate,
          });
        }
      } catch (err) {
        logger.warn(
          `[voice] synthesis failed [thread=${job.threadId}] [utterance=${job.syntheticId}]: ${getErrorMessage(
            err
          )}`
        );
      }
      // Record what was spoken (in synth order) so a mid-stream barge-in can quote
      // exactly what the user heard from the tracker, before any row exists.
      addSpokenText(job.syntheticId, text);
    }
  } finally {
    // Always signal end so the client's playback queue can finalize + report
    // playback:done (even on abort — the client flushes its buffer).
    job.sink.emitEnd({ utteranceId: job.syntheticId });
  }
}

/** Catch-up synthesis: whole utterance at once, keyed by the real messageId. */
async function speakWhole(
  evt: UtterancePersistedEvent,
  sentences: string[],
  sink: TtsSink,
  signal: AbortSignal
): Promise<void> {
  const engine = await getVoiceEngine();
  if (!engine) return;
  if (signal.aborted) return;

  const voiceId = await resolveAgentVoiceId(evt.agentId);
  let seq = 0;
  try {
    for (const text of sentences) {
      if (signal.aborted) break;
      for await (const frame of engine.synthesize(text, voiceId)) {
        if (signal.aborted) break;
        if (frame.sampleRate > 0) {
          addSynthesizedMs(evt.messageId, (frame.pcm16.length / frame.sampleRate) * 1000);
        }
        sink.emitChunk({
          utteranceId: evt.messageId,
          agentId: evt.agentId,
          seq: seq++,
          pcm16: pcm16ToBase64(frame.pcm16),
          sampleRate: frame.sampleRate,
        });
      }
      addSpokenText(evt.messageId, text);
    }
  } catch (err) {
    logger.warn(
      `[voice] synthesis failed [thread=${evt.threadId}] [utterance=${evt.messageId}]: ${getErrorMessage(
        err
      )}`
    );
  } finally {
    sink.emitEnd({ utteranceId: evt.messageId });
  }
}

/** Test-only reset. */
export function __resetTtsPipeline(): void {
  sinksByThread.clear();
  openByRun.clear();
  segmenter = engineSegmenter;
  streamSegmenterFactory = createEngineStreamSegmenter;
  wired = false;
}
