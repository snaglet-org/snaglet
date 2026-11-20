/**
 * HookRunner — run as. A hook set to run as an agent spawns with a
 * dispatch credential bound to that agent and a SNAGLET_TOOL_CONTEXT_JSON agentId
 * naming it (so the SDK's forwarded agent_id matches the credential), and its
 * run record names it. Without one, an agentless event still binds the ghost
 * system actor. An agent archived or deleted since it was picked refuses the
 * run: nothing spawns, and a failed run says why.
 */
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  HookRunner,
  actingAgentId,
  type HookRunRecorder,
} from '@server/services/customHooks/hookRunner';
import { mintChildDispatchToken } from '@server/middleware/panelAuth';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';

interface ChildSeen {
  token: string | null;
  context: { agentId?: string };
  file: string;
}

describe('HookRunner — run as', () => {
  let tmpDir: string;
  let outFile: string;
  let builtPath: string;
  let started: Array<{ agentId?: string; chainDepth: number }>;
  let finished: Array<{ ok: boolean; stderr: string }>;
  let checkRunAs: jest.Mock<(agentId: string) => Promise<string | null>>;
  let runner: HookRunner;
  /** The sha256 of the built bundle: what run as was approved for. */
  let approved: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `snaglet-test-hook-run-as-${process.pid}-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    outFile = path.join(tmpDir, 'seen.json');
    builtPath = path.join(tmpDir, 'hook.cjs');
    await writeFile(
      builtPath,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
        '  token: process.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? null,',
        "  context: JSON.parse(process.env.SNAGLET_TOOL_CONTEXT_JSON || '{}'),",
        '  file: __filename,',
        '}));',
      ].join('\n')
    );
    approved = createHash('sha256')
      .update(await readFile(builtPath))
      .digest('hex');
    started = [];
    finished = [];
    const recorder: HookRunRecorder = {
      start: async (input) => {
        started.push({ agentId: input.agentId, chainDepth: input.chainDepth });
      },
      finish: async (_id, result) => {
        finished.push({ ok: result.ok, stderr: result.stderr });
      },
    };
    checkRunAs = jest.fn(async (agentId: string) =>
      agentId === AGENT_B ? 'agent "Test Agent B" is archived' : null
    );
    runner = new HookRunner({
      serverUrl: 'http://127.0.0.1:4001',
      timeoutMs: 5000,
      recorder,
      checkRunAs,
    });
  });

  afterEach(async () => {
    await runner.settle();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const seen = async (): Promise<ChildSeen> =>
    JSON.parse(await readFile(outFile, 'utf-8')) as ChildSeen;

  it('a table-row event run set to run as an agent acts as that agent', async () => {
    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'table_entry:update',
      event: { type: 'table_entry:update' },
      context: { runAsAgentId: AGENT_A, runAsBuildHash: approved },
    });

    const child = await seen();
    expect(child.token).toBe(
      mintChildDispatchToken(AGENT_A, 'test-hook', 1, ['test-hook'], false, true)
    );
    expect(child.context.agentId).toBe(AGENT_A);
    expect(child.context).not.toHaveProperty('runAsAgentId');
    // It started a private copy of the bytes it checked, removed afterward.
    expect(child.file).not.toBe(builtPath);
    await expect(stat(child.file)).rejects.toThrow();
    expect(started).toEqual([{ agentId: AGENT_A, chainDepth: 1 }]);
    expect(finished).toEqual([{ ok: true, stderr: '' }]);
    expect(checkRunAs).toHaveBeenCalledWith(AGENT_A);
  });

  it("wins over the event's own agent", async () => {
    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: { agentId: 'test-agent-c', runAsAgentId: AGENT_A, runAsBuildHash: approved },
    });

    const child = await seen();
    expect(child.token).toBe(
      mintChildDispatchToken(AGENT_A, 'test-hook', 1, ['test-hook'], false, true)
    );
    expect(child.context.agentId).toBe(AGENT_A);
  });

  it('defaults to the ghost system actor when nothing names an agent', async () => {
    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'table_entry:create',
      event: {},
      context: {},
    });

    const child = await seen();
    expect(child.token).toBe(mintChildDispatchToken(GHOST_AGENT_ID, 'test-hook', 1, ['test-hook']));
    expect(child.file).toBe(await realpath(builtPath));
    expect(child.context.agentId).toBeUndefined();
    expect(started).toEqual([{ agentId: undefined, chainDepth: 1 }]);
    expect(checkRunAs).not.toHaveBeenCalled();
  });

  it('refuses an event run whose agent was archived since: nothing spawns, the run log says why', async () => {
    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'table_entry:update',
      event: {},
      context: { runAsAgentId: AGENT_B, runAsBuildHash: approved },
    });

    await expect(stat(outFile)).rejects.toThrow();
    expect(started).toEqual([{ agentId: AGENT_B, chainDepth: 1 }]);
    expect(finished).toHaveLength(1);
    expect(finished[0].ok).toBe(false);
    expect(finished[0].stderr).toBe(
      'Refused before running: hook "test-hook" is set to run as test-agent-b, but agent "Test Agent B" is archived. Pick another agent or clear Run as in the hook editor.'
    );
  });

  it('refuses a test or scheduled run the same way, and never falls back to another identity', async () => {
    const result = await runner.runForTest({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'schedule:fire',
      event: {},
      context: { agentId: AGENT_A, runAsAgentId: AGENT_B, runAsBuildHash: approved },
      source: 'schedule',
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('is archived');
    await expect(stat(outFile)).rejects.toThrow();
  });

  it('refuses a run whose built bundle changed since run as was set', async () => {
    await writeFile(builtPath, `${await readFile(builtPath, 'utf-8')}\n// swapped in later\n`);

    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'table_entry:update',
      event: {},
      context: { runAsAgentId: AGENT_A, runAsBuildHash: approved },
    });

    await expect(stat(outFile)).rejects.toThrow();
    expect(finished).toHaveLength(1);
    expect(finished[0].ok).toBe(false);
    expect(finished[0].stderr).toContain("the hook's built code changed since Run as was set");
  });

  it('refuses run as with no approved build recorded', async () => {
    const result = await runner.runForTest({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'table_entry:update',
      event: {},
      context: { runAsAgentId: AGENT_A },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('no approved build is recorded');
    await expect(stat(outFile)).rejects.toThrow();
  });

  it('a test run of a hook set to run as an agent acts as it', async () => {
    const result = await runner.runForTest({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'table_entry:update',
      event: {},
      context: { runAsAgentId: AGENT_A, runAsBuildHash: approved },
    });

    expect(result.ok).toBe(true);
    expect((await seen()).context.agentId).toBe(AGENT_A);
  });
});

describe('actingAgentId', () => {
  it('is the run-as agent, else the event agent, else ghost', () => {
    expect(actingAgentId({ runAsAgentId: AGENT_A, agentId: AGENT_B })).toBe(AGENT_A);
    expect(actingAgentId({ agentId: AGENT_B })).toBe(AGENT_B);
    expect(actingAgentId({})).toBe(GHOST_AGENT_ID);
  });
});
