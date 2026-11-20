/**
 * voiceSessionRegistry — the dictate/speak split. Beyond the indirect
 * coverage in runPhaseTracker.test.ts and VoiceSessionService.test.ts's
 * thread-level-exclusivity suite, this covers the registry's own contract
 * directly: two independently-tracked client sets (mic vs speak) behind one
 * `markThreadVoiceActive(threadId, clientId, flags)` call.
 */
import {
  markThreadVoiceActive,
  unmarkThreadVoiceActive,
  isThreadVoiceActive,
  micClientsForThread,
  __resetVoiceRegistry,
} from '@server/services/SocketService/voiceSession/voiceSessionRegistry';

const THREAD = 'thread-1';

afterEach(() => __resetVoiceRegistry());

describe('markThreadVoiceActive / isThreadVoiceActive (speak-scoped)', () => {
  it('a dictate-only client (speak:false) does not make the thread voice-active', () => {
    markThreadVoiceActive(THREAD, 'client-a', { dictate: true, speak: false });
    // isThreadVoiceActive gates the per-turn VOICE_PROFILE_BLOCK
    // (composeTurnContextTail.ts) — a dictate-only session must never carry
    // it, since nothing is being spoken aloud on this thread.
    expect(isThreadVoiceActive(THREAD)).toBe(false);
  });

  it('a speak-only client (dictate:false) does make the thread voice-active', () => {
    markThreadVoiceActive(THREAD, 'client-a', { dictate: false, speak: true });
    expect(isThreadVoiceActive(THREAD)).toBe(true);
  });

  it("a both-on client makes the thread voice-active (today's combined behavior)", () => {
    markThreadVoiceActive(THREAD, 'client-a', { dictate: true, speak: true });
    expect(isThreadVoiceActive(THREAD)).toBe(true);
  });

  it('unmarking removes the client from both sets', () => {
    markThreadVoiceActive(THREAD, 'client-a', { dictate: true, speak: true });
    unmarkThreadVoiceActive(THREAD, 'client-a');
    expect(isThreadVoiceActive(THREAD)).toBe(false);
    expect(micClientsForThread(THREAD)).toEqual([]);
  });

  it('stays voice-active while at least one other client still has speak on', () => {
    markThreadVoiceActive(THREAD, 'client-a', { dictate: false, speak: true });
    markThreadVoiceActive(THREAD, 'client-b', { dictate: false, speak: true });
    unmarkThreadVoiceActive(THREAD, 'client-a');
    expect(isThreadVoiceActive(THREAD)).toBe(true);
    unmarkThreadVoiceActive(THREAD, 'client-b');
    expect(isThreadVoiceActive(THREAD)).toBe(false);
  });
});

describe('micClientsForThread (dictate-scoped, mic-takeover lock)', () => {
  it('only lists clients with dictate:true — a speak-only client never appears', () => {
    markThreadVoiceActive(THREAD, 'dictator', { dictate: true, speak: false });
    markThreadVoiceActive(THREAD, 'speaker', { dictate: false, speak: true });
    expect(micClientsForThread(THREAD)).toEqual(['dictator']);
  });

  it('lists a both-on client too (it does hold the mic)', () => {
    markThreadVoiceActive(THREAD, 'both', { dictate: true, speak: true });
    expect(micClientsForThread(THREAD)).toEqual(['both']);
  });

  it('is empty when only speak-only clients are on the thread (mic-lock exemption)', () => {
    markThreadVoiceActive(THREAD, 'speaker-a', { dictate: false, speak: true });
    markThreadVoiceActive(THREAD, 'speaker-b', { dictate: false, speak: true });
    expect(micClientsForThread(THREAD)).toEqual([]);
  });
});
