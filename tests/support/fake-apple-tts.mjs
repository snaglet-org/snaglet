#!/usr/bin/env node
/**
 * fake-apple-tts — a stand-in for the `snaglet-apple-tts` Swift daemon, used by the
 * AppleTtsEngine jest tests. It speaks the exact wire contract (length-prefixed
 * JSON requests in, tagged binary frames out) so the engine can be exercised
 * end-to-end without Swift, audio, or AVFoundation.
 *
 * Flags (anywhere in argv):
 *   --frames N            audio frames per synth (default 3)
 *   --samples S           float samples per audio frame (default 8)
 *   --frame-delay-ms D    space audio frames by D ms (default 0) — lets a test
 *                         abort mid-stream and send `cancel`
 *   --floats "a,b,c"      emit one audio frame with these exact float32 values
 *                         (overrides --frames/--samples; for the f32→i16 test)
 *   --error-voice <id>    a synth for this voiceId emits an error frame + END
 *   --exit-after-synth    exit(0) shortly after each synth's END (respawn test)
 *   --no-ready            never emit {"type":"ready"} (stuck-start simulation)
 */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valOf = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : def;
};

const FRAMES = Number(valOf('--frames', '3'));
const SAMPLES = Number(valOf('--samples', '8'));
const FRAME_DELAY_MS = Number(valOf('--frame-delay-ms', '0'));
const FLOATS = has('--floats')
  ? valOf('--floats', '')
      .split(',')
      .map((s) => Number(s.trim()))
  : null;
const ERROR_VOICE = has('--error-voice') ? valOf('--error-voice', '') : null;
const EXIT_AFTER_SYNTH = has('--exit-after-synth');

const TAG = { AUDIO: 0x01, END: 0x02, JSON: 0x03 };

function writeFrame(tag, payload) {
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([header, payload]));
}
function writeJSON(obj) {
  writeFrame(TAG.JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
}
function writeAudio(id, floats) {
  const body = Buffer.alloc(4 + floats.length * 4);
  body.writeUInt32BE(id, 0);
  for (let i = 0; i < floats.length; i++) body.writeFloatLE(floats[i], 4 + i * 4);
  writeFrame(TAG.AUDIO, body);
}
function writeEnd(id) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(id, 0);
  writeFrame(TAG.END, b);
}

const CANNED_VOICES = [
  {
    identifier: 'com.apple.voice.premium.en-US.Zoe',
    name: 'Zoe',
    quality: 'premium',
    lang: 'en-US',
  },
  {
    identifier: 'com.apple.voice.enhanced.en-GB.Daniel',
    name: 'Daniel',
    quality: 'enhanced',
    lang: 'en-GB',
  },
  {
    identifier: 'com.apple.voice.compact.en-US.Samantha',
    name: 'Samantha',
    quality: 'default',
    lang: 'en-US',
  },
];

const canceled = new Set();

function handleSynth(id, voiceId) {
  if (ERROR_VOICE !== null && voiceId === ERROR_VOICE) {
    writeJSON({ type: 'error', id, message: `unknown voice identifier: ${voiceId}` });
    writeEnd(id);
    return;
  }
  const frames = FLOATS
    ? [FLOATS]
    : Array.from({ length: FRAMES }, (_, i) =>
        Array.from({ length: SAMPLES }, (_, j) => ((i * SAMPLES + j) % 10) / 10)
      );

  let idx = 0;
  const emitNext = () => {
    if (canceled.has(id)) {
      canceled.delete(id);
      writeEnd(id);
      afterSynth();
      return;
    }
    if (idx >= frames.length) {
      writeEnd(id);
      afterSynth();
      return;
    }
    writeAudio(id, frames[idx++]);
    if (FRAME_DELAY_MS > 0) setTimeout(emitNext, FRAME_DELAY_MS);
    else emitNext();
  };
  emitNext();
}

function afterSynth() {
  if (EXIT_AFTER_SYNTH) setTimeout(() => process.exit(0), 30);
}

if (!has('--no-ready')) writeJSON({ type: 'ready' });

// Request parser: [4 byte BE length][UTF-8 JSON].
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) break;
    const payload = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    let req;
    try {
      req = JSON.parse(payload.toString('utf8'));
    } catch {
      continue;
    }
    const id = Number(req.id ?? 0);
    if (req.cmd === 'synthesize') handleSynth(id, req.voiceId ?? '');
    else if (req.cmd === 'list-voices') writeJSON({ type: 'voices', id, voices: CANNED_VOICES });
    else if (req.cmd === 'cancel') canceled.add(id);
  }
});

process.stdin.on('end', () => process.exit(0));
