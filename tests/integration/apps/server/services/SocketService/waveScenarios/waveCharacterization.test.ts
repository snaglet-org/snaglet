/**
 * Wave-loop characterization suite: pins dispatch-loop behavior so auto-pass
 * and mention semantics do not drift. Each test runs the real dispatch loop +
 * turn loop against the per-file PostgreSQL clone with scripted-provider
 * agents (see scenarioHarness.ts).
 *
 * The ConversationBudget wave counter is the only wave cap, and `maxWaves` is
 * not clamped to a server ceiling. What makes an absurd override finite is the
 * per-agent hard dispatch ceiling (`dispatch.soft_threshold * 2`), which a
 * per-thread maxAgentDispatches cannot change.
 *
 * Every ending carries a ConversationStopReason (DispatchResult.stopReason and
 * the persisted [conversation ended …] event); solo natural endings emit no
 * event. Pass detection is anchored: a standalone or trailing [PASS]/[DONE]
 * passes, a mid-prose [PASS] is inert.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { generateId } from '@snaglet/shared/utils';
import {
  createScenario,
  pinConversationCompaction,
  pinEmbeddingsUnavailable,
  waitFor,
  type Scenario,
} from './scenarioHarness';

// Wave bounds must be measured against the shipping compaction default, not
// whatever the machine's gitignored .env happens to set.
pinConversationCompaction();
// Likewise stagnation must not depend on whether this machine has the local
// embedder's model files: every scenario runs the Jaccard fallback.
pinEmbeddingsUnavailable();

jest.setTimeout(90_000);

let scenario: Scenario | null = null;

afterEach(async () => {
  if (scenario) {
    await scenario.cleanup();
    scenario = null;
  }
});

/** done frames for one agent, in emission order. */
function doneFrames(s: Scenario, agentId: string) {
  return s.events.filter(
    (e) => e.type === 'socket:done' && e.payload['agentId'] === agentId && e.payload['runId']
  );
}

/**
 * Distinct relay replies for endless-mention scenarios. Each turn must differ
 * from the agent's previous one: identical repeat-last content trips the
 * stagnation detector and auto-passes the agent out of the relay.
 */
const RELAY_LINES = [
  'Opening point: the cache layer needs explicit invalidation hooks.',
  'Second — would write-through be simpler than invalidation here?',
  'Benchmarks from Tuesday show p99 at 40ms on the current path, for reference.',
  'I keep coming back to shipping the simpler design first and iterating.',
  'One more angle: the failure mode matters more than the throughput.',
  'Let me push back gently — recovery time is what users actually feel.',
  'Documenting the tradeoffs might resolve half of this disagreement.',
  'Counterpoint: our metrics dashboard already covers the risky window.',
  'A staged rollout would derisk both options at once, honestly.',
  'Closing thought from me: pick whichever we can revert fastest.',
  'Actually the revert story is weaker than assumed; flags help there.',
  'Final flag from my side: capacity planning owns the last word here.',
];

function relayScript(lines: string[], mention: string) {
  return lines.map((line) => ({ reply: `${line} @${mention} your move.` }));
}

describe('wave characterization — current behavior', () => {
  it('(a3) an absurd maxWaves override is not clamped — the per-agent dispatch ceiling is the backstop', async () => {
    // There is no server wave ceiling: `maxWaves` is deliberately not a
    // clampable field (see clampToCeiling in groupChat/safety.ts), and there
    // is no per-thread `maxAgentDispatches` override. What bounds a runaway
    // relay is the per-agent hard dispatch ceiling —
    // `dispatch.soft_threshold * 2`, i.e. 10 at the registry default — plus
    // the stagnation detector, so the relay stops on a per-agent/quality
    // guard rather than at any wave number.
    scenario = await createScenario({
      prefix: 'waveceil',
      dispatchMode: 'mentioned',
      budget: { maxWaves: 999 },
      agents: [
        {
          key: 'alpha',
          script: relayScript(RELAY_LINES, 'waveceil-beta'),
          onExhausted: 'repeat-last',
        },
        {
          key: 'beta',
          script: relayScript([...RELAY_LINES].reverse(), 'waveceil-alpha'),
          onExhausted: 'repeat-last',
        },
      ],
    });

    const result = await scenario.send(`@${scenario.names.alpha} Run forever please.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No wave cap fires: 999 is not clamped, and the relay ends long before
    // wave 999.
    expect(result.capHit).toBe(false);
    expect(result.reason).toBe('completed');
    expect(result.stopReason).toBe('all-passed');
    // Each agent stops at the per-agent hard ceiling (soft 5 x 2 = 10), which
    // is what makes an absurd override finite.
    expect(scenario.callsFor('alpha')).toHaveLength(10);
    expect(scenario.callsFor('beta')).toHaveLength(10);
  });

  it('(b) natural convergence: A wakes B by mention, B joins the same wave, both converge before any cap', async () => {
    scenario = await createScenario({
      prefix: 'waveconv',
      dispatchMode: 'mentioned',
      agents: [
        {
          key: 'alpha',
          script: [{ reply: 'Handing off to @waveconv-beta for review.' }],
        },
        { key: 'beta', script: [{ reply: 'Reviewed. All good.' }] },
      ],
    });

    const result = await scenario.send(`@${scenario.names.alpha} please start.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reason).toBe('completed');
    expect(result.capHit).toBe(false);
    expect(result.stopReason).toBe('all-passed');
    const endedB = scenario.conversationEndedEvents();
    expect(endedB).toHaveLength(1);
    expect(endedB[0]!.payload['stop_reason']).toBe('all-passed');

    // Alpha spoke once. Beta was woken mid-wave (parallel 'mentioned' mode
    // startAgent path) and joined wave 1 — then, because wokenByMention is
    // only cleared per-wave (not per-satisfied-mention), beta escapes the
    // post-wave auto-pass and gets a redundant wave-2 turn, where its
    // exhausted script answers [PASS] (explicit pass on a continuation round).
    expect(scenario.callsFor('alpha')).toHaveLength(1);
    expect(scenario.callsFor('beta')).toHaveLength(2);

    const betaDones = doneFrames(scenario, scenario.ids.beta);
    expect(betaDones).toHaveLength(2);
    expect(betaDones[1]!.payload['passed']).toBe(true);

    // Both real replies persisted; the [PASS] did not.
    const assistantRows = await scenario.assistantMessages();
    expect(assistantRows.map((m) => m.content)).toEqual([
      'Handing off to @waveconv-beta for review.',
      'Reviewed. All good.',
    ]);
  });

  it('(c) mid-wave mention growth: A mentions C mid-run; C joins the current wave (no socket:agent:continuing for the join)', async () => {
    scenario = await createScenario({
      prefix: 'wavegrow',
      dispatchMode: 'mentioned',
      agents: [
        { key: 'alpha', script: [{ reply: 'Pulling in @wavegrow-gamma.' }] },
        { key: 'beta', script: [{ reply: 'Beta reporting.' }] },
        { key: 'gamma', script: [{ reply: 'Gamma here, on it.' }] },
      ],
    });

    const result = await scenario.send(`@${scenario.names.alpha} kick off.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reason).toBe('completed');
    expect(result.stopReason).toBe('all-passed');

    // Beta was never mentioned → never dispatched.
    expect(scenario.callsFor('beta')).toHaveLength(0);
    // Gamma joined via alpha's mid-run mention.
    expect(scenario.callsFor('gamma').length).toBeGreaterThanOrEqual(1);

    // Gamma's first turn ran inside wave 1: socket:agent:continuing only
    // fires for turns with conversationRound > 0, so the first gamma turn has
    // no continuing frame before its first delta/done.
    const gammaContinuing = scenario.events.filter(
      (e) => e.type === 'socket:agent:continuing' && e.payload['agentId'] === scenario!.ids.gamma
    );
    const gammaDones = doneFrames(scenario, scenario.ids.gamma);
    expect(gammaDones.length).toBeGreaterThanOrEqual(1);
    // First gamma turn joined wave 1 → at most one continuing frame, and only
    // for the redundant wave-2 re-dispatch (same mechanism as (b)).
    expect(gammaContinuing.length).toBeLessThanOrEqual(1);
  });

  it('(d) all-mode fan-out re-wakes participants in the same wave, bounded by the settings ceiling a per-thread override cannot tighten', async () => {
    // In 'all' mode every persisted reply, even one with no @mentions, fans out
    // to every other participant (routeAllModeMidRunMessage) and wakes idle ones
    // into the current wave, so two agents re-wake each other inside wave 1.
    // The budget is checked only at wave boundaries; the per-agent hard
    // dispatch ceiling is the only in-wave guard. maxAgentDispatches=2 is inert
    // (no per-thread override): the bound is the registry's (soft 5 → hard 10).
    scenario = await createScenario({
      prefix: 'waveall',
      dispatchMode: 'all',
      maxAgentDispatches: 2,
      agents: [
        { key: 'alpha', script: [{ reply: 'Alpha take.' }] },
        { key: 'beta', script: [{ reply: 'Beta take.', delayMs: 150 }] },
      ],
    });

    const result = await scenario.send('Everyone, thoughts?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reason).toBe('completed');
    expect(result.capHit).toBe(false);
    expect(result.stopReason).toBe('all-passed');
    // The fan-out re-wake ping-pong ran beyond the initial two turns, all
    // inside wave 1, bounded by the settings hard ceiling (10 = 2x the
    // dispatch soft threshold) rather than by the thread's inert override.
    // Exact counts are timing-sensitive under parallel jest files (a wake
    // that lands while the peer is still running queues instead of waking,
    // ending the storm early) — the invariants are the bounds.
    expect(scenario.callsFor('alpha').length).toBeLessThanOrEqual(10);
    expect(scenario.callsFor('beta').length).toBeLessThanOrEqual(10);
    expect(
      scenario.callsFor('alpha').length + scenario.callsFor('beta').length
    ).toBeGreaterThanOrEqual(3);
    // Zero socket:agent:continuing frames → every turn ran at round 0
    // (wave 1); the "waves" never advanced while the ping-pong ran.
    const continuing = scenario.events.filter((e) => e.type === 'socket:agent:continuing');
    expect(continuing).toHaveLength(0);
    // The literal [PASS] rows persisted (round-0 pass tokens are inert).
    const rows = await scenario.assistantMessages();
    expect(rows.some((m) => m.content === '[PASS]')).toBe(true);
  });

  it('(d2) a default thread (absent max_agent_dispatches) gets the settings ceiling, bounding the all-mode ping-pong', async () => {
    // threads.maxAgentDispatches is unpacked from config_json->>'max_agent_dispatches',
    // which is NULL when the key is absent — i.e. for every normally-created
    // thread. Null/absent falls back to the settings registry (soft 5 → hard
    // ceiling 10) rather than meaning "explicitly unlimited" (which would let
    // the all-mode fan-out ping-pong of (d) run unbounded), so a default
    // thread is bounded: each agent runs to exactly 10 calls inside wave 1, then the
    // conversation converges.
    scenario = await createScenario({
      prefix: 'wavehole',
      dispatchMode: 'all',
      agents: [
        { key: 'alpha', script: [{ reply: 'Alpha take.' }] },
        { key: 'beta', script: [{ reply: 'Beta take.', delayMs: 150 }] },
      ],
    });

    const result = await scenario.send('Everyone, thoughts?');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reason).toBe('completed');
    expect(result.stopReason).toBe('all-passed');
    // Bounded by the settings-default ceiling (soft 5 → hard 10);
    // ranges rather than exact counts — see (d) on storm timing sensitivity.
    expect(scenario.callsFor('alpha').length).toBeLessThanOrEqual(10);
    expect(scenario.callsFor('beta').length).toBeLessThanOrEqual(10);
    expect(
      scenario.callsFor('alpha').length + scenario.callsFor('beta').length
    ).toBeGreaterThanOrEqual(4);
  });

  it('(g) mid-run injected user message: solo terminal drain persists it and re-wakes the agent for one extra wave', async () => {
    scenario = await createScenario({
      prefix: 'wavemid',
      dispatchMode: 'all',
      agents: [
        {
          key: 'solo',
          script: [
            // Long enough for the mid-run enqueue below to land during the
            // final (zero-tool) model call.
            { reply: 'First answer.', delayMs: 600 },
            { reply: 'Answering your follow-up.' },
          ],
        },
      ],
    });

    const midRunId = generateId('message');
    const sendPromise = scenario.send('Initial question?');
    // Wait until the agent's (final, zero-tool) model call is actually in
    // flight — the call is recorded before its scripted delay — then park a
    // user message in the live session queue (the socket path's mid-run
    // enqueue seam). A fixed sleep would race run setup: too early and the lock
    // isn't held yet (enqueue → false) or the message is drained before the
    // first call; too late and the call already finished.
    await waitFor(() => scenario.callsFor('solo').length >= 1, {
      label: 'solo model call in flight',
    });
    const queued = activeRunTracker.enqueueMessageForThread(
      scenario.threadId,
      midRunId,
      'Follow-up while you were thinking!'
    );
    expect(queued).toBe(true);

    const result = await sendPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reason).toBe('completed');
    expect(result.stopReason).toBe('all-passed');
    // Solo natural endings are not narrated — a 1:1 chat ending after
    // every answer would be noise. The structured log still fires.
    expect(scenario.conversationEndedEvents()).toHaveLength(0);

    // The mid-run message was persisted (injected_during_run) and answered.
    const all = await scenario.allMessages();
    const injected = all.find((m) => m.id === midRunId);
    expect(injected).toBeDefined();
    expect(injected!.injectedDuringRun).toBe(true);
    expect(scenario.callsFor('solo')).toHaveLength(2);
    expect(all.some((m) => m.content === 'Answering your follow-up.')).toBe(true);
  });

  it('(h) budget stop: token exhaustion ends the loop with a visible token-budget reason', async () => {
    scenario = await createScenario({
      prefix: 'wavebudget',
      dispatchMode: 'mentioned',
      // The thread's "Output tokens" override caps the pool (the default is
      // the 192k ceiling). It gates dispatch; it never sizes a reply.
      budget: { maxTotalOutputTokens: 32_000 },
      agents: [
        {
          key: 'alpha',
          // Report enormous output usage so the 32k pool exhausts after
          // wave 2 (20k + 20k), before wave 3's round cap.
          script: [{ reply: 'Big spend. @wavebudget-beta go.', usage: { outputTokens: 20_000 } }],
          onExhausted: 'repeat-last',
        },
        {
          key: 'beta',
          script: [
            { reply: 'Big spend back. @wavebudget-alpha go.', usage: { outputTokens: 20_000 } },
          ],
          onExhausted: 'repeat-last',
        },
      ],
    });

    const result = await scenario.send(`@${scenario.names.alpha} Burn it down.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Alpha and beta ran, then the budget stop.
    // The `reason` field stays 'completed' for API compatibility; stopReason
    // and the persisted narration carry the budget stop.
    expect(scenario.callsFor('alpha')).toHaveLength(1);
    expect(scenario.callsFor('beta')).toHaveLength(1);
    expect(result.capHit).toBe(false);
    expect(result.reason).toBe('completed');
    expect(result.stopReason).toBe('token-budget');
    const endedH = scenario.conversationEndedEvents();
    expect(endedH).toHaveLength(1);
    expect(endedH[0]!.payload['stop_reason']).toBe('token-budget');
    expect(endedH[0]!.payload['content']).toContain('output budget reached');
  });
});
