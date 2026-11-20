import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicCapture } from './MicCapture';
import { MicUnsupportedError } from './micError';

describe('MicCapture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resumes a suspended Chrome AudioContext before declaring capture started', async () => {
    const track = {
      label: 'Test microphone',
      getSettings: () => ({ deviceId: 'mic-1' }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };
    const mediaDevices = {
      getUserMedia: vi.fn(async () => stream),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    });

    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const processor = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const ctx = {
      state: 'suspended',
      sampleRate: 48_000,
      destination: {},
      resume: vi.fn(async () => {
        ctx.state = 'running';
      }),
      createMediaStreamSource: vi.fn(() => source),
      createScriptProcessor: vi.fn(() => processor),
      close: vi.fn(async () => {}),
    };
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: vi.fn(() => ctx),
    });

    const capture = new MicCapture({ onChunk: vi.fn() });
    await capture.start();

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(ctx.createScriptProcessor).toHaveBeenCalledTimes(1);

    capture.stop();
  });

  it('rejects startup when Chrome refuses to resume the capture context', async () => {
    const track = {
      label: 'Test microphone',
      getSettings: () => ({ deviceId: 'mic-1' }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track],
        })),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const error = new Error('AudioContext was not allowed to start');
    const close = vi.fn(async () => {});
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: vi.fn(() => ({
        state: 'suspended',
        sampleRate: 48_000,
        resume: vi.fn(async () => {
          throw error;
        }),
        close,
      })),
    });

    const capture = new MicCapture({ onChunk: vi.fn() });

    await expect(capture.start()).rejects.toBe(error);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('MicCapture without media capture', () => {
  it('rejects with MicUnsupportedError when the page has no getUserMedia', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const capture = new MicCapture({ onChunk: vi.fn() });
    await expect(capture.start()).rejects.toBeInstanceOf(MicUnsupportedError);
  });
});
