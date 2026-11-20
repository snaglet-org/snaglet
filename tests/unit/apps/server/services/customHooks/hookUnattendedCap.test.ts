/**
 * A hook run an agent started or caused may not auto-approve what it wakes
 * (causeUnattendedCap): an agent's tool call running it (`hook` op `run`, a
 * write that fired it), an agent-caused event (the context says so), or work
 * that is already capped. A schedule or a person's action leaves it uncapped.
 * The cap rides into the child inside its signed dispatch token.
 */
import { describe, expect, it } from '@jest/globals';
import { runWithActor } from '@server/realtime/actorContext';
import {
  currentUnattendedCap,
  runCappedUnattended,
  runWithRunContext,
} from '@server/realtime/runContext';
import { causeUnattendedCap } from '@server/services/customHooks/hookRunner';

const AGENT = { actorKind: 'agent' as const, actorId: 'test-agent-a', actorName: 'Test Agent A' };
const USER = { actorKind: 'user' as const, actorId: 'test-user', actorName: 'Test User' };

describe('causeUnattendedCap', () => {
  it('is off for a schedule (no actor) and a person', () => {
    expect(causeUnattendedCap({})).toBe(false);
    expect(runWithActor(USER, () => causeUnattendedCap({ agentId: 'test-agent-a' }))).toBe(false);
  });

  it("is on inside an agent's tool call (hook op:run, a write that fired the hook)", () => {
    expect(runWithActor(AGENT, () => causeUnattendedCap({}))).toBe(true);
  });

  it('is on for an agent-caused event and inside capped work', () => {
    expect(causeUnattendedCap({ unattendedCap: true })).toBe(true);
    expect(runCappedUnattended(() => causeUnattendedCap({}))).toBe(true);
  });
});

describe('the ambient cap', () => {
  it('is inherited by nested run contexts and never cleared by them', () => {
    runCappedUnattended(() => {
      runWithRunContext({ threadId: 'thread-1111111111111-aaaaaaaaa', runId: null }, () => {
        expect(currentUnattendedCap()).toBe(true);
      });
    });
    expect(currentUnattendedCap()).toBe(false);
  });
});
