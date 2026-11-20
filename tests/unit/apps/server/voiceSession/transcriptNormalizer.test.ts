/**
 * transcriptNormalizer — all-caps detection + sentence casing.
 * The zipformer emits ALL CAPS unpunctuated text; Moonshine emits cased text.
 */

import { describe, expect, it } from '@jest/globals';
import {
  isAllCaps,
  normalizeTranscript,
} from '@server/services/SocketService/voiceSession/transcriptNormalizer';

describe('isAllCaps', () => {
  it('is true for uppercase-dominant text', () => {
    expect(isAllCaps('THE QUICK BROWN FOX')).toBe(true);
    expect(isAllCaps('HELLO THERE, HOW ARE YOU?')).toBe(true);
  });

  it('is false for normally-cased or lowercase text', () => {
    expect(isAllCaps('The quick brown fox')).toBe(false);
    expect(isAllCaps('hello there')).toBe(false);
    expect(isAllCaps("Sure, I'll check that now.")).toBe(false);
  });

  it('ignores digits/punctuation/whitespace and empty letter sets', () => {
    expect(isAllCaps('12:45 — !!!')).toBe(false);
    expect(isAllCaps('')).toBe(false);
    // One stray lowercase letter in an otherwise-caps string stays >80% → caps.
    expect(isAllCaps('THE QUICK BROWN FOx')).toBe(true);
  });
});

describe('normalizeTranscript', () => {
  it('lowercases + sentence-cases all-caps zipformer output', () => {
    expect(normalizeTranscript('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG')).toBe(
      'The quick brown fox jumps over the lazy dog'
    );
  });

  it('capitalizes the first letter after each sentence terminator', () => {
    expect(normalizeTranscript('HELLO THERE. HOW ARE YOU? I AM FINE! THANKS')).toBe(
      'Hello there. How are you? I am fine! Thanks'
    );
  });

  it('uppercases the standalone pronoun I and its contractions', () => {
    expect(normalizeTranscript('CAN I CHECK IF I AM DONE')).toBe('Can I check if I am done');
    expect(normalizeTranscript("I THINK I'LL DO IT AND I'M SURE I'VE SEEN IT")).toBe(
      "I think I'll do it and I'm sure I've seen it"
    );
  });

  it('does not uppercase i inside a word', () => {
    expect(normalizeTranscript('THIS IS A LIST OF ITEMS')).toBe('This is a list of items');
  });

  it('passes already-cased Moonshine/whisper output through untouched (trimmed)', () => {
    const cased = 'Sure, I can help with that. One second while I check.';
    expect(normalizeTranscript(`  ${cased}  `)).toBe(cased);
    expect(normalizeTranscript('Ship the release.')).toBe('Ship the release.');
  });

  it('returns empty for empty/whitespace input', () => {
    expect(normalizeTranscript('')).toBe('');
    expect(normalizeTranscript('   ')).toBe('');
  });

  it('strips a spurious leading list marker Moonshine prepends', () => {
    expect(normalizeTranscript('1. What is two plus two?')).toBe('What is two plus two?');
    expect(normalizeTranscript('2) Ship the release.')).toBe('Ship the release.');
    expect(normalizeTranscript('- what is the status')).toBe('what is the status');
    expect(normalizeTranscript('• pick up the milk')).toBe('pick up the milk');
  });

  it('leaves a genuine numeric start untouched (marker punctuation required)', () => {
    // No "." or ")" after the digit → not a list marker → not stripped.
    expect(normalizeTranscript('2 plus 2 is what I asked')).toBe('2 plus 2 is what I asked');
  });

  it('strips the marker before all-caps sentence casing', () => {
    expect(normalizeTranscript('1. WHAT IS THE STATUS')).toBe('What is the status');
  });
});
