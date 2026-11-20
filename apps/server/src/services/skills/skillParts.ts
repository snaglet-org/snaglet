/**
 * Skill text in numbered parts — pure, no I/O.
 *
 * Skills have no length limit, but every tool result longer than the ingest
 * ceiling (never below the `max_result_chars` setting) is head+tail trimmed as
 * it arrives (toolDispatch.ts), which would silently cut the middle out of a
 * long skill. So `skill` op `load` / `read` return the whole text when it fits
 * in one result, and otherwise one numbered part per call: every part,
 * header and footer included, is at most `max_result_chars` long, so no part
 * is ever trimmed.
 *
 * Parts split at line boundaries; only a single line longer than a part is cut
 * mid-line, and that part's footer says so. Every part but the last ends with
 * a footer naming the exact call for the next part, version included: each
 * call re-reads and re-splits the file, so a call carrying the version of an
 * earlier part is refused when the file has changed since, instead of
 * silently repeating or skipping text.
 */

/**
 * Smallest part body. When `max_result_chars` minus a part's header and
 * footer leaves less than this (an absurdly small setting, or a very long
 * file path), the call fails with a clear error instead of returning a part
 * longer than one tool result.
 */
const MIN_PART_CHARS = 100;

/** A shorter version than this (from a condensed marker, say) is not trusted. */
const MIN_VERSION_CHARS = 8;

/** One part of the text: `body` slices concatenate back to the original. */
interface TextPart {
  body: string;
  /** True when the part ends inside a line (only for a line longer than a part). */
  endsMidLine: boolean;
}

/** Which part a header describes; null when the text fits in one result. */
type PartPosition = { n: number; total: number } | null;

export interface PagedSkillTextInput {
  /** The whole file, read once for this call. */
  text: string;
  /** Version of the whole `text`; every footer's next call carries it. */
  version: string;
  /** The result's first line, e.g. `[Skill x · version …]`, with the part when split. */
  header: (position: PartPosition) => string;
  /** The tool input for the next part minus `part` and `version`, e.g. `{op, slug}`. */
  call: Record<string, unknown>;
  /** What the parts belong to, for errors (e.g. "Skill 'x'"). */
  label: string;
  /** The `max_result_chars` setting: no result is longer than this. */
  maxResultChars: number;
  /** The requested part, 1-based; undefined or null means 1. */
  part: unknown;
  /** The version the caller expects (from a footer); undefined or null skips the check. */
  expectedVersion: unknown;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Split `text` into bodies of at most `maxChars` characters, breaking only
 * after a newline. A line longer than `maxChars` is cut into `maxChars`-sized
 * pieces (never between the two halves of a surrogate pair); its tail starts
 * the next part. Joining every body gives back `text` exactly.
 */
export function splitAtLines(text: string, maxChars: number): TextPart[] {
  const max = Math.max(2, Math.floor(maxChars));
  const parts: TextPart[] = [];
  let current = '';
  for (const line of text.split(/(?<=\n)/)) {
    if (current.length + line.length <= max) {
      current += line;
      continue;
    }
    // `current` holds only whole lines here, so it ends on a line boundary.
    if (current) parts.push({ body: current, endsMidLine: false });
    let rest = line;
    while (rest.length > max) {
      const cut = isHighSurrogate(rest.charCodeAt(max - 1)) ? max - 1 : max;
      parts.push({ body: rest.slice(0, cut), endsMidLine: true });
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) parts.push({ body: current, endsMidLine: false });
  return parts;
}

function footer(input: PagedSkillTextInput, n: number, total: number, midLine: boolean): string {
  const where = midLine ? ', ends mid-line' : '';
  const next = JSON.stringify({ ...input.call, part: n + 1, version: input.version });
  return `[Part ${n} of ${total}${where} — call skill ${next} for the next part]`;
}

function requestedPart(part: unknown): number {
  if (part === undefined || part === null) return 1;
  const n = typeof part === 'string' && /^\d+$/.test(part.trim()) ? Number(part) : part;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error('part must be a whole number, 1 or more.');
  }
  return n;
}

function requestedVersion(version: unknown): string | null {
  if (version === undefined || version === null) return null;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('version must be the version string from a part footer.');
  }
  return version.trim().toLowerCase();
}

/** True when `expected` names `current`: equal, or one a prefix of the other (8+ chars). */
function versionMatches(expected: string, current: string): boolean {
  if (expected.length < MIN_VERSION_CHARS) return false;
  return current.startsWith(expected) || expected.startsWith(current);
}

/**
 * Characters a part body may use: `max_result_chars` minus the longest header
 * and footer any part of this text can have (part numbers at their widest:
 * there are never more parts than characters) and the two line breaks.
 * Throws when that leaves less than MIN_PART_CHARS.
 */
function partBudget(input: PagedSkillTextInput): number {
  const widest = Number('9'.repeat(String(Math.max(1, input.text.length)).length));
  const frame =
    input.header({ n: widest, total: widest }).length +
    footer(input, widest, widest, true).length +
    2;
  const budget = input.maxResultChars - frame;
  if (budget < MIN_PART_CHARS) {
    throw new Error(
      `${input.label} is too long for one tool result and cannot be split into parts that fit: ` +
        `max_result_chars is ${input.maxResultChars} and a part's header and footer alone need ` +
        `${frame}. Raise the max_result_chars setting, or use a shorter file path.`
    );
  }
  return budget;
}

/**
 * The result for one `skill` call: the whole text under its header when it
 * fits in `max_result_chars`, else the requested part. Throws on a part that
 * is not a whole number or is past the last part (naming how many there are),
 * and on an `expectedVersion` the text no longer has.
 */
export function pageSkillText(input: PagedSkillTextInput): string {
  const n = requestedPart(input.part);
  const expected = requestedVersion(input.expectedVersion);
  const whole = `${input.header(null)}\n${input.text}`;
  const parts =
    whole.length <= input.maxResultChars ? null : splitAtLines(input.text, partBudget(input));
  const total = parts?.length ?? 1;
  if (expected !== null && !versionMatches(expected, input.version)) {
    throw new Error(
      `${input.label} changed since that part (now version ${input.version}, ` +
        `${total} part${total === 1 ? '' : 's'}). Start again from part 1.`
    );
  }
  if (!parts) {
    if (n !== 1) throw new Error(`${input.label} has 1 part; part ${n} does not exist.`);
    return whole;
  }
  if (n > total) {
    throw new Error(
      `${input.label} has ${total} parts; part ${n} does not exist. Ask for part 1 to ${total}.`
    );
  }
  const { body, endsMidLine } = parts[n - 1];
  const head = `${input.header({ n, total })}\n${body}`;
  if (n === total) return head;
  const gap = body.endsWith('\n') ? '' : '\n';
  return `${head}${gap}${footer(input, n, total, endsMidLine)}`;
}
