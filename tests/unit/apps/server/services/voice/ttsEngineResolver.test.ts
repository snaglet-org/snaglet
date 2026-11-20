/**
 * ttsEngineResolver — the Apple-TTS availability rule. The pure `decideTtsEngine`
 * covers the platform/availability/forced matrix; `resolveTtsEngineKind` is
 * exercised against the live process to prove the SNAGLET_TTS_ENGINE knob wins.
 *
 * TTS is additive (piper is always present + the default), so `'local'` here
 * means "piper only", `'apple'` means "also offer Apple voices". On a
 * non-darwin host Apple is never selected — piper carries CI with no Apple dep.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { afterEach, describe, expect, it } from '@jest/globals';
import { decideTtsEngine, resolveTtsEngineKind } from '@server/services/voice/ttsEngineResolver';

describe('decideTtsEngine — platform × availability × forced', () => {
  it('darwin + sidecar available → apple (hybrid)', () => {
    expect(decideTtsEngine({ platform: 'darwin', binaryAvailable: true })).toBe('apple');
  });

  it('darwin + sidecar not available → local (piper only)', () => {
    expect(decideTtsEngine({ platform: 'darwin', binaryAvailable: false })).toBe('local');
  });

  it('non-darwin → local regardless of availability (CI has no Apple dep)', () => {
    expect(decideTtsEngine({ platform: 'linux', binaryAvailable: true })).toBe('local');
    expect(decideTtsEngine({ platform: 'win32', binaryAvailable: true })).toBe('local');
  });

  it('SNAGLET_TTS_ENGINE=local forces piper-only even on darwin with the sidecar', () => {
    expect(decideTtsEngine({ platform: 'darwin', binaryAvailable: true, forced: 'local' })).toBe(
      'local'
    );
    expect(decideTtsEngine({ platform: 'darwin', binaryAvailable: true, forced: 'LOCAL' })).toBe(
      'local'
    );
  });

  it('SNAGLET_TTS_ENGINE=apple forces apple even off-platform / unavailable', () => {
    expect(decideTtsEngine({ platform: 'linux', binaryAvailable: false, forced: 'apple' })).toBe(
      'apple'
    );
  });

  it('an unrecognized forced value is ignored (falls through to detection)', () => {
    expect(decideTtsEngine({ platform: 'linux', binaryAvailable: true, forced: 'espeak' })).toBe(
      'local'
    );
  });
});

describe('resolveTtsEngineKind — env knob honored live', () => {
  const prior = process.env.SNAGLET_TTS_ENGINE;
  afterEach(() => {
    if (prior === undefined) delete process.env.SNAGLET_TTS_ENGINE;
    else process.env.SNAGLET_TTS_ENGINE = prior;
  });

  it('SNAGLET_TTS_ENGINE=local always resolves to local', () => {
    process.env.SNAGLET_TTS_ENGINE = 'local';
    expect(resolveTtsEngineKind()).toBe('local');
  });

  it('SNAGLET_TTS_ENGINE=apple always resolves to apple', () => {
    process.env.SNAGLET_TTS_ENGINE = 'apple';
    expect(resolveTtsEngineKind()).toBe('apple');
  });
});
