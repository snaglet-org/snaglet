#!/usr/bin/env node
/**
 * fake-apple-stt — a stand-in for the `snaglet-apple-stt` Swift sidecar, used by the
 * AppleSttEngine jest tests. It speaks the exact wire contract (length-prefixed
 * binary frames in, newline-delimited JSON out) so the engine can be exercised
 * end-to-end without Swift, audio, or the macOS Speech framework.
 *
 * Flags (anywhere in argv):
 *   --final "<text>"      final text to emit on FINALIZE (default "the quick brown fox")
 *   --exit-after-final    exit(0) shortly after each FINALIZE (simulates a dying
 *                         sidecar → exercises AppleSttEngine's respawn path)
 *   --no-ready            never emit {"type":"ready"} (simulates a stuck start)
 *   --warmup-fail         warmup subcommand exits non-zero (no error line, like
 *                         an older binary)
 *   --fail-code "<code>"  warmup AND stream report {"type":"error","code":..}
 *                         and exit 1 (a sidecar that can't run)
 *   --crash-after-frames N  stream exits 1 after N audio frames (a crash mid-utterance)
 */

const argv = process.argv.slice(2);
const sub = argv.find((a) => ['warmup', 'stream', 'file', 'probe'].includes(a)) ?? 'stream';
const has = (flag) => argv.includes(flag);
const valOf = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : def;
};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const failCode = valOf('--fail-code', null);
if (failCode && (sub === 'warmup' || sub === 'stream')) {
  emit({ type: 'error', code: failCode, message: 'fake failure' });
  process.exit(1);
}

if (sub === 'warmup') {
  if (has('--warmup-fail')) process.exit(1);
  emit({ type: 'ready' });
  process.exit(0);
}

if (sub !== 'stream') {
  // probe/file are not exercised by the engine tests.
  emit({ type: 'ready' });
  process.exit(0);
}

const finalText = valOf('--final', 'the quick brown fox');
const exitAfterFinal = has('--exit-after-final');
const crashAfterFrames = Number(valOf('--crash-after-frames', '0'));

if (!has('--no-ready')) emit({ type: 'ready' });

// Frame parser: [1 byte opcode][4 byte BE length][payload].
let buf = Buffer.alloc(0);
let audioFrames = 0;

process.stdin.on('data', (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  while (buf.length >= 5) {
    const op = buf[0];
    const len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) break;
    buf = buf.subarray(5 + len);
    if (op === 0x01) {
      // AUDIO — emit a cumulative partial so onPartial is exercised.
      audioFrames += 1;
      if (crashAfterFrames > 0 && audioFrames >= crashAfterFrames) process.exit(1);
      emit({
        type: 'partial',
        text: `partial ${audioFrames}`,
        tMs: audioFrames,
        audioMs: audioFrames * 100,
      });
    } else if (op === 0x02) {
      // FINALIZE — one final per control frame, then re-arm for the next utterance.
      emit({ type: 'final', text: finalText, tMs: audioFrames, audioMs: 0 });
      audioFrames = 0;
      if (exitAfterFinal) {
        // Let stdout flush the final line before dying.
        setTimeout(() => process.exit(0), 30);
      }
    }
  }
});

process.stdin.on('end', () => process.exit(0));
