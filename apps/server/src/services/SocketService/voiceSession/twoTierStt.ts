/**
 * twoTierStt — resolve the DISPATCHED final transcript from the two STT tiers.
 *
 * Tier 1 (streaming zipformer) drives live partials and produces a fast final at
 * end-of-speech. Tier 2 (offline Moonshine) re-decodes the same utterance's full
 * pcm16 into cased + punctuated text. We prefer tier 2, but only if it returns in
 * time: the quality decode is raced against a timeout
 * (`SNAGLET_VOICE_QUALITY_DECODE_TIMEOUT_MS`, default 1200 ms) and, on timeout /
 * failure / empty output, we fall back to the (normalized) streaming final so a
 * slow or missing quality model never blocks or drops an utterance.
 *
 * `normalizeTranscript` is applied to whichever tier wins — the zipformer's
 * ALL-CAPS output gets sentence-cased; Moonshine's already-cased text passes
 * through. Pure + injectable (clock, decoder) so the fallback matrix is unit
 * tested without the real engine.
 */

import { normalizeTranscript } from './transcriptNormalizer';

export interface TwoTierFinal {
  /** The DISPATCHED final text (normalized). */
  readonly text: string;
  /** Which tier produced `text`. */
  readonly tier: 'quality' | 'streaming';
  /** Normalized streaming (zipformer) final — always computed (fallback + logs). */
  readonly streamingText: string;
  /** Raw quality (Moonshine) output before normalization, or null if it didn't run/win. */
  readonly qualityText: string | null;
  /** Wall-clock ms spent awaiting the quality decode (0 when it wasn't attempted). */
  readonly qualityDecodeMs: number;
  /** True when the quality decode exceeded the timeout (fell back to streaming). */
  readonly timedOut: boolean;
}

export interface ResolveTwoTierOptions {
  /** Raw streaming (zipformer) final for the utterance. */
  readonly streamingText: string;
  /** The utterance's full pcm16 for the quality re-decode (null → skip tier 2). */
  readonly pcm: Int16Array | null;
  /** Quality decoder (Moonshine). Absent → dispatch the normalized streaming final. */
  readonly qualityDecode?: (pcm16: Int16Array) => Promise<string>;
  /** Race window for the quality decode. */
  readonly timeoutMs: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

const TIMEOUT = Symbol('quality-decode-timeout');

/**
 * Resolve the final transcript from both tiers. Never throws — a rejected /
 * timed-out / empty quality decode degrades to the normalized streaming final.
 */
export async function resolveTwoTierFinal(opts: ResolveTwoTierOptions): Promise<TwoTierFinal> {
  const now = opts.now ?? Date.now;
  const streamingText = normalizeTranscript(opts.streamingText);
  const base: TwoTierFinal = {
    text: streamingText,
    tier: 'streaming',
    streamingText,
    qualityText: null,
    qualityDecodeMs: 0,
    timedOut: false,
  };
  if (!opts.qualityDecode || !opts.pcm || opts.pcm.length === 0) return base;

  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), opts.timeoutMs);
  });

  try {
    const raced = await Promise.race([opts.qualityDecode(opts.pcm), timeout]);
    const qualityDecodeMs = now() - start;
    if (raced === TIMEOUT) {
      return { ...base, qualityDecodeMs, timedOut: true };
    }
    const raw = (raced ?? '').trim();
    if (raw.length === 0) {
      // Quality returned nothing (silence / no transcript) — keep streaming.
      return { ...base, qualityText: '', qualityDecodeMs };
    }
    return {
      text: normalizeTranscript(raw),
      tier: 'quality',
      streamingText,
      qualityText: raw,
      qualityDecodeMs,
      timedOut: false,
    };
  } catch {
    // Quality decode rejected (model missing / worker error) — streaming stands.
    return { ...base, qualityDecodeMs: now() - start };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
