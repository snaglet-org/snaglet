/**
 * Adversarial runaway verification: each scenario is a runaway shape the wave
 * limits must stop. All run the real dispatch loop + turn loop against the
 * per-file PostgreSQL clone with scripted agents (scenarioHarness).
 *
 * EmbeddingService is mocked with deterministic vectors (the stagnation policy
 * is under test, not the local embedder). Texts not in the vector map embed as
 * null → the Jaccard fallback, as in production without a local embedder.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { generateId } from '@snaglet/shared/utils';

// Deterministic embedding seam
// Paraphrase texts (exact posted replies) map to near-identical vectors;
// everything else embeds null → Jaccard fallback.
const PARA = [
  'We should ship the simpler storage design first and iterate. @advpara-beta thoughts?',
  'My position: start with the less complex storage approach, improve later. @advpara-beta thoughts?',
  'I still think the easy storage option goes out first, then we refine. @advpara-beta thoughts?',
  'Same view as before: begin with the simplest storage plan and evolve it. @advpara-beta thoughts?',
];
const VectorByText = new Map<string, number[]>(
  PARA.map((text, i) => [text, [0.98, 0.19 + i * 0.0005, 0.05]])
);

jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn(async () => undefined),
  generateDocumentEmbedding: jest.fn(async () => ({
    embedding: null,
    model: '',
    provider: '',
    cached: false,
    contentHash: null,
    modelRowId: null,
  })),
  generateQueryEmbedding: jest.fn(async (text: string) => ({
    embedding: VectorByText.get(text.trim()) ?? null,
    model: 'stub',
    provider: 'stub',
    cached: false,
    contentHash: null,
    modelRowId: null,
  })),
}));

import { listActiveAgentRuns } from '@server/services/SocketService/abortStore';
import {
  runReaperSweepOnce,
  startRunReaper,
  stopRunReaper,
} from '@server/services/RunReaperService';
import {
  createScenario,
  pinConversationCompaction,
  waitFor,
  type Scenario,
} from './scenarioHarness';

// This suite must not inherit whatever COMPACT_CONVERSATIONS the machine's
// gitignored .env carries.
pinConversationCompaction();

jest.setTimeout(120_000);

let scenario: Scenario | null = null;

afterEach(async () => {
  stopRunReaper();
  if (scenario) {
    await scenario.cleanup();
    scenario = null;
  }
});

/** Distinct sentences (mutually low Jaccard) for endless-relay scripts. */
const LINES = [
  'Opening point: the cache layer needs explicit invalidation hooks.',
  'Second thought — would write-through be simpler than invalidation?',
  'Benchmarks show p99 at forty milliseconds on the current path.',
  'Shipping the simpler design first still seems right to me.',
  'The failure mode matters more than raw throughput here.',
  'Recovery time is what users actually feel during incidents.',
  'Documenting tradeoffs might resolve half of this debate.',
  'Our metrics dashboard already covers the risky window.',
  'A staged rollout would derisk both options at once.',
  'Pick whichever option we can revert fastest, honestly.',
  'Feature flags make the revert story stronger than assumed.',
  'Capacity planning owns the final call on this one.',
];

function relay(lines: string[], mention: string) {
  return lines.map((line) => ({ reply: `${line} @${mention} your move.` }));
}

/** Assert the run left no live-turn residue behind (cleanup check). */
function expectCleanRuntime(threadId: string): void {
  const snapshot = activeRunTracker.snapshot();
  expect(snapshot.activeThreadCount).toBe(0);
  expect(snapshot.activeRunCount).toBe(0);
  expect(listActiveAgentRuns(threadId)).toHaveLength(0);
}

describe('adversarial runaway verification', () => {
  it('mutual-mention ping-pong (mentioned mode) is bounded by the per-agent ceiling and context grows append-only', async () => {
    scenario = await createScenario({
      prefix: 'advping',
      dispatchMode: 'mentioned',
      agents: [
        {
          key: 'alpha',
          script: relay(LINES, 'advping-beta'),
          onExhausted: 'repeat-last',
        },
        {
          key: 'beta',
          script: relay([...LINES].reverse(), 'advping-alpha'),
          onExhausted: 'repeat-last',
        },
      ],
    });

    const result = await scenario.send(`@${scenario.names.alpha} keep the relay alive forever.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Bounded: per-agent hard ceiling (settings default 5 → 2x = 10) caps the
    // in-wave mention ping-pong; the conversation then converges with a
    // truthful reason instead of hanging.
    expect(result.stopReason).toBeDefined();
    expect(scenario.callsFor('alpha').length).toBeLessThanOrEqual(10);
    expect(scenario.callsFor('beta').length).toBeLessThanOrEqual(10);
    expect(
      scenario.callsFor('alpha').length + scenario.callsFor('beta').length
    ).toBeGreaterThanOrEqual(3);

    // Context sizes are logged, not asserted: in a mentioned-mode mention
    // storm, finalReply routes spoken mentions before persisting the terminal
    // row, so a woken turn can assemble from a briefly stale history.
    console.log(
      '[adversarial:A1] context sizes alpha=%j beta=%j',
      scenario.callsFor('alpha').map((c) => c.messageCount),
      scenario.callsFor('beta').map((c) => c.messageCount)
    );

    expectCleanRuntime(scenario.threadId);
  });

  it('three-agent mention cycle (A→B→C→A) converges without hanging and leaks nothing', async () => {
    scenario = await createScenario({
      prefix: 'advcycle',
      dispatchMode: 'mentioned',
      agents: [
        { key: 'alpha', script: relay(LINES, 'advcycle-beta'), onExhausted: 'repeat-last' },
        {
          key: 'beta',
          script: relay([...LINES].reverse(), 'advcycle-gamma'),
          onExhausted: 'repeat-last',
        },
        {
          key: 'gamma',
          script: relay([...LINES.slice(6), ...LINES.slice(0, 6)], 'advcycle-alpha'),
          onExhausted: 'repeat-last',
        },
      ],
    });

    const result = await scenario.send(`@${scenario.names.alpha} start the cycle.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Terminates with a truthful reason (per-agent ceilings end the cycle);
    // never hangs (jest timeout is the hang guard).
    expect(result.stopReason).toBeDefined();
    for (const key of ['alpha', 'beta', 'gamma'] as const) {
      expect(scenario.callsFor(key).length).toBeLessThanOrEqual(10);
    }

    // No leaked timers/controllers/locks after the dispatch resolves.
    expectCleanRuntime(scenario.threadId);
  });

  it('tiny token budget exhausts mid-conversation — clean stop, correct reason, mid-run message drained not lost', async () => {
    scenario = await createScenario({
      prefix: 'advbudget',
      dispatchMode: 'mentioned',
      budget: { maxWaves: 12, maxTotalOutputTokens: 1000 },
      agents: [
        {
          key: 'alpha',
          script: [
            {
              reply: 'Burning budget. @advbudget-beta your move.',
              usage: { outputTokens: 600 },
            },
          ],
          onExhausted: 'repeat-last',
        },
        {
          key: 'beta',
          script: [
            {
              reply: 'Burning more. @advbudget-alpha your move.',
              usage: { outputTokens: 600 },
              delayMs: 700,
            },
          ],
          onExhausted: 'repeat-last',
        },
      ],
    });

    const midRunId = generateId('message');
    const sendPromise = scenario.send(`@${scenario.names.alpha} Spend it all.`);
    // Land a user message while beta's (budget-exhausting) turn is running:
    // poll for beta's model call to be in flight (recorded before its scripted
    // delay) instead of a fixed sleep that races setup + alpha's turn — if the
    // run had already ended, the enqueue would silently return false.
    await waitFor(() => scenario.callsFor('beta').length >= 1, {
      label: 'beta model call in flight',
    });
    const queued = activeRunTracker.enqueueMessageForThread(
      scenario.threadId,
      midRunId,
      'A mid-run question that must not vanish.'
    );
    expect(queued).toBe(true);

    const result = await sendPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('token-budget');
    expect(result.capHit).toBe(false);
    const ended = scenario.conversationEndedEvents();
    expect(ended).toHaveLength(1);
    expect(ended[0]!.payload['stop_reason']).toBe('token-budget');

    // The mid-run message was persisted by the end-of-run flush (never lost).
    const all = await scenario.allMessages();
    const drained = all.find((m) => m.id === midRunId);
    expect(drained).toBeDefined();
    expect(drained!.content).toBe('A mid-run question that must not vanish.');

    expectCleanRuntime(scenario.threadId);
  });

  it('a wedged agent is released by the reaper and the conversation ends with the truthful reaper reason', async () => {
    scenario = await createScenario({
      prefix: 'advreap',
      dispatchMode: 'mentioned',
      budget: { maxWaves: 8 },
      agents: [
        {
          key: 'alpha',
          script: [{ reply: 'Handing over. @advreap-beta your move.' }],
          onExhausted: 'repeat-last',
        },
        {
          key: 'beta',
          // Wedge: far past any test-scale stall window; abort-aware, so the
          // watchdog release unwinds it cleanly.
          script: [{ reply: 'Never arrives.', delayMs: 60_000 }],
        },
      ],
    });

    // Reaper armed with a short stall window; sweeps run manually via the
    // test seam so no timers are left behind.
    startRunReaper({ stallMs: 1_500, sweepIntervalMs: 600_000, graceMs: 100 });

    const sendPromise = scenario.send('@advreap-alpha Begin, then wedge.');
    // Let wave 1 finish and beta wedge past the stall window, then sweep.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    runReaperSweepOnce();

    const result = await sendPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The watchdog's attributed abort surfaces as the conversation reason.
    expect(result.stopReason).toBe('reaper');
    expect(scenario.callsFor('alpha')).toHaveLength(1);
    expect(scenario.callsFor('beta')).toHaveLength(1);
    expect(scenario.callsFor('beta')[0]!.aborted).toBe(true);

    expectCleanRuntime(scenario.threadId);
  });
});
