#!/usr/bin/env node
/**
 * fake-nlp-helper — a stand-in for the `snaglet-nlp-helper` Swift daemon, used by
 * the NlpHelperClient jest tests. Speaks the exact wire contract
 * (length-prefixed binary frames in, newline-delimited JSON out) so the
 * client can be exercised end-to-end without Swift or the NaturalLanguage
 * framework.
 *
 * Flags (anywhere in argv):
 *   --entities "a,b,c"   entities to report for every request (default: none)
 *   --language <code>    language to report (default: "en")
 *   --crash-after N      exit(1) right after answering the Nth request
 *                         (simulates a dying helper → exercises
 *                         NlpHelperClient's respawn path)
 *   --hang               never respond to any request (simulates a wedged
 *                         helper → exercises the per-request timeout path)
 *   --die-immediately    exit(1) right at startup, before reading any request
 *                         (simulates a helper that fails to come up at all)
 *   --delay-response-ms N   answer, but only after N ms, AND ignore SIGTERM
 *                         while waiting — so the response is still written
 *                         even though the parent already believes this
 *                         process was killed. Reproduces the response-
 *                         ordering desync race: NlpHelperClient's
 *                         killForDesync() kills a timed-out child, but a
 *                         response it already wrote (or, here, writes late)
 *                         can still land at the parent after a replacement
 *                         child has been spawned for the next request (see
 *                         NlpHelperClient.test.ts's desync-generation test).
 */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valOf = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : def;
};

if (has('--die-immediately')) {
  process.exit(1);
}

const entities = valOf('--entities', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const language = valOf('--language', 'en');
const crashAfter = Number(valOf('--crash-after', '0')) || 0;
const hang = has('--hang');
const delayResponseMs = Number(valOf('--delay-response-ms', '0')) || 0;

if (delayResponseMs > 0) {
  // See the flag doc above — this process intentionally outlives the
  // parent's kill() so its delayed write can still happen.
  process.on('SIGTERM', () => {});
}
// If the parent has already destroyed its read end of this pipe (e.g. after
// deciding this process is dead/discarded), a subsequent write here would
// otherwise EPIPE-crash the process — harmless for the race being simulated,
// but noisy; swallow it.
process.stdout.on('error', () => {});

let answered = 0;

// Frame parser: [4-byte BE length][UTF-8 text payload] — mirrors nlpProtocol.ts.
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) break;
    const text = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);

    if (hang) continue; // swallow the request, never answer (timeout path)

    answered += 1;
    // echoLen proves the full text (including embedded newlines) survived
    // the length-prefixed framing intact.
    const line = JSON.stringify({ entities, language, echoLen: text.length }) + '\n';

    if (delayResponseMs > 0) {
      setTimeout(() => {
        process.stdout.write(line, () => process.exit(0));
      }, delayResponseMs);
    } else if (crashAfter > 0 && answered >= crashAfter) {
      // stdout to a pipe is ASYNC — calling process.exit() right after
      // write() can truncate the write before the kernel pipe buffer has it
      // (a fixed setTimeout "grace period" is a race, not a guarantee, under
      // load). Passing a callback to write() and exiting only once that
      // callback fires guarantees the response is fully handed off first.
      process.stdout.write(line, () => process.exit(1));
    } else {
      process.stdout.write(line);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
