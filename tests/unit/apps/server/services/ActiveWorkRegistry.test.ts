/**
 * ActiveWorkRegistry — the in-memory "who is working on what" set behind the
 * status bar's active-agents indicator. Pins register/unregister pairing
 * through ActiveRunTracker.start()/finish() (every run end path, including
 * the error path and the teardown flush's double finish), the finishSession
 * purge of entries orphaned by reaped runs, HookRunner's spawn try/finally,
 * and the snapshot shape, newest-first order and broadcasts.
 */

const emitAgentWorkStarted = jest.fn();
const emitAgentWorkFinished = jest.fn();
jest.mock('@server/realtime/surfaces/agentWork', () => ({
  emitAgentWorkStarted: (...a: unknown[]) => emitAgentWorkStarted(...a),
  emitAgentWorkFinished: (...a: unknown[]) => emitAgentWorkFinished(...a),
}));

import path from 'path';
import os from 'os';
import { mkdir, rm, writeFile } from 'fs/promises';
import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';
import { activeWorkRegistry } from '@server/services/ActiveWorkRegistry';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { HookRunner } from '@server/services/customHooks/hookRunner';

const runMeta = (threadId: string) => ({
  agentId: 'agent-1',
  agentName: 'Clio',
  threadId,
  threadTitle: 'Release planning',
});

beforeEach(() => {
  activeWorkRegistry.clear();
  emitAgentWorkStarted.mockClear();
  emitAgentWorkFinished.mockClear();
});

describe('ActiveWorkRegistry — registration + snapshot shape', () => {
  it('registers a thread run with the full item shape and broadcasts it', () => {
    activeWorkRegistry.registerThreadRun({ id: 'run-1', ...runMeta('thread-1') });

    expect(activeWorkRegistry.size).toBe(1);
    const [item] = activeWorkRegistry.snapshot();
    expect(item).toEqual({
      id: 'run-1',
      kind: 'thread-run',
      agentId: 'agent-1',
      agentName: 'Clio',
      threadId: 'thread-1',
      threadTitle: 'Release planning',
      startedAt: expect.any(String),
    });
    // startedAt is a real ISO timestamp, not garbage.
    expect(Number.isNaN(Date.parse(item!.startedAt))).toBe(false);
    expect(emitAgentWorkStarted).toHaveBeenCalledTimes(1);
    expect(emitAgentWorkStarted).toHaveBeenCalledWith(item);
  });

  it('registers hook runs; agentless hooks omit the agent/thread keys', () => {
    activeWorkRegistry.registerHookRun({ id: 'hook-a', hookName: 'on-doc-saved' });
    activeWorkRegistry.registerHookRun({
      id: 'hook-b',
      hookName: 'on-message',
      agentId: 'agent-2',
      threadId: 'thread-9',
    });

    const items = activeWorkRegistry.snapshot();
    const agentless = items.find((i) => i.id === 'hook-a')!;
    const bound = items.find((i) => i.id === 'hook-b')!;
    expect(agentless).toEqual({
      id: 'hook-a',
      kind: 'hook-run',
      hookName: 'on-doc-saved',
      startedAt: expect.any(String),
    });
    expect(agentless).not.toHaveProperty('agentId');
    expect(bound.agentId).toBe('agent-2');
    expect(bound.threadId).toBe('thread-9');
  });

  it('orders the snapshot newest first', () => {
    jest.useFakeTimers({ now: new Date('2026-07-29T10:00:00.000Z') });
    try {
      activeWorkRegistry.registerThreadRun({ id: 'run-old', ...runMeta('thread-1') });
      jest.setSystemTime(new Date('2026-07-29T10:00:05.000Z'));
      activeWorkRegistry.registerHookRun({ id: 'hook-newer', hookName: 'h' });
      jest.setSystemTime(new Date('2026-07-29T10:00:09.000Z'));
      activeWorkRegistry.registerThreadRun({ id: 'run-newest', ...runMeta('thread-2') });

      expect(activeWorkRegistry.snapshot().map((i) => i.id)).toEqual([
        'run-newest',
        'hook-newer',
        'run-old',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('snapshot returns copies — callers cannot mutate registry state', () => {
    activeWorkRegistry.registerThreadRun({ id: 'run-1', ...runMeta('thread-1') });
    const [copy] = activeWorkRegistry.snapshot();
    (copy as ActiveWorkItem).agentName = 'tampered';
    expect(activeWorkRegistry.snapshot()[0]!.agentName).toBe('Clio');
  });

  it('unregister is idempotent and broadcasts the removal exactly once', () => {
    activeWorkRegistry.registerThreadRun({ id: 'run-1', ...runMeta('thread-1') });
    activeWorkRegistry.unregister('run-1');
    activeWorkRegistry.unregister('run-1'); // teardown flush double-finish
    activeWorkRegistry.unregister('never-existed');

    expect(activeWorkRegistry.size).toBe(0);
    expect(emitAgentWorkFinished).toHaveBeenCalledTimes(1);
    expect(emitAgentWorkFinished).toHaveBeenCalledWith('run-1');
  });
});

describe('ActiveWorkRegistry — ActiveRunTracker seam', () => {
  it('start(runId, work) registers; finish(runId) removes (completion path)', () => {
    activeRunTracker.start('run-seam-1', runMeta('thread-seam-1'));
    expect(activeWorkRegistry.snapshot().map((i) => i.id)).toEqual(['run-seam-1']);

    activeRunTracker.finish('run-seam-1');
    expect(activeWorkRegistry.size).toBe(0);
  });

  it('start without work metadata registers nothing (callers without metadata stay inert)', () => {
    activeRunTracker.start('run-seam-2');
    expect(activeWorkRegistry.size).toBe(0);
    activeRunTracker.finish('run-seam-2');
    expect(emitAgentWorkFinished).not.toHaveBeenCalled();
  });

  it('error path: a finish() in the finally clears the entry even when the turn throws', async () => {
    const failingTurn = async (): Promise<void> => {
      activeRunTracker.start('run-err', runMeta('thread-err'));
      try {
        throw new Error('provider stream died');
      } finally {
        // Mirrors turnLoop's error/abort handling + the dispatch teardown
        // flush — every end path funnels through finish().
        activeRunTracker.finish('run-err');
      }
    };

    await expect(failingTurn()).rejects.toThrow('provider stream died');
    expect(activeWorkRegistry.size).toBe(0);
    expect(emitAgentWorkFinished).toHaveBeenCalledWith('run-err');
  });

  it('double finish (teardown flush after a normal finish) broadcasts once', () => {
    activeRunTracker.start('run-dbl', runMeta('thread-dbl'));
    activeRunTracker.finish('run-dbl');
    activeRunTracker.finish('run-dbl');
    expect(emitAgentWorkFinished).toHaveBeenCalledTimes(1);
  });

  it('finishSession purges thread-run entries orphaned by an abnormal unwind', () => {
    expect(activeRunTracker.startSession('session-orphan', 'thread-orphan')).toBe(true);
    // A zombie run that never reached its own teardown (reaper force-release).
    activeRunTracker.start('run-orphan', runMeta('thread-orphan'));
    // A hook run on the same thread must survive — its lifetime is the child
    // process, not the thread lock.
    activeWorkRegistry.registerHookRun({
      id: 'hook-survivor',
      hookName: 'observer',
      threadId: 'thread-orphan',
    });

    activeRunTracker.finishSession('session-orphan');

    expect(activeWorkRegistry.snapshot().map((i) => i.id)).toEqual(['hook-survivor']);
    expect(emitAgentWorkFinished).toHaveBeenCalledWith('run-orphan');
    activeWorkRegistry.clear();
  });
});

describe('ActiveWorkRegistry — HookRunner spawn try/finally', () => {
  let tmpDir: string;
  let runner: HookRunner;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `snaglet-test-active-work-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    runner = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 5000 });
  });

  afterEach(async () => {
    await runner.settle();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('registers while the child runs and unregisters after it exits', async () => {
    const builtPath = path.join(tmpDir, 'hook.cjs');
    await writeFile(builtPath, 'setTimeout(() => process.exit(0), 300);');

    const done = runner.run({
      hookName: 'slow-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: { agentId: 'agent-7', threadId: 'thread-7' },
    });

    // Becomes visible once the child holds an execution slot.
    const deadline = Date.now() + 2000;
    while (activeWorkRegistry.size === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const [item] = activeWorkRegistry.snapshot();
    expect(item).toMatchObject({
      kind: 'hook-run',
      hookName: 'slow-hook',
      agentId: 'agent-7',
      threadId: 'thread-7',
    });

    await done;
    expect(activeWorkRegistry.size).toBe(0);
  });

  it('a hook child that exits non-zero still unregisters (finally path)', async () => {
    const builtPath = path.join(tmpDir, 'hook.cjs');
    await writeFile(builtPath, 'process.exit(3);');

    await runner.run({
      hookName: 'failing-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
      context: {},
    });

    expect(activeWorkRegistry.size).toBe(0);
    expect(emitAgentWorkStarted).toHaveBeenCalledTimes(1);
    expect(emitAgentWorkFinished).toHaveBeenCalledTimes(1);
  });

  it('a timed-out (SIGKILLed) hook still unregisters', async () => {
    const shortRunner = new HookRunner({ serverUrl: 'http://127.0.0.1:4001', timeoutMs: 200 });
    const builtPath = path.join(tmpDir, 'hook.cjs');
    await writeFile(builtPath, 'setTimeout(() => process.exit(0), 60_000);');

    await shortRunner.runForTest({
      hookName: 'wedged-hook',
      builtPath,
      hookDir: tmpDir,
      eventName: 'message:create',
      event: {},
    });

    expect(activeWorkRegistry.size).toBe(0);
    expect(emitAgentWorkFinished).toHaveBeenCalledTimes(1);
    await shortRunner.settle();
  });
});
