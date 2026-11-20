#!/usr/bin/env node
/**
 * Writes the built-in reminder sounds as 16-bit mono WAV files into
 * apps/desktop-ui/public/sounds/reminders/. The same files are played by the
 * in-app banner and bundled into the desktop app for native (OS-scheduled)
 * notifications, so a reminder sounds the same either way. Pure Node, no
 * dependencies; the output is deterministic, so re-running it is a no-op.
 *
 *   node scripts/generate-reminder-sounds.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44_100;
const outDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/desktop-ui/public/sounds/reminders'
);

/** A tone: frequency (Hz), start (s), length (s), peak gain, decay rate, partials. */
function tone(freq, start, length, gain, decay, partials = [[1, 1]]) {
  return { freq, start, length, gain, decay, partials };
}

const SOUNDS = {
  // Two soft rising notes.
  chime: [
    tone(1318.5, 0, 1.1, 0.5, 4, [
      [1, 1],
      [2, 0.15],
    ]),
    tone(1975.5, 0.18, 1.1, 0.45, 4, [
      [1, 1],
      [2, 0.12],
    ]),
  ],
  // One struck bell with inharmonic partials.
  bell: [
    tone(880, 0, 2.0, 0.55, 2.2, [
      [1, 1],
      [2.0, 0.5],
      [2.76, 0.35],
      [5.4, 0.15],
    ]),
  ],
  // A single short high ping.
  ping: [
    tone(1760, 0, 0.45, 0.5, 9, [
      [1, 1],
      [3, 0.05],
    ]),
  ],
  // Three short beeps.
  pulse: [0, 0.18, 0.36].map((t) =>
    tone(880, t, 0.11, 0.45, 18, [
      [1, 1],
      [2, 0.1],
    ])
  ),
  // A rising three-note marimba figure.
  marimba: [523.25, 659.25, 783.99].map((f, i) =>
    tone(f, i * 0.14, 0.6, 0.5, 9, [
      [1, 1],
      [4, 0.3],
      [10, 0.05],
    ])
  ),
};

function render(tones) {
  const end = Math.max(...tones.map((t) => t.start + t.length));
  const samples = new Float64Array(Math.ceil(end * RATE));
  for (const t of tones) {
    const from = Math.floor(t.start * RATE);
    const count = Math.floor(t.length * RATE);
    for (let i = 0; i < count; i += 1) {
      const s = i / RATE;
      // 5 ms attack, exponential decay, 20 ms fade-out at the tail.
      const attack = Math.min(1, s / 0.005);
      const release = Math.min(1, (t.length - s) / 0.02);
      const env = t.gain * attack * release * Math.exp(-t.decay * s);
      let v = 0;
      for (const [ratio, amp] of t.partials) v += amp * Math.sin(2 * Math.PI * t.freq * ratio * s);
      samples[from + i] += env * v;
    }
  }
  const peak = Math.max(...samples.map(Math.abs), 1e-9);
  const scale = peak > 0.9 ? 0.9 / peak : 1;
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) =>
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * scale)) * 32767), i * 2)
  );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

mkdirSync(outDir, { recursive: true });
for (const [id, tones] of Object.entries(SOUNDS)) {
  const file = path.join(outDir, `${id}.wav`);
  writeFileSync(file, render(tones));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
