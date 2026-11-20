/**
 * Vision access transitions delivered into agent turn context.
 *
 * Two properties are easy to get wrong and expensive when wrong:
 *
 *   - An agent must be able to tell "vision was never on" from "vision was
 *     revoked since your last turn". Without the second, an agent keeps
 *     believing it can look.
 *   - The notice must never claim sight. Access is permission; nothing has
 *     been seen until a capture tool has actually returned pixels.
 *
 * The delta is derived (last-acknowledged vs current) rather than queued, so
 * these tests also pin idempotence across provider retries and model fallback.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  VisionSnapshotService,
  type VisionSnapshotRuntime,
} from '@server/services/vision/VisionSnapshotService';
import {
  VisionThreadService,
  runtimeForSnapshotService,
} from '@server/services/vision/VisionThreadService';
import { composeVisionAccessSegment } from '@server/services/vision/visionAccessContext';
import {
  buildTurnContextMessage,
  TURN_CONTEXT_SENTINEL,
} from '@server/services/SystemPromptComposer/composeTurnContextTail';

const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(96, 9)]);
const BOTH_TOOLS = { screen: 'capture_user_screen', camera: 'capture_user_camera' };
const NO_TOOLS = { screen: null, camera: null };

async function service(): Promise<VisionThreadService> {
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-transition-'));
  const snapshotRuntime: VisionSnapshotRuntime = {
    async captureFrame(framePath) {
      await writeFile(framePath, JPEG);
    },
  };
  const snapshots = new VisionSnapshotService(snapshotRuntime, { spoolRoot });
  return new VisionThreadService(
    runtimeForSnapshotService(snapshots),
    () => {},
    () => {},
    () => {},
    async () => JPEG
  );
}

/**
 * One model attempt's context assembly: derive the delta, render it, and build
 * the candidate snapshot that rides on this attempt. Confirms nothing —
 * building a payload is not the model receiving it.
 */
const assemble = (
  svc: VisionThreadService,
  agentId: string,
  tools = BOTH_TOOLS,
  threadId = 'thread-1'
) => {
  const delta = svc.accessDeltaFor(threadId, agentId);
  const segment = composeVisionAccessSegment(delta, tools);
  return { segment, candidate: delta && segment ? svc.accessCandidateFrom(delta) : null };
};

/** An attempt that assembled and got a successful provider result. */
const segmentFor = (
  svc: VisionThreadService,
  agentId: string,
  tools = BOTH_TOOLS,
  threadId = 'thread-1'
) => {
  const { segment, candidate } = assemble(svc, agentId, tools, threadId);
  svc.confirmAccessDelivered(threadId, agentId, candidate);
  return segment;
};

/** A pure read — what the agent would be shown, delivering nothing. */
const peek = (svc: VisionThreadService, agentId: string, threadId = 'thread-1') =>
  composeVisionAccessSegment(svc.accessDeltaFor(threadId, agentId), BOTH_TOOLS);

describe('vision access transitions', () => {
  it('says nothing at all when vision has never been enabled', async () => {
    const svc = await service();
    expect(svc.accessDeltaFor('thread-1', 'agent-1')).toBeNull();
    expect(segmentFor(svc, 'agent-1')).toBeNull();
  });

  it.each([
    ['screen', ['capture_user_screen'], ['capture_user_camera']],
    ['camera', ['capture_user_camera'], ['capture_user_screen']],
  ] as const)('enabling %s names only that capture tool', async (source, named, absent) => {
    const svc = await service();
    await svc.start('thread-1', source, 'client-1');

    const text = segmentFor(svc, 'agent-1') ?? '';
    expect(text).toContain('just granted');
    for (const tool of named) expect(text).toContain(tool);
    for (const tool of absent) expect(text).not.toContain(tool);
  });

  it('enabling both names both capture tools', async () => {
    const svc = await service();
    await svc.start('thread-1', 'both', 'client-1');

    const text = segmentFor(svc, 'agent-1') ?? '';
    expect(text).toContain('capture_user_screen');
    expect(text).toContain('capture_user_camera');
  });

  it('never claims the agent can see continuously or has already looked', async () => {
    const svc = await service();
    await svc.start('thread-1', 'both', 'client-1');

    const text = (segmentFor(svc, 'agent-1') ?? '').toLowerCase();
    expect(text).toContain('permission only');
    expect(text).toContain('nothing is captured automatically');
    expect(text).toContain('have not been shown anything yet');
    // Nothing that would read as an existing view of the user's screen.
    expect(text).not.toMatch(/you can see|currently viewing|the user's screen shows/);
  });

  it('reports a source switch with both the prior and the new source', async () => {
    const svc = await service();
    await svc.start('thread-1', 'screen', 'client-1');
    segmentFor(svc, 'agent-1'); // a completed prior turn that saw the grant
    svc.markAccessSeen('thread-1', 'agent-1');

    await svc.start('thread-1', 'camera', 'client-1');

    const text = segmentFor(svc, 'agent-1') ?? '';
    expect(text).toContain('from screen to camera');
    expect(text).toContain('revoked');
    expect(text).toContain('capture_user_camera');
  });

  it('reports revocation once, then stops repeating it', async () => {
    const svc = await service();
    await svc.start('thread-1', 'screen', 'client-1');
    segmentFor(svc, 'agent-1'); // a completed prior turn that saw the grant
    svc.markAccessSeen('thread-1', 'agent-1');

    await svc.stop('thread-1');

    const revocation = segmentFor(svc, 'agent-1') ?? '';
    expect(revocation).toContain('turned off vision access');
    expect(revocation).toContain('no longer usable');
    // The agent must not go on believing it can still look.
    expect(revocation).toContain('do not describe it as something you can still see');

    // Turn ends; the next clean turn is silent rather than re-announcing.
    svc.markAccessSeen('thread-1', 'agent-1');
    expect(segmentFor(svc, 'agent-1')).toBeNull();
  });

  it('distinguishes "never enabled" from "revoked since your last turn"', async () => {
    const svc = await service();
    await svc.start('thread-1', 'screen', 'client-1');
    segmentFor(svc, 'saw-it');
    svc.markAccessSeen('thread-1', 'saw-it');
    await svc.stop('thread-1');

    // The agent that saw access is told it went away...
    expect(segmentFor(svc, 'saw-it')).toContain('turned off vision access');
    // ...while an agent that never saw it is told nothing, not a phantom revocation.
    expect(segmentFor(svc, 'never-saw-it')).toBeNull();
  });

  it('delivers to each agent on its own perception boundary', async () => {
    const svc = await service();
    await svc.start('thread-1', 'screen', 'client-1');

    // Agent A runs and acknowledges; agent B has not run yet.
    expect(segmentFor(svc, 'agent-a')).toContain('just granted');
    svc.markAccessSeen('thread-1', 'agent-a');

    // A's turn did not consume B's copy.
    expect(segmentFor(svc, 'agent-b')).toContain('just granted');

    // A now sees only the steady-state snapshot, not the enable again.
    const aSecond = segmentFor(svc, 'agent-a') ?? '';
    expect(aSecond).toContain('Access is active for screen');
    expect(aSecond).not.toContain('just granted');
  });

  it('is idempotent across provider retries and model fallback within one turn', async () => {
    const svc = await service();
    await svc.start('thread-1', 'both', 'client-1');

    // prepareModelAttemptContext runs once per model attempt; nothing is
    // consumed until the turn completes, so every attempt sees the same bytes.
    const first = segmentFor(svc, 'agent-1');
    const afterRetry = segmentFor(svc, 'agent-1');
    const afterFallback = segmentFor(svc, 'agent-1');
    expect(afterRetry).toBe(first);
    expect(afterFallback).toBe(first);

    // Only turn completion advances it.
    svc.markAccessSeen('thread-1', 'agent-1');
    expect(segmentFor(svc, 'agent-1')).not.toBe(first);
  });

  it('tells the truth when access is granted but no capture tool is available', async () => {
    const svc = await service();
    await svc.start('thread-1', 'screen', 'client-1');

    const text = segmentFor(svc, 'agent-1', NO_TOOLS) ?? '';
    expect(text).toContain('No capture tool for screen is available to you');
    expect(text).toContain('say that plainly instead of attempting a call');
    // Must not instruct a call it cannot make.
    expect(text).not.toContain('Call `capture_user_screen`');
  });

  it('flags the unreachable half when only one granted source is available', async () => {
    const svc = await service();
    await svc.start('thread-1', 'both', 'client-1');

    const text = segmentFor(svc, 'agent-1', { screen: 'capture_user_screen', camera: null }) ?? '';
    expect(text).toContain('capture_user_screen');
    expect(text).toContain('Capture for camera is not available to you');
  });

  it('rides inside the trusted turn-context block, not as a user message', async () => {
    const svc = await service();
    await svc.start('thread-1', 'screen', 'client-1');
    const segment = segmentFor(svc, 'agent-1');

    // How it reaches the provider: spliced into the single ephemeral
    // turn-context tail, which carries TURN_CONTEXT_SENTINEL. Downstream
    // classification keys off that documented marker to exclude the block from
    // "what the human said"; a separate `<vision_access>` message would match no
    // marker, count as a human turn, and could be re-pinned as a user request.
    const tail = buildTurnContextMessage(['**Your current coordinates:**', segment]);

    expect(tail).not.toBeNull();
    expect(tail?.content.startsWith(TURN_CONTEXT_SENTINEL)).toBe(true);
    expect(tail?.content).toContain('Vision access');
    expect(tail?.content).toContain('capture_user_screen');
    // The header disclaims authorship for everything inside the block.
    expect(tail?.content).toContain('do not quote it as something a participant said');
  });

  describe('delivery acknowledgment', () => {
    it('acknowledges only what was delivered when access is revoked mid-turn', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');

      // Turn begins: the enable transition is rendered into the payload.
      expect(segmentFor(svc, 'agent-1')).toContain('just granted');

      // The user revokes while the provider is still responding.
      await svc.stop('thread-1');

      // Turn ends. Acknowledging current state here would retire a revocation
      // the agent was never shown, and it would go on believing it can look.
      svc.markAccessSeen('thread-1', 'agent-1');

      const next = peek(svc, 'agent-1') ?? '';
      expect(next).toContain('turned off vision access');
      expect(next).toContain('no longer usable');
    });

    it('leaves a transition pending when the turn died before context assembly', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');

      // No assembly happened — archived agent, no model, abort. Teardown still
      // runs, and must not consume a notice nobody ever received.
      svc.markAccessSeen('thread-1', 'agent-1');

      expect(peek(svc, 'agent-1')).toContain('just granted');
    });

    it('is byte-identical across model fallback and acknowledges exactly once', async () => {
      const svc = await service();
      await svc.start('thread-1', 'both', 'client-1');

      // Each model attempt re-runs assembly and re-records the same snapshot.
      const attemptOne = segmentFor(svc, 'agent-1');
      const attemptTwo = segmentFor(svc, 'agent-1');
      const attemptThree = segmentFor(svc, 'agent-1');
      expect(attemptTwo).toBe(attemptOne);
      expect(attemptThree).toBe(attemptOne);

      svc.markAccessSeen('thread-1', 'agent-1');

      // One acknowledgment covering all three attempts: the enable notice is
      // gone, leaving only the steady-state snapshot.
      const after = peek(svc, 'agent-1') ?? '';
      expect(after).toContain('Access is active for screen and camera');
      expect(after).not.toContain('just granted');

      // A second teardown cannot double-acknowledge into a later state.
      svc.markAccessSeen('thread-1', 'agent-1');
      expect(peek(svc, 'agent-1')).toBe(after);
    });

    it('acknowledges nothing when no vision segment was inserted', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');

      // An agent with no capture tools still gets a segment, so use the case
      // that genuinely produces none: an agent whose delta is null because
      // vision was never on for it.
      await svc.stop('thread-1');
      expect(segmentFor(svc, 'fresh-agent')).toBeNull();

      svc.markAccessSeen('thread-1', 'fresh-agent');

      // Re-enabling must still reach it — nothing was consumed.
      await svc.start('thread-1', 'camera', 'client-1');
      expect(peek(svc, 'fresh-agent')).toContain('just granted');
    });

    it('acknowledges the newer snapshot when a fallback attempt actually delivered it', async () => {
      const svc = await service();
      // A completed prior turn: this agent knows access is on for screen.
      await svc.start('thread-1', 'screen', 'client-1');
      segmentFor(svc, 'agent-1');
      svc.markAccessSeen('thread-1', 'agent-1');

      // This turn, attempt 1 renders the steady-state snapshot...
      expect(segmentFor(svc, 'agent-1')).toContain('Access is active for screen');
      // ...then the user switches source, and the fallback attempt renders and
      // genuinely delivers the change. Acknowledging the newer snapshot is
      // correct here precisely because the model did receive it.
      await svc.start('thread-1', 'camera', 'client-1');
      expect(segmentFor(svc, 'agent-1')).toContain('from screen to camera');

      svc.markAccessSeen('thread-1', 'agent-1');

      const after = peek(svc, 'agent-1') ?? '';
      expect(after).toContain('Access is active for camera');
      expect(after).not.toContain('from screen to camera');
    });
  });

  describe('perception requires a successful provider result', () => {
    it('replays the transition next turn when every provider attempt failed', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');

      // Payload assembled and the enable rendered into it...
      const { segment } = assemble(svc, 'agent-1');
      expect(segment).toContain('just granted');
      // ...but the provider call threw. Nothing confirmed.
      svc.markAccessSeen('thread-1', 'agent-1');

      expect(peek(svc, 'agent-1')).toContain('just granted');
    });

    it('acknowledges the fallback’s snapshot, never the failed attempt’s', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');
      segmentFor(svc, 'agent-1'); // prior completed turn: knows about screen
      svc.markAccessSeen('thread-1', 'agent-1');

      // Attempt 1 assembles the steady-state snapshot, then the provider fails.
      const failed = assemble(svc, 'agent-1');
      expect(failed.segment).toContain('Access is active for screen');

      // Source changes, then the fallback attempt assembles and succeeds.
      await svc.start('thread-1', 'camera', 'client-1');
      const { segment, candidate } = assemble(svc, 'agent-1');
      expect(segment).toContain('from screen to camera');
      svc.confirmAccessDelivered('thread-1', 'agent-1', candidate);

      svc.markAccessSeen('thread-1', 'agent-1');

      // Acknowledged at camera — the failed attempt's older snapshot did not win,
      // which would have replayed the switch forever.
      const after = peek(svc, 'agent-1') ?? '';
      expect(after).toContain('Access is active for camera');
      expect(after).not.toContain('from screen to camera');
    });

    it('may acknowledge when the provider succeeded but the turn failed later', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');

      // The model read the context and answered; a tool blew up afterward.
      // It still perceived the grant, so replaying it would be a lie.
      segmentFor(svc, 'agent-1');
      svc.markAccessSeen('thread-1', 'agent-1');

      const after = peek(svc, 'agent-1') ?? '';
      expect(after).toContain('Access is active for screen');
      expect(after).not.toContain('just granted');
    });

    it('leaves access change after a successful request pending', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');
      segmentFor(svc, 'agent-1'); // assembled and answered

      // User revokes while the model is still streaming its reply.
      await svc.stop('thread-1');
      svc.markAccessSeen('thread-1', 'agent-1');

      expect(peek(svc, 'agent-1')).toContain('turned off vision access');
    });

    it('confirms nothing when the attempt carried no vision candidate', async () => {
      const svc = await service();
      await svc.start('thread-1', 'screen', 'client-1');

      const { candidate } = assemble(svc, 'fresh-agent');
      expect(candidate).not.toBeNull();

      // A null candidate — no segment in the payload — must be inert.
      svc.confirmAccessDelivered('thread-1', 'other-agent', null);
      svc.markAccessSeen('thread-1', 'other-agent');
      expect(peek(svc, 'other-agent')).toContain('just granted');
    });
  });

  it('carries no pixels, paths, credentials, or capture identifiers', async () => {
    const svc = await service();
    await svc.start('thread-1', 'both', 'secret-capture-client-id');

    const text = segmentFor(svc, 'agent-1') ?? '';
    expect(text).not.toContain('secret-capture-client-id');
    expect(text).not.toMatch(/base64|data:image|\/var\/folders|\/tmp\/|sessionId|frameId/i);
  });
});
