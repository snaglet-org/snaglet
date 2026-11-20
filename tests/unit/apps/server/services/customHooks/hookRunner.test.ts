/**
 * HookRunner — child env security, including the per-agent token binding
 * that blocks cross-agent impersonation.
 *
 * Hooks spawn like workspace tools: user-authored code in a bounded child
 * process. A hook's child env never contains SNAGLET_PANEL_TOKEN (full panel
 * authority), only a per-spawn SNAGLET_CHILD_DISPATCH_TOKEN bound to the invoking
 * agent, which can run a normal tool as that agent and nothing more, even if
 * the hook raw-fetches /execute with a forged agent_id (see panelAuth.ts).
 */
import path from 'path';
import { writeFile, mkdir, rm, stat } from 'fs/promises';
import os from 'os';
import { HookRunner, type HookRunRecorder } from '@server/services/customHooks/hookRunner';
import { mintChildDispatchToken } from '@server/middleware/panelAuth';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';

describe('HookRunner — child env', () => {
  let tmpDir: string;
  let runner: HookRunner;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `snaglet-test-hook-runner-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    runner = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 5000 });
  });

  afterEach(async () => {
    await runner.settle();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does not put SNAGLET_PANEL_TOKEN in a hook child's env", async () => {
    const outFile = path.join(tmpDir, 'out.json');
    const builtPath = path.join(tmpDir, 'hook.cjs');
    await writeFile(
      builtPath,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ panelToken: process.env.SNAGLET_PANEL_TOKEN ?? null }));`,
      ].join('\n')
    );

    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: {},
    });

    const { readFile } = await import('fs/promises');
    const raw = await readFile(outFile, 'utf-8');
    const parsed = JSON.parse(raw) as { panelToken: string | null };
    expect(parsed.panelToken).toBeNull();
  });

  it('binds the ghost system actor when the run has no agent context — an unbound token could never execute tools', async () => {
    const outFile = path.join(tmpDir, 'out.json');
    const builtPath = path.join(tmpDir, 'hook.cjs');
    await writeFile(
      builtPath,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ childDispatchToken: process.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? null }));`,
      ].join('\n')
    );

    await runner.run({
      hookName: 'test-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: {},
    });

    const { readFile } = await import('fs/promises');
    const raw = await readFile(outFile, 'utf-8');
    const parsed = JSON.parse(raw) as { childDispatchToken: string | null };
    // context.agentId is undefined above. Binding no agent would make the
    // credential tool-incapable (execution.routes.ts rejects unbound
    // child-dispatch outright), silently breaking every tool-using hook
    // fired by agentless events (task moves, schedules). Agentless spawns
    // therefore bind the ghost system actor — still exactly one bound
    // identity, so the impersonation invariant is intact.
    // An event-caused run is one chain-depth hop from a person (1),
    // and that depth and its hook chain are signed into the same token.
    expect(parsed.childDispatchToken).toBe(
      mintChildDispatchToken(GHOST_AGENT_ID, 'test-hook', 1, ['test-hook'])
    );
    expect(parsed.childDispatchToken).not.toBe(mintChildDispatchToken());
  });

  it('injects a token bound to the invoking agent and distinct per agent, so a hook cannot impersonate another agent', async () => {
    const outFileA = path.join(tmpDir, 'out-a.json');
    const outFileB = path.join(tmpDir, 'out-b.json');
    const scriptFor = (outFile: string) =>
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ childDispatchToken: process.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? null }));`,
      ].join('\n');

    const builtPathA = path.join(tmpDir, 'hook-a.cjs');
    const builtPathB = path.join(tmpDir, 'hook-b.cjs');
    await writeFile(builtPathA, scriptFor(outFileA));
    await writeFile(builtPathB, scriptFor(outFileB));

    const { readFile } = await import('fs/promises');

    // Two runs "for" two different agents — mirrors two separate
    // workspace-tool/hook children spawned for different agents.
    await runner.run({
      hookName: 'test-hook-a',
      builtPath: builtPathA,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: { agentId: 'agent-a' },
    });
    await runner.run({
      hookName: 'test-hook-b',
      builtPath: builtPathB,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: { agentId: 'agent-b' },
    });

    const parsedA = JSON.parse(await readFile(outFileA, 'utf-8')) as {
      childDispatchToken: string | null;
    };
    const parsedB = JSON.parse(await readFile(outFileB, 'utf-8')) as {
      childDispatchToken: string | null;
    };

    expect(parsedA.childDispatchToken).toBe(
      mintChildDispatchToken('agent-a', 'test-hook-a', 1, ['test-hook-a'])
    );
    expect(parsedB.childDispatchToken).toBe(
      mintChildDispatchToken('agent-b', 'test-hook-b', 1, ['test-hook-b'])
    );
    // A token minted for agent-a differs from one minted for agent-b, so
    // agent-a's hook child cannot replay its own token while claiming to be
    // agent-b (verifyChildDispatchToken recovers 'agent-a' regardless of what
    // the request body claims).
    expect(parsedA.childDispatchToken).not.toBe(parsedB.childDispatchToken);
  });

  it('still functions normally without any panel authority — a well-behaved hook exits 0', async () => {
    const builtPath = path.join(tmpDir, 'noop-hook.cjs');
    await writeFile(builtPath, 'process.exit(0);\n');

    // run() never rejects; if it resolved, the hook completed without
    // SNAGLET_PANEL_TOKEN in its env.
    await expect(
      runner.run({
        hookName: 'noop-hook',
        builtPath,
        hookDir: tmpDir,
        eventName: 'message:create',
        event: {},
        context: {},
      })
    ).resolves.toBeUndefined();
  });

  it('runForTest returns stdout, stderr, exit code, and duration', async () => {
    const builtPath = path.join(tmpDir, 'captured-hook.cjs');
    await writeFile(
      builtPath,
      "process.stdout.write('sample output'); process.stderr.write('sample warning');\n"
    );
    const result = await runner.runForTest({
      hookName: 'captured-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: { id: 'message-1' },
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('sample output');
    expect(result.stderr).toBe('sample warning');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runForTest reports a nonzero exit and a timeout', async () => {
    const failingPath = path.join(tmpDir, 'failing-hook.cjs');
    await writeFile(failingPath, "process.stderr.write('boom'); process.exit(7);\n");
    const failed = await runner.runForTest({
      hookName: 'failing-hook',
      builtPath: failingPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
    });
    expect(failed).toMatchObject({ ok: false, exitCode: 7, stderr: 'boom', timedOut: false });

    const hangingPath = path.join(tmpDir, 'hanging-hook.cjs');
    await writeFile(hangingPath, 'setInterval(() => {}, 1000);\n');
    const shortRunner = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 30 });
    const timedOut = await shortRunner.runForTest({
      hookName: 'hanging-hook',
      builtPath: hangingPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.timedOut).toBe(true);
  });

  it('records lifecycle and manual/scheduled sources through one execution ledger seam', async () => {
    const starts: Parameters<HookRunRecorder['start']>[0][] = [];
    const finishes: Array<{ id: string; ok: boolean }> = [];
    const recorder: HookRunRecorder = {
      start: async (input) => {
        starts.push(input);
      },
      finish: async (id, result) => {
        finishes.push({ id, ok: result.ok });
      },
    };
    const recordedRunner = new HookRunner({
      serverUrl: 'http://127.0.0.1:4001',
      timeoutMs: 5000,
      recorder,
    });
    const builtPath = path.join(tmpDir, 'recorded-hook.cjs');
    await writeFile(builtPath, "process.stdout.write('recorded');\n");

    await recordedRunner.run({
      hookName: 'event-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'doc:save',
      event: {},
      context: { threadId: 'thread-1' },
    });
    await recordedRunner.runForTest({
      hookName: 'scheduled-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'schedule:fire',
      event: {},
      source: 'schedule',
    });

    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      hookName: 'event-hook',
      source: 'event',
      eventName: 'doc:save',
      threadId: 'thread-1',
    });
    expect(starts[1]).toMatchObject({
      hookName: 'scheduled-hook',
      source: 'schedule',
      eventName: 'schedule:fire',
    });
    expect(finishes).toEqual([
      { id: starts[0]?.id, ok: true },
      { id: starts[1]?.id, ok: true },
    ]);
  });
});

describe('HookRunner — chain limits', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `snaglet-test-hook-limits-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function recordingRunner(opts: { concurrency?: number; timeoutMs?: number }) {
    const starts: Parameters<HookRunRecorder['start']>[0][] = [];
    const finishes: Array<{ id: string; result: Parameters<HookRunRecorder['finish']>[1] }> = [];
    const runner = new HookRunner({
      serverUrl: 'http://127.0.0.1:4001',
      timeoutMs: opts.timeoutMs ?? 5000,
      concurrency: opts.concurrency,
      recorder: {
        start: async (input) => {
          starts.push(input);
        },
        finish: async (id, result) => {
          finishes.push({ id, result });
        },
      },
      limits: () => Promise.resolve({ maxRunsPerMinute: 600 }),
    });
    return { runner, starts, finishes };
  }

  it('a deep event run (no depth limit) spawns and records its depth; only a nested self-run is refused', async () => {
    const { hooks } = await import('@server/services/HookService');
    const finished: unknown[] = [];
    const onFinished = (payload: unknown): void => void finished.push(payload);
    hooks.on('hook:finished', onFinished);
    const { runner, starts, finishes } = recordingRunner({});
    const marker = path.join(tmpDir, 'spawned.txt');
    const builtPath = path.join(tmpDir, 'marker-hook.cjs');
    await writeFile(builtPath, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    try {
      // A deep event run that also repeats in its chain still runs.
      await runner.run({
        hookName: 'test-hook-a',
        builtPath,
        hookDir: tmpDir,
        eventName: 'doc:edit',
        event: {},
        context: {
          chainDepth: 40,
          hookChain: ['test-hook-a', 'test-hook-b'],
          threadId: 'thread-1',
        },
      });
      // A hook running itself via snaglet.hooks.run while running is refused.
      const manual = await runner.runForTest({
        hookName: 'test-hook-a',
        builtPath,
        hookDir: tmpDir,
        eventName: 'schedule:fire',
        event: {},
        context: { chainDepth: 1, hookChain: ['test-hook-a'] },
      });
      await runner.settle();

      // The deep event run actually spawned.
      await expect(stat(marker)).resolves.toBeDefined();
      expect(starts[0]).toEqual(
        expect.objectContaining({
          hookName: 'test-hook-a',
          source: 'event',
          eventName: 'doc:edit',
          threadId: 'thread-1',
          chainDepth: 41,
        })
      );
      // The nested self-run's reason comes back to its caller and records a failed row.
      expect(manual.stderr).toContain('"test-hook-a" can\'t run itself');
      expect(
        finishes.some(
          ({ result }) => result.ok === false && result.stderr.includes("can't run itself")
        )
      ).toBe(true);
    } finally {
      hooks.off('hook:finished', onFinished);
    }
  });

  it('every run records its chain depth', async () => {
    const { runner, starts } = recordingRunner({});
    const builtPath = path.join(tmpDir, 'ok-hook.cjs');
    await writeFile(builtPath, 'process.exit(0);\n');
    await runner.run({
      hookName: 'test-hook-a',
      builtPath,
      hookDir: tmpDir,
      eventName: 'doc:edit',
      event: {},
      context: { chainDepth: 1, hookChain: ['test-hook-b'] },
    });
    await runner.runForTest({
      hookName: 'test-hook-a',
      builtPath,
      hookDir: tmpDir,
      eventName: 'schedule:fire',
      event: {},
      source: 'schedule',
    });
    expect(starts.map((start) => start.chainDepth)).toEqual([2, 1]);
  });

  it('a nested run never waits for a slot: it takes a nested slot, else a free one, else it is refused', async () => {
    const { runner, finishes } = recordingRunner({ concurrency: 1, timeoutMs: 1500 });
    const hanging = path.join(tmpDir, 'hanging-hook.cjs');
    await writeFile(hanging, 'setInterval(() => {}, 1000);\n');
    const hang = (hookName: string, hookChain: string[]) =>
      runner.runForTest({
        hookName,
        builtPath: hanging,
        hookDir: tmpDir,
        eventName: 'schedule:fire',
        event: {},
        context: { chainDepth: hookChain.length, hookChain },
      });
    // The shared slot (a person's run), then the one nested slot.
    const holder = hang('test-hook-a', []);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const nested = hang('test-hook-b', ['test-hook-a']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const third = await hang('test-hook-c', ['test-hook-a', 'test-hook-b']);
    // Refused at once, not after the others' timeouts.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(third).toMatchObject({ ok: false, exitCode: null, durationMs: 0, timedOut: false });
    expect(third.stderr).toBe(
      'Stopped by the nested-run slot limit: all 1 nested-run slots and all 1 hook slots are in ' +
        'use, and a nested run never waits for one (it would deadlock the hooks waiting on it). ' +
        'Chain: test-hook-a → test-hook-b → test-hook-c.'
    );
    await expect(holder).resolves.toMatchObject({ timedOut: true });
    await expect(nested).resolves.toMatchObject({ timedOut: true });
    expect(finishes).toHaveLength(3);
  });
});
