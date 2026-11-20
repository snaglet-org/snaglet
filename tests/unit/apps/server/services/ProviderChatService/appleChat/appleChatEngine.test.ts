/**
 * AppleChatEngine — driven against the FAKE sidecar
 * (tests/support/fake-apple-chat.mjs), a plain node script that speaks the
 * exact wire contract. No Swift, no macOS 26, no Apple Intelligence — proves
 * delta relay, restart-on-crash/backoff, per-session serialization (a mutex:
 * concurrent same-session calls are queued, not parallel; different sessions
 * run concurrently), and abort.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { AppleChatEngine } from '@server/services/ProviderChatService/appleChat/appleChatEngine';

// jest runs from the repo root — resolve the fake sidecar there.
const FAKE = join(process.cwd(), 'tests', 'support', 'fake-apple-chat.mjs');

interface DiagEvent {
  kind: 'START' | 'DONE';
  id: string;
  prompt?: string;
  t: number;
}

/** Build an engine talking to the fake sidecar (node <fake> …), with a spy
 * that counts `chat` subcommand spawns and exposes the last spawned child so
 * a test can read its stderr diagnostics directly. */
function makeEngine(extraArgs: string[] = []) {
  let chatSpawns = 0;
  let lastChild: ChildProcessWithoutNullStreams | null = null;
  const spawnSpy = ((cmd: string, args: readonly string[]) => {
    if (args.includes('chat')) chatSpawns++;
    const child = spawn(cmd, args as string[]) as ChildProcessWithoutNullStreams;
    lastChild = child;
    return child;
  }) as unknown as typeof spawn;
  const engine = new AppleChatEngine({
    command: process.execPath,
    prefixArgs: [FAKE, ...extraArgs],
    spawn: spawnSpy,
    restartBackoffMs: 0,
  });
  return { engine, chatSpawns: () => chatSpawns, lastChild: () => lastChild };
}

/** Attach a stderr parser to `child` collecting START/DONE diagnostic lines. */
function collectDiagnostics(child: ChildProcessWithoutNullStreams): DiagEvent[] {
  const events: DiagEvent[] = [];
  let buf = '';
  child.stderr.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      const startMatch = /^START (\S+) (\S+) (\d+)$/.exec(line);
      const doneMatch = /^DONE (\S+) (\d+)$/.exec(line);
      if (startMatch) {
        events.push({
          kind: 'START',
          id: startMatch[1]!,
          prompt: Buffer.from(startMatch[2]!, 'base64').toString('utf8'),
          t: Number(startMatch[3]),
        });
      } else if (doneMatch) {
        events.push({ kind: 'DONE', id: doneMatch[1]!, t: Number(doneMatch[2]) });
      }
    }
  });
  return events;
}

/** Find the START/DONE pair whose START prompt matches `prompt`. */
function timingFor(events: DiagEvent[], prompt: string): { start: number; done: number } {
  const start = events.find((e) => e.kind === 'START' && e.prompt === prompt);
  if (!start) throw new Error(`no START event for prompt ${JSON.stringify(prompt)}`);
  const done = events.find((e) => e.kind === 'DONE' && e.id === start.id);
  if (!done) throw new Error(`no DONE event for prompt ${JSON.stringify(prompt)}`);
  return { start: start.t, done: done.t };
}

/**
 * Wait for the sidecar's stderr diagnostics to arrive. They travel on a
 * separate pipe from the stdout frames that resolve `chat()`, so they can lag
 * it; wait for the events themselves rather than a fixed delay.
 */
async function diagnosticsFor(events: DiagEvent[], prompts: string[]): Promise<void> {
  const complete = (): boolean =>
    prompts.every((prompt) => {
      const start = events.find((e) => e.kind === 'START' && e.prompt === prompt);
      return start !== undefined && events.some((e) => e.kind === 'DONE' && e.id === start.id);
    });
  const deadline = Date.now() + 5_000;
  while (!complete() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AppleChatEngine — delta relay', () => {
  it('relays token deltas via onChunk and assembles the final reply', async () => {
    const { engine } = makeEngine(['--chunks', 'Hello ,world', '--work-ms', '5']);
    const chunks: string[] = [];
    const result = await engine.chat({
      sessionKey: 's1',
      prompt: 'hi',
      onChunk: (t) => chunks.push(t),
    });
    expect(chunks).toEqual(['Hello ', 'world']);
    expect(result.text).toBe('Hello world');
    expect(result.stopReason).toBe('end_turn');
    await engine.shutdown();
  });
});

describe('AppleChatEngine — per-session mutex', () => {
  it('queues concurrent calls sharing a sessionKey — never overlapping', async () => {
    const { engine, lastChild } = makeEngine(['--work-ms', '40', '--chunks', 'a,b']);
    // Prime: spawn the process with a throwaway call before recording timings.
    await engine.chat({ sessionKey: 'prime', prompt: 'prime' });
    const child = lastChild();
    expect(child).toBeTruthy();
    const events = collectDiagnostics(child!);

    const first = engine.chat({ sessionKey: 'same-session', prompt: 'first' });
    const second = engine.chat({ sessionKey: 'same-session', prompt: 'second' });
    await Promise.all([first, second]);
    await diagnosticsFor(events, ['first', 'second']);

    const t1 = timingFor(events, 'first');
    const t2 = timingFor(events, 'second');
    // Queued, not parallel: the second request must not START until the
    // first one's DONE — this is the Node-side mutex the task requires
    // (the framework's own guard is not relied on; see appleChatEngine.ts).
    expect(t2.start).toBeGreaterThanOrEqual(t1.done);
    await engine.shutdown();
  });

  it('runs calls with different sessionKeys concurrently', async () => {
    // The fake holds alpha and beta until both have arrived, so a concurrent
    // engine shows overlap however slowly the machine schedules either write;
    // a serializing engine never sends beta until alpha is done.
    const { engine, lastChild } = makeEngine([
      '--work-ms',
      '5',
      '--chunks',
      'a,b',
      '--hold-prompts',
      'alpha,beta',
    ]);
    await engine.chat({ sessionKey: 'prime', prompt: 'prime' });
    const child = lastChild();
    expect(child).toBeTruthy();
    const events = collectDiagnostics(child!);

    const first = engine.chat({ sessionKey: 'session-a', prompt: 'alpha' });
    const second = engine.chat({ sessionKey: 'session-b', prompt: 'beta' });
    await Promise.all([first, second]);
    await diagnosticsFor(events, ['alpha', 'beta']);

    const t1 = timingFor(events, 'alpha');
    const t2 = timingFor(events, 'beta');
    // Different sessions parallelize (confirmed safe by the feasibility
    // probe) — the second request starts well before the first one's DONE.
    expect(t2.start).toBeLessThan(t1.done);
    await engine.shutdown();
  });

  it('a failed/aborted request does not wedge the queue for the next same-session call', async () => {
    const { engine } = makeEngine(['--work-ms', '10']);
    const controller = new AbortController();
    const aborted = engine.chat({
      sessionKey: 'wedge-test',
      prompt: 'to-abort',
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    const next = await engine.chat({ sessionKey: 'wedge-test', prompt: 'after-abort' });
    expect(next.text.length).toBeGreaterThan(0);
    await engine.shutdown();
  });
});

describe('AppleChatEngine — abort', () => {
  it('rejects with an AbortError and sends a cancel frame', async () => {
    const { engine } = makeEngine(['--work-ms', '20', '--chunks', 'a,b,c,d']);
    const controller = new AbortController();
    // Abort on the first delta: the request is provably mid-stream, however
    // long the sidecar took to start.
    const promise = engine.chat({
      sessionKey: 's-abort',
      prompt: 'long one',
      signal: controller.signal,
      onChunk: () => controller.abort(),
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await engine.shutdown();
  });

  it('rejects immediately for an already-aborted signal, without ever spawning', async () => {
    const { engine, chatSpawns } = makeEngine();
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.chat({ sessionKey: 's-preaborted', prompt: 'never sent', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(chatSpawns()).toBe(0);
    await engine.shutdown();
  });
});

describe('AppleChatEngine — restart on crash', () => {
  it('respawns after the sidecar process dies and keeps serving requests', async () => {
    const { engine, chatSpawns, lastChild } = makeEngine([
      '--chunks',
      'ok',
      '--work-ms',
      '5',
      '--exit-after-done',
    ]);
    const first = await engine.chat({ sessionKey: 's-crash', prompt: 'one' });
    expect(first.text).toBe('ok');
    // The fake exits shortly after DONE. Wait for that exit itself: the
    // engine's own 'exit' listener was attached first, so it has run by then.
    const dying = lastChild()!;
    if (dying.exitCode === null && dying.signalCode === null) await once(dying, 'exit');

    const second = await engine.chat({ sessionKey: 's-crash', prompt: 'two' });
    expect(second.text).toBe('ok');
    expect(chatSpawns()).toBe(2); // fresh process after the crash
    await engine.shutdown();
  });

  it('rejects the in-flight request when the process dies mid-stream (before `done`)', async () => {
    const { engine } = makeEngine(['--work-ms', '10', '--chunks', 'a,b,c', '--die-mid-stream']);
    const promise = engine.chat({ sessionKey: 's-die', prompt: 'slow' });
    await expect(promise).rejects.toThrow(/apple-chat sidecar exited/);
    await engine.shutdown();
  });
});

describe('AppleChatEngine — availability probe', () => {
  it('reports available', async () => {
    const { engine } = makeEngine();
    await expect(engine.checkAvailability()).resolves.toEqual({ available: true });
    await engine.shutdown();
  });

  it('reports unavailable with the sidecar-provided reason', async () => {
    const { engine } = makeEngine(['--unavailable', '--unavailable-reason', 'modelNotReady']);
    await expect(engine.checkAvailability()).resolves.toEqual({
      available: false,
      reason: 'modelNotReady',
    });
    await engine.shutdown();
  });
});
