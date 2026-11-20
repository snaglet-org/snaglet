/**
 * audioCodec — base64 ⇄ PCM16 helpers + a WAV wrapper for the preview route.
 *
 * The WS contract carries audio as base64-encoded little-endian PCM16 inside
 * JSON (plan: "base64 pcm16 mono 16k in JSON"). These helpers are the single
 * place that endianness/format lives, so the pipeline never hand-rolls buffers.
 */

import { VOICE_SAMPLE_RATE } from './constants';

/** Decode a base64 little-endian PCM16 payload into an Int16Array. */
export function base64ToPcm16(b64: string): Int16Array {
  const buf = Buffer.from(b64, 'base64');
  // A stray odd byte would corrupt the last sample — floor to whole samples.
  const sampleCount = Math.floor(buf.byteLength / 2);
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

/** Encode an Int16Array as a base64 little-endian PCM16 payload. */
export function pcm16ToBase64(pcm16: Int16Array): string {
  const buf = Buffer.alloc(pcm16.length * 2);
  for (let i = 0; i < pcm16.length; i++) {
    buf.writeInt16LE(pcm16[i]!, i * 2);
  }
  return buf.toString('base64');
}

/**
 * Wrap mono PCM16 samples in a canonical 44-byte WAV header. Used by the REST
 * preview route so a browser `<audio>`/AudioContext can play the bytes directly.
 */
export function encodeWav(pcm16: Int16Array, sampleRate: number = VOICE_SAMPLE_RATE): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm16.length * bytesPerSample;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20); // AudioFormat = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34); // BitsPerSample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const body = Buffer.alloc(dataSize);
  for (let i = 0; i < pcm16.length; i++) {
    body.writeInt16LE(pcm16[i]!, i * 2);
  }
  return Buffer.concat([header, body]);
}
