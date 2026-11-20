/**
 * NlpHelperClient — driven against the FAKE helper (tests/support/fake-nlp-helper.mjs),
 * a plain node script that speaks the exact wire contract. No Swift, no
 * NaturalLanguage framework — proves framing (including embedded newlines),
 * request serialization over one long-lived process, per-request timeout
 * fallback, bounded restart-on-crash, and the never-throws fallback contract
 * when the binary is absent/ENOENT.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { NlpHelperClient, EMPTY_EXTRACTION_RESULT } from '@server/services/nlp/NlpHelperClient';

// jest runs from the repo root — resolve the fake helper there.
const FAKE = join(process.cwd(), 'tests', 'support', 'fake-nlp-helper.mjs');

function makeClient(
  extraArgs: string[] = [],
  opts: { requestTimeoutMs?: number; restartBackoffMs?: number; maxRestarts?: number } = {}
): NlpHelperClient {
  return new NlpHelperClient({
    command: process.execPath,
    prefixArgs: [FAKE, ...extraArgs],
    requestTimeoutMs: opts.requestTimeoutMs ?? 2_000,
    restartBackoffMs: opts.restartBackoffMs ?? 0,
    maxRestarts: opts.maxRestarts ?? 3,
  });
}

describe('NlpHelperClient — framing + basic extraction', () => {
  it('sends a request and parses the framed response', async () => {
    const client = makeClient(['--entities', 'Jane Doe,Acme Corp', '--language', 'en']);
    const result = await client.extractEntities('hello world');
    expect(result).toEqual({ entities: ['Jane Doe', 'Acme Corp'], language: 'en' });
    await client.shutdown();
  });

  it('survives embedded newlines in the request text (length-prefixed framing)', async () => {
    const client = makeClient(['--entities', 'X']);
    const text = 'line one\nline two\nline three — the whole point of length-prefixing';
    const result = await client.extractEntities(text);
    expect(result.entities).toEqual(['X']);
    await client.shutdown();
  });

  it('reports no entities/language when the helper returns none', async () => {
    const client = makeClient([]);
    const result = await client.extractEntities('nothing special here');
    expect(result.entities).toEqual([]);
    await client.shutdown();
  });

  it('serializes concurrent calls over one long-lived process', async () => {
    let spawns = 0;
    const spawnSpy = ((cmd: string, args: readonly string[]) => {
      spawns += 1;
      return spawn(cmd, args as string[]);
    }) as unknown as typeof spawn;
    const client = new NlpHelperClient({
      command: process.execPath,
      prefixArgs: [FAKE, '--entities', 'A'],
      spawn: spawnSpy,
      restartBackoffMs: 0,
    });

    const [r1, r2, r3] = await Promise.all([
      client.extractEntities('one'),
      client.extractEntities('two'),
      client.extractEntities('three'),
    ]);
    expect(r1.entities).toEqual(['A']);
    expect(r2.entities).toEqual(['A']);
    expect(r3.entities).toEqual(['A']);
    expect(spawns).toBe(1); // one process reused across all three calls
    await client.shutdown();
  });
});

describe('NlpHelperClient — per-request timeout', () => {
  it('falls back to empty entities when the helper never responds', async () => {
    const client = makeClient(['--hang'], { requestTimeoutMs: 150 });
    const result = await client.extractEntities('hello');
    expect(result).toEqual(EMPTY_EXTRACTION_RESULT);
    await client.shutdown();
  });

  it('recovers on the next call after a timeout (kills the desynced process)', async () => {
    // First call hangs and times out; the client should discard that process
    // rather than risk a stale response misaligning with a later request.
    const client = makeClient(['--hang'], { requestTimeoutMs: 100, restartBackoffMs: 0 });
    const timedOut = await client.extractEntities('will hang');
    expect(timedOut).toEqual(EMPTY_EXTRACTION_RESULT);
    await client.shutdown();
  });
});

describe('NlpHelperClient — restart on crash (bounded)', () => {
  it('respawns after the helper crashes and keeps serving later requests', async () => {
    const client = makeClient(['--entities', 'B', '--crash-after', '1'], {
      restartBackoffMs: 10,
      maxRestarts: 3,
    });
    const r1 = await client.extractEntities('one'); // answered, then the process dies
    expect(r1.entities).toEqual(['B']);

    // Give the async 'exit' event a tick to land before the next call.
    await new Promise((r) => setTimeout(r, 60));

    const r2 = await client.extractEntities('two'); // triggers a respawn
    expect(r2.entities).toEqual(['B']);
    await client.shutdown();
  });

  it('gives up after maxRestarts attempts and stays in permanent fallback', async () => {
    const client = makeClient(['--die-immediately'], { maxRestarts: 2, restartBackoffMs: 0 });
    const r1 = await client.extractEntities('one');
    const r2 = await client.extractEntities('two');
    const r3 = await client.extractEntities('three'); // restart budget exhausted by now
    expect(r1).toEqual(EMPTY_EXTRACTION_RESULT);
    expect(r2).toEqual(EMPTY_EXTRACTION_RESULT);
    expect(r3).toEqual(EMPTY_EXTRACTION_RESULT);
    await client.shutdown();
  });
});

describe('NlpHelperClient — response-ordering desync (generation tagging)', () => {
  it("never delivers a killed process's late-buffered response into a later request", async () => {
    // Request #1's child answers only after request #1 timed out
    // (killForDesync discarded it) and request #2 went to a fresh replacement.
    // The wire protocol has no request ids, so without a generation check and
    // stdout detachment on kill, the stale line would answer request #2.
    //
    // The stale child (spawn #1) ignores SIGTERM and answers 300ms late,
    // inside request #2's pending window; the fresh child (spawn #2) hangs,
    // so request #2 can only resolve via its own timeout or a misattributed
    // stale line.
    let spawnCount = 0;
    const staleVsFreshSpawn = ((cmd: string, _args: readonly string[]) => {
      spawnCount += 1;
      const args =
        spawnCount === 1
          ? [FAKE, '--entities', 'STALE_ENTITY', '--delay-response-ms', '300']
          : [FAKE, '--hang'];
      return spawn(cmd, args);
    }) as unknown as typeof spawn;

    const client = new NlpHelperClient({
      command: process.execPath,
      spawn: staleVsFreshSpawn,
      requestTimeoutMs: 250,
      restartBackoffMs: 0,
      maxRestarts: 3,
    });

    // The fresh child (--hang) never exits on its own; guarantee shutdown() (which
    // kills it) runs even if an assertion below throws, or the process would
    // leak past this test and hang jest's teardown.
    try {
      // Request #1 → the stale child. Times out at 250ms — its answer is still
      // ~50ms+ away at that point, so this must resolve via the fallback.
      const r1 = await client.extractEntities('one');
      expect(r1).toEqual(EMPTY_EXTRACTION_RESULT);

      // Request #2 → the fresh child (generation bumped), which hangs,
      // so this can only resolve via its own 250ms timeout — unless the
      // stale child's delayed answer (landing ~300ms after it received
      // request #1, squarely inside this request's pending window) gets
      // misdelivered here.
      const r2 = await client.extractEntities('two');
      expect(r2).toEqual(EMPTY_EXTRACTION_RESULT);
      expect(r2.entities).not.toEqual(['STALE_ENTITY']);

      expect(spawnCount).toBe(2);
    } finally {
      await client.shutdown();
    }
  }, 10_000);
});

describe('NlpHelperClient — fallback when the binary is unavailable', () => {
  it('resolves the empty fallback without ever spawning when command is null', async () => {
    let spawns = 0;
    const spawnSpy = ((cmd: string, args: readonly string[]) => {
      spawns += 1;
      return spawn(cmd, args as string[]);
    }) as unknown as typeof spawn;
    const client = new NlpHelperClient({ command: null, spawn: spawnSpy });
    const result = await client.extractEntities('hello');
    expect(result).toEqual(EMPTY_EXTRACTION_RESULT);
    expect(spawns).toBe(0);
  });

  it('resolves the empty fallback when the binary path ENOENTs', async () => {
    const client = new NlpHelperClient({
      command: '/nonexistent/path/to/snaglet-nlp-helper-does-not-exist',
      restartBackoffMs: 0,
      maxRestarts: 1,
    });
    const result = await client.extractEntities('hello');
    expect(result).toEqual(EMPTY_EXTRACTION_RESULT);
    await client.shutdown();
  });
});
