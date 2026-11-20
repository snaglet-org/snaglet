// voiceComposerDraft — the pure interaction rules for driving the chat composer
// from voice capture: stash on start, capture-wins overwrite, settle-then-restore
// on dispatch, merge on Esc bail, revert on a no-dispatch burst; plus the
// two-tier converging string.

import { describe, it, expect } from 'vitest';
import {
  reduceVoiceDraft,
  INITIAL_VOICE_DRAFT,
  mergeStash,
  convergeTranscript,
  isRevision,
} from './voiceComposerDraft';

describe('reduceVoiceDraft', () => {
  it('stashes the current typed draft on start (no value change yet)', () => {
    const r = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'half typed');
    expect(r.state).toEqual({ stash: 'half typed', active: true, settling: false });
    expect(r.setValue).toBeUndefined();
  });

  it('keeps the ORIGINAL stash on a second start mid-capture', () => {
    const first = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'draft').state;
    // A second start while active must not stash the transcript that has since
    // overwritten the value.
    const r = reduceVoiceDraft(first, { type: 'start' }, 'transcript so far');
    expect(r.state.stash).toBe('draft');
  });

  it('overwrites the composer with the transcript on update (capture wins)', () => {
    const started = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'draft').state;
    const r = reduceVoiceDraft(started, { type: 'update', text: 'hello world' }, 'draft');
    expect(r.setValue).toBe('hello world');
    expect(r.state.active).toBe(true);
  });

  it('settles on the dispatched final, then restores the stash on settle-done', () => {
    const started = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'my draft').state;
    const settle = reduceVoiceDraft(started, { type: 'settle', text: 'sent text' }, 'hello world');
    expect(settle.setValue).toBe('sent text');
    expect(settle.state).toEqual({
      stash: 'my draft',
      active: false,
      settling: true,
      settledText: 'sent text',
    });

    const done = reduceVoiceDraft(settle.state, { type: 'settle-done' }, 'sent text');
    expect(done.setValue).toBe('my draft');
    expect(done.state).toEqual({ stash: '', active: false, settling: false });
  });

  it('merges stash + transcript on Esc bail (nothing lost)', () => {
    const started = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'notes:').state;
    const r = reduceVoiceDraft(
      started,
      { type: 'bail', text: 'delete everything' },
      'delete everything'
    );
    expect(r.setValue).toBe('notes: delete everything');
    expect(r.state).toEqual({ stash: '', active: false, settling: false });
  });

  it('reverts to the stash on a no-dispatch burst (backchannel)', () => {
    const started = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'keep me').state;
    const r = reduceVoiceDraft(started, { type: 'revert' }, 'mhm');
    expect(r.setValue).toBe('keep me');
    expect(r.state).toEqual({ stash: '', active: false, settling: false });
  });
});

// Sent/settled text is never stash-eligible. These cover every ordering around
// the ~700 ms settle window: a capture starting inside it must not stash the
// just-sent text and let it reappear after the next send.
//
// During the settle window the composer shows the just-sent text, so the tests
// pass it as `currentValue` on the interrupting 'start'/'update'; the reducer
// must ignore it.
describe('reduceVoiceDraft — settle-window is never stash-eligible', () => {
  it('HER REPRO: a start inside the settle window re-stashes the pre-settle draft, not the sent text', () => {
    // No typed draft — the common "two voice messages in a row" case.
    const s0 = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, '').state;
    const s1 = reduceVoiceDraft(s0, { type: 'update', text: 'first message' }, '').state;
    const settle = reduceVoiceDraft(s1, { type: 'settle', text: 'first message' }, 'first message');
    expect(settle.state.settling).toBe(true);
    expect(settle.state.settledText).toBe('first message');

    // The user speaks again before the 700 ms settle-restore fires. The composer
    // value is still the just-sent 'first message'; the new 'start' must not stash
    // it. It re-stashes the pre-settle draft ('') and drops the settle.
    const restart = reduceVoiceDraft(settle.state, { type: 'start' }, 'first message');
    expect(restart.state.stash).toBe(''); // not 'first message'
    expect(restart.state.active).toBe(true);
    expect(restart.state.settling).toBe(false);
    expect(restart.setValue).toBe(''); // sent text cleared, not left lingering

    // Partials for the new utterance render only the new transcript.
    const u = reduceVoiceDraft(restart.state, { type: 'update', text: 'second message' }, '');
    expect(u.setValue).toBe('second message');

    // Second send settles and restores: the original empty draft comes back, and
    // 'first message' never pops back in.
    const settle2 = reduceVoiceDraft(
      u.state,
      { type: 'settle', text: 'second message' },
      'second message'
    );
    const done2 = reduceVoiceDraft(settle2.state, { type: 'settle-done' }, 'second message');
    expect(done2.setValue).toBe(''); // original draft, not 'first message' / 'second message'
    expect(done2.state).toEqual({ stash: '', active: false, settling: false });
  });

  it('preserves a real typed draft across a start inside the settle window', () => {
    const s0 = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'my draft').state;
    const s1 = reduceVoiceDraft(s0, { type: 'update', text: 'hello world' }, 'my draft').state;
    const settle = reduceVoiceDraft(s1, { type: 'settle', text: 'hello world' }, 'hello world');

    // Start again mid-settle: re-stash the original 'my draft', restore it as value.
    const restart = reduceVoiceDraft(settle.state, { type: 'start' }, 'hello world');
    expect(restart.state.stash).toBe('my draft');
    expect(restart.setValue).toBe('my draft');

    // The new utterance turns out to be a backchannel → revert restores 'my draft',
    // never the sent 'hello world'.
    const r = reduceVoiceDraft(restart.state, { type: 'revert' }, '');
    expect(r.setValue).toBe('my draft');
  });

  it('open-mic: a partial arriving during settle without a preceding start keeps the pre-settle stash', () => {
    // Open-mic may emit the partial ('update') before/without a 'start' for the new
    // utterance. It must overwrite with the new transcript and preserve the stash —
    // never fold the just-sent text into the stash or lose the draft.
    const s0 = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'note:').state;
    const s1 = reduceVoiceDraft(s0, { type: 'update', text: 'message one' }, 'note:').state;
    const settle = reduceVoiceDraft(s1, { type: 'settle', text: 'message one' }, 'message one');

    const u = reduceVoiceDraft(
      settle.state,
      { type: 'update', text: 'message two' },
      'message one'
    );
    expect(u.setValue).toBe('message two');
    expect(u.state.stash).toBe('note:'); // pre-settle draft preserved, sent text not folded in
    expect(u.state.settling).toBe(false);
    expect(u.state.settledText).toBeUndefined();

    const settle2 = reduceVoiceDraft(
      u.state,
      { type: 'settle', text: 'message two' },
      'message two'
    );
    const done2 = reduceVoiceDraft(settle2.state, { type: 'settle-done' }, 'message two');
    expect(done2.setValue).toBe('note:'); // original draft, not 'message one'
  });

  it('a settle-done that fires after a new capture has begun cannot restore the sent text', () => {
    // Defense in depth: even if the settle timer were to fire (it is canceled in
    // the wiring), the reducer state after a mid-settle start does not reference
    // the sent text; its stash is the pre-settle draft, so a stray settle-done is
    // harmless.
    const s0 = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, 'keep').state;
    const settle = reduceVoiceDraft(s0, { type: 'settle', text: 'SENT' }, 'SENT');
    const restart = reduceVoiceDraft(settle.state, { type: 'start' }, 'SENT');
    const stray = reduceVoiceDraft(restart.state, { type: 'settle-done' }, 'live transcript');
    expect(stray.setValue).toBe('keep'); // not 'SENT'
  });

  it('handles two sends back-to-back within the settle window', () => {
    // send A → settle A → speak B inside the window → settle B → send C likewise.
    let st = reduceVoiceDraft(INITIAL_VOICE_DRAFT, { type: 'start' }, '').state;
    st = reduceVoiceDraft(st, { type: 'settle', text: 'A' }, 'A').state;
    // B starts while A is settling.
    let r = reduceVoiceDraft(st, { type: 'start' }, 'A');
    expect(r.state.stash).toBe('');
    st = reduceVoiceDraft(r.state, { type: 'update', text: 'B' }, '').state;
    st = reduceVoiceDraft(st, { type: 'settle', text: 'B' }, 'B').state;
    // C starts while B is settling.
    r = reduceVoiceDraft(st, { type: 'start' }, 'B');
    expect(r.state.stash).toBe(''); // still the original empty draft, never 'A' or 'B'
    st = reduceVoiceDraft(r.state, { type: 'update', text: 'C' }, '').state;
    st = reduceVoiceDraft(st, { type: 'settle', text: 'C' }, 'C').state;
    const done = reduceVoiceDraft(st, { type: 'settle-done' }, 'C');
    expect(done.setValue).toBe(''); // nothing pops back
  });
});

describe('mergeStash', () => {
  it('joins a non-empty stash with the transcript', () => {
    expect(mergeStash('draft', 'text')).toBe('draft text');
  });
  it('returns just the transcript for a blank stash', () => {
    expect(mergeStash('   ', 'text')).toBe('text');
    expect(mergeStash('', 'text')).toBe('text');
  });
});

describe('isRevision — revise-vs-extend detection for the voice cue', () => {
  it('is not a revision when the new text purely EXTENDS the shown words', () => {
    expect(isRevision('the quick brown', 'the quick brown fox')).toBe(false);
  });

  it('is not a revision when the text is unchanged', () => {
    expect(isRevision('the quick brown', 'the quick brown')).toBe(false);
  });

  it('is a REVISION when an already-shown word changes (Apple STT churn)', () => {
    expect(isRevision('I scream', 'ice cream')).toBe(true);
    expect(isRevision('recognize speech', 'wreck a nice beach')).toBe(true);
  });

  it('is a REVISION when words are dropped (the shown text shrank)', () => {
    expect(isRevision('the quick brown fox', 'the quick brown')).toBe(true);
  });

  it('ignores casing and punctuation — a re-case/re-punctuate is an extension', () => {
    expect(isRevision('the quick brown', 'The quick brown, fox')).toBe(false);
    expect(isRevision("i'm going", 'Im going too')).toBe(false);
  });

  it('empty previous text is never a revision (first partial of an utterance)', () => {
    expect(isRevision('', 'hello there')).toBe(false);
    expect(isRevision('   ', 'hello there')).toBe(false);
  });
});

describe('convergeTranscript', () => {
  it('returns the live text when there is no quality tier yet', () => {
    expect(convergeTranscript('', 'hello there')).toBe('hello there');
  });
  it('returns quality (sticky) when the live partial is not longer', () => {
    expect(convergeTranscript('The quick brown', 'the quick')).toBe('The quick brown');
  });
  it('appends the extra trailing live words as a provisional tail', () => {
    expect(convergeTranscript('The quick', 'the quick brown fox')).toBe('The quick brown fox');
  });
});
