/**
 * Stub for onnxruntime-node inside jest.
 *
 * The real module loads a native library that intermittently SIGABRTs jest
 * workers at teardown — taking down whichever unrelated suite shares the
 * worker. No in-jest test runs real ONNX inference anyway: suites that need
 * the real models (embedder verify, vector parity, migration bootstrap)
 * shell out to tsx child processes. Mapped via moduleNameMapper in
 * jest.config.js.
 */
'use strict';

class Tensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

module.exports = {
  Tensor,
  InferenceSession: {
    create: async () => {
      throw new Error(
        'onnxruntime-node is stubbed in jest — run real inference via the tsx verify scripts'
      );
    },
  },
};
