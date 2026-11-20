/**
 * speakability — the `Segmenter` seam the TTS pipeline consumes.
 *
 * Composes the voice engine's real segmenter +
 * speakability filter (@server/services/voice): `segmentText` groups a raw
 * assistant utterance into sentence/code/table/list segments, and
 * `filterSegments` turns each into a spoken string (structured blocks → a short
 * placeholder, markdown stripped, `@Name` → "Name"). Those modules are pure
 * string logic (no native addons), so this composition loads fine in jest.
 *
 * ttsPipeline consumes only the `Segmenter` interface (and its __setSegmenter
 * seam for tests); the default implementation lives in the voice engine's
 * utils.
 */

import { createSentenceSegmenter, segmentText } from '@server/services/voice/sentenceSegmenter';
import { filterSegments } from '@server/services/voice/speakabilityFilter';

interface SpeakableSentence {
  /** Text to synthesize (already stripped/placeholdered for speech). */
  readonly text: string;
}

export interface Segmenter {
  /** Turn a raw assistant utterance into an ordered list of speakable sentences. */
  segment(raw: string): SpeakableSentence[];
}

class EngineSegmenter implements Segmenter {
  segment(raw: string): SpeakableSentence[] {
    if (!raw || raw.trim().length === 0) return [];
    // segmentText → structural segments; filterSegments → spoken strings
    // (drops empties, collapses repeated block placeholders).
    return filterSegments(segmentText(raw)).map((r) => ({ text: r.speak }));
  }
}

/** The default segmenter — the voice engine's sentence segmenter + speakability filter. */
export const engineSegmenter: Segmenter = new EngineSegmenter();

/**
 * Streaming variant: feed visible-text deltas as they
 * arrive and get back each completed speakable sentence the moment it is
 * unambiguously done — the pipeline synthesizes it immediately instead of waiting
 * for the whole utterance. Wraps the stateful `createSentenceSegmenter` (which
 * already buffers fenced code / tables / lists across deltas) + the speakability
 * filter (structured blocks → placeholder, markdown stripped, `@Name` → "Name").
 */
export interface StreamSegmenter {
  /** Feed a delta; returns speakable strings for any sentences that completed. */
  push(delta: string): string[];
  /** End of utterance: drain the buffered tail as speakable strings. */
  flush(): string[];
  /** Discard buffered state (barge-in / abort). */
  reset(): void;
}

/** Factory for a streaming segmenter over the voice engine's segmenter + filter. */
export function createEngineStreamSegmenter(): StreamSegmenter {
  const seg = createSentenceSegmenter();
  const speakable = (segments: ReturnType<typeof seg.push>): string[] =>
    filterSegments(segments)
      .map((r) => r.speak)
      .filter((s) => s.length > 0);
  return {
    push: (delta) => speakable(seg.push(delta)),
    flush: () => speakable(seg.flush()),
    reset: () => seg.reset(),
  };
}
