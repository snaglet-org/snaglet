/**
 * Hook chain depth.
 *
 * Pins how depth moves: a person's action is 0; nested run-context bindings
 * keep the enclosing depth across `await`s and tool dispatch; a hook run is its
 * cause's depth + 1, and that depth reaches the child only through explicit
 * channels (signed into the dispatch token and as SNAGLET_CHAIN_DEPTH), never by
 * inheriting the server env; `hook:finished` fires for successful runs only,
 * at the run's own depth; the bus remembers recent catalog events (redacted)
 * with the depth they were emitted at.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import path from 'path';
import os from 'os';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import {
  currentChainDepth,
  currentHookChain,
  currentHookOrigin,
  extendHookChain,
  normalizeChainDepth,
  runAtChainDepth,
  runWithRunContext,
} from '@server/realtime/runContext';
import { mintChildDispatchToken, verifyChildDispatchToken } from '@server/middleware/panelAuth';
import { HookRunner, runChainDepth } from '@server/services/customHooks/hookRunner';
import { hooks, RECENT_EVENTS_PER_NAME, type HookEventMap } from '@server/services/HookService';
import { buildToolEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import { HOOKS_V2_EVENT_NAMES } from '@server/services/hooks/events';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('run context chain depth', () => {
  it('is 0 (a person) when nothing bound a depth', () => {
    expect(currentChainDepth()).toBe(0);
    expect(runWithRunContext({ threadId: 't', runId: 'r' }, () => currentChainDepth())).toBe(0);
  });

  it('survives await boundaries inside a bound run', async () => {
    const seen = await runAtChainDepth(2, async () => {
      await tick();
      const afterOne = currentChainDepth();
      await Promise.resolve();
      return [afterOne, currentChainDepth()];
    });
    expect(seen).toEqual([2, 2]);
    expect(currentChainDepth()).toBe(0);
  });

  it('a nested tool-dispatch binding without a depth keeps the enclosing depth', async () => {
    const depth = await runAtChainDepth(3, () =>
      // toolDispatch.ts binds { threadId, runId } around every tool call.
      runWithRunContext({ threadId: 'thread-1', runId: 'run-1' }, async () => {
        await tick();
        return currentChainDepth();
      })
    );
    expect(depth).toBe(3);
  });

  it('an explicit depth on a nested binding wins', () => {
    expect(runAtChainDepth(3, () => runWithRunContext({ chainDepth: 1 }, currentChainDepth))).toBe(
      1
    );
  });

  it('normalizes junk to 0', () => {
    for (const junk of [-1, 1.5, Number.NaN, '2', null, undefined]) {
      expect(normalizeChainDepth(junk)).toBe(0);
    }
    expect(normalizeChainDepth(4)).toBe(4);
  });

  it("a hook's tool call binds the hook as origin across awaits; a woken run does not inherit it", async () => {
    const origin = { kind: 'hook' as const, hookName: 'test-hook' };
    expect(currentHookOrigin()).toBeUndefined();
    const seen = await runAtChainDepth(
      1,
      async () => {
        await tick();
        return [
          currentHookOrigin(),
          currentChainDepth(),
          runWithRunContext({ threadId: 't', runId: 'r' }, currentHookOrigin),
        ];
      },
      origin
    );
    expect(seen).toEqual([origin, 1, undefined]);
    expect(runAtChainDepth(2, currentHookOrigin)).toBeUndefined();
    expect(currentHookOrigin()).toBeUndefined();
  });

  it('the hook chain is bound like the depth: kept across awaits and nested tool dispatch', async () => {
    expect(currentHookChain()).toEqual([]);
    const seen = await runAtChainDepth(
      2,
      () =>
        runWithRunContext({ threadId: 'thread-1', runId: 'run-1' }, async () => {
          await tick();
          return currentHookChain();
        }),
      undefined,
      ['test-hook-a', 'test-hook-b']
    );
    expect(seen).toEqual(['test-hook-a', 'test-hook-b']);
    // A binding that names no chain keeps the enclosing one; an explicit one wins.
    expect(
      runAtChainDepth(1, () => runAtChainDepth(2, currentHookChain), undefined, ['a'])
    ).toEqual(['a']);
    expect(
      runAtChainDepth(1, () => runAtChainDepth(0, currentHookChain, undefined, []), undefined, [
        'a',
      ])
    ).toEqual([]);
    expect(currentHookChain()).toEqual([]);
  });

  it('a chain entry is the hook name cut to 128 characters, and a chain holds at most 32', () => {
    const long = 'h'.repeat(200);
    expect(extendHookChain(['a'], long)).toEqual(['a', 'h'.repeat(128)]);
    const full = Array.from({ length: 32 }, (_, i) => `hook-${i}`);
    expect(extendHookChain(full, 'next')).toEqual([...full.slice(1), 'next']);
  });

  it('a hook run is its cause + 1, from the context or else the ambient depth', () => {
    expect(runChainDepth({})).toBe(1);
    expect(runChainDepth({ chainDepth: 2 })).toBe(3);
    expect(runAtChainDepth(4, () => runChainDepth(undefined))).toBe(5);
    expect(runAtChainDepth(4, () => runChainDepth({ chainDepth: 0 }))).toBe(1);
  });
});

describe('child-dispatch token carries a signed depth', () => {
  it('round-trips depth with and without a hook name', () => {
    expect(verifyChildDispatchToken(mintChildDispatchToken('agent-a', 'h', 2))).toEqual({
      agentId: 'agent-a',
      hookName: 'h',
      chainDepth: 2,
    });
    expect(verifyChildDispatchToken(mintChildDispatchToken('agent-a', undefined, 3))).toEqual({
      agentId: 'agent-a',
      chainDepth: 3,
    });
  });

  it('depth 0 keeps the original token shapes byte-for-byte', () => {
    expect(mintChildDispatchToken('agent-a', 'h', 0)).toBe(mintChildDispatchToken('agent-a', 'h'));
    expect(mintChildDispatchToken('agent-a', undefined, 0)).toBe(mintChildDispatchToken('agent-a'));
    expect(verifyChildDispatchToken(mintChildDispatchToken('agent-a'))).toEqual({
      agentId: 'agent-a',
    });
  });

  it('a child cannot lower its depth by editing the payload', () => {
    const token = mintChildDispatchToken('agent-a', 'h', 3);
    const [payload, mac] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...decoded, chainDepth: 1 }), 'utf8').toString(
      'base64url'
    );
    expect(verifyChildDispatchToken(`${forged}.${mac}`)).toBeNull();
  });

  it('SNAGLET_CHAIN_DEPTH passes the tool-env allow-list; the depth is never inherited', () => {
    const previous = process.env.SNAGLET_CHAIN_DEPTH;
    process.env.SNAGLET_CHAIN_DEPTH = '9';
    try {
      expect(buildToolEnv({}).SNAGLET_CHAIN_DEPTH).toBeUndefined();
      expect(buildToolEnv({ SNAGLET_CHAIN_DEPTH: '2' }).SNAGLET_CHAIN_DEPTH).toBe('2');
    } finally {
      if (previous === undefined) delete process.env.SNAGLET_CHAIN_DEPTH;
      else process.env.SNAGLET_CHAIN_DEPTH = previous;
    }
  });
});

describe('hook runner depth and hook:finished', () => {
  let tmpDir: string;
  let runner: HookRunner;
  const finished: Array<{ payload: HookEventMap['hook:finished']; ambient: number }> = [];
  const onFinished = (payload: HookEventMap['hook:finished']): void => {
    finished.push({ payload, ambient: currentChainDepth() });
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `snaglet-test-chain-depth-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
    runner = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 5000 });
    finished.length = 0;
    hooks.on('hook:finished', onFinished);
  });

  afterEach(async () => {
    hooks.off('hook:finished', onFinished);
    await runner.settle();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeEnvProbe(outFile: string): Promise<string> {
    const builtPath = path.join(tmpDir, 'probe.cjs');
    await writeFile(
      builtPath,
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
        '  depth: process.env.SNAGLET_CHAIN_DEPTH ?? null,',
        '  token: process.env.SNAGLET_CHILD_DISPATCH_TOKEN ?? null,',
        '  context: process.env.SNAGLET_TOOL_CONTEXT_JSON ?? null,',
        '}));',
      ].join('\n')
    );
    return builtPath;
  }

  it('an event at depth 2 runs its hook at depth 3, passed explicitly to the child', async () => {
    const outFile = path.join(tmpDir, 'out.json');
    const builtPath = await writeEnvProbe(outFile);
    await runner.run({
      hookName: 'deep-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'doc:edit',
      event: {},
      context: { agentId: 'agent-a', chainDepth: 2 },
    });
    await runner.settle();
    const probe = JSON.parse(await readFile(outFile, 'utf8')) as {
      depth: string;
      token: string;
      context: string;
    };
    expect(probe.depth).toBe('3');
    expect(verifyChildDispatchToken(probe.token)).toEqual({
      agentId: 'agent-a',
      hookName: 'deep-hook',
      chainDepth: 3,
      hookChain: ['deep-hook'],
    });
    // Depth is server bookkeeping, not part of the SDK's tool context.
    expect(JSON.parse(probe.context)).toEqual({ agentId: 'agent-a' });
    expect(finished).toHaveLength(1);
    expect(finished[0]!.payload).toMatchObject({
      hookName: 'deep-hook',
      eventName: 'doc:edit',
      chainDepth: 3,
    });
    expect(finished[0]!.ambient).toBe(3);
  });

  it('a person-started test run is depth 1', async () => {
    const outFile = path.join(tmpDir, 'out-test.json');
    const builtPath = await writeEnvProbe(outFile);
    const result = await runner.runForTest({
      hookName: 'manual-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'schedule:fire',
      event: {},
    });
    expect(result.ok).toBe(true);
    const probe = JSON.parse(await readFile(outFile, 'utf8')) as { depth: string };
    expect(probe.depth).toBe('1');
    expect(finished.map((f) => f.payload.chainDepth)).toEqual([1]);
  });

  it('failed and timed-out runs emit no hook:finished (success only, D3)', async () => {
    const failing = path.join(tmpDir, 'fail.cjs');
    await writeFile(failing, 'process.exit(2);\n');
    const hanging = path.join(tmpDir, 'hang.cjs');
    await writeFile(hanging, 'setInterval(() => {}, 1000);\n');
    const quick = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 300 });
    const failed = await quick.runForTest({
      hookName: 'fails',
      builtPath: failing,
      hookDir: tmpDir,
      eventName: 'schedule:fire',
      event: {},
    });
    const timedOut = await quick.runForTest({
      hookName: 'hangs',
      builtPath: hanging,
      hookDir: tmpDir,
      eventName: 'schedule:fire',
      event: {},
    });
    await runner.run({
      hookName: 'fails-on-event',
      builtPath: failing,
      hookDir: tmpDir,
      eventName: 'doc:edit',
      event: {},
      context: {},
    });
    await runner.settle();
    await quick.settle();
    expect(failed.ok).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(finished).toEqual([]);
  });
});

describe('recent-event ring', () => {
  it('remembers catalog events newest first with their emit depth, redacted and capped', () => {
    for (let i = 0; i < RECENT_EVENTS_PER_NAME + 5; i += 1) {
      runAtChainDepth(i % 3, () =>
        hooks.emit('doc:rename', {
          id: `doc-${i}`,
          oldTitle: 'old',
          newTitle: `key sk-ant-api03-${'a'.repeat(40)} #${i}`,
        })
      );
    }
    const recent = hooks.recent('doc:rename');
    expect(recent).toHaveLength(RECENT_EVENTS_PER_NAME);
    const newest = RECENT_EVENTS_PER_NAME + 4;
    expect((recent[0]!.payload as { id: string }).id).toBe(`doc-${newest}`);
    expect(recent[0]!.chainDepth).toBe(newest % 3);
    expect(JSON.stringify(recent)).not.toContain('a'.repeat(40));
    expect(hooks.recent('doc:rename', 2)).toHaveLength(2);
  });

  it('keeps nothing for events outside the Hooks v2 catalog', () => {
    expect(HOOKS_V2_EVENT_NAMES).not.toContain('credential:delete');
    hooks.emit('credential:delete', { id: 'cred-1' });
    expect(hooks.recent('credential:delete')).toEqual([]);
  });

  it('the catalog is the authored list plus the two Hooks v2 events', () => {
    expect(HOOKS_V2_EVENT_NAMES.slice(-2)).toEqual(['hook:finished', 'hook:signal']);
  });
});
