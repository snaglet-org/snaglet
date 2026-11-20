import { describe, expect, it } from 'vitest';
import { MicUnsupportedError, micErrorMessage } from './micError';

function domError(name: string): Error {
  const err = new Error('raw developer text');
  err.name = name;
  return err;
}

describe('micErrorMessage', () => {
  it.each(['NotAllowedError', 'SecurityError'])('names the permission fix for %s', (name) => {
    expect(micErrorMessage(domError(name))).toMatch(/isn't allowed to use the microphone/);
  });

  it('says no microphone was found', () => {
    expect(micErrorMessage(domError('NotFoundError'))).toBe(
      'No microphone was found. Connect one, then try again.'
    );
  });

  it('suggests another app holds a busy microphone', () => {
    expect(micErrorMessage(domError('NotReadableError'))).toMatch(/Another app may be using it/);
  });

  it('explains a window with no media capture at all', () => {
    expect(micErrorMessage(new MicUnsupportedError())).toMatch(/can't use the microphone/);
  });

  it('keeps the raw detail for anything unrecognized', () => {
    expect(micErrorMessage(new Error('AudioContext was not allowed to start'))).toBe(
      "The microphone couldn't start: AudioContext was not allowed to start"
    );
  });
});
