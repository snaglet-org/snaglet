/**
 * sttEngineResolver — the engine-selection rule. The pure `decideSttEngine`
 * covers the platform/availability/forced matrix; `resolveSttEngineKind` is
 * exercised against the live process to prove the SNAGLET_VOICE_STT_ENGINE knob wins.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import {
  appleSpeechOsSupported,
  decideSttEngine,
  resolveSttEngineKind,
} from '@server/services/voice/sttEngineResolver';

const mac26 = { platform: 'darwin', osSupported: true };

describe('decideSttEngine — platform × OS × availability × forced', () => {
  it('darwin + sidecar available → apple', () => {
    expect(decideSttEngine({ ...mac26, binaryAvailable: true })).toBe('apple');
  });

  it('darwin + sidecar not available → local (fallback tier)', () => {
    expect(decideSttEngine({ ...mac26, binaryAvailable: false })).toBe('local');
  });

  it('a macOS older than 26 → local even with the sidecar, which could only report unsupported-os', () => {
    expect(decideSttEngine({ platform: 'darwin', osSupported: false, binaryAvailable: true })).toBe(
      'local'
    );
  });

  it('non-darwin → local regardless of availability', () => {
    expect(decideSttEngine({ platform: 'linux', osSupported: false, binaryAvailable: true })).toBe(
      'local'
    );
    expect(decideSttEngine({ platform: 'win32', osSupported: false, binaryAvailable: true })).toBe(
      'local'
    );
  });

  it('SNAGLET_VOICE_STT_ENGINE=local forces local even on darwin with the sidecar', () => {
    expect(decideSttEngine({ ...mac26, binaryAvailable: true, forced: 'local' })).toBe('local');
    expect(decideSttEngine({ ...mac26, binaryAvailable: true, forced: 'LOCAL' })).toBe('local');
  });

  it('SNAGLET_VOICE_STT_ENGINE=apple forces apple even off-platform / unavailable / older macOS', () => {
    expect(
      decideSttEngine({
        platform: 'linux',
        osSupported: false,
        binaryAvailable: false,
        forced: 'apple',
      })
    ).toBe('apple');
    expect(
      decideSttEngine({
        platform: 'darwin',
        osSupported: false,
        binaryAvailable: true,
        forced: 'apple',
      })
    ).toBe('apple');
  });

  it('an unrecognized forced value is ignored (falls through to detection)', () => {
    expect(
      decideSttEngine({
        platform: 'linux',
        osSupported: false,
        binaryAvailable: true,
        forced: 'whisper',
      })
    ).toBe('local');
  });
});

describe('appleSpeechOsSupported — Darwin kernel release to macOS version', () => {
  it('macOS 26 (Darwin 25) and later have SpeechAnalyzer', () => {
    expect(appleSpeechOsSupported('25.0.0')).toBe(true);
    expect(appleSpeechOsSupported('25.6.0')).toBe(true);
    expect(appleSpeechOsSupported('26.1.0')).toBe(true);
  });

  it('macOS 15 (Darwin 24) and macOS 14 (Darwin 23) do not', () => {
    expect(appleSpeechOsSupported('24.6.0')).toBe(false);
    expect(appleSpeechOsSupported('23.6.0')).toBe(false);
  });

  it('an unreadable release is treated as unsupported', () => {
    expect(appleSpeechOsSupported('')).toBe(false);
    expect(appleSpeechOsSupported('unknown')).toBe(false);
  });
});

describe('resolveSttEngineKind — env knob honored live', () => {
  const prior = process.env.SNAGLET_VOICE_STT_ENGINE;
  afterEach(() => {
    if (prior === undefined) delete process.env.SNAGLET_VOICE_STT_ENGINE;
    else process.env.SNAGLET_VOICE_STT_ENGINE = prior;
  });

  it('SNAGLET_VOICE_STT_ENGINE=local always resolves to local', () => {
    process.env.SNAGLET_VOICE_STT_ENGINE = 'local';
    expect(resolveSttEngineKind()).toBe('local');
  });

  it('SNAGLET_VOICE_STT_ENGINE=apple always resolves to apple', () => {
    process.env.SNAGLET_VOICE_STT_ENGINE = 'apple';
    expect(resolveSttEngineKind()).toBe('apple');
  });
});
