#!/usr/bin/env node
/**
 * fake-apple-chat — a stand-in for the `snaglet-apple-chat` Swift sidecar, used by
 * the AppleChatEngine jest tests. Speaks the exact wire contract (NDJSON in,
 * NDJSON out — see native/apple-chat/chat.swift's header comment) so the
 * engine can be exercised end-to-end without Swift, macOS 26, or Apple
 * Intelligence.
 *
 * Important: emitted "token" frames here are already-diffed DELTAS (exactly
 * what the real sidecar emits after its own snapshot-diffing — see chat.swift).
 * This fake does not re-derive that math; it just
 * proves the ENGINE relays/accumulates deltas correctly, which is the layer
 * the engine unit tests exercise. The diff math itself was validated against
 * the real FoundationModels framework by the env-gated test that
 * spawns the actual compiled binary.
 *
 * Flags (anywhere in argv):
 *   --chunks "a,b,c"      delta chunks to emit in order (default "Hello ,world")
 *   --work-ms N           delay before each chunk (default 20) — deliberately
 *                         slow enough that a same-session serialization test
 *                         can observe request B waiting for request A
 *   --exit-after-done     exit(0) shortly after each `done` (simulates a
 *                         dying sidecar → exercises AppleChatEngine's
 *                         respawn path)
 *   --die-mid-stream      exit(1) right after the first chunk, before `done`
 *                         (simulates a crash mid-generation → exercises the
 *                         in-flight-request rejection path)
 *   --no-ready            never emit {"type":"ready"} (simulates a stuck start)
 *   --hold-prompts "a,b"  requests with these prompts emit nothing until all of
 *                         them have arrived (or --hold-max-ms passes, default
 *                         2000), so a concurrency test observes overlap by
 *                         construction instead of by racing a work delay
 *   --unavailable         `availability` subcommand reports unavailable
 *   --unavailable-reason  reason string for the above (default
 *                         "appleIntelligenceNotEnabled")
 *
 * Diagnostics (stderr, not part of the wire contract — read only by tests
 * that grab the child process directly):
 *   START <id> <base64(prompt)> <hrtimeMs>   the instant a request line
 *                                            arrives (prompt is base64'd so
 *                                            a test can correlate a specific
 *                                            `chat()` call — which it knows
 *                                            the prompt text of, but not the
 *                                            internally-generated request id
 *                                            — with its arrival time)
 *   DONE <id> <hrtimeMs>                     the instant its `done` frame is
 *                                            emitted
 * Lets a test assert arrival order and timing across requests without polluting
 * the actual token text.
 */

const argv = process.argv.slice(2);
const sub = argv.find((a) => ['availability', 'chat'].includes(a)) ?? 'chat';
const has = (flag) => argv.includes(flag);
const valOf = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : def;
};

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function diag(line) {
  process.stderr.write(`${line}\n`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

if (sub === 'availability') {
  if (has('--unavailable')) {
    emit({
      type: 'availability',
      available: false,
      reason: valOf('--unavailable-reason', 'appleIntelligenceNotEnabled'),
    });
  } else {
    emit({ type: 'availability', available: true });
  }
  process.exit(0);
}

// chat mode
const workMs = Number(valOf('--work-ms', '20'));
const exitAfterDone = has('--exit-after-done');
const dieMidStream = has('--die-mid-stream');
const chunks = valOf('--chunks', 'Hello ,world').split(',');
const holdPrompts = new Set(valOf('--hold-prompts', '').split(',').filter(Boolean));
const holdMaxMs = Number(valOf('--hold-max-ms', '2000'));
const arrivedHeld = new Set();
const holdWaiters = [];

function releaseHeldIfComplete() {
  if (arrivedHeld.size < holdPrompts.size) return;
  for (const release of holdWaiters.splice(0)) release();
}

function holdUntilAllArrived(prompt) {
  if (!holdPrompts.has(prompt)) return Promise.resolve();
  arrivedHeld.add(prompt);
  releaseHeldIfComplete();
  if (arrivedHeld.size >= holdPrompts.size) return Promise.resolve();
  return new Promise((resolve) => {
    holdWaiters.push(resolve);
    setTimeout(resolve, holdMaxMs);
  });
}

if (!has('--no-ready')) emit({ type: 'ready' });

const canceled = new Set();
let buf = '';

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.cancel) {
      canceled.add(req.id);
      continue;
    }
    void handleRequest(req);
  }
});

process.stdin.on('end', () => process.exit(0));

async function handleRequest(req) {
  const { id } = req;
  const promptB64 = Buffer.from(req.prompt ?? '', 'utf8').toString('base64');
  diag(`START ${id} ${promptB64} ${nowMs()}`);
  await holdUntilAllArrived(req.prompt ?? '');
  let emittedFirst = false;
  for (const text of chunks) {
    await sleep(workMs);
    if (canceled.has(id)) {
      canceled.delete(id);
      diag(`DONE ${id} ${nowMs()}`);
      emit({ type: 'done', id, stopReason: 'aborted' });
      return;
    }
    emit({ type: 'token', id, text });
    emittedFirst = true;
    if (dieMidStream && emittedFirst) {
      // Crash before `done` — the engine must reject the in-flight request
      // rather than hang forever waiting for a line that will never arrive.
      process.exit(1);
    }
  }
  diag(`DONE ${id} ${nowMs()}`);
  emit({ type: 'done', id, stopReason: 'end_turn' });
  if (exitAfterDone) setTimeout(() => process.exit(0), 30);
}
