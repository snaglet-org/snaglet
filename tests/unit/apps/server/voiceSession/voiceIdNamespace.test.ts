/**
 * voiceIdNamespace — the voice-id dispatch rule. Proves `apple:`/`piper:`/bare
 * routing and the back-compat invariant: a bare (unprefixed) id, including the
 * default and older stored agents.voice values, routes to piper.
 */

import { describe, expect, it } from '@jest/globals';
import {
  parseVoiceId,
  toAppleVoiceId,
} from '@server/services/SocketService/voiceSession/voiceIdNamespace';
import { DEFAULT_VOICE_ID } from '@server/services/SocketService/voiceSession/constants';

describe('parseVoiceId', () => {
  it('routes an apple:-prefixed id to the apple engine, stripping the prefix', () => {
    expect(parseVoiceId('apple:com.apple.voice.premium.en-US.Zoe')).toEqual({
      engine: 'apple',
      nativeId: 'com.apple.voice.premium.en-US.Zoe',
    });
  });

  it('routes a piper:-prefixed id to piper, stripping the prefix', () => {
    expect(parseVoiceId('piper:en_US-ryan-medium')).toEqual({
      engine: 'piper',
      nativeId: 'en_US-ryan-medium',
    });
  });

  it('a bare (unprefixed) id routes to piper unchanged', () => {
    expect(parseVoiceId('en_US-amy-medium')).toEqual({
      engine: 'piper',
      nativeId: 'en_US-amy-medium',
    });
  });

  it('the default voice id (bare) routes to piper', () => {
    expect(parseVoiceId(DEFAULT_VOICE_ID)).toEqual({
      engine: 'piper',
      nativeId: DEFAULT_VOICE_ID,
    });
  });

  it('trims surrounding whitespace before dispatch', () => {
    expect(parseVoiceId('  apple:foo  ')).toEqual({ engine: 'apple', nativeId: 'foo' });
  });
});

describe('toAppleVoiceId', () => {
  it('namespaces an AV identifier for storage', () => {
    expect(toAppleVoiceId('com.apple.eloquence.en-US.Eddy')).toBe(
      'apple:com.apple.eloquence.en-US.Eddy'
    );
  });

  it('round-trips through parseVoiceId', () => {
    const id = toAppleVoiceId('com.apple.voice.enhanced.en-GB.Daniel');
    expect(parseVoiceId(id)).toEqual({
      engine: 'apple',
      nativeId: 'com.apple.voice.enhanced.en-GB.Daniel',
    });
  });
});
