/**
 * Stub for sherpa-onnx-node inside jest.
 *
 * The real module loads a ~75 MB native addon and needs the fetched voice
 * models + audio — never available or wanted in CI. No in-jest test runs real
 * sherpa inference: the voice engine's native path (VoiceEngine/worker) is
 * exercised only by the `voice:smoke` tsx script, and VoiceEngineService is
 * unit-tested through a fake worker. Mapped via moduleNameMapper in
 * jest.config.js, mirroring the onnxruntime-node stub.
 *
 * Any accidental use of a constructor here throws with an actionable message
 * instead of dragging the native binary into the jest worker.
 */
'use strict';

function nativeGuard(name) {
  return class {
    constructor() {
      throw new Error(
        `sherpa-onnx-node is stubbed in jest (${name}) — run real synthesis via ` +
          '`pnpm --filter @snaglet/server voice:smoke`'
      );
    }
  };
}

module.exports = {
  OnlineRecognizer: nativeGuard('OnlineRecognizer'),
  OfflineRecognizer: nativeGuard('OfflineRecognizer'),
  OfflineTts: nativeGuard('OfflineTts'),
  Vad: nativeGuard('Vad'),
  CircularBuffer: nativeGuard('CircularBuffer'),
  readWave: () => {
    throw new Error('sherpa-onnx-node readWave is stubbed in jest');
  },
  writeWave: () => {
    throw new Error('sherpa-onnx-node writeWave is stubbed in jest');
  },
  version: '0.0.0-stub',
};
