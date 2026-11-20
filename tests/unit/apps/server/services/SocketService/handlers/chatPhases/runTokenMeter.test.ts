/**
 * runTokenMeter — coalescing, accumulation, and agreement with what is
 * persisted to `runs`.
 *
 * The live counter must move often enough to read as "climbing" without
 * turning a provider's event rate into a socket-frame rate, and must settle on
 * exactly what the run row records. It emits best-effort mid-stream estimates
 * but commits each finished call from the provider's own `result.usage`, so the
 * terminal total is the value `finalReply` hands to `Runs.markCompleted`.
 */

import {
  createRunTokenMeter,
  RUN_USAGE_EMIT_INTERVAL_MS,
  type RunTokenTotals,
} from '@server/services/SocketService/handlers/chatPhases/runTokenMeter';

interface EmittedFrame {
  billedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  providerCalls: number;
  final: boolean;
}

function setup() {
  const frames: EmittedFrame[] = [];
  const meter = createRunTokenMeter({ emit: (payload) => frames.push({ ...payload }) });
  return { meter, frames };
}

/** One provider call as the turn loop drives it: begin → stream → commit. */
function runCall(
  meter: ReturnType<typeof createRunTokenMeter>,
  opts: {
    streamed?: Array<{ inputTokens?: number; outputTokens?: number }>;
    committed?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  }
) {
  meter.beginCall();
  for (const snapshot of opts.streamed ?? []) meter.observe(snapshot);
  meter.commitCall(opts.committed);
}

describe('runTokenMeter — coalescing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('emits at most one frame per interval no matter how fast the provider reports', () => {
    const { meter, frames } = setup();

    meter.beginCall();
    // 50 usage callbacks inside a single interval — a chatty provider, or a
    // future incremental-usage stream. One frame must reach the socket, not 50.
    for (let i = 1; i <= 50; i++) {
      meter.observe({ inputTokens: 10_000, outputTokens: i * 10 });
    }

    expect(frames).toHaveLength(1);
    // Leading edge: the first reading goes out immediately so the counter
    // appears as soon as the run starts, rather than after a delay.
    expect(frames[0]!.billedInputTokens).toBe(10_000);
    expect(frames[0]!.outputTokens).toBe(10);
  });

  it('flushes the latest value on the trailing edge so nothing is silently dropped', () => {
    const { meter, frames } = setup();

    meter.beginCall();
    meter.observe({ inputTokens: 10_000, outputTokens: 10 });
    meter.observe({ inputTokens: 10_000, outputTokens: 500 });
    expect(frames).toHaveLength(1);

    jest.advanceTimersByTime(RUN_USAGE_EMIT_INTERVAL_MS);

    expect(frames).toHaveLength(2);
    expect(frames[1]!.outputTokens).toBe(500);
  });

  it('paces a long stream to the configured rate rather than the event rate', () => {
    const { meter, frames } = setup();

    meter.beginCall();
    // One second of reporting, ten events per interval.
    for (let tick = 0; tick < 40; tick++) {
      meter.observe({ inputTokens: 10_000, outputTokens: tick * 25 });
      jest.advanceTimersByTime(RUN_USAGE_EMIT_INTERVAL_MS / 10);
    }

    const oneSecondOfFrames = Math.ceil(1000 / RUN_USAGE_EMIT_INTERVAL_MS);
    expect(frames.length).toBeLessThanOrEqual(oneSecondOfFrames + 1);
    expect(frames.length).toBeGreaterThan(1);
  });

  it('does not repeat a frame when the totals have not moved', () => {
    const { meter, frames } = setup();

    meter.beginCall();
    meter.observe({ inputTokens: 10_000, outputTokens: 0 });
    expect(frames).toHaveLength(1);

    jest.advanceTimersByTime(RUN_USAGE_EMIT_INTERVAL_MS * 4);
    meter.observe({ inputTokens: 10_000, outputTokens: 0 });

    expect(frames).toHaveLength(1);
  });

  it('stops emitting after finalize and leaves no pending timer behind', () => {
    const { meter, frames } = setup();

    meter.beginCall();
    meter.observe({ inputTokens: 10_000, outputTokens: 100 });
    meter.observe({ inputTokens: 10_000, outputTokens: 400 });
    meter.finalize();

    const afterFinalize = frames.length;
    expect(frames[afterFinalize - 1]!.final).toBe(true);

    jest.advanceTimersByTime(RUN_USAGE_EMIT_INTERVAL_MS * 10);
    expect(frames).toHaveLength(afterFinalize);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('runTokenMeter — accumulation across provider calls', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sums input across tool cycles instead of keeping only the last call', () => {
    const { meter } = setup();

    // Three tool cycles. Each re-sends the whole prompt, so each is charged for
    // it again — the run's billed input is the sum, not the 14k of the last.
    runCall(meter, { committed: { inputTokens: 10_000, outputTokens: 300 } });
    runCall(meter, { committed: { inputTokens: 12_000, outputTokens: 180 } });
    runCall(meter, { committed: { inputTokens: 14_000, outputTokens: 420 } });

    const totals = meter.totals();
    expect(totals.billedInputTokens).toBe(36_000);
    expect(totals.outputTokens).toBe(900);
    expect(totals.providerCalls).toBe(3);
    // The last call's prompt size is tracked separately — it is the
    // context-window gauge the per-message badge uses, not a cost figure.
    expect(totals.promptTokens).toBe(14_000);
  });

  it('sums cache reads separately so the cached/fresh split survives', () => {
    const { meter } = setup();

    runCall(meter, { committed: { inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 0 } });
    runCall(meter, {
      committed: { inputTokens: 12_000, outputTokens: 100, cacheReadTokens: 9_800 },
    });

    expect(meter.totals().billedInputTokens).toBe(22_000);
    expect(meter.totals().cacheReadTokens).toBe(9_800);
  });

  it('replaces the in-flight estimate rather than adding to it', () => {
    const { meter } = setup();

    meter.beginCall();
    // Anthropic reports input at message_start and restates usage at
    // message_delta. Adding those would double-count the same prompt.
    meter.observe({ inputTokens: 10_000, outputTokens: 0 });
    meter.observe({ inputTokens: 10_000, outputTokens: 250 });

    expect(meter.totals().billedInputTokens).toBe(10_000);
    expect(meter.totals().outputTokens).toBe(250);
  });

  it('discards a failed attempt’s partial reading when the call is retried', () => {
    const { meter } = setup();

    meter.beginCall();
    meter.observe({ inputTokens: 10_000, outputTokens: 120 }); // attempt dies here
    meter.beginCall(); // transient retry re-sends the same prompt
    meter.observe({ inputTokens: 10_000, outputTokens: 60 });
    meter.commitCall({ inputTokens: 10_000, outputTokens: 300 });

    // Only the attempt that actually produced a result is counted.
    expect(meter.totals().billedInputTokens).toBe(10_000);
    expect(meter.totals().outputTokens).toBe(300);
    expect(meter.totals().providerCalls).toBe(1);
  });
});

describe('runTokenMeter — agreement with the persisted run row', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('lands on Σ result.usage even when the streamed estimates were wrong', () => {
    const { meter, frames } = setup();

    // The streamed numbers deliberately disagree with the authoritative ones —
    // a truncated stream, a provider that under-reports mid-flight. The commit
    // must win, or the counter and `runs` would tell different stories.
    runCall(meter, {
      streamed: [{ inputTokens: 9_000, outputTokens: 50 }],
      committed: { inputTokens: 10_000, outputTokens: 300 },
    });
    runCall(meter, {
      streamed: [{ inputTokens: 11_000, outputTokens: 20 }],
      committed: { inputTokens: 12_000, outputTokens: 180 },
    });
    meter.finalize();

    const totals: RunTokenTotals = meter.totals();
    // What finalReply hands to Runs.markCompleted:
    const persisted = {
      inputTokens: totals.billedInputTokens,
      outputTokens: totals.outputTokens,
    };
    expect(persisted).toEqual({ inputTokens: 22_000, outputTokens: 480 });

    // …and what the last frame told the UI is the same thing.
    const last = frames[frames.length - 1]!;
    expect(last.final).toBe(true);
    expect(last.billedInputTokens).toBe(persisted.inputTokens);
    expect(last.outputTokens).toBe(persisted.outputTokens);
  });

  it('reports a partial total when a run is aborted mid-cycle', () => {
    const { meter } = setup();

    runCall(meter, { committed: { inputTokens: 10_000, outputTokens: 300 } });
    meter.beginCall();
    meter.observe({ inputTokens: 12_000, outputTokens: 40 });
    // Abort: the in-flight call never commits, so only completed calls are
    // persisted — markFailed writes the same numbers markCompleted would have.
    meter.finalize();

    expect(meter.totals().billedInputTokens).toBe(22_000);
    expect(meter.totals().providerCalls).toBe(1);
  });
});

describe('runTokenMeter — providers that report nothing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('emits no frame at all rather than a zero the UI would render', () => {
    const { meter, frames } = setup();

    // apple-on-device returns `usage: undefined`; nothing is known, ever.
    runCall(meter, { committed: undefined });
    runCall(meter, { committed: undefined });
    meter.finalize();

    expect(frames).toHaveLength(0);
    expect(meter.totals().reported).toBe(false);
    expect(meter.totals().billedInputTokens).toBe(0);
  });

  it('emits once at the end for a provider that only reports on completion', () => {
    const { meter, frames } = setup();

    // Chat Completions puts usage in a single terminal chunk, so `observe`
    // never fires — the counter must arrive late, not never.
    meter.beginCall();
    expect(frames).toHaveLength(0);
    meter.commitCall({ inputTokens: 9_000, outputTokens: 512 });
    meter.finalize();

    expect(frames.length).toBeGreaterThanOrEqual(1);
    const last = frames[frames.length - 1]!;
    expect(last.billedInputTokens).toBe(9_000);
    expect(last.outputTokens).toBe(512);
    expect(last.final).toBe(true);
  });

  it('ignores negative or non-finite readings instead of propagating NaN', () => {
    const { meter } = setup();

    runCall(meter, { committed: { inputTokens: Number.NaN, outputTokens: -5 } });
    runCall(meter, { committed: { inputTokens: 1_000, outputTokens: 10 } });

    expect(Number.isFinite(meter.totals().billedInputTokens)).toBe(true);
    expect(meter.totals().billedInputTokens).toBe(1_000);
    expect(meter.totals().outputTokens).toBe(10);
  });
});
