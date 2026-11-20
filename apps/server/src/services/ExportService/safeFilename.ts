/**
 * safeFilename — turn arbitrary text into exactly ONE path segment.
 *
 * This is the only sanitizer between a caller-supplied name and a real write,
 * so it is written to be boring and total: every input produces a usable
 * single segment, and no input can produce a separator, a traversal, or an
 * empty string. `exportPaths.resolveExportTarget` performs the only path join
 * in the service, and its filename argument always comes from here — which is
 * what makes traversal structurally impossible rather than merely defended
 * against.
 *
 * Length is bounded in BYTES, not code units. Filesystems limit a path
 * component to 255 bytes (ext4, APFS, HFS+); a 200-character emoji title is
 * well past that in UTF-8 while looking short in JavaScript. Truncation walks
 * code points so it can never split a surrogate pair and emit a lone half,
 * which would surface downstream as U+FFFD in a filename.
 */

import path from 'path';

/** POSIX/APFS per-component ceiling. The whole final name must fit. */
export const MAX_COMPONENT_BYTES = 255;

/** Headroom for a ` (9999)` no-clobber suffix, so dedupe can never overflow. */
const DEDUPE_RESERVE_BYTES = 8;

/** Cosmetic cap: long names are legal but unpleasant in a Finder column. */
const MAX_STEM_CODE_POINTS = 120;

/**
 * Path separators plus the characters Windows rejects outright. Both
 * separators are stripped regardless of platform: a backslash separates on
 * Windows and is merely awkward on posix, and this service's output is meant
 * to be portable between them.
 */
const ILLEGAL_CHARS = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);

/** Windows reserves these regardless of extension; harmless to avoid on posix. */
const RESERVED_STEMS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Used when the input sanitizes down to nothing at all ("///", "...", ""). */
export const FALLBACK_STEM = 'untitled';

/**
 * A trailing dot-segment that reads as a file extension: 1-8 alphanumerics
 * containing at least one letter. The letter requirement keeps `report.2026`
 * intact (a year, not an extension) while still catching `.mp3` and `.7z`.
 */
const TRAILING_EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

/**
 * Replace every separator, reserved character, and control character with a
 * space. A space rather than deletion, so "a/b" reads as "a b" instead of
 * silently welding into "ab".
 *
 * Written as a code-point scan rather than a regex because the interesting
 * members of this set are unprintable, and a literal character class
 * containing them is easy to mistranscribe and hard to review.
 */
function blankIllegalChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    out += isControl || ILLEGAL_CHARS.has(ch) ? ' ' : ch;
  }
  return out;
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes and `maxCodePoints` code points.
 *
 * Iterating with `for...of` yields whole code points, so an astral character
 * (emoji, many CJK extensions) is either fully included or fully excluded —
 * `String.prototype.slice` would cut between the surrogates and leave an
 * unpaired half.
 */
function clampToBytes(
  input: string,
  maxBytes: number,
  maxCodePoints: number = Number.MAX_SAFE_INTEGER
): string {
  let out = '';
  let bytes = 0;
  let points = 0;
  for (const ch of input) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes || points + 1 > maxCodePoints) break;
    out += ch;
    bytes += size;
    points += 1;
  }
  return out;
}

/**
 * Collapse `input` to one safe path segment.
 *
 * Leading dots are stripped: a name beginning with `.` is hidden on unix, and
 * `..` is the traversal primitive itself.
 *
 * `maxBytes` bounds the RESULT. Callers applying an extension pass a reduced
 * budget so the composed name still fits (see safeFilenameWithExtension).
 */
export function safeFilename(
  input: string,
  fallback: string = FALLBACK_STEM,
  maxBytes: number = MAX_COMPONENT_BYTES - DEDUPE_RESERVE_BYTES
): string {
  const collapsed = blankIllegalChars(input.normalize('NFC'))
    .replace(/\s+/g, ' ')
    // Leading dots AND whitespace in one pass. Stripping dots and then
    // trimming is not equivalent: separators become spaces above, so
    // "....//....//x" arrives here as ".... .... x", and removing only the
    // first dot run leaves " .... x" — which trims back to a leading dot.
    // An interior dot is untouched; it is a legitimate extension separator.
    .replace(/^[.\s]+/, '');

  const clamped = clampToBytes(collapsed, maxBytes, MAX_STEM_CODE_POINTS);
  // A trailing dot or space is stripped by the Windows shell on creation,
  // which would silently change the name we believe we wrote. Also cleans up
  // a space left dangling by truncation.
  const trimmed = clamped.replace(/[.\s]+$/, '');

  if (!trimmed) return fallback;
  if (RESERVED_STEMS.has(trimmed.toLowerCase())) return `${trimmed}_`;
  return trimmed;
}

/**
 * Sanitize a filename and force a known extension, REPLACING whatever
 * extension the caller supplied.
 *
 * The extension is authoritative (for images it comes from the stored MIME
 * type), so `my shot.txt` for a PNG becomes `my shot.png` — not
 * `my shot.txt.png`, which would preserve a lie about the format. Internal
 * dots survive: `v1.2 shot` keeps its version, because `.2 shot` is not a
 * plausible extension.
 *
 * The composed result is guaranteed to fit MAX_COMPONENT_BYTES with room for
 * a dedupe suffix: the stem budget is reduced by the extension's own size.
 */
export function safeFilenameWithExtension(
  input: string,
  extension: string,
  fallback: string = FALLBACK_STEM
): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const extBytes = Buffer.byteLength(ext, 'utf8');
  const stemBudget = Math.max(1, MAX_COMPONENT_BYTES - extBytes - DEDUPE_RESERVE_BYTES);

  // Drop a trailing extension-looking segment, whatever it was. Matching the
  // forced extension is just the common case of the same rule.
  const match = TRAILING_EXTENSION.exec(input);
  const hasLetter = match ? /[A-Za-z]/.test(match[1]) : false;
  const withoutExt = match && hasLetter ? input.slice(0, input.length - match[0].length) : input;

  const stem = safeFilename(withoutExt, '', stemBudget);
  if (stem) return `${stem}${ext}`;

  // Stem sanitized away — fall back, still inside the budget.
  const safeFallback = safeFilename(fallback, FALLBACK_STEM, stemBudget);
  return `${safeFallback}${ext}`;
}

/**
 * Deterministic collision suffix: `Notes.md` -> `Notes (2).md` -> `Notes (3).md`.
 *
 * `taken` is the authority rather than the filesystem. A multi-file export
 * allocates many names in one run, and re-`stat`ing per candidate is both
 * slower and racy — a name reserved earlier in the same run has usually not
 * been written yet. Callers add the result to `taken` themselves, so one set
 * can span a whole export.
 *
 * The suffix always fits: names come from safeFilename*, which reserves
 * DEDUPE_RESERVE_BYTES against the component ceiling.
 */
export function dedupeFilename(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 10k identically-named siblings is not a real workspace; refuse rather than
  // loop forever or silently overwrite.
  throw new Error(`Could not find a free filename for "${name}" after 10000 attempts`);
}
