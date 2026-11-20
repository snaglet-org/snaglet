/**
 * audioCodec — base64 ⇄ PCM16 round-trip + a valid WAV header.
 */

import {
  base64ToPcm16,
  pcm16ToBase64,
  encodeWav,
} from '@server/services/SocketService/voiceSession/audioCodec';

describe('base64 ⇄ pcm16', () => {
  it('round-trips samples losslessly (incl. negatives)', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    const b64 = pcm16ToBase64(samples);
    expect(base64ToPcm16(b64)).toEqual(samples);
  });

  it('drops a stray odd trailing byte rather than corrupting a sample', () => {
    // 3 bytes = 1.5 samples → floor to 1 whole sample.
    const b64 = Buffer.from([0x01, 0x00, 0x7f]).toString('base64');
    expect(base64ToPcm16(b64).length).toBe(1);
  });
});

describe('encodeWav', () => {
  it('writes a canonical 44-byte PCM header around the samples', () => {
    const pcm = new Int16Array([100, -100, 200]);
    const wav = encodeWav(pcm, 16000);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2); // data size
    expect(wav.length).toBe(44 + pcm.length * 2);
  });

  it('carries the 22050 Hz TTS output rate (piper + Apple both render @ 22050)', () => {
    // Synthetic Int16 @ 22050 → valid RIFF, no Apple/engine dependency. The
    // hybrid TTS audio (piper or Apple, both 22050) is wrapped by this exact path.
    const pcm = Int16Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 1000 : -1000));
    const wav = encodeWav(pcm, 22_050);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(22_050); // sample rate
    expect(wav.readUInt32LE(28)).toBe(22_050 * 2); // byteRate = rate * blockAlign
    expect(wav.readUInt16LE(32)).toBe(2); // blockAlign (mono 16-bit)
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length * 2); // RIFF chunk size
    for (let i = 0; i < pcm.length; i++) {
      expect(wav.readInt16LE(44 + i * 2)).toBe(pcm[i]!); // samples round-trip
    }
  });
});
