/**
 * transcriptNormalizer — make a finalized voice transcript read like natural
 * writing before it is dispatched or shown.
 *
 * The streaming zipformer (2023) emits UPPERCASE, unpunctuated text. When a
 * transcript is
 * effectively all-caps we lowercase it and apply light sentence casing
 * (capitalize the first letter and the letter after `.`/`!`/`?`, and fix the
 * pronoun `I` / its contractions). The Moonshine quality tier already produces
 * cased + punctuated text, so a non-all-caps input is passed through untouched —
 * the detector is what lets one normalizer safely wrap whichever tier wins.
 */

/**
 * True when more than 80% of the alphabetic characters are uppercase — the
 * signature of the zipformer's uppercase output. Punctuation/digits/spaces are
 * ignored; a string with no letters is not "all caps".
 */
export function isAllCaps(text: string): boolean {
  let upper = 0;
  let letters = 0;
  for (const ch of text) {
    if (ch >= 'a' && ch <= 'z') {
      letters++;
    } else if (ch >= 'A' && ch <= 'Z') {
      letters++;
      upper++;
    }
  }
  if (letters === 0) return false;
  return upper / letters > 0.8;
}

/**
 * Lowercase `text` then capitalize the first letter of each sentence (start of
 * string + first letter after `.`/`!`/`?`), and uppercase the standalone pronoun
 * `i` (which also fixes `i'm`, `i'll`, `i've`, `i'd` — the apostrophe is a word
 * boundary).
 */
function sentenceCase(text: string): string {
  const lowered = text.toLowerCase();
  let out = '';
  let capNext = true;
  for (const ch of lowered) {
    if (capNext && ch >= 'a' && ch <= 'z') {
      out += ch.toUpperCase();
      capNext = false;
    } else {
      out += ch;
      if (ch === '.' || ch === '!' || ch === '?') capNext = true;
    }
  }
  // Standalone pronoun "i" → "I" (covers "i'm"/"i'll"/"i've"/"i'd").
  return out.replace(/\bi\b/g, 'I');
}

/**
 * Normalize a finalized transcript. All-caps input (the zipformer's output) is
 * lowercased + sentence-cased; already-cased input (Moonshine / whisper) is
 * returned trimmed but otherwise untouched.
 */
export function normalizeTranscript(text: string): string {
  // Strip a spurious leading list marker before any casing. Moonshine
  // occasionally prepends one ("1. What is 2 plus 2?" / "- ...") to a plain
  // spoken sentence. The marker must carry its punctuation (`1.`/`1)`/`-`/`*`/`•`)
  // plus a trailing space, so a genuine numeric start like "2 plus 2 is what I
  // asked" (no marker punctuation) is left untouched.
  const stripped = text.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '');
  const trimmed = stripped.trim();
  if (trimmed.length === 0) return trimmed;
  if (!isAllCaps(trimmed)) return trimmed;
  return sentenceCase(trimmed);
}
