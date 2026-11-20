/**
 * AppleSttEngine — driven against the fake sidecar (tests/support/fake-apple-stt.mjs),
 * a plain node script that speaks the exact wire contract. No Swift, no audio,
 * no Speech framework — proves feed→onPartial→finalize, native-rate feeding,
 * one long-lived process across multiple utterances, close-re-arm, warmup, and
 * respawn after the sidecar dies.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { AppleSttEngine, AppleSttError } from '@server/services/voice/appleSttEngine';

// jest runs from the repo root — resolve the fake sidecar there.
const FAKE = join(process.cwd(), 'tests', 'support', 'fake-apple-stt.mjs');

/** Build an engine talking to the fake sidecar (node <fake> …). */
function makeEngine(extraArgs: string[] = []) {
  let streamSpawns = 0;
  const spawnSpy = ((cmd: string, args: readonly string[]) => {
    if (args.includes('stream')) streamSpawns++;
    return spawn(cmd, args as string[]);
  }) as unknown as typeof spawn;
  const engine = new AppleSttEngine({
    command: process.execPath,
    prefixArgs: [FAKE, ...extraArgs],
    spawn: spawnSpy,
    restartBackoffMs: 0,
    finalizeTimeoutMs: 2_000,
  });
  return { engine, streamSpawns: () => streamSpawns };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('AppleSttEngine — warmup', () => {
  it('resolves when the sidecar warmup subcommand reports ready', async () => {
    const { engine } = makeEngine();
    await expect(engine.warmup()).resolves.toBeUndefined();
  });

  it('rejects with a plain reason that names the fix when warmup fails', async () => {
    // An older binary: exits 1 with no error line.
    const { engine } = makeEngine(['--warmup-fail']);
    await expect(engine.warmup()).rejects.toThrow(
      "Apple's built-in speech recognition didn't start. Check System Settings → " +
        'Privacy & Security → Speech Recognition and Microphone, then try again.'
    );
  });

  it("names the sidecar's own reason (blocked speech recognition)", async () => {
    const { engine } = makeEngine(['--fail-code', 'not-authorized']);
    const err = await engine.warmup().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleSttError);
    expect((err as AppleSttError).code).toBe('not-authorized');
    expect((err as AppleSttError).message).toBe(
      'macOS is blocking speech recognition for Snaglet. Allow Snaglet in System Settings → ' +
        'Privacy & Security → Speech Recognition, then try again.'
    );
  });

  it('says what is missing when the helper binary is gone', async () => {
    const engine = new AppleSttEngine({ command: '/nonexistent/snaglet-apple-stt', spawn });
    await expect(engine.warmup()).rejects.toThrow(/speech helper is missing/);
  });
});

describe('AppleSttEngine — failures reach the session once', () => {
  it('a stream that cannot start fails the session with the reason; later feeds are dropped', async () => {
    const { engine } = makeEngine(['--fail-code', 'assets']);
    const stt = engine.createSttSession({ sampleRate: 48_000 });
    const errors: Error[] = [];
    stt.onError((err) => errors.push(err));
    stt.feed(Int16Array.from([1, 2]));
    for (let i = 0; i < 100 && errors.length === 0; i += 1) await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(
      "macOS couldn't set up its on-device speech model (fake failure). Check your " +
        'internet connection, then try again.'
    );
    stt.feed(Int16Array.from([3, 4])); // no throw, no second report
    await tick();
    expect(errors).toHaveLength(1);
    // finalize still settles (best-effort), it never hangs.
    await expect(stt.finalize()).resolves.toBe('');
    await engine.shutdown();
  });

  it('a sidecar that dies mid-utterance fails the session as "quit unexpectedly"', async () => {
    const { engine } = makeEngine(['--crash-after-frames', '2']);
    const stt = engine.createSttSession({ sampleRate: 48_000 });
    const errors: Error[] = [];
    stt.onError((err) => errors.push(err));
    stt.feed(Int16Array.from([1, 2]));
    stt.feed(Int16Array.from([3, 4]));
    for (let i = 0; i < 100 && errors.length === 0; i += 1) await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/quit unexpectedly/);
    await engine.shutdown();
  });

  it('an intentional shutdown is not reported as a failure', async () => {
    const { engine } = makeEngine();
    const stt = engine.createSttSession({ sampleRate: 48_000 });
    const errors: Error[] = [];
    stt.onError((err) => errors.push(err));
    stt.feed(Int16Array.from([1, 2]));
    await tick();
    await engine.shutdown();
    await tick();
    expect(errors).toHaveLength(0);
  });
});

describe('AppleSttEngine — streaming session', () => {
  it('does not respawn after an intentional shutdown, then re-arms on next use', async () => {
    const { engine, streamSpawns } = makeEngine(['--final', 'stopped']);
    const session = engine.createSttSession({ sampleRate: 48_000 });
    session.feed(Int16Array.from([1, 2]));
    await tick();
    await engine.shutdown();
    const afterShutdown = streamSpawns();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(streamSpawns()).toBe(afterShutdown);

    const next = engine.createSttSession({ sampleRate: 48_000 });
    next.feed(Int16Array.from([3, 4]));
    await tick();
    expect(await next.finalize()).toBe('stopped');
    expect(streamSpawns()).toBe(afterShutdown + 1);
    await engine.shutdown();
  });

  it('feeds native pcm, surfaces partials, and finalizes the cased text', async () => {
    const { engine } = makeEngine(['--final', 'hello world from apple']);
    const stt = engine.createSttSession({ sampleRate: 48_000 });
    expect(stt.wantsNativeRate).toBe(true);

    const partials: string[] = [];
    stt.onPartial((t) => partials.push(t));
    stt.feed(Int16Array.from([1, 2, 3, 4]));
    stt.feed(Int16Array.from([5, 6, 7, 8]));
    // Poll for the first partial rather than assuming a fixed delay — the fake
    // sidecar is a spawned subprocess whose startup latency varies under load.
    for (let i = 0; i < 100 && partials.length === 0; i += 1) await tick();

    expect(partials.length).toBeGreaterThanOrEqual(1);
    const text = await stt.finalize();
    expect(text).toBe('hello world from apple');
    await engine.shutdown();
  });

  it('runs multiple utterances over one long-lived process', async () => {
    const { engine, streamSpawns } = makeEngine(['--final', 'utterance text']);

    const a = engine.createSttSession({ sampleRate: 48_000 });
    a.feed(Int16Array.from([1, 2]));
    await tick();
    expect(await a.finalize()).toBe('utterance text');

    const b = engine.createSttSession({ sampleRate: 48_000 });
    b.feed(Int16Array.from([3, 4]));
    await tick();
    expect(await b.finalize()).toBe('utterance text');

    expect(streamSpawns()).toBe(1); // same process re-armed, not respawned
    await engine.shutdown();
  });

  it('close() without finalize re-arms the sidecar for the next utterance', async () => {
    const { engine, streamSpawns } = makeEngine(['--final', 'after close']);
    const a = engine.createSttSession({ sampleRate: 48_000 });
    a.feed(Int16Array.from([1, 2]));
    await tick();
    a.close(); // abort without finalize
    await tick();

    const b = engine.createSttSession({ sampleRate: 48_000 });
    b.feed(Int16Array.from([9, 9]));
    await tick();
    expect(await b.finalize()).toBe('after close');
    expect(streamSpawns()).toBe(1);
    await engine.shutdown();
  });

  it('respawns after the sidecar process dies', async () => {
    const { engine, streamSpawns } = makeEngine(['--final', 'respawned', '--exit-after-final']);
    const a = engine.createSttSession({ sampleRate: 48_000 });
    a.feed(Int16Array.from([1, 2]));
    await tick();
    expect(await a.finalize()).toBe('respawned');
    // The fake exits ~30 ms after that final — wait for the exit to register.
    await new Promise((r) => setTimeout(r, 80));

    const b = engine.createSttSession({ sampleRate: 48_000 });
    b.feed(Int16Array.from([3, 4]));
    await tick();
    expect(await b.finalize()).toBe('respawned');
    expect(streamSpawns()).toBe(2); // fresh process after the crash
    await engine.shutdown();
  });
});
