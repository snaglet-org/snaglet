/**
 * runTokenMeter — the running token total for ONE run.
 *
 * A run is not one provider call. The turn loop calls the provider once per
 * tool cycle and re-sends the whole prompt every time, so the prompt is billed
 * again on each cycle. The meter therefore keeps two different quantities and
 * never conflates them:
 *
 *   billedInputTokens — Σ over calls of that call's input. The honest cost
 *                       figure, and what the live bubble counter shows.
 *   promptTokens      — the LAST call's input. A context-window proxy; it is
 *                       what `messages.usage.inputTokens` carries, because the
 *                       compaction detector in MessageList watches it shrink.
 *
 * Two-phase accounting keeps the live number honest without letting it drift
 * from the authoritative one:
 *
 *   observe(snapshot)   — the in-flight call's usage as the provider reports
 *                         it mid-stream. Best-effort; feeds the live frames.
 *   commitCall(usage)   — the call finished. The in-flight estimate is thrown
 *                         away and the provider's own `ProviderChatResult.usage`
 *                         is folded into the committed totals instead.
 *
 * Because every completed call is committed from `result.usage`, the final
 * totals are exactly Σ `result.usage` across the run — the same values written
 * to `runs` and sent on `socket:done`. A mid-run frame can lag, but the end
 * state cannot diverge.
 */

import type { RunTokenUsagePayload } from '@snaglet/shared/types';
import type { ProviderUsageSnapshot } from '@server/services/ProviderChatService/types';

/**
 * Minimum gap between emitted frames, per run.
 *
 * Anthropic reports usage about twice per provider call (`message_start` gives
 * the whole input, `message_delta` gives output at the end) and Gemini restates
 * cumulative usage on several chunks, so the raw callback rate is low — but it
 * is a provider-controlled rate, and a chattier provider (or a future
 * incremental-usage beta) must not translate into a socket frame per event.
 * 250ms caps a run at 4 frames/second, which is far below the `socket:delta`
 * rate already flowing on the same channel and still reads as continuous
 * movement to the eye.
 */
export const RUN_USAGE_EMIT_INTERVAL_MS = 250;

export interface RunTokenTotals extends RunTokenUsagePayload {
  /** The LAST completed call's input — the context-window proxy, not a total. */
  promptTokens: number;
  /** False until some provider call has reported a non-zero figure. */
  reported: boolean;
  // `cacheCreationTokens` rides `RunTokenUsagePayload` itself so the UI can
  // show the cache read/write split next to the run counter. It remains a
  // BREAKDOWN of `billedInputTokens`, never an addend — display code must
  // not sum it on top.
}

export interface RunTokenMeter {
  /**
   * A provider call is starting. Discards any in-flight estimate, so a
   * transient failure's partial reading can't survive into the retry.
   * Does not count the call — `providerCalls` counts completed calls, which is
   * what makes the number mean "calls whose usage is in this total".
   */
  beginCall(): void;
  /** Mid-stream usage for the in-flight call. Best-effort. */
  observe(usage: ProviderUsageSnapshot | undefined): void;
  /** The in-flight call finished; fold its authoritative usage in. */
  commitCall(usage: ProviderUsageSnapshot | undefined): void;
  /** Committed totals plus whatever the in-flight call has reported. */
  totals(): RunTokenTotals;
  /** Emit the terminal frame (if anything was ever reported) and stop timers. */
  finalize(): void;
}

export interface CreateRunTokenMeterInput {
  /** Sends one coalesced frame. Never called with an all-zero, never-reported run. */
  emit: (payload: RunTokenUsagePayload & { final: boolean }) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  intervalMs?: number;
}

const EMPTY_CALL: Required<ProviderUsageSnapshot> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function normalize(usage: ProviderUsageSnapshot | undefined): Required<ProviderUsageSnapshot> {
  if (!usage) return { ...EMPTY_CALL };
  return {
    inputTokens: Math.max(0, Math.trunc(usage.inputTokens ?? 0)) || 0,
    outputTokens: Math.max(0, Math.trunc(usage.outputTokens ?? 0)) || 0,
    cacheReadTokens: Math.max(0, Math.trunc(usage.cacheReadTokens ?? 0)) || 0,
    cacheCreationTokens: Math.max(0, Math.trunc(usage.cacheCreationTokens ?? 0)) || 0,
  };
}

export function createRunTokenMeter(input: CreateRunTokenMeterInput): RunTokenMeter {
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? RUN_USAGE_EMIT_INTERVAL_MS;

  let committedInput = 0;
  let committedOutput = 0;
  let committedCacheRead = 0;
  let committedCacheCreation = 0;
  let promptTokens = 0;
  let providerCalls = 0;
  let reported = false;
  let inFlight: Required<ProviderUsageSnapshot> = { ...EMPTY_CALL };

  let lastEmitAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmittedKey = '';
  let done = false;

  const snapshot = (): RunTokenTotals => ({
    billedInputTokens: committedInput + inFlight.inputTokens,
    outputTokens: committedOutput + inFlight.outputTokens,
    cacheReadTokens: committedCacheRead + inFlight.cacheReadTokens,
    cacheCreationTokens: committedCacheCreation + inFlight.cacheCreationTokens,
    providerCalls,
    promptTokens,
    reported,
  });

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const emitNow = (final: boolean) => {
    const totals = snapshot();
    // Never paint a zero. A provider that reports nothing (apple-on-device) or
    // reports only at completion must produce no counter at all rather than a
    // "0 / 0" that looks like a real measurement.
    if (!totals.reported) return;
    const key = `${totals.billedInputTokens}:${totals.outputTokens}:${totals.cacheReadTokens}:${totals.cacheCreationTokens}:${totals.providerCalls}`;
    if (!final && key === lastEmittedKey) return;
    lastEmittedKey = key;
    lastEmitAt = now();
    input.emit({
      billedInputTokens: totals.billedInputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      providerCalls: totals.providerCalls,
      final,
    });
  };

  /** Leading-edge emit, trailing flush — at most one frame per `intervalMs`. */
  const schedule = () => {
    if (done) return;
    const elapsed = now() - lastEmitAt;
    if (elapsed >= intervalMs) {
      clearTimer();
      emitNow(false);
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      emitNow(false);
    }, intervalMs - elapsed);
    // Never keep the process (or a test runner) alive for a usage frame.
    timer.unref?.();
  };

  return {
    beginCall() {
      inFlight = { ...EMPTY_CALL };
    },

    observe(usage) {
      const next = normalize(usage);
      // Providers restate this call's usage cumulatively, so replace rather
      // than add — adding would double-count `message_start`'s input against
      // the same call's `message_delta`.
      inFlight = next;
      if (next.inputTokens > 0 || next.outputTokens > 0) reported = true;
      schedule();
    },

    commitCall(usage) {
      const finalForCall = normalize(usage);
      inFlight = { ...EMPTY_CALL };
      providerCalls += 1;
      committedInput += finalForCall.inputTokens;
      committedOutput += finalForCall.outputTokens;
      committedCacheRead += finalForCall.cacheReadTokens;
      committedCacheCreation += finalForCall.cacheCreationTokens;
      if (finalForCall.inputTokens > 0) promptTokens = finalForCall.inputTokens;
      if (finalForCall.inputTokens > 0 || finalForCall.outputTokens > 0) reported = true;
      schedule();
    },

    totals: snapshot,

    finalize() {
      if (done) return;
      done = true;
      clearTimer();
      emitNow(true);
    },
  };
}
