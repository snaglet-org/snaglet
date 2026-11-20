/**
 * Ambient types for `sherpa-onnx-node` (the package ships no `.d.ts`). Only the
 * surface the voice engine uses is declared — streaming STT, offline TTS, and
 * wav I/O. Configs are typed as the addon's loosely-shaped option objects.
 *
 * The package's named ESM exports are unreliable under CJS interop (see
 * voiceEngine.ts), so callers default-import the module object and destructure.
 */
declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }
  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export class OnlineStream {
    acceptWaveform(obj: Waveform): void;
    inputFinished(): void;
  }

  export class OnlineRecognizer {
    constructor(config: unknown);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): { text: string };
  }

  export class OfflineStream {
    acceptWaveform(obj: Waveform): void;
  }

  export class OfflineRecognizer {
    constructor(config: unknown);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { text: string };
  }

  export class OfflineTts {
    constructor(config: unknown);
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generate(obj: { text: string; sid: number; speed: number }): GeneratedAudio;
  }

  export class Vad {
    constructor(config: unknown, bufferSizeInSeconds: number);
  }
  export class CircularBuffer {
    constructor(capacity: number);
  }

  export function readWave(filename: string): Waveform;
  export function writeWave(filename: string, wave: Waveform): void;
  export const version: string;

  interface SherpaModule {
    OnlineRecognizer: typeof OnlineRecognizer;
    OnlineStream: typeof OnlineStream;
    OfflineRecognizer: typeof OfflineRecognizer;
    OfflineStream: typeof OfflineStream;
    OfflineTts: typeof OfflineTts;
    Vad: typeof Vad;
    CircularBuffer: typeof CircularBuffer;
    readWave: typeof readWave;
    writeWave: typeof writeWave;
    version: string;
  }
  const sherpa: SherpaModule;
  export default sherpa;
}
