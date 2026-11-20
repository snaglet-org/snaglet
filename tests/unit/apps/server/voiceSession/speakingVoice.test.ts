/**
 * speakingVoice — a saved voice speaks as itself when installed, else as the
 * first installed voice, and as itself (TTS unavailable) when none is
 * installed. Apple voices pass through untouched.
 */

jest.mock('@server/config/logger', () => ({ logger: { warn: jest.fn() } }));

let installed: string[] = [];
const mockInstalledVoiceIds = jest.fn(async () => installed);
jest.mock('@server/services/voice/installedVoices', () => ({
  installedVoiceIds: () => mockInstalledVoiceIds(),
}));

import { speakingVoiceId } from '@server/services/SocketService/voiceSession/speakingVoice';
import { DEFAULT_VOICE_ID } from '@server/services/voice/voiceModelManifest';

const AMY = 'en_US-amy-medium';
const RYAN = 'en_US-ryan-medium';
const JOE = 'en_US-joe-medium';

beforeEach(() => {
  installed = [];
  mockInstalledVoiceIds.mockClear();
});

describe('speakingVoiceId', () => {
  it('speaks an installed voice as itself', async () => {
    installed = [AMY, RYAN];
    expect(await speakingVoiceId(RYAN)).toBe(RYAN);
    expect(await speakingVoiceId(`piper:${RYAN}`)).toBe(RYAN);
  });

  it('speaks an uninstalled voice, the default included, as the first installed one', async () => {
    installed = [RYAN, JOE];
    expect(await speakingVoiceId(AMY)).toBe(RYAN);
    expect(await speakingVoiceId(DEFAULT_VOICE_ID)).toBe(RYAN);
  });

  it('speaks an id the catalog does not ship as the default, or the first installed voice', async () => {
    installed = [AMY, JOE];
    expect(await speakingVoiceId('en_US-retired-medium')).toBe(AMY);
    installed = [JOE];
    expect(await speakingVoiceId('en_US-retired-medium')).toBe(JOE);
  });

  it('with no voice installed returns the voice itself, so synthesis fails as with TTS missing', async () => {
    expect(await speakingVoiceId(RYAN)).toBe(RYAN);
    expect(await speakingVoiceId('en_US-retired-medium')).toBe(DEFAULT_VOICE_ID);
  });

  it('passes Apple voices through without a disk lookup', async () => {
    const apple = 'apple:com.apple.voice.premium.en-US.Zoe';
    expect(await speakingVoiceId(apple)).toBe(apple);
    expect(mockInstalledVoiceIds).not.toHaveBeenCalled();
  });

  it('speaks the voice itself when the disk lookup fails', async () => {
    mockInstalledVoiceIds.mockRejectedValueOnce(new Error('settings unavailable'));
    expect(await speakingVoiceId(RYAN)).toBe(RYAN);
  });
});
