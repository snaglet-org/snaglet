/**
 * openMicVad — the VAD endpointer state machine + PCM framer (open-mic mode).
 * Driven with synthetic probability sequences (no audio) so onset/endpoint/
 * backchannel behavior is deterministic and hardware-free.
 */

import {
  createVadEndpointer,
  createVadFramer,
  isBackchannelUtterance,
  normalizeBackchannelText,
  type VadEvent,
} from '@server/services/SocketService/voiceSession/openMicVad';

/** Push a run of frames at a fixed probability, collecting events. */
function pushMany(ep: ReturnType<typeof createVadEndpointer>, prob: number, n: number): VadEvent[] {
  const out: VadEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...ep.push(prob));
  return out;
}

describe('createVadEndpointer', () => {
  // frameMs 10 keeps the math easy: silence 300ms = 30 frames, minSpeech 500 = 50.
  const opts = { frameMs: 10, silenceMs: 300, minSpeechMs: 500 };

  it('fires speech-start on the first frame at/above onset', () => {
    const ep = createVadEndpointer(opts);
    expect(ep.push(0.2)).toEqual([]);
    expect(ep.inSpeech()).toBe(false);
    expect(ep.push(0.9)).toEqual([{ type: 'speech-start' }]);
    expect(ep.inSpeech()).toBe(true);
  });

  it('endpoints after the silence window and reports voicedMs (real utterance)', () => {
    const ep = createVadEndpointer(opts);
    ep.push(0.9); // start (10ms voiced)
    pushMany(ep, 0.9, 79); // +790ms voiced → 800ms total voiced
    // 29 silent frames (290ms) is under the 300ms window — no endpoint yet.
    expect(pushMany(ep, 0.05, 29)).toEqual([]);
    expect(ep.inSpeech()).toBe(true);
    // The 30th silent frame (300ms) closes the utterance.
    const events = ep.push(0.05);
    expect(events).toEqual([{ type: 'speech-end', voicedMs: 800, backchannel: false }]);
    expect(ep.inSpeech()).toBe(false);
  });

  it('flags a short burst as a backchannel (voicedMs < minSpeechMs)', () => {
    const ep = createVadEndpointer(opts);
    ep.push(0.9); // 10ms voiced
    pushMany(ep, 0.9, 19); // +190ms → 200ms voiced (< 500ms)
    pushMany(ep, 0.0, 29); // 290ms silence, no endpoint yet
    const [end] = ep.push(0.0); // 300ms silence → endpoint
    expect(end).toEqual({ type: 'speech-end', voicedMs: 200, backchannel: true });
  });

  it('resets the trailing-silence timer on a re-voiced frame', () => {
    const ep = createVadEndpointer(opts);
    ep.push(0.9);
    pushMany(ep, 0.9, 60); // long voiced
    pushMany(ep, 0.0, 20); // 200ms silence
    ep.push(0.9); // re-voiced → resets the silence timer
    expect(pushMany(ep, 0.0, 29)).toEqual([]); // 290ms again, still open
    expect(ep.inSpeech()).toBe(true);
  });

  it('reset() drops all state', () => {
    const ep = createVadEndpointer(opts);
    ep.push(0.9);
    expect(ep.inSpeech()).toBe(true);
    ep.reset();
    expect(ep.inSpeech()).toBe(false);
  });

  describe('setSilenceForCurrentRun (barge-in finish window)', () => {
    it('extends the silence window for the current run so a pause does not endpoint early', () => {
      const ep = createVadEndpointer(opts); // default silence 300ms (30 frames)
      ep.push(0.9); // speech-start
      pushMany(ep, 0.9, 50); // voiced
      // Arm a longer window (600ms) — the barge-in finish window.
      ep.setSilenceForCurrentRun(600);
      // 59 silent frames (590ms) is under 600ms — still open (would have ended at
      // 300ms under the default window).
      expect(pushMany(ep, 0.02, 59)).toEqual([]);
      expect(ep.inSpeech()).toBe(true);
      // The 60th silent frame (600ms) finally endpoints.
      expect(ep.push(0.02)).toEqual([{ type: 'speech-end', voicedMs: 510, backchannel: false }]);
    });

    it('reverts to the default window on the next run (extension is per-run)', () => {
      const ep = createVadEndpointer(opts);
      ep.push(0.9);
      ep.setSilenceForCurrentRun(600);
      pushMany(ep, 0.9, 50);
      pushMany(ep, 0.02, 59); // under 600ms
      ep.push(0.02); // 600ms → endpoint (run 1 ends)

      // Run 2: no extension armed → the default 300ms window applies again.
      ep.push(0.9); // speech-start
      pushMany(ep, 0.9, 50);
      expect(pushMany(ep, 0.02, 29)).toEqual([]); // 290ms, still open
      expect(ep.push(0.02)).toEqual([{ type: 'speech-end', voicedMs: 510, backchannel: false }]);
    });
  });
});

describe('createVadFramer', () => {
  it('emits whole 512-sample frames and carries the remainder', () => {
    const framer = createVadFramer();
    // 600 samples → one 512 frame, 88 carried.
    const first = framer.push(new Int16Array(600));
    expect(first).toHaveLength(1);
    expect(first[0]!.length).toBe(512);
    // +600 more = 688 buffered → one more 512 frame, 176 carried.
    const second = framer.push(new Int16Array(600));
    expect(second).toHaveLength(1);
  });

  it('normalizes pcm16 to float32 in [-1, 1]', () => {
    const framer = createVadFramer();
    const pcm = new Int16Array(512).fill(16384); // half scale
    const [frame] = framer.push(pcm);
    expect(frame![0]).toBeCloseTo(0.5, 3);
  });
});

describe('normalizeBackchannelText', () => {
  it('lowercases and strips punctuation + whitespace', () => {
    expect(normalizeBackchannelText('Uh-huh')).toBe('uhhuh');
    expect(normalizeBackchannelText('uh huh')).toBe('uhhuh');
    expect(normalizeBackchannelText('Mm-hmm.')).toBe('mmhmm');
    expect(normalizeBackchannelText('OK!')).toBe('ok');
  });
});

describe('isBackchannelUtterance (transcript-aware)', () => {
  it('a short filler (or empty) burst is a backchannel', () => {
    expect(isBackchannelUtterance(300, 'mhm', 500)).toBe(true);
    expect(isBackchannelUtterance(300, 'Mm-hmm.', 500)).toBe(true);
    expect(isBackchannelUtterance(300, 'uh huh', 500)).toBe(true);
    expect(isBackchannelUtterance(300, 'Yeah!', 500)).toBe(true);
    expect(isBackchannelUtterance(300, '', 500)).toBe(true);
  });

  it('a short but meaningful command is not a backchannel', () => {
    expect(isBackchannelUtterance(300, 'stop', 500)).toBe(false);
    expect(isBackchannelUtterance(300, 'no', 500)).toBe(false);
    expect(isBackchannelUtterance(300, 'wait', 500)).toBe(false);
  });

  it('a long burst is never a backchannel, even a filler', () => {
    expect(isBackchannelUtterance(600, 'yeah', 500)).toBe(false);
    expect(isBackchannelUtterance(500, '', 500)).toBe(false); // at threshold → long
  });
});
